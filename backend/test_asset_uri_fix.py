#!/usr/bin/env python3
"""验证 asset:// URI 修复：to_public_url 不再拼坏火山素材引用。"""
import sys
sys.path.insert(0, '.')

from app.providers.base import to_public_url

print("① to_public_url 对各类 URL 的处理：\n")

cases = [
    ("asset://asset-20260824141302-vx8gs", "asset://asset-20260824141302-vx8gs"),
    ("http://oss.example.com/a.png", "http://oss.example.com/a.png"),
    ("https://oss.example.com/b.png", "https://oss.example.com/b.png"),
    ("data:image/png;base64,iVBOR...", "data:image/png;base64,iVBOR..."),
    ("/fw/media/img_abc.png", "http://118.196.33.51:9080/fw/media/img_abc.png"),
]

all_pass = True
for inp, expect in cases:
    out = to_public_url(inp)
    ok = (out == expect)
    if not ok:
        all_pass = False
    print(f"  {'✅' if ok else '❌'} {inp[:40]:40s} → {out}")
    if not ok:
        print(f"     期望: {expect}")

print("\n② 完整推理流程测试（需要 .env 配置）：\n")

try:
    import asyncio
    from app.db import get_session, Job
    from app.jobs import generate_video_batch

    async def retry_job():
        job_id = '5e034a72513b'
        with get_session() as s:
            j = s.get(Job, job_id)
            if not j:
                print(f"  ✗ Job {job_id} 不存在")
                return

            # 重置状态
            j.error = '[]'
            j.status = 'pending'
            j.shots_done = sum(1 for sh in j.shots if sh.status == 'done')
            s.commit()
            print(f"  重置 job {job_id}  {j.shots_total} 镜，已完成 {j.shots_done} 镜")

        print("  开始生成...")
        await generate_video_batch(job_id)

        with get_session() as s:
            j = s.get(Job, job_id)
            print(f"\n  最终: {j.status}  {j.shots_done}/{j.shots_total} 完成")

            if j.error and j.error != '[]':
                import json
                errs = json.loads(j.error)
                print(f"  失败 {len(errs)} 条")
                if errs:
                    print(f"  样例: {errs[0].get('error', '')[:120]}")

    asyncio.run(retry_job())

except Exception as e:
    print(f"  跳过推理测试: {e}")

if all_pass:
    print("\n✅ asset:// URI 处理修复验证通过")
else:
    print("\n❌ 仍有问题")
