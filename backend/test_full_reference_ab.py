"""全能参考(full_reference) vs 首帧生视频(i2va) 对照实验。

背景（用户 2026-08 反馈）：i2va 这条链路是"当年只有 veo 这类首帧生视频模型"
时期的产物。现在 minimax-h3-ref2v 与 seedance-2.0-mini 都能直接吃多张参考图
（full_reference），首帧那一跳既多花一次生图钱、又引入一次信息损耗
（首帧把"人是谁 + 场景长什么样"压成一张图，视频模型只能看到这张图的解读结果）。

本脚本对同一批镜头，用**项目现有的参考图注入规则 + 现有提示词优化框架**，
在 full_reference 模式下分别跑 seedance-2.0-mini 与 minimax-h3-ref2v，
产物与库里已有的 i2va 版本并列，供人工比对。

⚠️ 只读库、只写生成结果到 media 目录，**不改 shots.video_url / 不落 shot_versions**，
   所以跑完不会污染项目的已采用版本。
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time

sys.path.insert(0, "/root/filmweaver-dev/backend")

from app.db import Shot, get_session  # noqa: E402
from app.jobs import _FRAME_REF_LIMIT, _auto_inject_refs  # noqa: E402
from app.prompt_opt import optimize_to_prompt  # noqa: E402
from app.providers.base import VideoRequest, infer_generation_mode  # noqa: E402
from app.providers.registry import register_defaults, registry  # noqa: E402

#: 参赛模型。两者都自称支持 full_reference，实测校验见输出的 mode_support 一行。
MODELS = ["seedance-2.0-mini", "minimax-h3-ref2v"]


def build_ctx(model_id: str, n_refs: int, labels: list[str],
              duration_ms: int | None) -> str:
    """复刻 run_shot_videos 里 full_reference 分支的 extra_context 组装。

    刻意不走 i2va 那段"外观以首帧为准"的指令——那是首帧路线专用，
    全能参考路线恰恰需要提示词**配合参考图**点名谁是谁。
    """
    ctx = ["生成模式: full_reference"]
    if duration_ms:
        ctx.append(f"目标时长: {duration_ms / 1000:.2f} 秒")
    if n_refs:
        if model_id.startswith("seedance") and labels:
            listing = "; ".join(f"图片{i + 1}={lb}" for i, lb in enumerate(labels))
            ctx.append(
                f"本次实际提供 {len(labels)} 张参考图: {listing}。"
                f"提示词中可用 @图片N 引用对应角色/场景（如 @图片1）保持形象一致；"
                f"除这些外不存在任何图片，严禁引用或发明其它 @图片N")
        else:
            ctx.append(f"参考图 {n_refs} 张(角色/场景定妆参考)"
                       + ("；提示词中严禁出现 @图片N 等图片引用"
                          if model_id.startswith("seedance") else ""))
    return "; ".join(ctx)


async def run_one(model_id: str, shot: dict, aspect: str, megapixels: float) -> dict:
    """单模型单镜生成，返回耗时/URL/提示词/错误。异常一律吃掉，不打断整批。"""
    provider = registry.get_video(model_id)
    if provider is None:
        return {"model": model_id, "order": shot["order"], "error": f"{model_id} 未注册"}

    support = provider.mode_support().get("full_reference", {})
    if not support.get("available"):
        return {"model": model_id, "order": shot["order"],
                "error": f"{model_id} 不支持 full_reference: {support}"}

    # 参考图张数按视频模型自身能力封顶（seedance 4 / H3 9），与生产路径同口径
    cap = getattr(provider, "max_reference_images", 0)
    refs, labels = _auto_inject_refs(shot["id"], cap)

    ms = int((shot["duration_sec"] or 5) * 1000)
    ctx = build_ctx(model_id, len(refs), labels, ms)
    prompt = await optimize_to_prompt(
        shot["gen_prompt"] or shot["script_ref"], video_model_id=model_id,
        extra_context=ctx)

    vreq = VideoRequest(
        prompt=prompt,
        generation_mode="full_reference",
        reference_image_urls=refs,
        duration_ms=ms,
        aspect_ratio=aspect,
        megapixels=megapixels,
    )
    inferred = infer_generation_mode(vreq)

    t0 = time.monotonic()
    try:
        res = await provider.submit(vreq)
    except Exception as e:  # noqa: BLE001
        return {"model": model_id, "order": shot["order"], "elapsed": time.monotonic() - t0,
                "error": repr(e), "prompt": prompt, "refs": refs, "labels": labels}
    return {
        "model": model_id, "order": shot["order"], "elapsed": round(time.monotonic() - t0, 1),
        "status": res.status, "video_url": res.video_url, "error": res.error,
        "prompt": prompt, "refs": refs, "labels": labels, "inferred_mode": inferred,
    }


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", default="e3e5d6e517c6")
    ap.add_argument("--orders", default="57,159,163",
                    help="镜号，逗号分隔（默认三镜：参考图覆盖齐全、时长 3-4s 控成本）")
    ap.add_argument("--models", default=",".join(MODELS))
    ap.add_argument("--out", default="/root/filmweaver-dev/backend/ab_full_reference.json")
    args = ap.parse_args()

    register_defaults()
    orders = [int(o) for o in args.orders.split(",") if o.strip()]
    models = [m.strip() for m in args.models.split(",") if m.strip()]

    with get_session() as s:
        proj_rows = s.query(Shot).filter(Shot.project_id == args.project,
                                         Shot.order.in_(orders)).all()
        shots = [{"id": r.id, "order": r.order, "episode": r.episode,
                  "location": r.location, "characters": r.characters,
                  "script_ref": r.script_ref, "gen_prompt": r.gen_prompt,
                  "duration_sec": r.duration_sec,
                  "i2va_video": r.video_url, "first_frame": r.first_frame_url}
                 for r in sorted(proj_rows, key=lambda r: r.order)]

    print(f"参赛模型: {models}")
    for m in models:
        p = registry.get_video(m)
        print(f"  {m:22} 注册={'✓' if p else '✗'} "
              f"max_refs={getattr(p, 'max_reference_images', '-')} "
              f"full_reference={p.mode_support().get('full_reference') if p else '-'}")
    print(f"\n测试镜头 {len(shots)} 个 × {len(models)} 模型 = {len(shots) * len(models)} 次生成\n")

    tasks = [run_one(m, sh, "9:16", 0.5) for sh in shots for m in models]
    out = await asyncio.gather(*tasks)

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump({"project": args.project, "shots": shots, "results": out},
                  f, ensure_ascii=False, indent=2)

    print(f"\n{'=' * 72}")
    for sh in shots:
        print(f"\n镜 #{sh['order']} ep{sh['episode']} {sh['location']} "
              f"{sh['duration_sec']}s  角色={sh['characters']}")
        print(f"  [i2va 现有]        {sh['i2va_video']}  (首帧 {sh['first_frame']})")
        for r in out:
            if r["order"] != sh["order"]:
                continue
            tag = f"[{r['model']}]"
            if r.get("error"):
                print(f"  {tag:22} ❌ {str(r['error'])[:120]}")
            else:
                print(f"  {tag:22} {r.get('status')} {r.get('video_url')} "
                      f"({r.get('elapsed')}s, {len(r.get('refs') or [])} 张参考图)")
    print(f"\n完整结果（含各模型优化后的提示词全文）：{args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
