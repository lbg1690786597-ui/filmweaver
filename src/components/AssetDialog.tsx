import { useEffect, useMemo, useState } from "react";
import { api, ShotInfo, StageInfo } from "../api";
import AutoTextarea from "./AutoTextarea";

/** 统一资产详情弹窗的目标描述：
 *  - stage 有值 = 阶段上下文（主角阶段/配角唯一阶段）：可改阶段名/区间/确认/删除，生成写回 AssetStage
 *  - stage 为 null = 纯资产上下文（场景/自定义/无阶段角色）：生成写回 Asset（assetId 或 upsert） */
export interface AssetDialogTarget {
  kind: "character" | "location" | "custom";
  name: string;
  assetId: string | null;
  stage: StageInfo | null;
  imageUrl: string | null;
}

interface Props {
  projectId: string;
  target: AssetDialogTarget;
  /** 用途计算（精确到集数区间）：客户端按 effective 集合汇总出场集 */
  shots: ShotInfo[];
  onClose: () => void;
  onToast: (m: string) => void;
  /** 生成/改动落库后刷新（stages + detail） */
  onChanged: () => void;
}

const ASPECTS = ["1:1", "9:16", "16:9"] as const;
/** 兜底模型清单（后端 /providers/image 未响应时用；渠道链后端内部维护） */
const FALLBACK_MODELS = [{ id: "gpt-image-2", label: "GPT Image 2" }];

/** 比例 × 分辨率档 → 网关 size 串（以网关实际支持为准，失败会报错提示换档） */
const sizeFor = (aspect: string, hd: boolean): string => {
  if (aspect === "9:16") return hd ? "1536x2688" : "1024x1792";
  if (aspect === "16:9") return hd ? "2688x1536" : "1792x1024";
  return hd ? "1536x1536" : "1024x1024";
};

/** 连续集数合并为区间文案：[1,2,3,5] → "第1-3集、第5集" */
const epRanges = (eps: number[]): string => {
  if (!eps.length) return "尚未在任何镜头中使用";
  const sorted = [...new Set(eps)].sort((a, b) => a - b);
  const runs: [number, number][] = [[sorted[0], sorted[0]]];
  for (const e of sorted.slice(1)) {
    const last = runs[runs.length - 1];
    if (e === last[1] + 1) last[1] = e; else runs.push([e, e]);
  }
  return runs.map(([a, b]) => (a === b ? `第${a}集` : `第${a}-${b}集`)).join("、");
};

/** 统一资产详情弹窗：用途（集数区间）+ 阶段信息 + 生成参数（比例/分辨率/模型）+ 候选生成。
 *  资产页卡片单击、时间轴条目双击均打开此弹窗（轨道侧防误触）。 */
