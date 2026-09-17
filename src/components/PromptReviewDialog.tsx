import { useEffect, useMemo, useRef, useState } from "react";
import { api, ShotInfo } from "../api";
import type { Say } from "../hooks/useToast";
import AutoTextarea from "./AutoTextarea";
import { useProjectStore } from "../stores/projectStore";

/** 出片前「提示词终审」弹窗。
 *
 * ── 为什么要有这一步 ────────────────────────────────────────────────────
 * 拆解确实**不会**自动触发出片（`run_breakdown_all` → `breakdown_by_episode`
 * → `_pregen_prompts` 到写 `gen_prompt` 就结束，全程没有 submit/create_job；
 * `useBreakdown` 收到 done 只弹一句「✅ 分镜与提示词生成完成」）。唯一会自动
 * 往下串的链路是用户自己按下的「▷ 一键成片」，那是他自己的选择。
 *
 * 但"没有自动串"不等于"用户确认过了"：拆解完提示词就静静躺在镜头卡里，批量
 * 出片时没人会去逐张点开看。而这一稿是 **draft** ——拆解那一刻资产还不存在，
 * 服装、人称、场景锚点全是 AI 从剧本猜的。真正的改写发生在点下「生成视频」
 * 之后的 `run_shot_videos` 里，等用户看见时钱已经花了、片已经出了。
 *
 * 所以本弹窗做三件事：
 *   ① 把**即将下发的那一稿**原文摊出来（不是缩略、不是摘要）；
 *   ② 允许就地改，改完通过 `PATCH /shots/{id}/prompt` 落库——后端会同时写
 *      `profile_override.prompt`，这是唯一"AI 不许再改"的通道（只写
 *      gen_prompt 的话，有参考图时会被重新优化顶掉，见 jobs.py 的优先级）；
 *   ③ 改完才出片。没改的镜头一字节都不写，不锁稿、不产生额外请求。
 *
 * ── 与资产对齐的关系 ────────────────────────────────────────────────────
 * `draft` 与 `aligned` 的区别是"有没有按当前资产重写过"。用户审稿时看到一堆
 * draft 却看不出来，所以每行都挂状态角标；要批量对齐就地点「按资产重写」，
 * 不必退出弹窗去别的面板找那个按钮。
 *
 * ⚠️ 重启后失效：弹窗内的编辑状态是**组件本地**的。关闭弹窗即丢弃未保存的
 * 改动——这与 Inspector 里的提示词编辑框行为一致（那边也是本地 draft +
 * 「保存提示词」按钮）。点主按钮会**先保存再出片**，所以走正常路径不会丢。
 */
interface Props {
  projectId: string;
  /** 待出片的镜头（顺序即镜头顺序）。只读快照——但外层逐帧重渲染时，
   *  Textarea 已编辑的内容由 `edits` 覆盖，不会被刷掉。 */
  shots: ShotInfo[];
  /** 刷新项目详情：审稿期间 AI 重写完成后要把新稿刷进来。
   *  缺省用 projectStore 的 `refreshDetail`（挂载点在面板内的场景），
   *  脱离 store 单测时可显式传入。 */
  onRefresh?: () => Promise<void> | void;
  /** 重写完成/保存后由外层刷新，这里只负责发信号 */
  onToast: Say;
  onClose: () => void;
  /** 用户确认：提示词已保存，可以出片了 */
  onConfirm: () => void;
}

/** prompt_state → 角标文案。口径见 api.ts 里 ShotInfo.prompt_state 的注释。 */
const STATE_LABEL: Record<string, { text: string; title: string; cls: string }> = {
  draft: {
    text: "初稿",
    title: "拆解时的初稿：那时资产还没生成，服装/人称/场景锚点都是 AI 从剧本猜的。"
         + "建议先「按资产重写」，或自己改一遍。",
    cls: "draft",
  },
  aligned: {
    text: "已对齐",
    title: "已按当前资产（参考图造型 + 人物档案）重写过，可以直接出片。",
    cls: "aligned",
  },
  sent: {
    text: "上片稿",
    title: "上一次出片时实际下发给视频模型的那一稿。",
    cls: "sent",
  },
  manual: {
    text: "手动稿",
    title: "你手填并锁定过的稿子：出片时原样下发，AI 不会改写。",
    cls: "manual",
  },
};

