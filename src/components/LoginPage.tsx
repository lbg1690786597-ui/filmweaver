import { useState } from "react";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { api, APP_VERSION } from "../api";

interface Props {
  onLoggedIn: (user: { username: string; display_name: string | null; role: string }) => void;
}

/** 登录页（复用主平台账号）。
 *  必备逃生门：右下角「检查更新」——防止旧版客户端因协议不兼容无法登录、
 *  又因登录不了进不去主界面而无法更新的死循环。 */
export default function LoginPage(p: Props) {
  const [username, setUsername] = useState(() => localStorage.getItem("fw_last_user") ?? "");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // 更新状态（与主界面 checkUpdate 同逻辑，独立实现避免依赖登录后的组件树）
  const [upd, setUpd] = useState<"idle" | "checking" | "downloading" | "ready" | "none">("idle");
  const [updPct, setUpdPct] = useState(0);

  const doLogin = async () => {
    if (!username.trim() || !password) return;
    setBusy(true); setErr("");
    try {
      const r = await api.login(username.trim(), password);
      localStorage.setItem("fw_session", r.token);
      localStorage.setItem("fw_last_user", username.trim());
      p.onLoggedIn(r.user);
    } catch (e) {
      const msg = String(e);
      setErr(msg.includes("401") ? "用户名或密码错误"
        : msg.includes("403") ? "账号已被禁用，请联系管理员"
        : `登录失败: ${msg.slice(0, 120)}`);
    } finally { setBusy(false); }
  };

  const doCheckUpdate = async () => {
    setUpd("checking");
    try {
      const update = await check();
      if (!update?.available) { setUpd("none"); return; }
      setUpd("downloading");
      let done = 0, total = 0;
      await update.downloadAndInstall((ev) => {
        if (ev.event === "Started") total = ev.data.contentLength ?? 0;
        if (ev.event === "Progress") {
          done += ev.data.chunkLength;
          setUpdPct(total > 0 ? Math.round((done / total) * 100) : 0);
        }
        if (ev.event === "Finished") setUpd("ready");
      });
    } catch (e) { setUpd("idle"); setErr(`检查更新失败: ${String(e).slice(0, 120)}`); }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <h1>🎬 FilmWeaver 织影</h1>
        <div className="muted">使用主平台账号登录 · v{APP_VERSION}</div>
        <input placeholder="用户名" value={username} autoFocus
          onChange={(e) => setUsername(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && doLogin()} />
        <input placeholder="密码" type="password" value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && doLogin()} />
        {err && <div className="err">{err}</div>}
        <button className="btn primary wide" disabled={busy || !username.trim() || !password}
          onClick={doLogin}>
          {busy ? "登录中…" : "登 录"}
        </button>

        {/* 逃生门：无法登录时仍可更新客户端 */}
        <div className="login-update">
          {upd === "idle" && (
            <button className="btn ghost" onClick={doCheckUpdate}>⟳ 检查更新</button>
          )}
          {upd === "checking" && <span className="muted">检查更新中…</span>}
          {upd === "none" && <span className="muted">✓ 已是最新版本</span>}
          {upd === "downloading" && <span className="muted">下载更新 {updPct}%</span>}
          {upd === "ready" && (
            <button className="btn primary" onClick={() => relaunch()}>🔄 重启安装新版本</button>
          )}
        </div>
      </div>
    </div>
  );
}
