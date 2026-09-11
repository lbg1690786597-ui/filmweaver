"""登录认证（复用主平台用户体系，需求定稿 11.2）。

架构：FW 不建用户表、不碰密码哈希——身份一律来自主平台
（dev=drama-dev:8001；未来上线 prod 改 FW_AUTH_UPSTREAM 即可，用户数据自动对应）。
校验成功后 FW 自签会话 token 落 SQLite（重启不丢），中间件按会话校验。

启用开关：FW_AUTH_UPSTREAM 设置即启用登录；不设置保持开放（dev 默认）。
放行清单（防"无法登录→无法更新"死循环）：/health、/v2/auth/*、/v2/app/latest、/media 静态。

## 登录方式：只有飞书扫码（2026-08 起）

账号密码登录已**移除**（前端入口与后端接口一并删除），与剧本平台看齐。
织影没有生产环境，不存在存量用户迁移问题。

⚠️ 已装 v0.7.6 及更早版本的客户端只会调 `POST /v2/auth/login`，
该接口删除后它们会登录失败——这是用户明确确认过的取舍（"立刻删掉"）。
旧客户端仍可用登录页右下角的「⟳ 检查更新」升级到新版（那是刻意保留的逃生门）。

## 桌面端飞书登录为什么要绕一圈

飞书只认**已登记**的重定向 URL，而桌面应用没有 URL 可以接住回调。
所以链路是：

    桌面端 → POST /v2/auth/feishu/start        取 authorize_url + ticket
           → 用系统浏览器打开 authorize_url     用户扫码
    飞书   → GET  /v2/auth/feishu/callback     （已在飞书后台登记本地址）
           → 织影后端拿 code 去上游换身份 → 签发会话 → 存进 ticket
    桌面端 → GET  /v2/auth/feishu/poll         轮询取回会话 token

**凭据不落织影**：换 code 需要 app_secret，织影不复制它，而是把 code 交给上游
`/v1/auth/feishu/callback`（以非浏览器身份调用，它会返回 JSON）。
密钥只存在剧本平台一处，轮换时不必两边改，也少一处泄露面。

## 票据为什么要配一个 claim_secret（2026-09-11 修 S2）

上面这条链路里，**受害者扫的二维码只认 state，而 ticket 就编在 state 里**。
于是原实现有一条不需要猜任何随机串的劫持路径：

    攻击者自己 POST /feishu/start  → 拿到 {ticket, authorize_url}
    把 authorize_url 发给受害者   → 受害者扫码、授权（他看到的一切都是真的）
    飞书回调                      → **受害者的会话被投进攻击者手里的那张 ticket**
    攻击者 GET /feishu/poll       → 取走令牌，以受害者身份访问全部项目

病根是"谁发起的"和"谁能取走"之间没有任何绑定 —— poll 只要 ticket，而 ticket
必然要经过受害者的浏览器。修法是再发一个**只回给发起方、绝不进 state**
的随机串 `claim_secret`：受害者链路里全程不出现它，poll 必须同时出示
ticket + claim_secret。攻击者仍能让受害者扫码，但取不走结果。

`claim_secret` 走 **`X-FW-Claim` 请求头**而不是 query —— query 会进 nginx
access log，而 ticket 本来就在 query 里，两个都落日志的话拿到日志就等于
拿到会话，这道锁就白加了。
"""
from __future__ import annotations

import hashlib
import logging
import secrets
import time
from datetime import datetime, timedelta, timezone

import httpx
from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from pydantic import BaseModel
from sqlalchemy import String
from sqlalchemy.orm import Mapped, mapped_column
from urllib.parse import quote

from .config import get_settings
from .db import Base, get_session

log = logging.getLogger(__name__)

SESSION_TTL = timedelta(days=7)

#: 桌面端取号票据的存活时间。用户要在浏览器里完成扫码，给足 10 分钟；
#: 超时后 ticket 作废，桌面端会提示重新发起。
_TICKET_TTL = 600.0

