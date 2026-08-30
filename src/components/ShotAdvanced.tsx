import { useEffect, useState } from "react";
import { api, ShotInfo, VideoProviderInfo } from "../api";
import AutoTextarea from "./AutoTextarea";
import { productionModeLabel } from "../lib/modelLabels";

interface Props {
  shot: ShotInfo;
  productionMode: string | null;   // 项目级模式（继承来源展示）
  onClose: () => void;
  onSaved: () => void;
  onToast: (m: string) => void;
}

/** T-R1-04 镜头高级面板：三层策略覆盖 + 五生成模式选择器（modes 置灰带原因）。 */
export default function ShotAdvanced(p: Props) {
  const [providers, setProviders] = useState<VideoProviderInfo[]>([]);
  const [modeNames, setModeNames] = useState<Record<string, string>>({});
  const ov = (p.shot.profile_override ?? {}) as Record<string, any>;

  const [modelId, setModelId] = useState<string>(ov.model_id ?? "");
  const [genMode, setGenMode] = useState<string>(ov.generation_mode ?? "");
  const [durationS, setDurationS] = useState<string>(ov.duration_ms ? String(ov.duration_ms / 1000) : "");
  const [mp, setMp] = useState<string>(ov.megapixels ? String(ov.megapixels) : "");
  const [prompt, setPrompt] = useState<string>(ov.prompt ?? "");
  const [firstFrame, setFirstFrame] = useState<string>(ov.first_frame_url ?? "");
  const [lastFrame, setLastFrame] = useState<string>(ov.last_frame_url ?? "");
  // 「标记为特殊镜头」勾选框已删除（用户反馈"意义不明"：它只在导出时把该镜排除出
  // 自动审片，UI 上没有任何配套流程，勾了看不出区别）。这里仍读取镜头原值原样回传，
  // 避免保存覆盖时把历史数据上的 is_special 悄悄清掉。
  const special = p.shot.is_special;
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.videoProviders().then((r) => {
      setProviders(r.providers);
      setModeNames((r as any).generation_modes ?? {});
    }).catch(() => {});
  }, []);

  const activeProvider = providers.find((x) => x.model_id === (modelId || undefined))
    ?? providers[0];

  const upload = async (f: File, setter: (u: string) => void) => {
    try {
      const r = await api.uploadMedia(f);
      setter(r.url);
    } catch (e) { p.onToast(String(e)); }
  };

  const save = async () => {
    setBusy(true);
    try {
      const override: Record<string, unknown> = {};
      if (modelId) override.model_id = modelId;
      if (genMode) override.generation_mode = genMode;
      if (durationS) override.duration_ms = Math.round(Number(durationS) * 1000);
      if (mp) override.megapixels = Number(mp);
      if (prompt.trim()) override.prompt = prompt.trim();
      if (firstFrame) override.first_frame_url = firstFrame;
      if (lastFrame) override.last_frame_url = lastFrame;
      await api.patchShotOverride(p.shot.id, Object.keys(override).length ? override : null, special);
      p.onSaved();
      p.onToast("✅ 镜头覆盖已保存");
      p.onClose();
    } catch (e) { p.onToast(String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="drawer-mask" onClick={p.onClose}>
      <div className="wizard" style={{ width: 520 }} onClick={(e) => e.stopPropagation()}>
        <h2>镜头 #{p.shot.order} · 高级设置</h2>
        <div className="muted">
          继承：项目·{productionModeLabel(p.productionMode)} 模式{Object.keys(ov).length ? "（本镜已有覆盖）" : ""}
        </div>

        <label>模型（留空=继承项目模式）
          <select value={modelId} onChange={(e) => { setModelId(e.target.value); setGenMode(""); }}>
            <option value="">（继承）</option>
            {providers.map((x) => <option key={x.model_id} value={x.model_id}>{x.model_id}</option>)}
          </select>
        </label>

        <label>生成模式（按所选模型能力置灰）
          <div className="mode-cards" style={{ flexWrap: "wrap" }}>
            <button className={`mode-card ${genMode === "" ? "on" : ""}`}
              onClick={() => setGenMode("")}>自动推断</button>
            {Object.entries(activeProvider?.modes ?? {}).map(([m, s]) => (
              <button key={m} className={`mode-card ${genMode === m ? "on" : ""}`}
                disabled={!s.available}
                title={s.available
                  ? [modeNames[m] ?? m,
                     s.requires_first_frame && s.requires_last_frame ? "必须同时提供首帧图与尾帧图"
                       : s.max_reference_images != null ? `参考图上限 ${s.max_reference_images} 张` : "",
                     s.reference_audio === false ? "该模式不支持参考音频" : ""]
                      .filter(Boolean).join(" · ")
                  : (s.reason ?? "不可用")}
                onClick={() => setGenMode(m)}>
                {m}{!s.available && " 🔒"}
              </button>
            ))}
          </div>
        </label>


        {(genMode === "i2va" || genMode === "fl2va") && (
          <label>首帧图（i2va/fl2va）
            <div className="row">
              <input value={firstFrame} placeholder="/fw/media/... 或上传"
                onChange={(e) => setFirstFrame(e.target.value)} style={{ flex: 1 }} />
              <input type="file" accept=".png,.jpg,.jpeg,.webp" hidden id="ff-up"
                onChange={(e) => e.target.files?.[0] && upload(e.target.files[0], setFirstFrame)} />
              <button className="btn tiny" onClick={() => document.getElementById("ff-up")?.click()}>上传</button>
            </div>
          </label>
        )}
        {(genMode === "fl2va" || genMode === "l2va") && (
          <label>尾帧图（fl2va/l2va）
            <div className="row">
              <input value={lastFrame} placeholder="/fw/media/... 或上传"
                onChange={(e) => setLastFrame(e.target.value)} style={{ flex: 1 }} />
              <input type="file" accept=".png,.jpg,.jpeg,.webp" hidden id="lf-up"
                onChange={(e) => e.target.files?.[0] && upload(e.target.files[0], setLastFrame)} />
              <button className="btn tiny" onClick={() => document.getElementById("lf-up")?.click()}>上传</button>
            </div>
          </label>
        )}

        <div className="row">
          <label style={{ flex: 1 }}>时长档（秒）
            <select value={durationS} onChange={(e) => setDurationS(e.target.value)}>
              <option value="">（默认）</option>
              {(activeProvider?.duration_slots ?? []).map((d) => (
                <option key={d} value={d}>{d}s</option>
              ))}
            </select>
          </label>
          <label style={{ flex: 1 }}>画质（MP）
            <select value={mp} onChange={(e) => setMp(e.target.value)}>
              <option value="">（自动）</option>
              <option value="0.5">省 0.5MP（单镜可到 38s）</option>
              <option value="1">标准 1MP（单镜可到 18s）</option>
              <option value="2">高 2MP（单镜仅 7.5s）</option>
            </select>
          </label>
        </div>

        <label>提示词覆盖（留空=用镜头剧本片段）
          <AutoTextarea className="drawer-ta" minHeight={60}
            value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        </label>

        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button className="btn ghost" onClick={p.onClose}>取消</button>
          <button className="btn primary" disabled={busy} onClick={save}>
            {busy ? "保存中…" : "保存覆盖"}
          </button>
        </div>
      </div>
    </div>
  );
}
