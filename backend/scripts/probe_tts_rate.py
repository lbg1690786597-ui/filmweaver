"""探测 TTS 文本字数 → 音频时长 的关系（并发跑）。

为什么必须实测：解说剧用旁白时长驱动镜头时长，而镜头时长受视频模型显存
硬约束（实测已出现 35s 片段爆显存）。要在**切分阶段**就按目标时长反推
该切多少字，就得知道"多少字 = 多少秒"的真实系数。

拍脑袋不行——中文 TTS 语速受标点、数字、语气词、句长影响很大，
且 IndexTTS 有自己的节奏。只能实测回归。

样本设计：字数跨度 4~200，覆盖短句/长句/多标点/对白/数字/排比，
每档多个样本以便看方差（同字数不同文体的语速差异）。

用法:
    python3 probe_tts_rate.py
    python3 probe_tts_rate.py --out /tmp/rate.json
"""
import argparse
import asyncio
import json
import statistics
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, "/root/filmweaver-dev/backend")

OUT_DEFAULT = Path("/root/filmweaver-dev/docs/TTS-RATE-实测.json")

#: 按字数梯度铺开，每档 2-3 个不同文体，用来看"同字数不同写法"的方差。
SAMPLES: list[str] = [
    # ~5 字
    "他走了。",
    "不可能！",
    "她愣住了。",
    # ~12 字
    "林晚秋推开了门。",
    "客厅的挂钟停了。",
    "雨点砸在玻璃上。",
    # ~25 字
    "客厅的挂钟停在三点十七分，正是母亲去世的那一刻。",
    "她已经三年没有回来过了，一次也没有。",
    "信封里只有一张泛黄的照片和一把铜钥匙。",
    # ~50 字
    "林晚秋推开老宅斑驳的木门，灰尘在斜射的光柱里翻涌。她已经三年没有回来过了。",
    "林晚秋猛地回头，看见继父陈国栋倚在门框上，手里攥着一个褪色的信封。",
    "照片上是年轻的母亲抱着婴儿，站在一栋从未见过的洋房前，她从未听母亲提起过。",
    # ~80 字
    "陈国栋沉默了很久，才缓缓开口：城西，梧桐路十七号。你母亲说，等你二十五岁"
    "生日那天，才能去。而今天，正是她二十五岁生日。",
    "第一，你必须在二十五岁生日当天去；第二，钥匙只能你自己拿着；第三，无论"
    "看到什么，都不要告诉任何人。这是你母亲的原话。",
    # ~120 字
    "三年前的那个夏天，母亲把她送上了去南方的火车，从此再没有见过面。"
    "她一直以为母亲是嫌弃她的，直到今天才知道，那趟车票是母亲用最后一点积蓄买的。"
    "窗外的雨下得更大了，雨点砸在玻璃上噼啪作响。",
    # ~200 字（接近单段上限，看长文本语速是否漂移）
    "林晚秋站在梧桐路十七号的铁门前，手里的铜钥匙已经被汗浸湿。"
    "这栋洋房比照片上更旧，爬山虎几乎盖住了整面外墙，窗户蒙着厚厚的灰。"
    "她深吸一口气，把钥匙插进锁孔。锁芯发出干涩的摩擦声，然后咔哒一声开了。"
    "门后是一条长长的走廊，尽头挂着一盏昏黄的灯。走廊两侧的墙上，"
    "整整齐齐挂着几十张照片，每一张都是她——从襁褓里的婴儿，到今天的模样。"
    "有人一直在看着她长大。",
]


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(OUT_DEFAULT))
    a = ap.parse_args()

    from app.providers.tts import TTSProvider
    from app.media import probe_duration_local, UPLOAD_DIR

    prov = TTSProvider()
    if not prov.available:
        sys.exit("TTS 未配置（缺 RunningHub key/工作流），无法探测")

    refs = [p for p in UPLOAD_DIR.glob("*")
            if p.suffix.lower() in (".wav", ".mp3", ".m4a", ".flac", ".aac")]
    if not refs:
        sys.exit(f"没有可用的参考音色。请先往 {UPLOAD_DIR} 放一段人声音频")
    ref_local = max(refs, key=lambda p: p.stat().st_mtime)
    print(f"参考音色: {ref_local.name}")
    print(f"样本: {len(SAMPLES)} 条，**全部并发**（RunningHub 上限 800，打不到）\n")

    ref_name = await prov.upload_ref_voice(ref_local)
    print("参考音色已上传，开始并发合成…\n")

    t_start = time.time()
    done = {"n": 0}

    async def one(i: int, text: str) -> dict:
        n = len(text)
        t0 = time.time()
        try:
            url = await prov.synth(ref_name, text)
            dur = await probe_duration_local(url)
            done["n"] += 1
            r = {"chars": n, "sec": round(dur, 3),
                 "rate": round(n / dur, 3) if dur > 0 else 0,
                 "elapsed": round(time.time() - t0, 1), "text": text[:30]}
            print(f"  [{done['n']:2d}/{len(SAMPLES)}] {n:3d}字 → {dur:6.2f}s  "
                  f"({r['rate']:5.2f} 字/秒)")
            return r
        except Exception as e:  # noqa: BLE001
            done["n"] += 1
            print(f"  [{done['n']:2d}/{len(SAMPLES)}] {n:3d}字 → 失败 {repr(e)[:90]}")
            return {"chars": n, "error": repr(e)[:200]}

    rows = await asyncio.gather(*(one(i, t) for i, t in enumerate(SAMPLES)))
    ok = [r for r in rows if "sec" in r]
    wall = time.time() - t_start
    print(f"\n并发总耗时 {wall:.0f}s（串行需 ~{len(SAMPLES) * 65}s）")

    if len(ok) < 3:
        sys.exit("有效样本太少，无法回归")

    rates = [r["rate"] for r in ok]
    mean_r = statistics.mean(rates)
    med_r = statistics.median(rates)
    slow = min(rates)

    # 线性拟合 sec = a*chars + b
    n_ = len(ok)
    sx = sum(r["chars"] for r in ok)
    sy = sum(r["sec"] for r in ok)
    sxy = sum(r["chars"] * r["sec"] for r in ok)
    sxx = sum(r["chars"] ** 2 for r in ok)
    a_ = (n_ * sxy - sx * sy) / (n_ * sxx - sx * sx)
    b_ = (sy - a_ * sx) / n_

    print("\n" + "=" * 58)
    print("=== 回归结果 ===")
    print(f"  字/秒：均值 {mean_r:.2f}  中位 {med_r:.2f}  "
          f"范围 {min(rates):.2f}~{max(rates):.2f}")
    print(f"  线性拟合：时长 ≈ {a_:.4f} × 字数 + {b_:.2f}")
    print(f"  保守速率（最慢）：{slow:.2f} 字/秒")
    print("\n  按上限反推每段字数：")
    for limit in (8, 10, 12, 15, 20, 24):
        print(f"    {limit:>2}s → ≤{int(limit * slow):3d} 字"
              f"（线性式 ≤{int((limit - b_) / a_) if a_ > 0 else 0:3d} 字）")

    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({
        "probed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "ref_voice": ref_local.name,
        "samples": rows,
        "mean_rate": round(mean_r, 3),
        "median_rate": round(med_r, 3),
        "slow_rate": round(slow, 3),
        "linear": {"a": round(a_, 5), "b": round(b_, 3)},
        "wall_sec": round(wall, 1),
    }, ensure_ascii=False, indent=2))
    print(f"\n已写入 {out}")
    print("把「保守速率」填进 script_import.py::_CHARS_PER_SEC")


if __name__ == "__main__":
    asyncio.run(main())