#: ticket -> {"created": epoch, "result": None | {...}, "claim": str, "ip": str}
#: 进程内内存态即可：ticket 只在"发起登录→扫完码"这几分钟内有意义，
#: 后端重启时本来也没有正在进行的登录流程，落库反而要额外清理。
#: `claim` 是只回给发起方的取号密钥（见模块 docstring 的 S2 一节），
#: `ip` 是发起时的调用方 IP（纵深，不是唯一防线）。
_TICKETS: dict[str, dict] = {}


def _gc_tickets() -> None:
    """清掉过期票据，防长跑进程内存无界增长。"""
    now = time.time()
    for k in [k for k, v in _TICKETS.items() if now - v["created"] > _TICKET_TTL]:
        _TICKETS.pop(k, None)


def _client_ip(request: Request) -> str:
    """取调用方 IP（票据绑定用的纵深信号）。

    nginx 的 `/fw/` 块写的是 `proxy_set_header X-Real-IP $remote_addr` ——
    **覆盖**而非追加，所以经 nginx 进来的请求这个头不可被客户端伪造。
    直连 8002 的（只有本机可达）落到 `request.client`。

    ⚠️ 只用来比"start 与 poll 是否同一来源"，**不作为唯一防线** ——
    真正拦住劫持的是 `claim_secret`。桌面端与系统浏览器是两个进程，
    出口 IP 通常一致但 UA 必然不同，所以**只比 IP，不比 UA**。
    """
    xr = (request.headers.get("X-Real-IP") or "").strip()
    if xr:
        return xr
    xff = (request.headers.get("X-Forwarded-For") or "").split(",")[0].strip()
    if xff:
        return xff
    return (request.client.host if request.client else "") or ""


def _hash_token(token: str) -> str:
    """会话 token 的落库形态：sha256 十六进制（64 字符）。

    为什么不明文存（S3 的无争议项）：库文件、备份、任何一次误贴的 SELECT
    结果都等于一批可直接使用的 7 天有效会话。哈希后库里那串**不能**当令牌用，
    而校验只需把来访 token 哈希一次再查主键，成本与明文查完全一样。

    不加盐、不用 PBKDF2 是刻意的：token 本身是 `token_urlsafe(32)`（256 bit
    真随机），不存在字典/彩虹表攻击面，慢哈希只会给每个请求凭空加延迟。
    """
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


class AuthSession(Base):
    """FW 会话：token 随机生成，与主平台 JWT 解耦（不共享对方密钥）。

    ⚠️ `token` 列存的是 **sha256 十六进制摘要**，不是令牌本身（见 `_hash_token`）。
    所以这张表里的任何一行都**不能**被拿去当凭据用；反过来，也无法从库里
    捞回某个用户的 token（只能吊销）。
    """

    __tablename__ = "auth_sessions"

    token: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[int] = mapped_column()
    username: Mapped[str] = mapped_column(String(64))
    display_name: Mapped[str | None] = mapped_column(String(64), nullable=True)
    role: Mapped[str] = mapped_column(String(16), default="user")
    expires_at: Mapped[str] = mapped_column(String(32))  # ISO UTC


router = APIRouter(prefix="/v2/auth", tags=["auth"])


def _upstream() -> str:
    up = (get_settings().auth_upstream or "").rstrip("/")
    if not up:
        raise HTTPException(status_code=400,
                            detail="后端未启用登录（FW_AUTH_UPSTREAM 未配置）")
    return up


def _issue_session(user: dict) -> dict:
    """按上游返回的用户信息签发 FW 会话。登录链路的唯一签发口。

    明文 token 只在本函数的返回值里出现一次（交给调用方发给客户端），
    库里落的是它的 sha256（见 `_hash_token`）。
    """
    if (user.get("status") or "active") != "active":
        raise HTTPException(status_code=403, detail="账号已被禁用，请联系管理员")
    token = secrets.token_urlsafe(32)
    expires = datetime.now(timezone.utc) + SESSION_TTL
    with get_session() as session:
        session.add(AuthSession(
            token=_hash_token(token), user_id=int(user.get("id") or 0),
            username=user.get("username") or "",
            display_name=user.get("display_name"),
            role=user.get("role") or "user",
            expires_at=expires.isoformat(timespec="seconds"),
        ))
        session.commit()
    return {
        "token": token,
        "expires_at": expires.isoformat(timespec="seconds"),
        "user": {"id": user.get("id"), "username": user.get("username"),
                 "display_name": user.get("display_name"), "role": user.get("role")},
    }


