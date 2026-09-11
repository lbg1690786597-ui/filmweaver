"""FilmWeaver 后端入口（dev）。云端隐形生成后端，供 Tauri 桌面客户端调用。"""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .auth import cleanup_expired_sessions, router as auth_router, verify_session
from .config import get_settings
from .db import init_db
from .maintenance import (SWEEP_INTERVAL_SEC, backup_sqlite,
                          recover_zombie_tasks, sweep_orphaned_states)
from .media import DATA_DIR, router as media_router
from .migrations import run_migrations
from .providers.registry import register_defaults, registry
from .routes_v2 import router as v2_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    # 数据安全：备份必须在 run_migrations() **之前**。
    # 原来顺序相反 —— 迁移若损坏数据，备份快照的是已损坏的库，
    # 等于没有可回滚的点，而这正是最需要备份的场景。
    # （backup_sqlite 内部按分钟防抖，崩溃循环不会把历史备份冲掉。）
    bak = backup_sqlite()
    if bak:
        print(f"[backup] {bak}")
    applied = run_migrations()
    if applied:
        print(f"[migrations] applied: {applied}")
    # 易用性：清理上次进程遗留的僵尸任务/卡态镜头/卡态旁白（否则看板永远转圈）
    z = recover_zombie_tasks()
    if z["jobs"] or z["shots"] or z["audio"]:
        print(f"[recover] 置 failed: {z['jobs']} jobs, {z['shots']} shots, "
              f"{z['audio']} audio")
    n = cleanup_expired_sessions()
    if n:
        print(f"[auth] 清理过期会话: {n}")
    register_defaults()
    _selfcheck_imports()
    # B14：启动清一次盖不住"进程不重启但 runner 半途丢了"的情况，
    # 挂一个常驻巡检把孤儿瞬时态收回来（判据见 sweep_orphaned_states）。
    sweeper = asyncio.create_task(_sweep_loop())
    try:
        yield
    finally:
        sweeper.cancel()
        # 等它真的退出，避免关停时留下 "Task was destroyed but it is pending"
        try:
            await sweeper
        except asyncio.CancelledError:
            pass


async def _sweep_loop() -> None:
    """孤儿瞬时态常驻巡检。单次异常不能让循环死掉——否则后面永远不再巡检。"""
    while True:
        try:
            await asyncio.sleep(SWEEP_INTERVAL_SEC)
            await asyncio.to_thread(sweep_orphaned_states)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            logging.getLogger(__name__).exception("[sweep] 本轮巡检失败，继续下一轮")


