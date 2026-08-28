import { useEffect, useRef, useState } from "react";
import { api } from "../api";

/** 飞书官方二维码 SDK 注入的全局对象 */
declare global {
  interface Window {
    QRLogin?: (opts: {
      id: string;
      goto: string;
      width?: string;
      height?: string;
      style?: string;
    }) => { matchOrigin: (o: string) => boolean; matchData: (d: unknown) => boolean };
  }
}

const SDK_SRC =
  "https://lf-package-cn.feishucdn.com/obj/feishu-static/lark/passport/qrcode/LarkSSOSDKWebQRCode-1.0.3.js";

/**
 * 内嵌飞书扫码登录（飞书官方 QR SDK，与剧本平台同款）。
 *
 * 流程:
 *   1. 加载 SDK → window.QRLogin
 *   2. 后端 /feishu/start 签发 ticket 并返回 authorize_url，用作 goto
 *   3. SDK 在容器里插一个 iframe 渲染二维码
 *   4. 用户扫码确认 → iframe 通过 postMessage 回传 tmp_code
 *   5. 把 tmp_code 拼到 goto 上跳转 → 飞书带 code 重定向回我们的 callback
 *   6. 回调成功，302 回 /fw/app/，会话放 fragment —— 这里监听 hashchange 取回
 *
 * ⚠️ SDK 官方要求页面在 https 或 localhost 下，否则扫码后 postMessage 可能收不到
 *    （剧本平台的同款组件里有这条注释；它生产是 https://app.jubianai.net）。
 *    织影在 http://118.196.33.51:9080 —— **不满足**这个条件。
 *
 *    所以这里二维码与「跳转授权」按钮**并存**：
 *      · 二维码能用最好（体验最好，不离开当前页）
 *      · 若扫完码停在"打勾"页不动，说明 postMessage 确实被拦，
 *        用下面的按钮整页跳转（不依赖 postMessage，必定可用）
 *    等 9080 配上 SSL 后，二维码这条路才算稳。
 */
export default function FeishuQRLogin({ onDone }: {
  onDone: (r: { ok: true; token: string } | { ok: false; error: string }) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [err, setErr] = useState("");
  const [gotoUrl, setGotoUrl] = useState("");
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  // 监听回调 302 回来时的 fragment（#token=...或 #error=...）
  useEffect(() => {
    const check = () => {
      const frag = new URLSearchParams(window.location.hash.replace(/^#/, ""));
      const token = frag.get("token");
      const error = frag.get("error");
      if (token) {
        // 回调成功：清掉 fragment 避免刷新时重复触发
        window.history.replaceState(null, "", "/fw/app/");
        onDoneRef.current({ ok: true, token });
      } else if (error) {
        window.history.replaceState(null, "", "/fw/app/");
        onDoneRef.current({ ok: false, error });
      }
    };
    check();  // 页面加载时检查一次（可能是回调跳转回来的）
    window.addEventListener("hashchange", check, false);
    return () => window.removeEventListener("hashchange", check, false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let onMessage: ((e: MessageEvent) => void) | null = null;

    (async () => {
      try {
        // 1) 取授权 URL（后端签发 state 防 CSRF，并在 callback 中判定 302 目标）
        const { authorize_url } = await api.feishuStart("web");
        if (cancelled) return;
        setGotoUrl(authorize_url);

        // 2) 加载 SDK（只加载一次）
        if (!window.QRLogin) {
          await new Promise<void>((resolve, reject) => {
            const s = document.createElement("script");
            s.src = SDK_SRC;
            s.onload = () => resolve();
            s.onerror = () => reject(new Error("飞书二维码组件加载失败(检查网络)"));
            document.head.appendChild(s);
          });
        }
        if (cancelled || !window.QRLogin) return;

        // 3) 渲染二维码。
        //    SDK 会往容器里插 iframe，而这个容器同时也被 React 管理——
        //    直接 innerHTML="" 清空会让 React 卸载时找不到自己的子节点，
        //    报 "removeChild: The node to be removed is not a child of this node"。
        //    所以容器交给 SDK 独占：React 侧永远只渲染一个空 div。
        const box = boxRef.current;
        if (!box) return;
        while (box.firstChild) box.removeChild(box.firstChild);

        const qr = window.QRLogin({
          id: box.id,
          goto: authorize_url,
          width: "260",
          height: "260",
          style: "width:260px;height:260px;border:none",
        });

        // 4) 监听扫码结果
        onMessage = (e: MessageEvent) => {
          // 必须双重校验来源与数据格式，否则任意页面都能伪造消息
          if (!qr.matchOrigin(e.origin) || !qr.matchData(e.data)) return;
          const tmp = (e.data as { tmp_code?: string })?.tmp_code;
          if (!tmp) return;
          const sep = authorize_url.includes("?") ? "&" : "?";
          window.location.href =
            `${authorize_url}${sep}tmp_code=${encodeURIComponent(tmp)}`;
        };
        window.addEventListener("message", onMessage, false);
        setPhase("ready");
      } catch (e) {
        if (cancelled) return;
        setErr(e instanceof Error ? e.message : String(e));
        setPhase("error");
        onDoneRef.current({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    })();

    return () => {
      cancelled = true;
      if (onMessage) window.removeEventListener("message", onMessage, false);
      const box = boxRef.current;
      if (box) while (box.firstChild) box.removeChild(box.firstChild);
    };
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
      <div style={{ position: "relative", width: "260px", height: "260px",
                    borderRadius: "8px", overflow: "hidden", background: "#fff" }}>
        {phase === "loading" && (
          <div style={{ position: "absolute", inset: 0, display: "flex",
                        alignItems: "center", justifyContent: "center",
                        fontSize: "13px", color: "#888" }}>
            二维码加载中…
          </div>
        )}
        {/* 这个 div 交给飞书 SDK 独占：React 不在里面渲染任何子节点，
            否则 SDK 插 iframe 后 React 卸载时会 removeChild 报错。 */}
        <div id="fw_qr_login" ref={boxRef} style={{ position: "absolute", inset: 0 }} />
      </div>

      {phase === "error" && (
        <div style={{ marginTop: "12px", width: "260px", padding: "12px",
                      background: "#fee", border: "1px solid #faa", borderRadius: "8px",
                      fontSize: "13px", color: "#c33", lineHeight: 1.5 }}>
          {err}
        </div>
      )}

      {phase === "ready" && (
        <>
          <p style={{ marginTop: "12px", fontSize: "14px", color: "#9ca3af" }}>
            请用飞书扫码
          </p>
          {/* 兜底入口：本站是 HTTP，扫码后的 postMessage 可能被浏览器拦，
              那样会停在"打勾"页不动。整页跳转不依赖 postMessage，必定可用。 */}
          <button
            type="button"
            onClick={() => { if (gotoUrl) window.location.href = gotoUrl; }}
            className="btn ghost"
            style={{ marginTop: "10px", fontSize: "13px" }}
          >
            扫码后没反应？点此跳转授权
          </button>
        </>
      )}
    </div>
  );
}
