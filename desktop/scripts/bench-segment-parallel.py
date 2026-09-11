#!/usr/bin/env python3
"""P2-6 实测：分段编码 **串行 vs 并行**，用来回答「导出分段并行化值不值得做」。

## 为什么要有这个脚本而不是直接改代码

`renderer.ts:290` 的分段循环是严格串行的，看起来是个显而易见的优化点。
但 288 行那句注释写着「内存在这里恒定，**是整个方案的关键**」—— 串行不是疏忽，
是拿吞吐换峰值内存/磁盘的**有意取舍**。要推翻一个有意的取舍，得有数字。

而且并发数按项目铁律由用户掌控，**不能先改了再说**。所以先测。

## 怎么测才算测对（三个漏洞都得堵）

1. **别只测编码。** 轻滤镜时瓶颈在 x264，而 x264 默认吃满所有核，
   并行必然收益很小 —— 只测这一档会得出「并行无用」的偏低结论。
   真实 composite 段是**滤镜重**的（crop/pixel/overlay/gblur），
   ffmpeg 滤镜层基本单线程，那一档并行本该收益大得多。
2. **别只在开发机测。** 本机 16 核；用户机器常是 4~8 核。核越少，
   单个 ffmpeg 就越容易吃满，并行收益**越小**——方向与直觉相反，必须实测。
3. **要有灵敏度对照组。** 如果所有档都测出「没收益」，无法区分
   「真的没收益」与「测量方法根本测不出收益」。16 核+滤镜重那一档
   （实测 1.82×）就是这个对照组：它证明这套测法**能**看见收益。

## 用法
    python3 scripts/bench-segment-parallel.py            # 全部四档
    python3 scripts/bench-segment-parallel.py --quick    # 只跑最关键的 C 档

结果写进 `docs/SEGMENT-PARALLEL-实测.json`（与 TTS-RATE-实测.json 同约定）。
"""
from __future__ import annotations

import json
import os
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

N_SEGS = 8
SEG_SECONDS = 6
REPEATS = 3

# 滤镜重的段：贴近 §5 的统一蒙版合成器（crop → pixel → scale → overlay → 调色）。
# 刻意保留 `scale=iw/12:-1,scale=iw*12:-1` 这两次整除截断 + 后面的 scale 复位，
# 因为那正是现有 pixel 效果的真实形状（§5 缺陷 2）。
HEAVY_FILTER = (
    "[0:v]scale=1080:1920[bg];"
    "[bg]split[b1][b2];"
    "[b2]crop=400:400:100:200,scale=iw/12:-1,scale=iw*12:-1,scale=400:400,"
    "format=yuva420p[p];"
    "[b1][p]overlay=100:200,gblur=sigma=2,eq=contrast=1.1:saturation=1.2[v]"
)


def die(msg: str) -> None:
    print(f"❌ {msg}")
    sys.exit(1)


def encode_one(work: Path, i: int, heavy: bool, cpus: str | None) -> None:
    """跑一段。参数刻意与真实导出一致：**不下发 `-preset`、不下发 `-threads`**。

    不下发 preset 是 `encoderArgs.ts` 的既有决定；不下发 threads 则意味着
    libx264 自己按核数开线程 —— 这恰恰是并行收益被吃掉的原因，
    所以这里绝不能为了「让并行好看」而人为限制单进程线程数。
    """
    args = ["ffmpeg", "-v", "error", "-y", "-i", str(work / f"in_{i}.mp4")]
    if heavy:
        args += ["-filter_complex", HEAVY_FILTER, "-map", "[v]"]
    else:
        args += ["-vf", "scale=1080:1920,format=yuv420p"]
    args += ["-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", "-an",
             str(work / f"out_{i}.mp4")]
    if cpus:
        args = ["taskset", "-c", cpus] + args
    r = subprocess.run(args, capture_output=True, text=True)
    if r.returncode != 0:
        die(f"ffmpeg 失败({r.returncode}): {r.stderr[-400:]}")


