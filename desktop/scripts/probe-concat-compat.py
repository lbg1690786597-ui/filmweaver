#!/usr/bin/env python3
"""P2-8 前置实验：`concat -c copy` 是否容忍**各段编码参数不一致**。

## 这个实验决定 P2-8 做不做

P2-8 的设想是：passthrough 段若「源已经是目标规格」，就别重编码，直接 `-c:v copy`。
听起来是白捡的加速 —— 一个段能从几十秒降到几十毫秒。

但 `renderer.ts:356` 给最终 concat 写着一句前提：
「各段编码参数一致，-c copy 安全」。而 `-c:v copy` 出来的段带的是**源素材的**
SPS/PPS/profile/level；其余段带的是本机编码器的（`libx264` / `h264_nvenc` /
`h264_qsv` / `h264_amf`，各家 SPS 都不同，且随机器而变）。
也就是说 P2-8 一旦生效，就正好打破那句前提。

mp4 的 `-c copy` concat 只会写**第一段**的 avcC。后面参数不同的段会怎样？
不测就只能猜，而猜错的代价是「跑完几十分钟得到一个坏成片，且中途不报错」。

## 怎么判「坏没坏」（v1 的判法是错的，留在这里当反面教材）

第一版把「解码时 stderr 有输出」当损坏证据，于是报了「静默损坏」。
那几行其实是 `non monotonically increasing dts **to muxer**` ——
来自实验自己接的 `-f null` 输出端，**对照组一模一样地有**；而两组帧数都对。
那个断言根本不承重：它对着一个两组都会出现的噪声在判是非。

现在用**逐帧 md5**：把 concat 产物解成帧指纹，与两个源各自解出的指纹拼接比对。
逐字节一致 = 没坏；对不上 = 真坏，且能指出从第几帧开始坏。
对照组（两段参数相同）必须**逐字节一致**，否则说明测法本身有问题、
本次结论一律作废 —— 这条是这个脚本的自检，不是装饰。

## 用法
    python3 scripts/probe-concat-compat.py

## 实测结论（2026-09-06，ffmpeg 4.4.2）
    对照组（High 4.0 + High 4.0）  → 120/120 帧，逐帧 md5 一致    ✅
    实验组（High 4.0 + Baseline 3.1）→ **119**/120 帧，第 #89 帧起发散  ❌

即：EXIT=0、不报错、**少一帧且画面对不上**。属最坏的一类失败。
**P2-8 的混合段方案据此判定不成立**，详见 §0.6 P2-8 行。
"""
from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

W = Path(tempfile.mkdtemp(prefix="concat-compat-"))


def sh(a: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(a, capture_output=True, text=True)


def mk(name: str, profile: str, level: str) -> Path:
    """造一段 1080x1920 / 30fps / yuv420p 的片子，只有 profile/level 不同。

    刻意让**除 profile/level 外的一切都相同**：分辨率、帧率、像素格式、音轨规格。
    这样若实验组出问题，变量就被隔离到 profile/level 这一个上，不会含混。
    """
    p = W / name
    r = sh(["ffmpeg", "-v", "error", "-y",
            "-f", "lavfi", "-i", "testsrc2=s=1080x1920:r=30:d=2",
            "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
            "-map", "0:v", "-map", "1:a", "-shortest",
            "-c:v", "libx264", "-profile:v", profile, "-level", level,
            "-crf", "20", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-ar", "44100", "-ac", "2", "-b:a", "128k", str(p)])
    if r.returncode != 0:
        sys.exit(f"❌ 造样本失败: {r.stderr[-300:]}")
    return p


def frames(p: Path) -> list[str]:
    """逐帧 md5 —— 唯一能证明「画面没坏」的东西。"""
    r = sh(["ffmpeg", "-v", "error", "-i", str(p), "-map", "0:v", "-f", "framemd5", "-"])
    return [l.split(",")[-1].strip() for l in r.stdout.splitlines()
            if l and not l.startswith("#")]


def concat(parts: list[Path], out: Path) -> subprocess.CompletedProcess:
    lst = W / f"{out.stem}.txt"
    lst.write_text("".join(f"file '{p}'\n" for p in parts))
    return sh(["ffmpeg", "-y", "-v", "warning", "-f", "concat", "-safe", "0",
               "-i", str(lst), "-c", "copy", "-movflags", "+faststart", str(out)])


def check(title: str, parts: list[Path], out: Path) -> bool:
    r = concat(parts, out)
    got, want = frames(out), [f for p in parts for f in frames(p)]
    same = got == want
    bad = next((i for i, (g, w) in enumerate(zip(got, want)) if g != w), None)
    print(f"\n## {title}")
    print(f"   concat EXIT={r.returncode} · 产物 {len(got)} 帧 · 期望 {len(want)} 帧")
    for l in [x for x in r.stderr.splitlines() if x.strip()][:4]:
        print(f"   ⚠️ {l}")
    if same:
        print("   ✅ 逐帧 md5 与两源拼接**逐字节一致** → 无损坏")
    else:
        print(f"   ❌ 逐帧 md5 不一致，首个不同帧 = #{bad}"
              f"（产物 {len(got)} 帧 vs 期望 {len(want)} 帧）")
    return same


def main() -> None:
    if not shutil.which("ffmpeg"):
        sys.exit("❌ 本机没有 ffmpeg")
    try:
        a = mk("a_high.mp4", "high", "4.0")
        b = mk("b_base.mp4", "baseline", "3.1")
        a2 = mk("a2_high.mp4", "high", "4.0")
        print("样本：A=High 4.0 · A2=High 4.0（与 A 同规格）· B=Constrained Baseline 3.1")

        ctrl = check("对照组：参数一致（= 现状，renderer.ts:356 的前提）",
                     [a, a2], W / "same.mp4")
        exp = check("实验组：profile/level 不同（= P2-8 会造出的局面）",
                    [a, b], W / "mixed.mp4")

        print("\n=== 判定 ===")
        if not ctrl:
            print("  ⚠️ **对照组自己就对不上** → 测法有问题，本次结论一律作废，"
                  "不得用来支持任何决策。")
            sys.exit(2)
        if exp:
            print("  参数不同也逐帧一致 → 这条障碍不成立，"
                  "P2-8 可继续评估其余门槛（关键帧对齐 / 音频链 / 硬解兼容）。")
            sys.exit(0)
        print("  ⚠️ 参数不同会**静默损坏**（EXIT=0、不报错、帧对不上）")
        print("     → P2-8 的混合段方案不成立。renderer.ts:356 那句前提是**承重的**，")
        print("       不是随手写的注释。")
        sys.exit(1)
    finally:
        shutil.rmtree(W, ignore_errors=True)


if __name__ == "__main__":
    main()
