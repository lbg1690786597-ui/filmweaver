import { useEffect, useState } from "react";
import { api, ProjectInfo } from "../api";

interface Props {
  onOpen: (id: string) => void;
}

/** 项目列表 + 新建向导（T-R0-06）：启动首屏。 */
export default function ProjectList(p: Props) {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [modes, setModes] = useState<Record<string, { label: string }>>({});
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState("");
  // 向导表单
  const [title, setTitle] = useState("");
  const [aspect, setAspect] = useState("9:16");
  const [mode, setMode] = useState("fast");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.listProjects().then((r) => setProjects(r.projects)).catch((e) => setErr(String(e)));
    api.productionModes().then((r) => setModes(r.modes)).catch(() => {});
  }, []);

  const doCreate = async () => {
    if (!title.trim()) return;
    setBusy(true); setErr("");
    try {
      const proj = await api.createProject(title.trim(), aspect, mode);
      p.onOpen(proj.id);
    } catch (e) { setErr(String(e)); setBusy(false); }
  };

  return (
    <div className="plist">
      <header className="plist-head">
        <h1>🎬 FilmWeaver 织影</h1>
        <button className="btn primary" onClick={() => setCreating(true)}>＋ 新建项目</button>
      </header>
      {err && <div className="err">{err}</div>}

      {creating && (
        <div className="drawer-mask" onClick={() => setCreating(false)}>
          <div className="wizard" onClick={(e) => e.stopPropagation()}>
            <h2>新建项目</h2>
            <label>项目名
              <input value={title} onChange={(e) => setTitle(e.target.value)}
                placeholder="如：都市短剧《重逢》" autoFocus />
            </label>
            <label>画幅基准（生成与导出默认继承）
              <div className="seg">
                {["9:16", "16:9", "1:1"].map((a) => (
                  <button key={a} className={aspect === a ? "on" : ""}
                    onClick={() => setAspect(a)}>{a}</button>
                ))}
              </div>
            </label>
            <label>生产模式
              <div className="mode-cards">
                {Object.entries(modes).map(([k, m]) => (
                  <button key={k} className={`mode-card ${mode === k ? "on" : ""}`}
                    onClick={() => setMode(k)}>{m.label}</button>
                ))}
              </div>
            </label>
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button className="btn ghost" onClick={() => setCreating(false)}>取消</button>
              <button className="btn primary" disabled={!title.trim() || busy} onClick={doCreate}>
                {busy ? "创建中…" : "创建并进入"}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="plist-grid">
        {projects.map((proj) => (
          <div key={proj.id} className="pcard" onClick={() => p.onOpen(proj.id)}>
            <div className="pcard-title">{proj.title}</div>
            <div className="muted">
              {proj.base_aspect} · {proj.production_mode ?? "未定模式"}
              {proj.episodes_count ? ` · ${proj.episodes_count} 集` : ""}
            </div>
          </div>
        ))}
        {!projects.length && !err && (
          <div className="muted pad">还没有项目，点右上角「新建项目」开始</div>
        )}
      </div>
    </div>
  );
}
