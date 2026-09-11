"""verify_auth_s2.py — S2 / S5 / S3(无争议项) 的回归断言

钉住的是三类**静默**安全退化（都不会报错、都不会有人察觉）：

  S2 票据劫持    poll 只要 ticket 就给会话，而 ticket 必然经过扫码那个人的浏览器
  S2 越权登出    logout 直接 revoke 请求体里的 token，不问调用者是不是主人
  S5 前缀放行    `startswith` 匹配 → 任何名字以 `/media`/`/health` 开头的新路由免鉴权
  S3 明文令牌    auth_sessions.token 原样落库 = 一批可直接使用的 7 天会话

## 不打印任何真实令牌（硬约束）

全脚本只输出 HTTP 码、布尔、长度与字符集判定。为了测"A 不能吊销 B"必须
有两个真会话，脚本会用 `_issue_session` 造两个**一次性**会话并在结束时
**无条件删除**（`finally`）；它们的令牌只在内存里比较，从不 print。

## 为什么用 TestClient 而不是 curl 打 8002

`poll` 的成功分支要求票据里已经有"扫完码的结果"，而那结果只有飞书回调能写。
进程内可以直接往 `_TICKETS` 里摆一个假结果，于是"对的 claim → 200 且取走即销毁"
这条断言才测得成。跨进程的 curl 拿不到那个 dict —— 那条只能靠人扫码走一遍。

运行：/usr/bin/python3 scripts/verify_auth_s2.py   （cwd = backend/）
      仓内 backend/.venv 陈旧、没装 fastapi，必须用 /usr/bin/python3。
"""

import hashlib
import inspect as _inspect
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from starlette.testclient import TestClient  # noqa: E402

from app import auth  # noqa: E402
from app.db import get_session  # noqa: E402
from app.main import app  # noqa: E402

_pass = 0
_fail = 0


def ok(cond, msg):
    global _pass, _fail
    if cond:
        _pass += 1
        print(f"  ✅ {msg}")
    else:
        _fail += 1
        print(f"  ❌ {msg}")


#: 造票据时用的假结果。里面的 "token" 是个**显式假串**，不是任何真会话 ——
#: 只用来确认 poll 成功分支会把 result 原样交出来。
FAKE_RESULT = {"token": "NOT-A-REAL-TOKEN", "expires_at": "2099-01-01T00:00:00+00:00",
               "user": {"id": -1, "username": "_probe", "display_name": None,
                        "role": "user"}}


def make_ticket(prefix: str, claim: str, ip: str, result=None) -> str:
    """直接往进程内票据表里摆一张票（等价于 start 成功后的状态）。"""
    import secrets
    import time
    t = prefix + secrets.token_urlsafe(24)
    auth._TICKETS[t] = {"created": time.time(), "result": result,
                        "claim": claim, "ip": ip}
    return t