def _callback_url() -> str:
    """本服务的飞书回调地址，必须与飞书后台登记的**完全一致**。

    用户已在飞书后台登记：
        http://118.196.33.51:9080/fw/v2/auth/feishu/callback
    """
    base = (get_settings().feishu_callback_base or "").rstrip("/")
    return f"{base}/v2/auth/feishu/callback"


@router.post("/feishu/start")
async def feishu_start(request: Request, mode: str = "desktop") -> dict:
    """发起飞书登录：向上游取授权 URL，并签发一张取号票据。

    `redirect_uri` 传的是**织影自己的** callback——上游 `login-url` 支持覆盖，
    而 state 仍由上游签发，回调时它自己能校验通过。

    ⚠️ 关键：飞书回调时只会带 `code` 和 `state`（OAuth2 标准参数），
    不可能带我们自己加的 `ticket`。所以把 ticket **编码进 state** 一起签发，
    回调时从 state 解出来。格式：`{上游state}.{mode标记}{ticket}`。

    ⚠️ 正因为 ticket 必然经过**扫码那个人**的浏览器，它不能是取号的唯一凭据。
    桌面端模式额外返回 `claim_secret`：它只出现在本次响应里，**不进 state、
    不进授权 URL**，`poll` 必须用 `X-FW-Claim` 头带上它（详见模块 docstring）。
    网页端不返回 —— 它压根不走 poll（见 `_finish`），多发一个密钥只是多一处泄露面。

    `mode` 决定回调怎么收尾（两种客户端的形态完全不同）：
      desktop — 浏览器与应用是**两个窗口**，回调只能显示一张"可以回去了"的
                落地页，会话投进 ticket 等桌面端轮询取走
      web     — 授权前后是**同一个标签页**，回调应当直接 302 回应用并带上会话，
                用户眼里就是"扫完码就进来了"。多一张落地页纯属打断
    """
    _gc_tickets()
    up = _upstream()
    is_web = mode == "web"
    # 票据带 mode 前缀：飞书只回传 state，回调时得从里面认出客户端形态
    ticket = ("w-" if is_web else "d-") + secrets.token_urlsafe(24)
    # 取号密钥：与 ticket 同强度，但**只回给本次调用方**，绝不进 state / 授权 URL
    claim_secret = secrets.token_urlsafe(24)
    try:
        # 先取上游 authorize_url，从中提取 state
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(
                f"{up}/v1/auth/feishu/login-url",
                params={"redirect_uri": _callback_url(), "purpose": "auto_login"})
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"认证服务不可达: {e!r}")
    if resp.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail=f"取授权地址失败 HTTP {resp.status_code}: {resp.text[:120]}")
    url = (resp.json() or {}).get("authorize_url")
    if not url:
        raise HTTPException(status_code=502, detail="上游未返回 authorize_url")

    # 从 authorize_url 提取 state，拼上 ticket
    try:
        from urllib.parse import parse_qs, urlparse, urlencode, urlunparse
        u = urlparse(url)
        q = parse_qs(u.query)
        upstream_state = (q.get("state") or [""])[0]
        if not upstream_state:
            raise ValueError("上游 state 为空")
        combined_state = f"{upstream_state}.{ticket}"
        q["state"] = [combined_state]
        new_url = urlunparse((u.scheme, u.netloc, u.path,
                              u.params, urlencode(q, doseq=True), u.fragment))
    except Exception as e:  # noqa: BLE001
        log.warning("[feishu] 改写 state 失败: %r", e)
        raise HTTPException(status_code=500, detail="内部状态拼接失败")

    _TICKETS[ticket] = {"created": time.time(), "result": None,
                        "claim": claim_secret, "ip": _client_ip(request)}
    out = {"ticket": ticket, "authorize_url": new_url}
    if not is_web:
        out["claim_secret"] = claim_secret
    return out


