"""图像渠道兜底机制验证：冷却 / 健康度排序 / 抖动退避 / 无并发上限。

不打真网关：用假 factory 模拟各种故障，验证调度逻辑本身。
"""
from __future__ import annotations

import asyncio
import sys
import time

sys.path.insert(0, "/root/filmweaver-dev/backend")

from app.providers import image as im  # noqa: E402
from app.providers.image import ChannelDown, ImageProvider  # noqa: E402

FAILS = 0
PASSES = 0


def check(name: str, cond: bool, extra: str = "") -> None:
    global FAILS, PASSES
    if cond:
        PASSES += 1
        print(f"  ✅ {name}")
    else:
        FAILS += 1
        print(f"  ❌ {name} {extra}")


def make_provider(chain_spec):
    """chain_spec: [(渠道名, 行为函数)]；行为函数返回 images 或抛异常。"""
    p = ImageProvider(model_id="gpt-image-2")
    calls = []

    def _chain(prompt, size, n, refs=None):
        out = []
        for cname, behave in chain_spec:
            async def f(cname=cname, behave=behave):
                calls.append(cname)
                return behave()
            out.append((cname, f))
        return out

    p._chain = _chain  # type: ignore[method-assign]
    return p, calls


async def main() -> None:
    im._COOLDOWN.clear()
    # 落盘替身：不写真文件
    im._save_all = lambda images: [f"/fw/media/generated/fake_{i}.png"
                                   for i, _ in enumerate(images)]

    print("\n[1] 渠道级故障 → 自动切下一条并成功")
    im._COOLDOWN.clear()
    def down():
        raise ChannelDown("模拟欠费", account_level=True)
    p, calls = make_provider([("zx1", down), ("api4me", lambda: [b"png"])])
    urls = await p.generate("test")
    check("返回了图片", urls == ["/fw/media/generated/fake_0.png"], urls)
    check("两条渠道都被调用（第一条失败切第二条）", calls == ["zx1", "api4me"], calls)

    print("\n[2] 故障渠道进入冷却 → 下次直接跳过（不再白撞一个 RTT）")
    check("_COOLDOWN 记录了账号级 key 'zx1'", "zx1" in im._COOLDOWN, im._COOLDOWN)
    check("zx1 判定不健康", not im._healthy("zx1", "gpt-image-2"))
    check("api4me 仍健康", im._healthy("api4me", "gpt-image-2"))
    p2, calls2 = make_provider([("zx1", down), ("api4me", lambda: [b"png"])])
    await p2.generate("test")
    check("第二次调用直接走 api4me，跳过冷却中的 zx1",
          calls2 == ["api4me"], calls2)

    print("\n[3] 模型级故障只封该模型，同渠道其它模型不受影响")
    im._COOLDOWN.clear()
    def down_model():
        raise ChannelDown("该模型无可用渠道")
    p3, _ = make_provider([("zx1", down_model), ("api4me", lambda: [b"x"])])
    await p3.generate("test")
    check("冷却 key 是 'zx1:gpt-image-2' 而非 'zx1'",
          "zx1:gpt-image-2" in im._COOLDOWN and "zx1" not in im._COOLDOWN,
          im._COOLDOWN)
    check("zx1 上的其它模型仍健康", im._healthy("zx1", "nano-banana-pro"))

    print("\n[4] 429 瞬态 → 退避重试，同一渠道内自愈")
    im._COOLDOWN.clear()
    state = {"n": 0}
    def flaky():
        state["n"] += 1
        if state["n"] < 3:
            raise RuntimeError("HTTP 429: rate limit exceeded")
        return [b"png"]
    p4, calls4 = make_provider([("zx1", flaky), ("api4me", lambda: [b"y"])])
    t0 = time.monotonic()
    urls4 = await p4.generate("test")
    dt = time.monotonic() - t0
    check("重试后在同一渠道成功", urls4 and calls4 == ["zx1", "zx1", "zx1"], calls4)
    check("zx1 未被冷却（瞬态自愈不算渠道故障）", im._healthy("zx1", "gpt-image-2"))
    check(f"确实发生了退避等待（耗时 {dt:.1f}s > 1s）", dt > 1.0, f"{dt:.2f}s")

    print("\n[5] 持续 429 → 重试到头判定渠道故障，冷却并切另一条")
    im._COOLDOWN.clear()
    def always_429():
        raise RuntimeError("HTTP 429: rate limit")
    p5, calls5 = make_provider([("zx1", always_429), ("api4me", lambda: [b"z"])])
    urls5 = await p5.generate("test")
    check("最终由 api4me 兜底成功", bool(urls5), urls5)
    check("zx1 重试了 image_retries=3 次",
          calls5.count("zx1") == 3, calls5)
    check("zx1 被冷却", not im._healthy("zx1", "gpt-image-2"))

    print("\n[6] 内容级错误不冷却渠道（别因一条坏提示词封掉好渠道）")
    im._COOLDOWN.clear()
    def bad_prompt():
        raise RuntimeError("HTTP 400: content policy violation")
    p6, calls6 = make_provider([("zx1", bad_prompt), ("api4me", lambda: [b"w"])])
    await p6.generate("test")
    check("不重试（非瞬态）", calls6.count("zx1") == 1, calls6)
    check("zx1 未被冷却", im._healthy("zx1", "gpt-image-2"))

    print("\n[7] 全渠道失败 → 抛错且提示加 KEY（而非降并发）")
    im._COOLDOWN.clear()
    p7, _ = make_provider([("zx1", down), ("api4me", down)])
    try:
        await p7.generate("test")
        check("应当抛错", False)
    except RuntimeError as e:
        check("错误信息含各渠道明细", "zx1" in str(e) and "api4me" in str(e), str(e))
        check("提示加 KEY / 提配额", "API KEY" in str(e), str(e))

    print("\n[8] 退避带抖动（防惊群）：同一 attempt 的延迟应当各不相同")
    im._COOLDOWN.clear()
    delays = []
    orig_sleep = asyncio.sleep
    async def spy(d):
        delays.append(d)
    asyncio.sleep = spy  # type: ignore[assignment]
    try:
        for _ in range(20):
            await im._backoff(0)
    finally:
        asyncio.sleep = orig_sleep  # type: ignore[assignment]
    check(f"20 次退避产生了多个不同延迟（{len(set(delays))} 种）",
          len(set(delays)) >= 18, delays[:5])
    check("延迟落在 [0.5, 1.5]×base=2s 区间内",
          all(1.0 <= d <= 3.0 for d in delays), (min(delays), max(delays)))

    print("\n[9] 并发闸门：image_concurrency=0 → 真无上限")
    from app.config import get_settings
    from app import jobs
    s = get_settings()
    check("配置默认 image_concurrency == 0", s.image_concurrency == 0,
          s.image_concurrency)
    gate = jobs._image_gate()
    check("闸门是 _NoLimit（无信号量）", isinstance(gate, jobs._NoLimit),
          type(gate).__name__)
    # 实测 200 个协程同时进闸门
    peak = {"cur": 0, "max": 0}
    async def worker():
        async with gate:
            peak["cur"] += 1
            peak["max"] = max(peak["max"], peak["cur"])
            await orig_sleep(0.05)
            peak["cur"] -= 1
    await asyncio.gather(*(worker() for _ in range(200)))
    check(f"200 协程实测峰值并发 = {peak['max']}（无上限）",
          peak["max"] == 200, peak["max"])

    print("\n[10] 兼容：FW_IMAGE_CONCURRENCY=N 仍可临时限流")
    import os
    os.environ["FW_IMAGE_CONCURRENCY"] = "5"
    get_settings.cache_clear()
    gate2 = jobs._image_gate()
    check("设了环境变量后闸门变回信号量",
          isinstance(gate2, asyncio.Semaphore), type(gate2).__name__)
    peak2 = {"cur": 0, "max": 0}
    async def worker2():
        async with gate2:
            peak2["cur"] += 1
            peak2["max"] = max(peak2["max"], peak2["cur"])
            await orig_sleep(0.02)
            peak2["cur"] -= 1
    await asyncio.gather(*(worker2() for _ in range(50)))
    check(f"峰值并发被限到 5（实测 {peak2['max']}）", peak2["max"] == 5, peak2["max"])
    del os.environ["FW_IMAGE_CONCURRENCY"]
    get_settings.cache_clear()
    check("清掉环境变量后恢复无上限",
          isinstance(jobs._image_gate(), jobs._NoLimit))

    print("\n[11] 内容审核拒绝：不重试 / 不冷却渠道 / 仍切下一条")
    im._COOLDOWN.clear()
    # 两家网关的真实响应体（2026-08 实测抓到的原文）。注意状态码毫无参考价值：
    # api4me 把审核拒绝包成 429（像限流），zx1 包成 500（像服务端故障）——
    # 所以分类必须先看 body 再看 status，否则就会重试 3 次再把好渠道冷却 120s。
    BODY_4ME = ('{"error":{"message":"Your request was rejected by the safety '
                'system. safety_violations=[sexual]","code":"moderation_blocked"}}')
    BODY_ZX1 = '{"error":{"message":"提交中含有违反平台政策的内容，请修改后重试"}}'

    r1 = im._classify_http(429, BODY_4ME)
    check("api4me 的 HTTP 429 被识别为审核拒绝（而非限流）",
          isinstance(r1, im.ContentRejected), type(r1).__name__)
    check("解析出违规类别 ['sexual']",
          isinstance(r1, im.ContentRejected) and r1.categories == ["sexual"],
          getattr(r1, "categories", None))
    r2 = im._classify_http(500, BODY_ZX1)
    check("zx1 的 HTTP 500 被识别为审核拒绝（而非服务端故障）",
          isinstance(r2, im.ContentRejected), type(r2).__name__)
    check("审核拒绝不算瞬态（不该退避重试）",
          not im._is_transient(im.ContentRejected("x")))
    check("含 429 字样的审核拒绝文案也不算瞬态（双保险）",
          not im._is_transient(RuntimeError(f"HTTP 429: {BODY_4ME}")))
    check("真限流仍算瞬态（没误伤）",
          im._is_transient(RuntimeError("HTTP 429: rate limit exceeded")))

    def reject_4me():
        raise im._classify_http(429, BODY_4ME)
    p11, calls11 = make_provider([("zx1", reject_4me), ("api4me", lambda: [b"ok"])])
    t0 = time.monotonic()
    urls11 = await p11.generate("test")
    dt11 = time.monotonic() - t0
    check("被拒后立刻切下一条渠道并成功（审核口径各家不同，能救回来）",
          urls11 and calls11 == ["zx1", "api4me"], calls11)
    check("没有重试（同一提示词重试必然同样被拒）",
          calls11.count("zx1") == 1, calls11)
    check("没有退避等待（不该白等）", dt11 < 0.5, f"{dt11:.2f}s")
    check("zx1 未被冷却——渠道是好的，冷却会连累其他镜头",
          im._healthy("zx1", "gpt-image-2"), im._COOLDOWN)

    print("\n[12] 全渠道均因审核被拒 → 抛 ContentRejected 并给可执行建议")
    im._COOLDOWN.clear()
    def reject_zx1():
        raise im._classify_http(500, BODY_ZX1)
    p12, calls12 = make_provider([("zx1", reject_zx1), ("api4me", reject_4me)])
    try:
        await p12.generate("test")
        check("应当抛错", False)
    except im.ContentRejected as e:
        check("抛的是 ContentRejected 而非泛化 RuntimeError", True)
        check("建议换生图模型", "换生图模型" in str(e), str(e))
        check("说明重试无效", "重试无效" in str(e), str(e))
    except Exception as e:  # noqa: BLE001
        check(f"抛的是 ContentRejected（实际 {type(e).__name__}）", False, str(e))
    check("两条渠道各只试了一次", calls12 == ["zx1", "api4me"], calls12)
    check("两条渠道都没被冷却",
          im._healthy("zx1", "gpt-image-2") and im._healthy("api4me", "gpt-image-2"),
          im._COOLDOWN)

    print("\n[13] 审核拒绝 + 渠道故障混合 → 按渠道故障处理（还有得救，不是死路）")
    im._COOLDOWN.clear()
    p13, _ = make_provider([("zx1", reject_zx1), ("api4me", down)])
    try:
        await p13.generate("test")
        check("应当抛错", False)
    except im.ContentRejected:
        check("混合失败不该报成纯审核问题（会误导用户去改提示词）", False)
    except RuntimeError as e:
        check("报成渠道失败，附各渠道明细", "zx1" in str(e) and "api4me" in str(e), str(e))
        check("但仍点出'其中 N 条渠道判定内容违规'（否则用户只会一直重试）",
              "判定内容违规" in str(e) and "改写提示词" in str(e), str(e))

    print("\n[14] 异步任务型渠道（RunningHub）的审核拒绝也要认出来")
    im._COOLDOWN.clear()
    # RH 是"提交→轮询"，审核结论以任务状态回来，永远不经过 _classify_http。
    # 2026-08 实测原文：过不了审时前端却看到"建议增加 API KEY"，纯误导。
    RH_MSG = "RH task FAILED: Content security audit did not pass | 内容安全审查未通过"
    check("RH 的任务失败文案被识别为审核拒绝",
          isinstance(im._as_moderation_exc(RuntimeError(RH_MSG)), im.ContentRejected))
    check("普通任务失败不会被误判成审核拒绝",
          im._as_moderation_exc(RuntimeError("RH 任务超时或无产出图")) is None)

    def rh_reject():
        raise RuntimeError(RH_MSG)
    p14, calls14 = make_provider([("zx1", reject_zx1), ("api4me", reject_4me),
                                  ("rh-g2", rh_reject)])
    try:
        await p14.generate("test")
        check("应当抛错", False)
    except im.ContentRejected as e:
        check("三条渠道全被拒 → 报审核拒绝，不再误导用户去加 KEY",
              "API KEY" not in str(e) and "换生图模型" in str(e), str(e))
    except Exception as e:  # noqa: BLE001
        check(f"应抛 ContentRejected（实际 {type(e).__name__}）", False, str(e))
    check("RH 渠道只试一次、未被冷却",
          calls14.count("rh-g2") == 1 and im._healthy("rh-g2", "gpt-image-2"),
          (calls14, im._COOLDOWN))

    print(f"\n{'=' * 50}\n通过 {PASSES} 项，失败 {FAILS} 项\n{'=' * 50}")
    sys.exit(1 if FAILS else 0)


asyncio.run(main())
