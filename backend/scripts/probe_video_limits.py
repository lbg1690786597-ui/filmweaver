"""探测视频模型能力包线：时长 × 分辨率 × 机型，**全网格并发**。

为什么必须实测：解说剧用旁白时长驱动镜头时长，实测已出现 35s 片段爆显存。
但"上限到底多少"三个来源互相矛盾——
  · 文档标称 H3 15s
  · 用户实测 23.7s 成功过
  · 代码里 _auto_megapixels 的经验值是 2MP≤3s / 1MP≤8s
说明真实包线从没测准过。

RunningHub 机型价差（¥4/¥6/¥9 每小时）直接决定成本策略，必须分机型探。

全部并发提交：RunningHub 并发上限 800，串行探 72 个点要跑一整天。

用法:
    python3 probe_video_limits.py                    # 全网格（72 点）
    python3 probe_video_limits.py --instances default  # 只探 24G 机
    python3 probe_video_limits.py --quick            # 精简网格
"""
import argparse
import asyncio
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, "/root/filmweaver-dev/backend")

OUT = Path("/root/filmweaver-dev/docs/VIDEO-LIMITS-实测.json")

SECONDS_FULL = [5, 8, 12, 15, 20, 25, 30, 40]
SECONDS_QUICK = [8, 15, 25, 40]
MEGAPIXELS = [0.5, 1.0, 2.0]
INSTANCES = ["default", "plus", "ultra"]   # default=24G / plus=48G / ultra=84G

#: 首轮（2026-08-29）被**脚本自己**的 1800s 轮询上限取消的点。
#: 这些不是能力不足——RunningHub 从没说不行，是 72 点抢队列排太久，
#: 被我方主动放弃。而它们恰好全落在 plus/ultra 强于 default 的区间，
#: 导致统计出来三档机型上限看起来一样高（假象）。必须不设上限重跑。
RETRY_POINTS = [
    ("plus", 0.5, 40), ("plus", 1.0, 20), ("plus", 1.0, 25),
    ("plus", 2.0, 12), ("plus", 2.0, 15),
    ("ultra", 0.5, 40), ("ultra", 1.0, 20), ("ultra", 1.0, 25),
    ("ultra", 1.0, 30), ("ultra", 1.0, 40),
    ("ultra", 2.0, 12), ("ultra", 2.0, 15),
    ("ultra", 2.0, 20), ("ultra", 2.0, 25),
]

#: 轮询上限：**不设**。只认 RunningHub 主动报错（FAILED/OOM），
#: 绝不由我方主动放弃——被自己取消的任务会污染包线统计，
#: 把"没测出来"记成"测出来不行"。10s × 100000 ≈ 11.5 天，等价于无上限。
POLL_MAX_UNCAPPED = 100_000

_OOM_KEYS = ("illegal memory", "out of memory", "cuda", "oom", "显存",
             "allocat", "memory")

#: 只有 **RunningHub 主动报的任务失败** 才算爆显存。
#:
#: 2026-08-29 踩坑：原来只要报错里出现"显存/memory"就判 OOM，结果我方
#: 新加的提交前预算校验（错误文案含"显存"）把 14 个点在 0 秒本地拒掉，
#: 全被记成 OOM 写进结果文件——用自己写死的预算"证明"了自己的预算。
#: 本地拒绝、参数错误、网络失败一律不是能力边界，必须记为"未测出"。
_RH_FAILED_MARK = "RunningHub 任务 FAILED"


def _is_oom(msg: str) -> bool:
    low = msg.lower()
    return _RH_FAILED_MARK in msg and any(k in low for k in _OOM_KEYS)