def _done_page(title: str, msg: str, ok: bool) -> HTMLResponse:
    """回调落地页。用户是在系统浏览器里看到这一页的，所以要能自解释。"""
    color = "#16a34a" if ok else "#dc2626"
    icon = "✓" if ok else "✕"
    return HTMLResponse(
        "<!doctype html><meta charset='utf-8'>"
        "<meta name='viewport' content='width=device-width,initial-scale=1'>"
        f"<title>{title}</title>"
        "<div style=\"font-family:system-ui,-apple-system,'Segoe UI',sans-serif;"
        "display:flex;align-items:center;justify-content:center;height:100vh;"
        "margin:0;background:#0b0d10;color:#e5e7eb\">"
        "<div style='text-align:center;max-width:420px;padding:32px'>"
        f"<div style='font-size:48px;color:{color};line-height:1'>{icon}</div>"
        f"<h2 style='margin:16px 0 8px;font-weight:600'>{title}</h2>"
        f"<p style='margin:0;color:#9ca3af;line-height:1.6'>{msg}</p>"
        "</div></div>")


def _web_app_url() -> str:
    """网页端应用地址（回调后 302 回这里）。"""
    return f"{(get_settings().feishu_callback_base or '').rstrip('/')}/app/"


def _finish(ticket: str, ok: bool, title: str, msg: str,
            frag: str = "") -> HTMLResponse | RedirectResponse:
    """回调收尾：按客户端形态选择"落地页"还是"跳回应用"。

    网页端（ticket 以 `w-` 开头）：授权前后是同一个标签页，直接 302 回
    `/fw/app/`，把结果放 **fragment**（`#` 后的内容不发给服务器，
    因此不进 nginx access log、也不带进 Referer——与剧本平台落地页同理）。
    用户眼里就是"扫完码就进来了"，不再多一张要手动关掉的页。

    桌面端：浏览器与应用是两个窗口，只能显示落地页告诉用户可以回去了。
    """
    if ticket.startswith("w-"):
        sep = "#" + (frag if ok else f"error={quote(msg)}")
        return RedirectResponse(_web_app_url() + sep, status_code=302)
    return _done_page(title, msg, ok)