export default function AssetDialog(p: Props) {
  const t = p.target;
  const [prompt, setPrompt] = useState(() =>
    t.stage?.description
    ?? (t.kind === "location" ? `场景概念图, ${t.name}, 电影感, 高质量`
      : t.kind === "custom" ? ""
        : `角色立绘, ${t.name}, 全身, 高质量, 短剧风格`));
  const [aspect, setAspect] = useState<string>(t.kind === "location" ? "16:9" : "9:16");
  const [hd, setHd] = useState(false);
  const [models, setModels] = useState<{ id: string; label: string }[]>(FALLBACK_MODELS);
  const [model, setModel] = useState(FALLBACK_MODELS[0].id);
  useEffect(() => {
    api.imageProviders().then((r) => {
      if (r.models.length) { setModels(r.models); setModel((m) => r.models.some((x) => x.id === m) ? m : r.models[0].id); }
    }).catch(() => { /* 旧后端无此接口：保持兜底清单 */ });
  }, []);
  const [cands, setCands] = useState<string[]>([]);
  const [genBusy, setGenBusy] = useState(false);
  const [genN, setGenN] = useState(4);   // 生成张数 1-4（用户可选）
  const [curImg, setCurImg] = useState(t.imageUrl);

  // ---- 用途：按 effective 集合（(L1 ∪ add) − remove）汇总实际出场的集数 ----
  const usage = useMemo(() => {
    const eps: number[] = [];
    for (const sh of p.shots) {
      if (sh.is_special) continue;
      const ov = sh.ref_overrides ?? {};
      let present: boolean;
      if (t.kind === "location") {
        const rm = ov.remove_loc ?? [];
        present = [...(sh.location ? [sh.location] : []), ...(ov.add_loc ?? [])]
          .filter((c) => !rm.includes(c)).includes(t.name);
      } else {
        const rm = ov.remove ?? [];
        present = [...sh.characters, ...(ov.add ?? [])]
          .filter((c) => !rm.includes(c)).includes(t.name);
      }
      if (present) {
        // 阶段上下文：只统计本阶段区间内的出场
        if (t.stage && (sh.episode < t.stage.ep_from || sh.episode > t.stage.ep_to)) continue;
        eps.push(sh.episode);
      }
    }
    return epRanges(eps);
  }, [p.shots, t.kind, t.name, t.stage]);

  const saveStage = async (patch: Parameters<typeof api.patchStage>[1]) => {
    if (!t.stage) return;
    try {
      await api.patchStage(t.stage.id, patch);
      p.onChanged();
    } catch (e) { p.onToast(String(e)); }
  };

  const doGen = async () => {
    if (!prompt.trim()) { p.onToast("先填写生图提示词"); return; }
    setGenBusy(true);
    try {
      const r = await api.assetsGenerate(prompt.trim(), {
        modelId: model, size: sizeFor(aspect, hd), n: genN });
      setCands(r.urls);
      if (!r.urls.length) p.onToast("生图无产出，请重试");
      else if (r.urls.length === 1) await pick(r.urls[0]);  // 单张：直接采用，免一次点击
    } catch (e) { p.onToast(`生成失败：${String(e).slice(0, 160)}（高清档可能不被网关支持，可换标准档）`); }
    finally { setGenBusy(false); }
  };

  /** 点候选图 = 采用：阶段写 AssetStage.image_url；否则写 Asset（id 或 upsert） */
  const pick = async (u: string) => {
    try {
      if (t.stage) await api.patchStage(t.stage.id, { image_url: u });
      else if (t.assetId) await api.patchAsset(t.assetId, { imageUrl: u });
      else await api.upsertAssetImage(p.projectId, t.kind, t.name, u);
      setCurImg(u);
      setCands([]);
      p.onChanged();
      p.onToast("✅ 已设为资产图");
    } catch (e) { p.onToast(String(e)); }
  };

  const kindLabel = t.kind === "location" ? "场景" : t.kind === "custom" ? "自定义资产" : "角色";
  return (
    <div className="drawer-mask" onClick={p.onClose}>
      <div className="wizard wizard-lg" onClick={(e) => e.stopPropagation()}>
        <h2>{t.kind === "location" ? "🏞" : t.kind === "custom" ? "✨" : "👤"} {t.name}
          {t.stage && <span className="muted" style={{ fontWeight: 400 }}> · {t.stage.stage_name}</span>}
        </h2>

        {/* 当前图 + 用途 */}
        <div className="adlg-top">
          {curImg
            ? <img className="adlg-img" src={api.mediaUrl(curImg)} alt={t.name} />
            : <div className="adlg-img ph">尚无图</div>}
          <div className="adlg-meta">
            <div><b>类型</b>{kindLabel}{t.stage && t.stage.status === "confirmed" ? " · ✅已确认" : t.stage ? " · 草稿" : ""}</div>
            {t.stage && <div><b>阶段区间</b>第{t.stage.ep_from}-{t.stage.ep_to}集</div>}
            <div><b>实际用在</b>{t.kind === "custom" ? "拖到轨道/镜头槽后生效" : usage}</div>
          </div>
        </div>

        {/* 阶段字段（仅阶段上下文）：改名/调区间 */}
        {t.stage && (
          <div className="row">
            <label style={{ flex: 2 }}>阶段名
              <input defaultValue={t.stage.stage_name}
                onBlur={(e) => e.target.value !== t.stage!.stage_name && saveStage({ stage_name: e.target.value })} />
            </label>
            <label style={{ flex: 1 }}>起始集
              <input type="number" min={1} defaultValue={t.stage.ep_from}
                onBlur={(e) => saveStage({ ep_from: Number(e.target.value) })} />
            </label>
            <label style={{ flex: 1 }}>结束集
              <input type="number" min={1} defaultValue={t.stage.ep_to}
                onBlur={(e) => saveStage({ ep_to: Number(e.target.value) })} />
            </label>
          </div>
        )}

        {/* 生成参数：提示词 + 比例/分辨率/模型/张数 */}
        <label>生图提示词{t.stage ? "（即造型描述，修改会保存到阶段）" : ""}
          <AutoTextarea className="drawer-ta" minHeight={64} value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onBlur={() => { if (t.stage && prompt !== (t.stage.description ?? "")) void saveStage({ description: prompt }); }} />
        </label>
        <div className="row">
          <label style={{ flex: 1 }}>比例
            <select value={aspect} onChange={(e) => setAspect(e.target.value)}>
              {ASPECTS.map((a) => <option key={a} value={a}>{a}{a === "9:16" ? "（竖版）" : a === "16:9" ? "（横版）" : "（方形）"}</option>)}
            </select>
          </label>
          <label style={{ flex: 1 }}>分辨率
            <select value={hd ? "hd" : "std"} onChange={(e) => setHd(e.target.value === "hd")}>
              <option value="std">标准（{sizeFor(aspect, false)}）</option>
              <option value="hd">高清（{sizeFor(aspect, true)}，以网关支持为准）</option>
            </select>
          </label>
          <label style={{ flex: 1 }}>模型
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </label>
          <label style={{ width: 76 }}>张数
            <select value={genN} onChange={(e) => setGenN(Number(e.target.value))}>
              {[1, 2, 3, 4].map((n2) => <option key={n2} value={n2}>{n2} 张</option>)}
            </select>
          </label>
        </div>

        <button className="btn primary" disabled={genBusy} onClick={doGen}>
          {genBusy ? "生成中…（约 30-60s，可稍候）"
            : `✨ 生成${genN > 1 ? `（${genN} 张，点选采用）` : "（单张，自动采用）"}`}
        </button>
        {cands.length > 0 && (
          <div className="cand-grid">
            {cands.map((u) => (
              <img key={u} src={api.mediaUrl(u)} alt="候选" title="点击设为资产图"
                onClick={() => void pick(u)} />
            ))}
          </div>
        )}

        <div className="row" style={{ justifyContent: "space-between" }}>
          {t.stage ? (
            <button className="btn ghost" onClick={async () => {
              if (!window.confirm(`删除「${t.name}·${t.stage!.stage_name}」阶段？`)) return;
              await api.deleteStage(t.stage!.id);
              p.onChanged(); p.onClose();
            }}>🗑 删除阶段</button>
          ) : <span />}
          <span>
            <button className="btn ghost" onClick={p.onClose}>关闭</button>
            {t.stage && t.stage.status !== "confirmed" && (
              <button className="btn primary" disabled={!curImg}
                title={curImg ? "" : "先生成并选定资产图"}
                onClick={() => { void saveStage({ status: "confirmed" }); p.onToast("✅ 阶段已确认"); }}>
                ✅ 确认此阶段
              </button>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}
