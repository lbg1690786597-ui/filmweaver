import { useCallback, useEffect, useState } from "react";
import { api } from "../api";

export interface AuthUser {
  username: string;
  display_name: string | null;
  role: string;
}

/** G4 状态分层 · 会话层：后端连接探测 + 登录门控（FW_AUTH_UPSTREAM 启用时）。 */
export function useAuth() {
  const [backendOk, setBackendOk] = useState<boolean | null>(null);
  const [loginRequired, setLoginRequired] = useState<boolean | null>(null); // null=探测中
  const [user, setUser] = useState<AuthUser | null>(null);

  const probe = useCallback(async () => {
    setBackendOk(null);
    setLoginRequired(null);
    try {
      const h = await api.health();
      setBackendOk(true);
      if (!h.login) { setLoginRequired(false); return; }  // 后端未启用登录
      // 启用登录：验证本地会话是否仍有效
      const saved = localStorage.getItem("fw_session");
      if (saved) {
        try {
          // token 不再作参数传：authHeaders() 从同一个 fw_session key 读，
          // 走 Authorization header（避免 token 进日志/浏览器历史）
          const me = await api.authMe();
          setUser(me.user);
          setLoginRequired(false);
          return;
        } catch { localStorage.removeItem("fw_session"); }
      }
      setLoginRequired(true);
    } catch {
      // 后端不可达：**不能**把 loginRequired 置成 false 放人进去——
      // 那样用户会落到一个空项目列表，然后每个操作都失败，且看不出是后端的问题。
      // 保持 loginRequired=null，由 App 渲染「连不上后端」页并给重试入口。
      setBackendOk(false);
      setLoginRequired(null);
    }
  }, []);

  useEffect(() => { void probe(); }, [probe]);

  // 后端重启后自动恢复：探测只跑一次的话，用户得手动刷新整个应用。
  // 15s 一次，只在确认断开时轮询——连上之后就不再打扰后端。
  useEffect(() => {
    if (backendOk !== false) return;
    const t = window.setInterval(() => { void probe(); }, 15000);
    return () => clearInterval(t);
  }, [backendOk, probe]);

  const doLogout = async () => {
    const t = localStorage.getItem("fw_session");
    if (t) { await api.logout(t).catch(() => {}); localStorage.removeItem("fw_session"); }
    setUser(null);
    setLoginRequired(true);
  };

  const onLoggedIn = (u: AuthUser) => { setUser(u); setLoginRequired(false); };

  return { backendOk, loginRequired, user, doLogout, onLoggedIn, retry: probe };
}