def run_once(work: Path, conc: int, heavy: bool, cpus: str | None) -> float:
    for f in work.glob("out_*.mp4"):
        f.unlink()
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=conc) as ex:
        list(ex.map(lambda i: encode_one(work, i, heavy, cpus), range(N_SEGS)))
    return time.time() - t0


def table(work: Path, key: str, title: str, heavy: bool, cpus: str | None,
          concs=(1, 2, 4, 8)) -> dict:
    print(f"\n## {title}")
    print(f"{'并发':>4} {'总墙钟(s)':>10} {'相对串行':>9} {'并行效率':>9}")
    out: dict[str, float] = {}
    base = None
    for c in concs:
        # 重复取中位数：单次跑容易被别的进程干扰，而这里要下的结论是
        # 「1.1× 到底是真收益还是噪声」，没有误差范围就不能下这个结论。
        runs = [run_once(work, c, heavy, cpus) for _ in range(REPEATS)]
        wall = statistics.median(runs)
        spread = max(runs) - min(runs)
        base = base or wall
        sp = base / wall
        out[str(c)] = round(wall, 2)
        print(f"{c:>4} {wall:>10.1f} {sp:>8.2f}x {sp/c:>8.0%}"
              f"   (±{spread:.1f}s, {REPEATS} 次)")
    return {"title": title, "cpus": cpus or "all", "heavy": heavy,
            "wall_by_conc": out,
            "speedup_max": round(out[str(concs[0])] / min(out.values()), 2)}


def main() -> None:
    if not shutil.which("ffmpeg"):
        die("本机没有 ffmpeg")
    quick = "--quick" in sys.argv
    ncpu = os.cpu_count() or 1
    has_taskset = shutil.which("taskset") is not None
    if not has_taskset:
        print("⚠️ 没有 taskset，跳过「模拟 4 核」两档 —— 那两档恰恰是最像真实用户的，"
              "\n   只剩 16 核的数字会把并行收益系统性高估。")

    work = Path(tempfile.mkdtemp(prefix="segbench-"))
    try:
        print(f"本机 {ncpu} 核 · {N_SEGS} 段 × {SEG_SECONDS}s · 1080x1920 · "
              f"libx264 默认 preset · 每档 {REPEATS} 次取中位")
        src = work / "src.mp4"
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-f", "lavfi",
             "-i", f"testsrc2=s=1080x1920:r=30:d={SEG_SECONDS}",
             "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", str(src)],
            check=True)
        for i in range(N_SEGS):
            shutil.copy(src, work / f"in_{i}.mp4")

        results = {}
        if not quick:
            if has_taskset:
                results["A_4core_light"] = table(
                    work, "A", "A：模拟 4 核，轻滤镜（瓶颈在 x264）", False, "0-3")
            results["B_16core_heavy"] = table(
                work, "B", f"B：{ncpu} 核，滤镜重 —— **灵敏度对照组**", True, None)
        if has_taskset:
            results["C_4core_heavy"] = table(
                work, "C", "C：模拟 4 核 + 滤镜重（**最接近真实用户导出**）", True, "0-3")

        payload = {
            "measured_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "host": {"cpus": ncpu, "gpu": False,
                     "ffmpeg": subprocess.run(["ffmpeg", "-version"],
                                              capture_output=True, text=True)
                     .stdout.splitlines()[0]},
            "workload": {"segments": N_SEGS, "seconds_each": SEG_SECONDS,
                         "resolution": "1080x1920", "encoder": "libx264",
                         "preset": "(未下发，同 encoderArgs.ts)"},
            "results": results,
        }
        dest = Path(__file__).resolve().parent.parent.parent / "docs" / "SEGMENT-PARALLEL-实测.json"
        dest.write_text(json.dumps(payload, ensure_ascii=False, indent=2))
        print(f"\n已写入 {dest}")
        print("\n注：本表只测**编码吞吐**。并行还会把峰值内存与峰值磁盘乘上并发数，"
              "\n    而 renderer.ts:288「内存在这里恒定，是整个方案的关键」正是串行换来的；"
              "\n    另有 renderer.ts:261 的 `segMasks` 是**单个共享绑定**，"
              "\n    并行会让它跨段串味（见 §0.6 P2-6 行）。")
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()
