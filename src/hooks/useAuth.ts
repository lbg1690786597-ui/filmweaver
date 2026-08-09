import { useEffect, useState } from "react";
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

  useEffect(() => {
    api.health().then(async (h) => {
      setBackendOk(true);
      if (!h.login) { setLoginRequired(false); return; }  // 后端未启用登录
      // 启用登录：验证本地会话是否仍有效
      const saved = localStorage.getItem("fw_session");
      if (saved) {
        try {
          const me = await api.authMe(saved);
          setUser(me.user);
          setLoginRequired(false);
          return;
        } catch { localStorage.removeItem("fw_session"); }
      }
      setLoginRequired(true);
    }).catch(() => { setBackendOk(false); setLoginRequired(false); });
  }, []);

  const doLogout = async () => {
    const t = localStorage.getItem("fw_session");
    if (t) { await api.logout(t).catch(() => {}); localStorage.removeItem("fw_session"); }
    setUser(null);
    setLoginRequired(true);
  };

  const onLoggedIn = (u: AuthUser) => { setUser(u); setLoginRequired(false); };

  return { backendOk, loginRequired, user, doLogout, onLoggedIn };
}