export default function PromptReviewDialog(p: Props) {
  /** 本地编辑稿。key=shot_id；只有**改过**的才存进来，
   *  没改的镜头以 `s.gen_prompt` 为准——这样 AI 重写后本地的空值不会把新稿压回去。 */
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<null | "save" | "align">(null);
  /** 审稿期间 AI 重写要能刷新镜头文本。缺省走 store —— 弹窗挂在面板里，
   *  由 App 层层传一个 refreshDetail 下去会多穿两层 props，而 store 本来就是
   *  detail 的唯一所有者（见 stores/projectStore.ts 文件头）。 */
  const refresh = p.onRefresh ?? (() => useProjectStore.getState().refreshDetail());
  const [alignPhase, setAlignPhase] = useState<string>("");
  const alignTimer = useRef<number | null>(null);

  // 卸载兜底：重写 job 的轮询必须停，否则回调会对已卸载组件 setState
  useEffect(() => () => {
    if (alignTimer.current) clearInterval(alignTimer.current);
  }, []);

  /** 这一镜此刻显示什么。改过用本地稿，没改用服务端稿。 */
  const textOf = (s: ShotInfo) => edits[s.id] ?? (s.gen_prompt ?? "");
  const edited = (s: ShotInfo) => s.id in edits && edits[s.id] !== (s.gen_prompt ?? "");

  const stats = useMemo(() => {
    let draft = 0, blank = 0;
    for (const s of p.shots) {
      const t = textOf(s).trim();
      if (!t) blank += 1;
      else if ((s.prompt_state ?? "draft") === "draft") draft += 1;
    }
    const n = Object.keys(edits).filter((id) => {
      const s = p.shots.find((x) => x.id === id);
      return s ? edited(s) : false;
    }).length;
    return { draft, blank, edited: n, total: p.shots.length };
    // textOf/edited 依赖 edits 与 p.shots，两者都在依赖里
  }, [edits, p.shots]);

  const blankShots = p.shots.filter((s) => !textOf(s).trim());

  /** 只保存改过的。返回是否全部成功——有失败就不该继续出片。 */
  const saveEdits = async (): Promise<boolean> => {
    const dirty = p.shots.filter(edited);
    if (!dirty.length) return true;
    const failed: string[] = [];
    // 串行：一次几十个 PATCH 并发打过去没有意义（后端还是逐条写库），
    // 串行还能在中途失败时给出干净的部分成功语义。
    for (const s of dirty) {
      try {
        await api.patchShotPrompt(s.id, textOf(s));
      } catch (e) {
        failed.push(`#${s.order + 1} ${String(e).slice(0, 80)}`);
      }
    }
    if (failed.length) {
      p.onToast(`⚠️ ${failed.length}/${dirty.length} 个镜头的提示词保存失败：${failed[0]}`);
      return false;
    }
    p.onToast(`✅ 已保存 ${dirty.length} 个镜头的手改提示词（出片时原样下发）`);
    return true;
  };

  /** 主按钮：先落库再出片。空提示词在这里拦住——后端到那一步才失败的话，
   *  用户已经点了"生成"，看到的是任务失败而不是"这里少填了一段"。 */
  const confirm = async () => {
    if (blankShots.length) {
      p.onToast(`⚠️ 还有 ${blankShots.length} 个镜头没有提示词，请先补上或从这批里去掉`);
      return;
    }
    setBusy("save");
    try {
      if (!(await saveEdits())) return;
      p.onConfirm();
    } finally { setBusy(null); }
  };

  /** 就地按资产重写（纯文本 job，不出图不出片）。完成后刷新镜头，本地未保存的
   *  编辑**保留**——用户可能正是改了一半想先看看 AI 会怎么写。 */
  const alignAll = async () => {
    setBusy("align");
    setAlignPhase("正在提交…");
    try {
      const j = await api.submitReprompt(p.projectId);
      let tick = 0;
      alignTimer.current = window.setInterval(async () => {
        tick += 1;
        // 轮询回调自己吞异常：抛出去就是 unhandled rejection，interval 还会继续空转
        let s;
        try { s = await api.jobStatus(j.id); }
        catch (e) { console.warn("[PromptReviewDialog] 重写状态轮询失败，稍后重试:", e); return; }
        setAlignPhase(s.phase?.label
          ? `${s.phase.label}${s.phase.total ? ` ${s.phase.done}/${s.phase.total}` : ""}`
          : `已重写 ${s.progress}%`);
        if (s.status === "done" || s.status === "failed") {
          if (alignTimer.current) { clearInterval(alignTimer.current); alignTimer.current = null; }
          // 收尾这一次无条件刷新：最后一镜必须落地
          await refresh();
          setBusy(null);
          setAlignPhase("");
          p.onToast(s.status === "done"
            ? "✅ 提示词已按当前资产重写，请再确认一遍"
            : "⚠️ 部分镜头重写失败，可稍后重试");
        }
        // 保险：任务卡在 running 时不能永远转圈（5 分钟 = 100 次 × 3s）
        if (tick > 100 && alignTimer.current) {
          clearInterval(alignTimer.current); alignTimer.current = null;
          setBusy(null); setAlignPhase("");
          p.onToast("⏳ 重写任务仍在进行，可关闭本窗口稍后在镜头列表查看");
        }
      }, 3000);
    } catch (e) {
      p.onToast(String(e));
      setBusy(null); setAlignPhase("");
    }
  };

  const busyAny = busy !== null;

  return (
    <div className="drawer-mask" onClick={() => { if (!busyAny) p.onClose(); }}>
      <div className="wizard wizard-lg prv" onClick={(e) => e.stopPropagation()}>
        <h2>📝 出片前确认提示词</h2>

        {/* 口径必须如实：这里**不生成任何东西**，只让用户看一眼即将下发的文本。
            写清"拆解不会自动出片"是为了纠正一个常见误解，免得用户以为
            关掉这个弹窗出片跑掉了。 */}
        <div className="prv-lead">
          接下来会对 <b>{stats.total}</b> 个镜头出片。下面是这一批**即将下发给视频模型**
          的提示词原文，请过一遍——拆解出的初稿是在资产生成**之前**写的，
          服装与人物指代可能不准。
          {stats.draft > 0 && <> 其中 <b className="prv-warn">{stats.draft}</b> 个还是「初稿」。</>}
        </div>

        <div className="prv-bar">
          <span className="muted">
            {stats.edited > 0
              ? `已改 ${stats.edited} 个（点「保存并生成」后锁定，AI 不再改写）`
              : "未做修改"}
          </span>
          <span style={{ flex: 1 }} />
          {busy === "align" && <span className="muted">{alignPhase || "重写中…"}</span>}
          <button className="btn tiny" disabled={busyAny}
            title="按当前资产（参考图造型 + 人物档案）重写全部镜头提示词。纯文本任务，不出图不出片，不花钱。"
            onClick={alignAll}>
            {busy === "align" ? "重写中…" : "✨ 按资产重写"}
          </button>
          <button className="btn tiny" disabled={busyAny || !stats.edited}
            title="放弃本次全部手改，恢复成服务端上的那一稿（已保存过的稿不受影响）"
            onClick={() => { setEdits({}); p.onToast("已撤销本次未保存的修改"); }}>
            撤销修改
          </button>
        </div>

        {blankShots.length > 0 && (
          <div className="prv-alert">
            ⚠️ {blankShots.length} 个镜头没有提示词（
            {blankShots.slice(0, 6).map((s) => `#${s.order + 1}`).join("、")}
            {blankShots.length > 6 ? " …" : ""}）。
            空提示词会让这一镜出片失败或出成随机画面，请补上，或先在镜头列表里停用它。
          </div>
        )}

        <div className="prv-list">
          {p.shots.map((s) => {
            const st = STATE_LABEL[s.prompt_state ?? "draft"] ?? STATE_LABEL.draft;
            const t = textOf(s);
            const isEdited = edited(s);
            return (
              <div className="prv-row" key={s.id}>
                <div className="prv-no">
                  <b>#{s.order + 1}</b>
                  {s.thumb_url
                    ? <img className="zoomable" src={api.mediaUrl(s.thumb_url)} alt="缩略图" loading="lazy" />
                    : <div className="prv-no-ph">{s.first_frame_url ? "首帧" : "无图"}</div>}
                </div>
                <div className="prv-main">
                  <div className="prv-tags">
                    <span className={`prv-tag ${st.cls}`} title={st.title}>{st.text}</span>
                    {isEdited && <span className="prv-tag edited" title="本次改过，尚未保存">已改</span>}
                    {!t.trim() && <span className="prv-tag blank">空</span>}
                    {s.stale && s.stale_hint && (
                      <span className="prv-tag stale" title={s.stale_hint}>已过期</span>
                    )}
                    <span className="muted">{s.duration_sec ?? 5}s</span>
                  </div>
                  <AutoTextarea className="prv-ta" minHeight={54} value={t}
                    placeholder="这一镜还没有提示词。可直接在这里写——保存后出片就用它。"
                    disabled={busyAny}
                    onChange={(e) => setEdits((prev) => ({ ...prev, [s.id]: e.target.value }))} />
                </div>
              </div>
            );
          })}
        </div>

        <div className="prv-foot">
          <button className="btn" disabled={busyAny} onClick={p.onClose}>取消（不出片）</button>
          <span style={{ flex: 1 }} />
          {stats.blank > 0 && <span className="muted">{stats.blank} 个待补</span>}
          <button className="btn primary" disabled={busyAny} onClick={confirm}>
            {busy === "save" ? "保存中…"
              : stats.edited > 0 ? `保存 ${stats.edited} 处修改并生成` : `确认无误，生成 ${stats.total} 个片段`}
          </button>
        </div>
      </div>
    </div>
  );
}
