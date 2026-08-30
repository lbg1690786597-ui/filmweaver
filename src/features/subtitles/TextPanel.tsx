/**
 * TextPanel — 文本 / 字幕（PLAN §5.3）
 *
 * 三件事：
 *   ① **从旁白生成字幕**（主入口）——本机 ffmpeg silencedetect + 强制对齐，
 *      零网络零模型零费用。旁白是我们自己合成的，文本已知，用 ASR 去猜文本
 *      是把已知信息扔掉再买回一个更差的版本（详见 align.ts 头注释）。
 *      ASR 保留为**没有文本**（真人录音/外部素材）时的备选。
 *   ② 逐条编辑（文本 / 锚点镜头 / 镜内偏移 / 时长），不再只能删。
 *   ③ 两层样式：项目级默认（存 Project.default_profile.subtitle_style）
 *      + 单条覆写。烧录时 ffmpeg 只吃**一套** force_style，所以项目级那层
 *      是必需的，不能靠"随便挑一条 cue 的 style 代表全体"。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Type, Plus, Trash2, Wand2, Loader2, Sparkles, Check, AlertTriangle,
} from "lucide-react";
import { api } from "../../api";
import type { SubtitleClipInfo } from "../../api";
import type { SubtitleStyleLike } from "../../lib/subtitleStyle";
import { styleToCss } from "../../lib/subtitleStyle";
import { generateFromNarration } from "./generate";
import { BUNDLED_FONTS, listSystemFonts, type FontOption } from "./fonts";
import { IS_TAURI } from "../export/ExportDialog";
import "./TextPanel.css";

/** 字幕样式预设。**只是起点**——点一下把参数灌进下面的编辑器，之后随便改。
 *  （此前这 6 个预设是"只能选、不能改"，而且从未被主导出路径消费过。） */
export interface SubtitleStyle extends SubtitleStyleLike {
  id: string;
  name: string;
}

const PRESETS: SubtitleStyle[] = [
  { id: "default", name: "默认", fontSize: 42, color: "#ffffff", stroke: "#000000", strokeWidth: 3, bg: "transparent", bold: true, position: "bottom", marginV: 60 },
  { id: "drama", name: "短剧标准", fontSize: 48, color: "#ffffff", stroke: "#000000", strokeWidth: 4, bg: "transparent", bold: true, position: "bottom", marginV: 60 },
  { id: "yellow", name: "黄字描边", fontSize: 46, color: "#ffe14d", stroke: "#000000", strokeWidth: 4, bg: "transparent", bold: true, position: "bottom", marginV: 60 },
  { id: "boxed", name: "半透底框", fontSize: 40, color: "#ffffff", stroke: "transparent", strokeWidth: 0, bg: "rgba(0,0,0,0.55)", bold: false, position: "bottom", marginV: 60 },
  { id: "title", name: "标题大字", fontSize: 72, color: "#ffffff", stroke: "#000000", strokeWidth: 5, bg: "transparent", bold: true, position: "center", marginV: 60 },
  { id: "narration", name: "旁白顶部", fontSize: 36, color: "#e8e8e8", stroke: "#000000", strokeWidth: 2, bg: "transparent", bold: false, position: "top", marginV: 60 },
];

/** 项目没设过样式时的兜底。与 srtForceStyle / styleToCss 的默认值一致。 */
const BASE_STYLE: SubtitleStyleLike = {
  fontSize: 48, color: "#ffffff", stroke: "#000000", strokeWidth: 4,
  bg: "transparent", bold: true, position: "bottom", marginV: 60,
  fontFamily: "", fontSource: "system",
};

interface Props {
  projectId: string;
  /** 字幕列表。**由外层单一数据源下发**，本面板不再自己存一份。
   *
   *  原来面板内有个 items state，只在挂载和自身增删改后 load()。
   *  自动字幕跑完是外层 refreshSubtitles() 刷的，面板的 items 不会跟着变
   *  —— 时间轴字幕轨已经有字幕了，下面的「已添加」列表还是空的，
   *  用户以为识别失败。同一份数据存两处，其中一处不会更新。 */
  clips: SubtitleClipInfo[];
  hasSelection: boolean;
  /** 播放头所在镜头（字幕锚定镜头 order + 镜内偏移，与后端同构） */
  anchor: { order: number; offsetSec: number } | null;
  /** 项目级默认字幕样式（useSubtitleStyle 下发） */
  style: SubtitleStyleLike | null;
  /** 写回项目级样式（落库成功才更新 UI） */
  onSaveStyle: (s: SubtitleStyleLike | null) => Promise<void>;
  /** TB-08：提交语音识别 job（**备选**入口，仅在没有文本时用） */
  onAutoSubtitles: () => Promise<void>;
  /** 增删改后通知外层刷新（时间轴字幕轨与本面板共用同一份数据） */
  onChanged: () => void;
  onToast: (m: string) => void;
}