async def one(prov, seconds: float, mp: float, instance: str,
              aspect: str, tag: str, counter: dict, total: int) -> dict:
    from app.providers.base import VideoRequest
    from app.media import probe_duration_local

    t0 = time.time()
    row = {"seconds": seconds, "mp": mp, "instance": instance}
    try:
        req = VideoRequest(
            prompt="An empty quiet room at dusk, slow camera pan to the right. "
                   "Cinematic, photorealistic, no people.",
            duration_ms=int(seconds * 1000),
            aspect_ratio=aspect,
            megapixels=mp,
        )
        # submit() 内部已轮询至出片并把产出下载到本地，返回 VideoResult
        res = await prov.submit(req)
        if res.status != "done" or not res.video_url:
            raise RuntimeError(res.error or f"status={res.status}")
        real = await probe_duration_local(res.video_url)
        row.update(ok=True, real_dur=round(real, 2),
                   elapsed=round(time.time() - t0, 1))
    except Exception as e:  # noqa: BLE001
        msg = repr(e)[:240]
        row.update(ok=False, error=msg,
                   oom=_is_oom(msg),
                   elapsed=round(time.time() - t0, 1))
    counter["n"] += 1
    mark = "OK " if row.get("ok") else ("OOM" if row.get("oom") else "ERR")
    extra = (f"实际{row['real_dur']}s" if row.get("ok")
             else row.get("error", "")[:60])
    print(f"  [{counter['n']:2d}/{total}] {mark} {tag:>18}  "
          f"{row['elapsed']:5.0f}s  {extra}", flush=True)
    return row


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="minimax-h3-ref2v")
    ap.add_argument("--aspect", default="9:16")
    ap.add_argument("--quick", action="store_true")
    ap.add_argument("--retry", action="store_true",
                    help="只重跑首轮被 1800s 轮询上限取消的 14 个点")
    ap.add_argument("--instances", default=None,
                    help="逗号分隔；缺省探全部(default,plus,ultra)")
    a = ap.parse_args()

    secs = SECONDS_QUICK if a.quick else SECONDS_FULL
    insts = (INSTANCES if a.instances is None
             else [x.strip() for x in a.instances.split(",")])
    if a.retry:
        grid = [(s, mp, inst) for inst, mp, s in RETRY_POINTS]
        insts = sorted({inst for inst, _, _ in RETRY_POINTS})
    else:
        grid = [(s, mp, inst) for inst in insts for mp in MEGAPIXELS for s in secs]

    from app.config import get_settings
    from app.providers.video_runninghub import RunningHubH3VideoProvider

    if not (get_settings().runninghub_api_key or "").strip():
        print("FW_RUNNINGHUB_API_KEY 未配置，无法探测；先在 backend/.env 里配好再跑")
        return

    # ⚠️ 每个机型必须独立 Provider 实例：instance_type 是**构造期**固定的，
    # 若共用单例再在协程里改 _instance_type_override，并发点会互相覆盖，
    # 机型这一维的数据全是脏的（看着有结果，实则不知道跑在哪台机器上）。
    #
    # poll_max 抬到无上限：首轮 14 个点是被**我方**的 1800s 上限取消的，
    # RunningHub 并没有报错。主动放弃的点必须记为"未知"而不是"不行"，
    # 否则统计口径会把排队慢误判成能力不足。
    #
    # enforce_vram_budget=False：本脚本标定的就是那个预算，若探测也走守卫，
    # 请求会在 0 秒被本地拒绝、根本到不了 GPU（2026-08-29 实测踩过），
    # 等于拿写死的预算去"验证"自己。标定必须绕过被标定的对象。
    # ⚠️ 机型必须写全名（"default" 而非留空）：留空的语义已改成
    # "用默认档"，而默认档现在是 plus —— 留空会让 default 那一列
    # 实际跑的是 plus，标出来的数据张冠李戴且完全看不出来。
    provs = {inst: RunningHubH3VideoProvider(a.model, instance_type=inst,
                                             poll_max=POLL_MAX_UNCAPPED,
                                             enforce_vram_budget=False)
             for inst in insts}

    print(f"模型 {a.model}   画幅 {a.aspect}")
    if a.retry:
        print(f"重跑首轮被取消的 {len(grid)} 个点（**不设轮询上限**）")
    else:
        print(f"网格 {len(secs)}时长 × {len(MEGAPIXELS)}分辨率 × {len(insts)}机型 "
              f"= {len(grid)} 点，**全部并发**")
    print(f"机型: {insts}\n", flush=True)

    counter = {"n": 0}
    t0 = time.time()
    rows = await asyncio.gather(*(
        one(provs[inst], s, mp, inst, a.aspect,
            f"{s:>2.0f}s@{mp}MP/{inst}", counter, len(grid))
        for s, mp, inst in grid))
    wall = time.time() - t0

    # ---- 与历史结果合并 ----
    # ⚠️ 不能直接覆盖：--retry 只跑 14 个点，整份写回会把首轮**唯一测准的**
    # default 那 24 个点抹掉。按 (机型, 分辨率, 时长) 归并，同一个点以本轮为准
    # （本轮不设轮询上限，比首轮被取消的结果更可信）。
    OUT.parent.mkdir(parents=True, exist_ok=True)
    prev = json.loads(OUT.read_text()) if OUT.exists() else {}
    key = f"{a.model}::{a.aspect}"
    merged: dict[str, dict] = {
        f"{r['instance']}|{r['mp']}|{r['seconds']}": r
        for r in (prev.get(key, {}).get("raw") or [])
    }
    for r in rows:
        merged[f"{r['instance']}|{r['mp']}|{r['seconds']}"] = r
    all_rows = list(merged.values())

    print(f"\n并发总耗时 {wall / 60:.1f} 分钟")
    print(f"本轮 {len(rows)} 点，合并历史后共 {len(all_rows)} 点")
    print("=" * 62)
    print("=== 能力包线（每档最长成功时长）===")
    env: dict[str, dict[str, float]] = {}
    for r in all_rows:
        if not r.get("ok"):
            continue
        inst = r["instance"]
        mp = str(r["mp"])
        env.setdefault(inst, {})
        env[inst][mp] = max(env[inst].get(mp, 0), r["seconds"])

    for inst in sorted({r["instance"] for r in all_rows}):
        e = env.get(inst, {})
        line = "  ".join(f"{mp}MP→{sec:.0f}s" for mp, sec in
                         sorted(e.items(), key=lambda kv: -float(kv[0]))) or "全失败"
        print(f"  {inst:>8}: {line}")

    # 显存预算（MP·s）：成功点的最大值 vs 爆显存点的最小值，真值夹在中间。
    # 这比"最长成功时长"更能外推——显存正比于 像素 × 帧数。
    print("\n=== 显存预算（MP·s）===")
    for inst in sorted({r["instance"] for r in all_rows}):
        got = [r for r in all_rows if r["instance"] == inst]
        ok_max = max((r["mp"] * r["seconds"] for r in got if r.get("ok")),
                     default=0.0)
        oom_min = min((r["mp"] * r["seconds"] for r in got if r.get("oom")),
                      default=float("inf"))
        unknown = sum(1 for r in got if not r.get("ok") and not r.get("oom"))
        rng = (f"{ok_max:.1f} ~ {oom_min:.1f}" if oom_min < float("inf")
               else f"≥ {ok_max:.1f}（无爆显存点，上界未知）")
        note = f"  ⚠️ {unknown} 点未测出（非 OOM 失败）" if unknown else ""
        print(f"  {inst:>8}: {rng}{note}")

    ooms = [r for r in all_rows if not r.get("ok") and r.get("oom")]
    errs = [r for r in all_rows if not r.get("ok") and not r.get("oom")]
    print(f"\n  爆显存 {len(ooms)} 点 / 其他失败 {len(errs)} 点 / "
          f"成功 {sum(1 for r in all_rows if r.get('ok'))} 点")
    if ooms:
        print("  爆显存的组合:")
        for r in sorted(ooms, key=lambda r: (r["instance"], -r["mp"], r["seconds"])):
            print(f"    {r['instance']:>8}  {r['seconds']:>4.0f}s @ {r['mp']}MP")
    if errs:
        print("  非显存失败（**未测出**，不可当作能力不足）:")
        for r in errs:
            print(f"    {r['instance']:>8}  {r['seconds']:>4.0f}s @ {r['mp']}MP"
                  f"  {r.get('error','')[:70]}")

    prev[key] = {
        "probed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "envelope": env,
        "wall_min": round(wall / 60, 1),
        "raw": all_rows,
    }
    OUT.write_text(json.dumps(prev, ensure_ascii=False, indent=2))
    print(f"\n已写入 {OUT}")
    print("据此更新 providers/video_runninghub.py::_VRAM_BUDGET_MPS "
          "与 script_import.py::_MAX_NARRATION_SEC")


if __name__ == "__main__":
    asyncio.run(main())
