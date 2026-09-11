"""提交去重 + 阶段可见性验证。

背景（2026-08 真实事故）：用户点「▶ 全部生成」后，i2va 流水线要先把整批首帧
生完才提交视频，头几分钟界面上只有"已出片 0/170"、进度条纹丝不动，看着像卡死。
用户于是又点了一次 —— 后端没有任何去重，于是同一批 170 个镜头被排了两遍，
其中 113 个真的生成了两份视频（shot_versions 里 170 个镜头躺了 276 个版本）。

这里验证两条修复：
  ① find_active_job：同项目、同互斥组已有 pending/running 就不许再开一批
  ② 阶段可见：进度按 首帧40% : 视频60% 分配，并带「正在出首帧 N/M」标签
"""
from __future__ import annotations

import sys

sys.path.insert(0, "/root/filmweaver-dev/backend")

from app.jobs import (_update, create_job, find_active_job,  # noqa: E402
                      get_job_phase, set_job_phase)

FAILS = 0
PASSES = 0


def check(name: str, cond: bool, extra: object = "") -> None:
    global FAILS, PASSES
    if cond:
        PASSES += 1
        print(f"  ✅ {name}")
    else:
        FAILS += 1
        print(f"  ❌ {name} {extra}")


PID = "__test_dedup_project__"
PID2 = "__test_dedup_other__"
made: list[str] = []


def mk(kind: str, project_id: str | None, status: str = "running") -> str:
    jid = create_job(kind, {"project_id": project_id} if project_id else {})
    _update(jid, status=status)
    made.append(jid)
    return jid


print("\n[1] 同项目同 kind：第二次提交命中已在跑的那个")
j1 = mk("shot_videos", PID)
check("命中并返回既有 job", find_active_job("shot_videos", PID) == j1)

print("\n[2] 同互斥组跨 kind：一条龙内部就是首帧+片段，不许与出片并行")
check("first_frame_pipeline 被 shot_videos 挡住",
      find_active_job("first_frame_pipeline", PID) == j1)
check("first_frames 被挡住", find_active_job("first_frames", PID) == j1)
check("one_click_film 被挡住", find_active_job("one_click_film", PID) == j1)

print("\n[3] 不同互斥组互不干扰（资产/拆解与出片是不同资源）")
check("asset_batch 放行", find_active_job("asset_batch", PID) is None)
check("breakdown_all 放行", find_active_job("breakdown_all", PID) is None)

print("\n[4] 不同项目互不干扰")
check("另一个项目放行", find_active_job("shot_videos", PID2) is None)
j2 = mk("shot_videos", PID2)
check("各自命中各自的", find_active_job("shot_videos", PID2) == j2
      and find_active_job("shot_videos", PID) == j1)

print("\n[5] job 收尾后放行（否则一次卡死的任务会永久锁住项目）")
_update(j1, status="done")
check("done 后放行", find_active_job("shot_videos", PID) is None)
j3 = mk("shot_videos", PID, status="failed")
check("failed 的 job 不参与去重", find_active_job("shot_videos", PID) is None)
j4 = mk("shot_videos", PID, status="pending")
check("pending（还没被 BackgroundTasks 拉起）也算在跑",
      find_active_job("shot_videos", PID) == j4)

print("\n[6] 边界：无 project_id / 未登记的 kind 一律放行，不误伤单镜重生")
check("payload 没有 project_id → 不去重", find_active_job("shot_videos", None) is None)
j5 = mk("shot_videos", None)
check("库里那条无 project_id 的 job 不会误命中别人",
      find_active_job("shot_videos", PID) == j4)
check("未登记的 kind（如 compose/tts_batch）不去重",
      find_active_job("compose", PID) is None
      and find_active_job("tts_batch", PID) is None)

print("\n[7] 阶段标签：写入 → 读出 → job 收尾自动清除（防 dict 无限增长）")
set_job_phase(j4, {"key": "frames", "label": "正在出首帧", "done": 32, "total": 170})
ph = get_job_phase(j4)
check("读回阶段标签", ph is not None and ph["label"] == "正在出首帧", ph)
_update(j4, progress=20)
check("progress 变更不会误清阶段", get_job_phase(j4) is not None)
_update(j4, status="done")
check("job 收尾后阶段被清除", get_job_phase(j4) is None)

print("\n[8] 阶段化进度公式：首帧 40% / 视频 60%")
# 与 run_shot_videos._report 同一算式。要点是"整批首帧还没出完时进度也在动"——
# 否则前 40% 的时间里进度条纹丝不动，用户唯一能得到的信号就是"像死了"。
def pct(frames_done: int, frames_total: int, videos_done: int, videos_total: int) -> int:
    if frames_total:
        return int(40 * frames_done / frames_total + 60 * videos_done / videos_total)
    return int(videos_done / videos_total * 100)

check("刚开始 = 0%", pct(0, 170, 0, 170) == 0)
check("首帧出了一半、一片未出 = 20%（旧版这里恒为 0，正是'卡死'观感的来源）",
      pct(85, 170, 0, 170) == 20, pct(85, 170, 0, 170))
check("首帧全出、一片未出 = 40%", pct(170, 170, 0, 170) == 40)
check("全部出完 = 100%", pct(170, 170, 170, 170) == 100)
check("非 i2va 项目（无首帧阶段）沿用老口径 0-100%",
      pct(0, 0, 85, 170) == 50 and pct(0, 0, 170, 170) == 100)

# 清理测试 job，别把 dev 库的 jobs 表撑成垃圾场
from app.db import Job, get_session  # noqa: E402
with get_session() as s:
    for jid in made:
        row = s.get(Job, jid)
        if row:
            s.delete(row)
    s.commit()

print(f"\n{'=' * 50}\n通过 {PASSES} 项，失败 {FAILS} 项\n{'=' * 50}")
sys.exit(1 if FAILS else 0)