export default function TextPanel(p: Props) {
  const [tab, setTab] = useState<"text" | "style">("text");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [asrOk, setAsrOk] = useState(false);
  const [asrBusy, setAsrBusy] = useState(false);
  const [genLabel, setGenLabel] = useState("");      // 生成字幕进度文案（空 = 空闲）
  const [edit, setEdit] = useState<null | {
    id: string; text: string; order: number; off: number; dur: number;
  }>(null);

  // 样式工作副本。p.style 是"库里的"，这里是"正在调的"——分开才能做到
  // 拖滑块时实时预览、停手才落库。
  const [st, setSt] = useState<SubtitleStyleLike>({ ...BASE_STYLE, ...(p.style ?? {}) });
  const [saved, setSaved] = useState(false);
  useEffect(() => { setSt({ ...BASE_STYLE, ...(p.style ?? {}) }); }, [p.style]);

  const [sysFonts, setSysFonts] = useState<FontOption[]>([]);
  useEffect(() => { void listSystemFonts().then(setSysFonts); }, []);

  useEffect(() => {
    api.asrStatus().then((r) => setAsrOk(r.available)).catch(() => setAsrOk(false));
  }, []);

  /** 样式落库。防抖 600ms —— 改字号是拖着改的，每动一格发一次 PUT
   *  会打出几十个请求，而且中间态存进库里毫无意义。 */
  const saveTimer = useRef<number | null>(null);
  const patchStyle = (patch: Partial<SubtitleStyleLike>) => {
    const next = { ...st, ...patch };
    setSt(next);
    setSaved(false);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void p.onSaveStyle(next)
        .then(() => { setSaved(true); window.setTimeout(() => setSaved(false), 1500); })
        .catch((e) => p.onToast(`样式保存失败: ${String(e).slice(0, 120)}`));
    }, 600);
  };
  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);

  const reloadAll = () => { p.onChanged(); };

  const addText = async () => {
    if (!draft.trim()) { p.onToast("请先输入文字内容"); return; }
    setBusy(true);
    try {
      await api.createSubtitleClip({
        project_id: p.projectId,
        text: draft.trim(),
        // 居中大字按"标题"落库（导出时后端据此区分），其余是普通字幕
        kind: st.position === "center" ? "title" : "normal",
        start_shot_order: p.anchor?.order ?? 1,
        start_offset_sec: p.anchor?.offsetSec ?? 0,
        duration: 3,
        // 不写 style：让它继承项目级样式。逐条 style 是**覆写**，
        // 建条时就写死会让「样式」页后来的调整对它无效。
      });
      setDraft("");
      reloadAll();
      p.onToast(`已添加字幕（锚定镜头 #${p.anchor?.order ?? 1}）`);
    } catch (e) { p.onToast(String(e)); }
    finally { setBusy(false); }
  };

  /** 主入口：从已合成的旁白本地对齐出整轨字幕。 */
  const genFromNarration = async () => {
    setGenLabel("读取旁白…");
    try {
      const r = await generateFromNarration(p.projectId, {
        probe: IS_TAURI,     // 浏览器预览没有 sidecar ffmpeg，退化为比例分配
        onProgress: (done, total, label) => setGenLabel(`${label}（${done}/${total}）`),
      });
      reloadAll();
      const tail = r.degraded
        ? `；其中 ${r.degraded} 段没探到停顿，按字数比例分配（误差略大）`
        : "";
      p.onToast(`✅ 已从 ${r.sources} 段旁白生成 ${r.created} 条字幕`
        + (r.deleted ? `，替换旧的 ${r.deleted} 条` : "") + tail);
    } catch (e) {
      p.onToast(String(e instanceof Error ? e.message : e));
    } finally { setGenLabel(""); }
  };

  const removeItem = async (id: string) => {
    try { await api.deleteSubtitleClip(id); reloadAll(); }
    catch (e) { p.onToast(String(e)); }
  };

  const commitEdit = async () => {
    if (!edit) return;
    const cur = p.clips.find((c) => c.id === edit.id);
    setEdit(null);
    if (!cur) return;
    // 一个字段都没变就别发请求（点开又点走是常事）
    if (cur.text === edit.text && cur.start_shot_order === edit.order
        && Math.abs(cur.start_offset_sec - edit.off) < 1e-6
        && Math.abs(cur.duration - edit.dur) < 1e-6) return;
    try {
      await api.patchSubtitleClip(edit.id, {
        text: edit.text,
        start_shot_order: edit.order,
        start_offset_sec: edit.off,
        duration: Math.max(0.1, edit.dur),
      });
      reloadAll();
    } catch (e) { p.onToast(String(e)); }
  };

  /** 把逐条覆写清掉，让整轨跟随项目级样式。
   *
   *  刻意**不是**"把当前样式复制进每一条"：那样以后再改项目样式，
   *  这些条目就再也不跟了，用户会发现「样式」页调什么都没反应。 */
  const applyToAll = async () => {
    const overridden = p.clips.filter(
      (c) => c.style && Object.keys(c.style).length > 0);
    if (!overridden.length) { p.onToast("所有字幕已在跟随项目样式"); return; }
    setBusy(true);
    try {
      for (const c of overridden) await api.patchSubtitleClip(c.id, { style: {} });
      reloadAll();
      p.onToast(`✅ ${overridden.length} 条字幕已改为跟随项目样式`);
    } catch (e) { p.onToast(String(e)); }
    finally { setBusy(false); }
  };

  const fonts = useMemo<FontOption[]>(
    () => (st.fontSource === "bundled" ? BUNDLED_FONTS : sysFonts),
    [st.fontSource, sysFonts]);

  return (
    <div className="fw-text">
      <div className="fw-text-tabs">
        <button className={tab === "text" ? "on" : ""} onClick={() => setTab("text")}>
          <Type size={12} /> 文本
        </button>
        <button className={tab === "style" ? "on" : ""} onClick={() => setTab("style")}>
          样式
        </button>
      </div>

      <div className="fw-text-body">
        {tab === "text" && (
          <>
            <div className="fw-text-sec">从旁白生成（推荐）</div>
            <button className="fw-text-auto primary" disabled={!!genLabel}
              title="用本机 ffmpeg 检测旁白里的真实停顿，把已知的旁白文本对齐上去。不联网、不花钱、不会听错字"
              onClick={() => void genFromNarration()}>
              {genLabel
                ? <><Loader2 size={12} className="fw-spin" /> {genLabel}</>
                : <><Sparkles size={12} /> 从旁白生成字幕</>}
            </button>
            <div className="fw-text-hint">
              旁白文本是合成时用过的原文，逐字准确；时间位置由本机检测停顿得到。
              会**替换**上一次自动生成的字幕，手动添加的不受影响。
            </div>

            <div className="fw-text-sec">手动添加</div>
            <div className="fw-text-compose">
              <textarea value={draft} onChange={(e) => setDraft(e.target.value)}
                placeholder="输入字幕 / 标题文字…" rows={3} spellCheck={false} />
              <div className="fw-text-compose-acts">
                <span className="fw-text-at">
                  {p.anchor
                    ? `锚定镜头 #${p.anchor.order} 第 ${p.anchor.offsetSec.toFixed(1)}s`
                    : "锚定第 1 个镜头"}
                </span>
                <button className="primary" disabled={busy} onClick={() => void addText()}>
                  {busy ? <Loader2 size={12} className="fw-spin" /> : <Plus size={12} />} 添加
                </button>
              </div>
            </div>

            <div className="fw-text-sec">语音识别（没有文本时用）</div>
            <button className="fw-text-auto" disabled={!asrOk || asrBusy}
              title={asrOk
                ? "对音频做语音识别。只在没有原文时才需要——有原文时上面那个更准"
                : "未配置语音识别通道"}
              onClick={async () => {
                setAsrBusy(true);
                try {
                  await p.onAutoSubtitles();
                  // job 是异步的，给后端一点时间落库再刷新列表
                  setTimeout(reloadAll, 3000);
                } finally { setAsrBusy(false); }
              }}>
              {asrBusy ? <Loader2 size={12} className="fw-spin" /> : <Wand2 size={12} />}
              语音识别生成字幕
              {!asrOk && <span className="fw-text-todo">未配置</span>}
            </button>

            {p.clips.length > 0 && (
              <>
                <div className="fw-text-sec">已添加（{p.clips.length}）</div>
                <div className="fw-text-list">
                  {p.clips.map((it) => {
                    if (edit?.id === it.id) {
                      return (
                        <div key={it.id} className="fw-text-row editing">
                          <input className="fw-text-edit-text" autoFocus value={edit.text}
                            onChange={(e) => setEdit({ ...edit, text: e.target.value })}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") void commitEdit();
                              if (e.key === "Escape") setEdit(null);
                            }} />
                          <label>镜
                            <input type="number" min={1} step={1} value={edit.order}
                              onChange={(e) => setEdit({ ...edit, order: Number(e.target.value) })} />
                          </label>
                          <label>入
                            <input type="number" min={0} step={0.1} value={edit.off}
                              onChange={(e) => setEdit({ ...edit, off: Number(e.target.value) })} />
                          </label>
                          <label>长
                            <input type="number" min={0.1} step={0.1} value={edit.dur}
                              onChange={(e) => setEdit({ ...edit, dur: Number(e.target.value) })} />
                          </label>
                          <button title="保存" onClick={() => void commitEdit()}>
                            <Check size={11} />
                          </button>
                        </div>
                      );
                    }
                    const rowSt = (it.style && Object.keys(it.style).length
                      ? it.style : st) as SubtitleStyleLike;
                    return (
                      <div key={it.id} className="fw-text-row">
                        <span className="fw-text-row-preview" title="点击编辑"
                          onClick={() => setEdit({
                            id: it.id, text: it.text, order: it.start_shot_order,
                            off: Number(it.start_offset_sec.toFixed(2)),
                            dur: Number(it.duration.toFixed(2)),
                          })}
                          style={{
                            color: rowSt.color ?? "#fff",
                            fontWeight: rowSt.bold ? 700 : 400,
                            background: rowSt.bg ?? "transparent",
                            WebkitTextStroke: rowSt.strokeWidth
                              ? `${Math.min(2, rowSt.strokeWidth / 2)}px ${rowSt.stroke ?? "#000"}`
                              : undefined,
                          }}>{it.text}</span>
                        <span className="fw-text-row-meta">
                          #{it.start_shot_order} · {it.start_offset_sec.toFixed(1)}s
                          · {it.duration.toFixed(1)}s
                        </span>
                        <button className="danger" title="删除"
                          onClick={() => void removeItem(it.id)}>
                          <Trash2 size={11} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </>
        )}

        {tab === "style" && (
          <>
            <div className="fw-text-sec">
              预览（按 1080×1920 缩放）
              {saved && <span className="fw-text-saved"><Check size={10} /> 已保存</span>}
            </div>
            <div className="fw-text-preview">
              <div style={styleToCss(st, 220)}>字幕预览示例</div>
            </div>

            <div className="fw-text-sec">从预设开始</div>
            <div className="fw-text-presets">
              {PRESETS.map((s) => {
                const { id: _id, name: _name, ...rest } = s;
                return (
                  <button key={s.id} className="fw-text-preset"
                    onClick={() => patchStyle(rest)}>
                    <span className="fw-text-preset-demo" style={{
                      fontSize: Math.max(11, (s.fontSize ?? 42) / 4),
                      color: s.color,
                      fontWeight: s.bold ? 700 : 400,
                      background: s.bg,
                      WebkitTextStroke: s.strokeWidth
                        ? `${Math.min(1.5, s.strokeWidth / 3)}px ${s.stroke}` : undefined,
                      alignItems: s.position === "top" ? "flex-start"
                        : s.position === "center" ? "center" : "flex-end",
                    }}>示例字幕</span>
                    <span className="fw-text-preset-name">{s.name}</span>
                  </button>
                );
              })}
            </div>

            <div className="fw-text-sec">字体</div>
            <div className="fw-text-form">
              <Row k="来源">
                <select value={st.fontSource ?? "system"}
                  onChange={(e) => patchStyle({
                    fontSource: e.target.value as "bundled" | "system",
                    // 换来源必须清掉字体名：内置的名字在系统清单里多半不存在，
                    // 留着会让 ffmpeg 静默回落成默认字形
                    fontFamily: "",
                  })}>
                  <option value="system">系统字体</option>
                  <option value="bundled">内置字体（随包分发）</option>
                </select>
              </Row>
              <Row k="字体">
                <select value={st.fontFamily ?? ""}
                  onChange={(e) => patchStyle({ fontFamily: e.target.value })}>
                  <option value="">（默认）</option>
                  {fonts.map((f) => (
                    <option key={f.name} value={f.name}>{f.label}</option>
                  ))}
                </select>
              </Row>
            </div>
            {st.fontSource !== "bundled" && (
              <div className="fw-text-warn">
                <AlertTriangle size={12} />
                <span>
                  系统字体依赖这台电脑装了哪些字。换台机器导出、或把工程给别人，
                  缺字时 ffmpeg 会**静默换成别的字形**（不会报错）。
                  要保证成片一模一样，选「内置字体」。
                </span>
              </div>
            )}

            <div className="fw-text-sec">排版</div>
            <div className="fw-text-form">
              <Row k={`字号 ${st.fontSize ?? 48}px`}>
                <input type="range" min={16} max={120} step={1}
                  value={st.fontSize ?? 48}
                  onChange={(e) => patchStyle({ fontSize: Number(e.target.value) })} />
              </Row>
              <Row k="颜色">
                <input type="color" value={hexOf(st.color, "#ffffff")}
                  onChange={(e) => patchStyle({ color: e.target.value })} />
              </Row>
              <Row k="加粗">
                <input type="checkbox" checked={!!st.bold}
                  onChange={(e) => patchStyle({ bold: e.target.checked })} />
              </Row>
              <Row k={`描边 ${st.strokeWidth ?? 4}px`}>
                <input type="range" min={0} max={12} step={1}
                  value={st.strokeWidth ?? 4}
                  onChange={(e) => patchStyle({ strokeWidth: Number(e.target.value) })} />
              </Row>
              <Row k="描边色">
                <input type="color" value={hexOf(st.stroke, "#000000")}
                  onChange={(e) => patchStyle({ stroke: e.target.value })} />
              </Row>
              <Row k="底框">
                {/* 底框走 ASS 的 BorderStyle=3，此时描边宽度变成"框的内边距"，
                    两者不能同时表达——所以这里只给开/关，不给单独的框颜色。 */}
                <select value={st.bg && st.bg !== "transparent" ? st.bg : "transparent"}
                  onChange={(e) => patchStyle({ bg: e.target.value })}>
                  <option value="transparent">无（用描边）</option>
                  <option value="rgba(0,0,0,0.55)">半透黑</option>
                  <option value="rgba(0,0,0,0.85)">近实黑</option>
                  <option value="rgba(255,255,255,0.75)">半透白</option>
                </select>
              </Row>
              <Row k="位置">
                <select value={st.position ?? "bottom"}
                  onChange={(e) => patchStyle({
                    position: e.target.value as SubtitleStyleLike["position"] })}>
                  <option value="bottom">底部</option>
                  <option value="center">居中</option>
                  <option value="top">顶部</option>
                </select>
              </Row>
              <Row k={`边距 ${st.marginV ?? 60}px`}>
                <input type="range" min={0} max={400} step={5}
                  value={st.marginV ?? 60}
                  onChange={(e) => patchStyle({ marginV: Number(e.target.value) })} />
              </Row>
            </div>

            <div className="fw-text-sec">整轨</div>
            <button className="fw-text-auto" disabled={busy}
              title="清掉逐条样式覆写，让所有字幕跟随上面这套项目样式"
              onClick={() => void applyToAll()}>
              {busy ? <Loader2 size={12} className="fw-spin" /> : <Check size={12} />}
              应用到全部字幕
            </button>
            <div className="fw-text-hint">
              这套样式是**项目级默认**，导出烧录时用的就是它
              —— ffmpeg 一次只能烧一套样式，所以整片字幕外观由这里决定。
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** `<input type="color">` 只认 #rrggbb。rgba()/transparent 一律回落，
 *  否则 React 会对着一个非法值报警告，且色块显示成黑色误导用户。 */
function hexOf(v: string | undefined, fallback: string): string {
  return v && /^#[0-9a-fA-F]{6}$/.test(v) ? v : fallback;
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <label className="fw-text-frow">
      <span>{k}</span>{children}
    </label>
  );
}
