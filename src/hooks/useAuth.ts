import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api } from "../api";
import { mergeBackendOk, shouldLogoutOnProbeError } from "../lib/appGate";
import { getBackendReach, subscribeBackendReach } from "../lib/backendReach";

export interface AuthUser {
  username: string;
  display_name: string | null;
  role: string;
}

/** G4 状态分层 · 会话层：后端连接探测 + 登录门控（FW_AUTH_UPSTREAM 启用时）。
 *
 * @param onReconnect 断 → 通 的那一下调一次。6.8 之前这里自己造那句话，
 *   现在**必须**由调用方来说 —— 说什么取决于补发队列跑出来的结果，
 *   而队列不该被会话层知道。详见 `lib/appGate.ts` 里 `reconnectNotice` 的墓碑。 */
export function useAuth(onReconnect?: () => void) {
  const [probeOk, setProbeOk] = useState<boolean | null>(null);
  const [loginRequired, setLoginRequired] = useState<boolean | null>(null); // null=探测中
  const [user, setUser] = useState<AuthUser | null>(null);

  // 6.7：真实请求给出的可达性。探测每 15 秒才一次，而用户点下按钮的那一刻
  // 就已经有一个失败的请求了 —— 断网靠它察觉，比轮询快，且平时零额外请求。
  const reach = useSyncExternalStore(subscribeBackendReach, getBackendReach);
  const backendOk = mergeBackendOk(probeOk, reach);

  /**
   * @param background 后台重探（15s 轮询）。**不清空既有结论**。
   *
   * ⚠️ 这个参数不是优化，是必需的：`probe` 一进来就 `setBackendOk(null)`，
   * 而 null 在门禁里是「探测中」。轮询若走前台模式，断线页每 15 秒会闪一次
   * 「连接后端…」；更糟的是本条目让轮询也可能在**编辑器开着**的时候跑
   * （中途断网），那一闪就是把整个编辑器卸载重建一次 —— 播放位置、选中态全没。
   */
  const probe = useCallback(async (background = false) => {
    if (!background) {
      setProbeOk(null);
      setLoginRequired(null);
    }
    try {
      const h = await api.health();
      setProbeOk(true);
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
        } catch (e) {
          // 只有 401/403 才是"这张票不认了"。断网刚恢复时后端常回 502/503，
          // 按那个删会话 = 一次网络抖动就要重新走飞书扫码。判据见 appGate。
          if (shouldLogoutOnProbeError(e)) {
            localStorage.removeItem("fw_session");
            setUser(null);
          } else if (background) {
            // 后台重探遇到非鉴权错误：**什么都不动**，保持用户当前的状态，
            // 等下一轮。前台（首次探测）没有"当前状态"可保持，只能落到登录页。
            return;
          }
        }
      }
      setLoginRequired(true);
    } catch {
      // 后端不可达：**不能**把 loginRequired 置成 false 放人进去——
      // 那样用户会落到一个空项目列表，然后每个操作都失败，且看不出是后端的问题。
      // 保持 loginRequired=null；由 `decideScreen` 决定是渲染断线页
      // 还是（手上已有项目数据时）留在编辑器挂横幅。
      setProbeOk(false);
      setLoginRequired(null);
    }
  }, []);

  useEffect(() => { void probe(); }, [probe]);

  // 后端重启后自动恢复：探测只跑一次的话，用户得手动刷新整个应用。
  // 15s 一次，只在确认断开时轮询——连上之后就不再打扰后端。
  // （"确认断开"现在也包括真实请求报上来的断线，不再只有启动时那一次探测。）
  useEffect(() => {
    if (backendOk !== false) return;
    const t = window.setInterval(() => { void probe(true); }, 15000);
    return () => clearInterval(t);
  }, [backendOk, probe]);

  // 断 → 通 的那一下必须有交代。不交代的话，用户看着横幅消失，
  // 无从知道离线期间那几笔改动到底补上去没有。
  //
  // ⚠️ `wasDown` 用 ref 不用 state 是承重的：它一变就重渲染的话，这个 effect
  // 会跟着再跑一遍，而 `onReconnect` 里是**发请求**，等于每次恢复连接补发两趟。
  const wasDown = useRef(false);
  useEffect(() => {
    if (backendOk === false) { wasDown.current = true; return; }
    if (backendOk === true && wasDown.current) {
      // 先落旗再回调：`onReconnect` 是异步的，它内部的请求会再次触碰
      // `backendReach`，旗子还举着的话有机会把这个 effect 又勾一次。
      wasDown.current = false;
      onReconnect?.();
    }
  }, [backendOk, onReconnect]);

  const doLogout = async () => {
    const t = localStorage.getItem("fw_session");
    if (t) { await api.logout(t).catch(() => {}); localStorage.removeItem("fw_session"); }
    setUser(null);
    setLoginRequired(true);
  };

  const onLoggedIn = (u: AuthUser) => { setUser(u); setLoginRequired(false); };

  return {
    backendOk, loginRequired, user, doLogout, onLoggedIn,
    retry: () => probe(false),
  };
}