def _selfcheck_imports() -> None:
    """启动自检：把生成链路会用到的模块**真的导一遍**。

    为什么需要：jobs.py 里漏了一个 `from .db import AssetStage`，语法检查
    过、服务也起得来，直到用户点生成、执行到那一行才 NameError——任务卡在
    0% 39 分钟，进度条一直转，看不出哪里坏了。

    Python 的惰性求值让这类错误只在运行到那一行时才暴露。启动时主动引用
    一遍关键符号，坏了就在日志里立刻喊出来，而不是等用户踩。
    """
    try:
        from . import jobs
        # 逐个点名：只 import 模块不够，模块级 import 缺失才是要抓的那类
        for name in ("AssetStage", "to_public_url", "_to_trusted_assets",
                     "_auto_inject_refs_detailed", "run_shot_videos"):
            if not hasattr(jobs, name):
                print(f"[selfcheck] ❌ jobs.{name} 不存在——生成链路会在运行时炸")
    except Exception as e:  # noqa: BLE001
        print(f"[selfcheck] ❌ jobs 模块导入失败: {e!r}")


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title="FilmWeaver Backend", version="0.1.0", lifespan=lifespan)

    # Tauri 桌面客户端从本地 WebView 发起请求，Origin 是 `tauri://localhost`
    # （Windows WebView2 上是 `https://tauri.localhost`）；网页端则是本站地址。
    #
    # ⚠️ 这里原本是 `["*"] if env == "dev" else []` —— prod 下等于**一个来源都不放行**，
    # 桌面客户端每个请求都被 WebView 的 CORS 拦掉，表现为"连不上后端服务，
    # 正在每 15 秒重试"，而后端 /health 明明返回 200（实测 2026-08-28
    # 正式版首发即栽在这，dev 侥幸没事只因它走 env == "dev" 那条分支）。
    # prod 收紧是对的，但不能收成空集：要显式列出**合法的客户端来源**。
    _origins = ["*"] if settings.env == "dev" else [
        "tauri://localhost",          # Tauri WebView（Linux/macOS）
        "https://tauri.localhost",    # Tauri WebView（Windows WebView2）
        "http://tauri.localhost",
        settings.public_base_url,     # 网页端
        settings.feishu_callback_base.rsplit("/", 1)[0] if settings.feishu_callback_base else "",
    ]
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[o for o in _origins if o],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # 登录体系（FW_AUTH_UPSTREAM 设置即启用，复用主平台用户数据）：
    # /v2 全部接口需带 Authorization: Bearer <会话token>。
    # 放行清单（防"无法登录→无法更新"死循环）：/health、/v2/auth/*、
    # /v2/app/latest（检查更新）、/media（预览与更新包下载不经此后端）。
    if settings.auth_upstream:
        from starlette.requests import Request as _Req
        from starlette.responses import JSONResponse as _JR

        #: 放行的**精确**路径：必须一字不差才放行。
        _OPEN_PATHS = ("/health", "/v2/app/latest")
        #: 放行的**子树**：前缀本身或 `前缀 + "/"` 开头才放行。
        _OPEN_TREES = ("/v2/auth", "/media")

        def _is_open(path: str) -> bool:
            """公开路由判定。

            ⚠️ 2026-09-11（S5）之前这里是 `any(path.startswith(x) for x in ...)`，
            于是 `/mediaXXX`、`/healthz`、`/v2/authorize` 这类**名字以放行项开头
            的新路由会自动免鉴权**。当时恰好没有这种路由，属埋雷：半年后谁加一个
            `/v2/auth_admin`，它就默默对全公网开放，而且没有任何报错。
            改成"精确匹配 或 子树匹配"后，只有真正的 `/media` 与 `/media/...`
            放行，`/mediax` 不放行。
            """
            return path in _OPEN_PATHS or any(
                path == t or path.startswith(t + "/") for t in _OPEN_TREES)

        @app.middleware("http")
        async def session_guard(request: _Req, call_next):
            path = request.url.path
            if (request.method == "OPTIONS"
                    or _is_open(path)
                    or not path.startswith("/v2")):
                return await call_next(request)
            authz = request.headers.get("Authorization", "")
            token = authz[7:] if authz.startswith("Bearer ") else ""
            if not verify_session(token):
                return _JR({"detail": "未登录或会话已过期"}, status_code=401)
            return await call_next(request)

    # 可选 API Token（数据安全）：FW_API_TOKEN 设置即启用，对写操作校验；
    # 未设置保持 dev 开放，不破坏易用性。GET/health/media 静态放行（预览需要）。
    if settings.api_token:
        from starlette.requests import Request
        from starlette.responses import JSONResponse

        @app.middleware("http")
        async def token_guard(request: Request, call_next):
            if (request.method not in ("GET", "HEAD", "OPTIONS")
                    and request.url.path.startswith("/v2")
                    and request.headers.get("X-FW-Token") != settings.api_token):
                return JSONResponse({"detail": "无效或缺失 X-FW-Token"}, status_code=401)
            return await call_next(request)

    @app.get("/health")
    def health() -> dict:
        # llm_channels / image_channels：文本与图像的渠道兜底链
        # （只报渠道名与冷却状态，不含任何 key）。
        # 排障用：拆解/优化/生图全失败时先看这里是不是只剩一条、或全在冷却。
        from .providers.llm import _healthy, build_channels
        from .providers.image import _healthy as _img_healthy
        from .providers.image import channel_names
        chans = build_channels(settings.llm_model, settings)
        return {
            "status": "ok",
            "env": settings.env,
            "video_providers": len(registry.list_video()),
            "auth": "token" if settings.api_token else "open",
            "login": bool(settings.auth_upstream),  # 前端据此显示登录页
            "llm_model": settings.llm_model,
            "llm_channels": [
                {"name": c.name,
                 "cooling_down": not _healthy(c.name, settings.llm_model)}
                for c in chans
            ],
            "image_model": settings.image_model,
            # 图像侧无并发上限（0=不限），健壮性靠渠道冷却 + 抖动退避重试
            "image_concurrency": settings.image_concurrency,
            "image_channels": [
                {"name": n,
                 "cooling_down": not _img_healthy(n, settings.image_model)}
                for n in channel_names(settings.image_model)
            ],
        }

    app.include_router(v2_router)
    app.include_router(auth_router)
    app.include_router(media_router)
    # 素材/成片静态访问：/media/uploads/... /media/outputs/...
    app.mount("/media", StaticFiles(directory=str(DATA_DIR)), name="media")

    # 网页预览通道（dev 提效）：desktop 的 vite 构建产物挂在 /app，
    # 浏览器访问 http://<host>/fw/app/ 即可秒级预览最新 UI，无需打包 Windows 安装包。
    # Tauri 专属能力（更新器/sidecar 本机渲染）在浏览器中自动降级（代码已有 catch/云端兜底）。
    web_dir = DATA_DIR / "webapp"
    if web_dir.is_dir():
        app.mount("/app", StaticFiles(directory=str(web_dir), html=True),
                  name="webapp")

        @app.middleware("http")
        async def _no_cache_webapp_html(request, call_next):
            """给 /fw/app/ 的 HTML 加 no-cache。

            StaticFiles 默认只发 etag/last-modified，不发 Cache-Control，
            浏览器于是对 index.html 用**启发式缓存**——发布了新版本，
            用户（甚至 Ctrl+F5）仍可能拿旧 html，它引用的还是旧 hash 的
            js/css，看起来就是"改了没生效"。实际踩过这个坑。

            资源文件名带内容 hash，可以长缓存；只有入口 html 必须每次回源。
            """
            resp = await call_next(request)
            path = request.url.path
            if path.startswith("/app") and (
                    path.endswith((".html", "/")) or path == "/app"):
                resp.headers["Cache-Control"] = "no-cache, must-revalidate"
            return resp

    return app


app = create_app()