def main() -> int:
    c = TestClient(app, base_url="http://127.0.0.1:8002")
    # nginx 的 /fw/ 块写死了 X-Real-IP，所以线上 _client_ip 取的就是这个头。
    # 这里统一带同一个值，模拟"同一个客户端发起并轮询"。
    IP = {"X-Real-IP": "203.0.113.7"}
    OTHER_IP = {"X-Real-IP": "198.51.100.9"}

    print("\n【1】S2 取号必须同时出示 ticket + claim_secret")
    claim = "probe-claim-secret-value"
    t1 = make_ticket("d-", claim, "203.0.113.7")
    r = c.get(f"/v2/auth/feishu/poll?ticket={t1}", headers=IP)
    ok(r.status_code == 403, f"只带 ticket → {r.status_code}（应 403）")
    r = c.get(f"/v2/auth/feishu/poll?ticket={t1}",
              headers={**IP, "X-FW-Claim": claim + "x"})
    ok(r.status_code == 403, f"错的 claim_secret → {r.status_code}（应 403）")
    r = c.get(f"/v2/auth/feishu/poll?ticket={t1}",
              headers={**IP, "X-FW-Claim": claim})
    ok(r.status_code == 200 and r.json().get("status") == "pending",
       f"对的 claim_secret（还没扫码）→ {r.status_code} / "
       f"{r.json().get('status')}（应 200 / pending）")

    # 成功分支：票据里已有结果 → 取走并销毁
    t2 = make_ticket("d-", claim, "203.0.113.7", result=dict(FAKE_RESULT))
    r = c.get(f"/v2/auth/feishu/poll?ticket={t2}",
              headers={**IP, "X-FW-Claim": claim})
    ok(r.status_code == 200 and r.json().get("status") == "ok",
       f"扫码完成 + 对的 claim → {r.status_code} / {r.json().get('status')}（应 200 / ok）")
    ok(t2 not in auth._TICKETS, "取走即销毁：票据已从内存表移除")
    r = c.get(f"/v2/auth/feishu/poll?ticket={t2}",
              headers={**IP, "X-FW-Claim": claim})
    ok(r.json().get("status") == "expired", "同一张票第二次取 → expired（不可复用）")

    print("\n【2】S2 纵深：换来源 IP 取不走号")
    t3 = make_ticket("d-", claim, "203.0.113.7", result=dict(FAKE_RESULT))
    r = c.get(f"/v2/auth/feishu/poll?ticket={t3}",
              headers={**OTHER_IP, "X-FW-Claim": claim})
    ok(r.status_code == 403, f"claim 对但 IP 变了 → {r.status_code}（应 403）")
    ok(t3 in auth._TICKETS, "被拒的那次**没有**顺手销毁票据（合法客户端还能取）")
    auth._TICKETS.pop(t3, None)

    print("\n【3】S2 网页端票据不许走 poll")
    t4 = make_ticket("w-", claim, "203.0.113.7", result=dict(FAKE_RESULT))
    r = c.get(f"/v2/auth/feishu/poll?ticket={t4}",
              headers={**IP, "X-FW-Claim": claim})
    ok(r.status_code == 403, f"w- 票据 + 正确 claim → {r.status_code}（应 403）")
    auth._TICKETS.pop(t4, None)
    # start 的响应里 web 模式不该带 claim_secret（多发一个只是多一处泄露面）
    src = _inspect.getsource(auth.feishu_start)
    ok('if not is_web:\n        out["claim_secret"]' in src,
       "start 只在 desktop 模式返回 claim_secret")

    print("\n【4】S2 登出只能吊销自己（主体取自 Authorization 头）")
    tok_a = auth._issue_session({"id": -101, "username": "_probe_a"})["token"]
    tok_b = auth._issue_session({"id": -102, "username": "_probe_b"})["token"]
    try:
        ok(auth.verify_session(tok_a) is not None
           and auth.verify_session(tok_b) is not None,
           "两个一次性探测会话都已生效")
        # 用 A 的身份、请求体里写 B 的 token
        r = c.post("/v2/auth/logout", json={"token": tok_b},
                   headers={"Authorization": f"Bearer {tok_a}"})
        ok(r.status_code == 403, f"拿 A 的身份吊销 B → {r.status_code}（应 403）")
        ok(auth.verify_session(tok_b) is not None, "B 的会话仍然有效（没被踢下线）")
        # 不带 Authorization
        r = c.post("/v2/auth/logout", json={"token": tok_b})
        ok(r.status_code == 401, f"不带 Authorization 的登出 → {r.status_code}（应 401）")
        ok(auth.verify_session(tok_b) is not None, "B 的会话依旧有效")
        # 正常登出自己（body 带自己的 token，兼容既有客户端）
        r = c.post("/v2/auth/logout", json={"token": tok_a},
                   headers={"Authorization": f"Bearer {tok_a}"})
        ok(r.status_code == 200 and auth.verify_session(tok_a) is None,
           f"吊销自己 → {r.status_code} 且会话立即失效")
        # 空 body 也能登出自己（新前端就是这么发的）
        r = c.post("/v2/auth/logout", json={},
                   headers={"Authorization": f"Bearer {tok_b}"})
        ok(r.status_code == 200 and auth.verify_session(tok_b) is None,
           f"空请求体 + Bearer 自己 → {r.status_code} 且会话失效")
    finally:
        # 无条件清场：探测会话绝不允许留在库里
        auth.revoke_session(tok_a)
        auth.revoke_session(tok_b)
        with get_session() as s:
            s.query(auth.AuthSession).filter(
                auth.AuthSession.user_id.in_([-101, -102])).delete(
                    synchronize_session=False)
            s.commit()

    print("\n【5】S3 会话 token 以 sha256 落库，明文只回客户端一次")
    tok = auth._issue_session({"id": -103, "username": "_probe_hash"})["token"]
    try:
        digest = hashlib.sha256(tok.encode()).hexdigest()
        with get_session() as s:
            row_plain = s.get(auth.AuthSession, tok)
            row_hash = s.get(auth.AuthSession, digest)
        ok(row_plain is None, "库里查不到明文 token（主键不是它）")
        ok(row_hash is not None, "库里存的是它的 sha256 摘要")
        ok(auth.verify_session(tok) is not None, "客户端拿明文 token 仍能通过校验")
        ok(auth.verify_session(digest) is None,
           "拿库里那串摘要**当不了**令牌（拖库即用被堵死）")
    finally:
        auth.revoke_session(tok)

    # 全库形状：所有在用会话的 token 都该是 64 位小写十六进制
    with get_session() as s:
        all_tok = [t for (t,) in s.query(auth.AuthSession.token).all()]
    bad = [t for t in all_tok if not re.fullmatch(r"[0-9a-f]{64}", t or "")]
    ok(not bad, f"库内 {len(all_tok)} 条会话全为 64 位小写十六进制"
                f"（异常 {len(bad)} 条）")

    print("\n【6】S3 /me 不再接受 ?token= 兜底")
    ok("token" not in _inspect.signature(auth.me).parameters,
       "/me 的签名里没有 token 参数（只剩 request）")
    tok = auth._issue_session({"id": -104, "username": "_probe_me"})["token"]
    try:
        r = c.get(f"/v2/auth/me?token={tok}")
        ok(r.status_code == 401, f"只用 ?token= 访问 /me → {r.status_code}（应 401）")
        r = c.get("/v2/auth/me", headers={"Authorization": f"Bearer {tok}"})
        ok(r.status_code == 200, f"带 Bearer 头访问 /me → {r.status_code}（应 200）")
    finally:
        auth.revoke_session(tok)

    print("\n【7】S5 放行清单精确匹配，不再 startswith")
    from app import main as app_main
    ok("_OPEN_PREFIXES" not in _inspect.getsource(app_main.create_app),
       "旧的 _OPEN_PREFIXES + startswith 写法已不存在")
    # 中间件只在 FW_AUTH_UPSTREAM 配置时装；dev 有配，所以这几条测得成
    from app.config import get_settings
    if not get_settings().auth_upstream:
        print("  ·  本环境未配 FW_AUTH_UPSTREAM，鉴权中间件未装载，跳过路径断言")
    else:
        # ⚠️ 这个中间件**只管 `/v2` 开头的路径**（`or not path.startswith("/v2")`
        # 直接放行其余一切）。所以 S5 那个 `startswith` 漏洞的真实暴露面只在
        # `/v2/auth*` 与 `/v2/app/latest*` —— `/mediaXXX`、`/healthz` 本来就不
        # 经鉴权，它们的正确结果是 404（没这条路由）而不是 401。
        # 文档 S5「验证」原写 `/healthz` 应得 401，那是误判，已在文档里更正。
        for path, want in (("/health", 200), ("/healthz", 404),
                           ("/v2/app/latest", 200),
                           # 最锋利的一条：修复前 startswith 会把它当公开路由
                           # 放行（于是 404），修复后必须被鉴权挡下（401）。
                           ("/v2/app/latestXYZ", 401),
                           ("/v2/projects", 401),
                           ("/v2/authorize", 401), ("/v2/auth/me", 401)):
            r = c.get(path)
            ok(r.status_code == want, f"GET {path} → {r.status_code}（应 {want}）")
        r = c.get("/mediax/whatever")
        ok(r.status_code == 404,
           f"GET /mediax/whatever → {r.status_code}"
           "（非 /v2 前缀，鉴权中间件本来就不管，404 = 没这条路由）")

    print(f"\n认证探针：{_pass} ✅ / {_fail} ❌")
    if _fail:
        print("\n❌ 认证链路有断言不过 —— 别上线，先看上面第一条 ❌。")
        return 1
    print("\n✅ 取号必须 ticket+claim_secret 且一次性、w- 票据不走 poll、"
          "换 IP 取不走号；登出只能吊销自己；会话 token 以 sha256 落库且"
          "库里那串当不了令牌；/me 只认 Bearer；放行清单不再被"
          "「名字以放行项开头」的路径蹭过。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