@router.get("/feishu/callback", response_model=None)
async def feishu_callback(code: str = "",
                          state: str = "") -> HTMLResponse | RedirectResponse:
    """飞书授权回调（浏览器跳转到这里）。

    拿 code 去上游换身份——**不在本服务换**，因为换 code 需要 app_secret，
    而那个密钥只应存在剧本平台一处（少一处泄露面，轮换时也不必两边改）。
    上游 callback 在非浏览器调用时返回 JSON，正好可当作服务端接口用。

    `state` 是 `feishu_start` 拼的 `{上游state}.{ticket}`——飞书原样带回来。
    这里拆开：上游那半交还给上游校验，ticket 那半用来投递会话。

    收尾分两种（见 `_finish`）：桌面端显示落地页等轮询，网页端直接 302 回应用。
    """
    _gc_tickets()
    # 先拆 state 拿 ticket：后面所有分支的收尾方式都取决于它
    upstream_state, _, ticket = state.rpartition(".")
    if not upstream_state:
        # 没拼过的 state（例如有人直接访问回调地址）：无 ticket 可投递
        upstream_state, ticket = state, ""

    if not code:
        return _finish(ticket, False, "授权未完成",
                       "没有收到授权码，可能是取消了授权。请重新发起登录。")

    item = _TICKETS.get(ticket) if ticket else None
    if ticket and item is None:
        return _finish(ticket, False, "登录已超时",
                       "这次登录请求已过期（超过 10 分钟），请重新发起登录。")

    up = _upstream()
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            # 不带 Accept: text/html —— 上游据此返回 JSON 而不是 302
            resp = await client.get(f"{up}/v1/auth/feishu/callback",
                                    params={"code": code, "state": upstream_state},
                                    headers={"Accept": "application/json"})
    except Exception as e:  # noqa: BLE001
        log.warning("[feishu] 上游换取身份失败: %r", e)
        return _finish(ticket, False, "登录失败", "认证服务暂时不可达，请稍后重试。")

    if resp.status_code != 200:
        log.warning("[feishu] 上游返回 %s: %s", resp.status_code, resp.text[:200])
        detail = ""
        try:
            detail = (resp.json() or {}).get("detail") or ""
        except ValueError:
            pass
        return _finish(ticket, False, "登录失败",
                       detail or f"认证服务返回 HTTP {resp.status_code}。")

    data = resp.json() or {}
    user = data.get("user") or {}
    if not user:
        # 上游登录成功但没带 user（例如返回的是 link 流程）——用 access_token 兜底查一次
        jwt = data.get("access_token") or ""
        if jwt:
            try:
                async with httpx.AsyncClient(timeout=15.0) as client:
                    me_resp = await client.get(
                        f"{up}/v1/auth/me",
                        headers={"Authorization": f"Bearer {jwt}"})
                if me_resp.status_code == 200:
                    user = me_resp.json() or {}
            except Exception as e:  # noqa: BLE001
                log.warning("[feishu] 回查用户信息失败: %r", e)
    if not user:
        return _finish(ticket, False, "登录失败", "认证服务未返回用户信息。")

    try:
        issued = _issue_session(user)
    except HTTPException as e:
        return _finish(ticket, False, "登录被拒绝", str(e.detail))

    if item is None:
        # 没带 ticket（例如用户直接访问回调地址）：会话已签发但无处投递。
        # 明确告知，而不是让用户对着一个"成功"页干等。
        log.info("[feishu] 回调未带 ticket，会话已签发但无处投递")
        return _finish(ticket, False, "登录成功",
                       "但这次请求缺少票据，织影无法自动接收。请重新发起一次登录。")

    item["result"] = issued
    name = user.get("display_name") or user.get("username") or "你"
    # 网页端：会话直接放 fragment 带回应用，用户无需再看任何中间页。
    # 桌面端：会话留在 ticket 里等轮询，这里只显示"可以回去了"。
    return _finish(ticket, True, "登录成功",
                   f"欢迎，{name}。可以关掉这个页面，回到织影了。",
                   frag=f"token={quote(issued['token'])}")


@router.get("/feishu/poll")
def feishu_poll(request: Request, ticket: str = "",
                x_fw_claim: str = Header("")) -> dict:
    """桌面端轮询取会话。

    取号要两样东西：query 里的 `ticket` + `X-FW-Claim` 头里的 `claim_secret`。
    后者只在 `start` 的响应里出现过一次，**不曾经过扫码那个人的浏览器**，
    所以"把授权链接发给别人扫"拿不到会话（S2）。

    `status`：
      pending — 用户还没扫完码
      ok      — 已签发，`token`/`user` 可用（**取走即销毁**，票据不复用）
      expired — 票据过期或不存在

    校验不过一律 **403**（不是 401）：401 会被前端的会话拦截逻辑当成"登录过期"
    而弹登录页，可这里本来就在登录流程里，那样只会转圈。
    """
    _gc_tickets()
    # 网页端票据根本不经 poll：回调直接 302 回 `/fw/app/#token=`（见 `_finish`）。
    # 它没有 claim_secret，若允许 poll 就等于给劫持留了一条没有锁的门。
    if ticket.startswith("w-"):
        raise HTTPException(status_code=403,
                            detail="网页端登录不经轮询取号")
    item = _TICKETS.get(ticket) if ticket else None
    if item is None:
        return {"status": "expired"}
    # compare_digest 而非 `!=`：取号密钥是可被反复试探的短命秘密，
    # 顺手消掉时序侧信道，成本为零。
    if not (x_fw_claim and secrets.compare_digest(x_fw_claim, item["claim"])):
        log.warning("[feishu] poll 取号密钥不匹配，已拒绝（ticket 前 4 位 %s…）",
                    ticket[:4])
        raise HTTPException(status_code=403, detail="取号密钥不匹配，请重新发起登录")
    # IP 纵深：start 与 poll 应当来自同一个客户端。不匹配就拒绝并要求重发起 ——
    # 换网络（如切 Wi-Fi）会命中这一条，代价是重扫一次码，可接受。
    now_ip = _client_ip(request)
    if item["ip"] and now_ip and now_ip != item["ip"]:
        log.warning("[feishu] poll 来源 IP 与发起时不一致，已拒绝")
        raise HTTPException(status_code=403, detail="登录来源已变化，请重新发起登录")
    if item["result"] is None:
        return {"status": "pending"}
    _TICKETS.pop(ticket, None)      # 一次性：取走就作废
    return {"status": "ok", **item["result"]}


