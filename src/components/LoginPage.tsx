import { useEffect, useRef, useState } from "react";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { openUrl } from "@tauri-apps/plugin-opener";
import { api, APP_VERSION } from "../api";
import { IS_TAURI } from "../features/export/ExportDialog";
import FeishuQRLogin from "./FeishuQRLogin";

interface Props {
  onLoggedIn: (user: { username: string; display_name: string | null; role: string }) => void;
}

/** 轮询间隔与上限。后端票据 10 分钟过期，这里 3 秒一次 × 200 次 = 10 分钟，
 *  两边对齐——前端不会比后端先放弃，也不会在票据早已作废后还空转。 */
const POLL_MS = 3000;
const POLL_MAX = 200;

/** 登录页：飞书扫码（2026-08 起账号密码已移除，与剧本平台看齐）。
 *
 *  两种客户端、两套流程：
 *    **网页端**：内嵌二维码（飞书官方 QR SDK），扫完码页面就进主界面（无需轮询）。
 *               iframe 内的 postMessage 可能被浏览器在 HTTP 环境下拦截，
 *               所以同时提供"跳转授权"按钮兜底（不依赖 postMessage，必定可用）。
 *    **桌面端**：拉起系统浏览器授权 → 后端接住回调 → 前端轮询取号。
 *               桌面端因为浏览器和应用是两个窗口，必须用轮询，无法内嵌二维码。
 *               详见 backend/app/auth.py 的模块说明。
 *
 *  必备逃生门（仅桌面）：右下角「检查更新」——防止旧版客户端因协议不兼容无法登录、
 *  又因登录不了进不去主界面而无法更新的死循环。
 *  ⚠️ 这一版把账号密码接口也删了，旧客户端**只能**靠这个入口自救，务必保留。
 */
export default function LoginPage(p: Props) {
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);   // 已拉起浏览器，等用户扫码
  const [err, setErr] = useState("");
  // 更新状态（与主界面 checkUpdate 同逻辑，独立实现避免依赖登录后的组件树）
  const [upd, setUpd] = useState<"idle" | "checking" | "downloading" | "ready" | "none">("idle");
  const [updPct, setUpdPct] = useState(0);

  // 轮询定时器：组件卸载/登录成功都要停，否则会一直空转到票据过期
  const timer = useRef<number | null>(null);
  const stopPoll = () => {
    if (timer.current !== null) { window.clearInterval(timer.current); timer.current = null; }
  };
  useEffect(() => stopPoll, []);

  // 桌面端专属：拉系统浏览器、轮询取号
  const doFeishuLogin = async () => {
    setBusy(true); setErr("");
    try {
      const { ticket, authorize_url } = await api.feishuStart("desktop");
      // 用系统浏览器打开：飞书授权页在应用内 WebView 里常因 UA/Cookie 限制走不通，
      // 而且用户在系统浏览器里可能已有飞书登录态，扫码更快
      await openUrl(authorize_url);
      setWaiting(true);

      let n = 0;
      stopPoll();
      timer.current = window.setInterval(async () => {
        n += 1;
        if (n > POLL_MAX) {
          stopPoll(); setWaiting(false);
          setErr("登录超时（10 分钟未完成授权），请重试。");
          return;
        }
        try {
          const r = await api.feishuPoll(ticket);
          if (r.status === "ok" && r.token && r.user) {
            stopPoll(); setWaiting(false);
            localStorage.setItem("fw_session", r.token);
            p.onLoggedIn(r.user);
          } else if (r.status === "expired") {
            stopPoll(); setWaiting(false);
            setErr("登录请求已失效，请重新点击飞书登录。");
          }
          // pending：继续等
        } catch {
          // 单次轮询失败（网络抖动）不该终止整个流程，下一次再试
        }
      }, POLL_MS);
    } catch (e) {
      setErr(`发起登录失败: ${String((e as Error)?.message ?? e).slice(0, 140)}`);
      setWaiting(false);
    } finally { setBusy(false); }
  };

  const cancelWait = () => { stopPoll(); setWaiting(false); setErr(""); };

  // 网页端专属：QR 组件的回调
  const onQRDone = (r: { ok: true; token: string } | { ok: false; error: string }) => {
    if (r.ok) {
      localStorage.setItem("fw_session", r.token);
      // QR 组件只返回 token，需要再拉一次 /me 取 user —— 与 useAuth probe 同逻辑
      api.authMe().then(
        me => p.onLoggedIn(me.user),
        e => setErr(`登录成功但获取用户信息失败: ${String(e).slice(0, 100)}`)
      );
    } else {
      setErr(r.error);
    }
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
        <div className="muted">使用飞书扫码登录 · v{APP_VERSION}</div>

        {!IS_TAURI ? (
          /* 网页端：内嵌二维码，扫完码直接进主界面（回调 302 带回会话） */
          <FeishuQRLogin onDone={onQRDone} />
        ) : !waiting ? (
          <button className="btn primary wide" disabled={busy} onClick={doFeishuLogin}>
            {busy ? "正在打开飞书…" : "🔗 飞书扫码登录"}
          </button>
        ) : (
          <>
            <div className="muted" style={{ lineHeight: 1.7 }}>
              已在浏览器中打开飞书授权页。<br />
              扫码完成后会自动登录，这个窗口不用动。
            </div>
            <button className="btn ghost wide" onClick={cancelWait}>取消</button>
          </>
        )}

        {err && <div className="err">{err}</div>}

        {/* 逃生门：无法登录时仍可更新客户端。
            网页端没有更新器（check() 会抛错），且刷新页面就是最新版，故隐藏。 */}
        {IS_TAURI && (
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
        )}
      </div>
    </div>
  );
}