class LogoutIn(BaseModel):
    """登出请求体。

    `token` 保留是为了兼容既有客户端（它们会带上自己的 token），但现在
    **只允许等于调用方自己的 token** —— 谁是调用方由 `Authorization` 头决定。
    """

    token: str = ""


@router.post("/logout")
def logout_route(request: Request, body: LogoutIn | None = None) -> dict:
    """显式吊销会话（数据安全：登出即失效，而非仅前端丢弃）。

    ⚠️ 只能吊销**自己**的会话（S2 同类问题）：原实现直接 revoke 请求体里的
    token，只校验"这 token 是真的"、不校验"调用者是它的主人" —— 任何拿到
    他人 token 的人都能把对方踢下线。现在主体一律取自 `Authorization: Bearer`，
    请求体里的 token 只做一致性校验，不一致直接 403。

    对无效/过期 token 返回 `ok` 而不是报错：登出是幂等动作，会话已经没了
    也算达到目的；报错只会让前端在"会话刚过期时点登出"这种常见情形里卡住。
    """
    authz = request.headers.get("Authorization", "")
    mine = authz[7:] if authz.startswith("Bearer ") else ""
    if not mine:
        raise HTTPException(status_code=401,
                            detail="登出需带 Authorization: Bearer <会话token>")
    claimed = (body.token if body else "") or ""
    if claimed and not secrets.compare_digest(claimed, mine):
        raise HTTPException(status_code=403, detail="只能吊销自己的会话")
    revoke_session(mine)
    return {"ok": True}


@router.get("/me")
def me(request: Request) -> dict:
    """会话查询（前端恢复现场用）。

    只认 `Authorization: Bearer <token>`。原来还兜底读 `?token=` query 参数，
    已于 2026-09-11 删掉（S3）：query 会进 nginx access log 与浏览器历史，
    而这里传的正是 7 天有效的会话令牌 —— 一条日志行就是一次可重放的登录。
    前端 `api.authMe()` 早已只走 header，删除不影响任何在用客户端。
    """
    authz = request.headers.get("Authorization", "")
    token = authz[7:] if authz.startswith("Bearer ") else ""
    info = verify_session(token)
    if not info:
        raise HTTPException(status_code=401, detail="会话无效或已过期")
    return {"user": info}


def verify_session(token: str) -> dict | None:
    """校验会话 token；有效返回用户信息，无效返回 None。

    入参是**明文** token（来自 Authorization 头），查库前哈希一次 ——
    库里存的是摘要，见 `_hash_token`。
    """
    if not token:
        return None
    with get_session() as session:
        s = session.get(AuthSession, _hash_token(token))
        if not s:
            return None
        try:
            exp = datetime.fromisoformat(s.expires_at)
        except ValueError:
            return None
        if exp < datetime.now(timezone.utc):
            session.delete(s)
            session.commit()
            return None
        return {"id": s.user_id, "username": s.username,
                "display_name": s.display_name, "role": s.role}


def revoke_session(token: str) -> None:
    """吊销一个会话。入参是明文 token（库里按摘要存）。"""
    with get_session() as session:
        s = session.get(AuthSession, _hash_token(token))
        if s:
            session.delete(s)
            session.commit()


def cleanup_expired_sessions() -> int:
    """启动时清过期会话（维护任务）。"""
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with get_session() as session:
        n = (session.query(AuthSession)
             .filter(AuthSession.expires_at < now).delete())
        session.commit()
        return n
