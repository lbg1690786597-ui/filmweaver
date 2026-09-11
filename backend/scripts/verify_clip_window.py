"""verify_clip_window.py — 取片窗口（入点/出点）的进程内实测（批次 3 / 3.1）

## 这个脚本要防的是「轨上 2.4s、成片里 5s」

一个镜头有**两个时长**：`duration_sec` 是时间轴上显示的长度（也是未出片时
的生成目标），`clip_in_sec`/`clip_dur_sec` 才是导出（`render/normalize.ts`）
与字幕定时（`effective_shot_sec`）真正消费的取片窗口。两者一旦分叉，用户看到
的就是轨上短了、成片没变，**全程零报错**。

所以本脚本盯三件事，每一件都只能在真库里验：

  ① **不变式** `duration_sec == clip_dur_sec`。`split_shot` / `unsplit_shot`
     一直在维持它，`patch_shot_timeline` 是第三个写入者。
  ② **窗口下限是 0.1 不是 1.0**。库里真实存在 0.75s / 0.99s 的碎片
     （split 只保证两侧各留 0.5s）。floor 到 1.0 = 把用户想剪短的东西**拉长**。
  ③ **半个窗口不许留**：只有 `clip_in_sec` 没有 `clip_dur_sec` 时，导出会按
     `-ss 入点 -t duration_sec` 取片（比用户看到的长），而前端判「有没有窗口」
     看的是 `clip_dur_sec`，会认为这镜压根没被修剪过。

⚠️ 断言的是「响应说的」**与**「库里真的是」两者都对 —— 只看响应会漏掉
少 commit 这一类错误。

直连路由函数、自建临时行，**不签发任何令牌**；跑完删干净（finally）。

用法：`python3 backend/scripts/verify_clip_window.py`（跑在 dev 库上）
"""
import sys, uuid
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.db import Project, Shot, get_session, reset_clip_window
from app.routes_v2 import patch_shot_timeline, ShotTimelineIn

fails = []
def ck(name, actual, expected):
    good = actual == expected
    if not good: fails.append(name)
    print(f"  {'✅' if good else '❌'} {name}")
    if not good: print(f"      期望 {expected}  实际 {actual}")

pid = "probe31-" + uuid.uuid4().hex[:8]
sid = "probe31s-" + uuid.uuid4().hex[:8]
with get_session() as s:
    s.add(Project(id=pid, title="probe31 临时项目"))
    s.add(Shot(id=sid, project_id=pid, episode=1, order=9001,
               script_ref="probe31", duration_sec=8.0,
               video_url="/media/probe31.mp4"))
    s.commit()

def db():
    with get_session() as s:
        sh = s.get(Shot, sid)
        return (sh.duration_sec, sh.clip_in_sec, sh.clip_dur_sec)

try:
    print("\n① 建窗口：拖左边缘（inPatch 发的三个字段）")
    r = patch_shot_timeline(sid, ShotTimelineIn(
        duration_sec=5.6, clip_in_sec=2.4, clip_dur_sec=5.6))
    ck("响应回的入点", r.get("clip_in_sec"), 2.4)
    ck("响应回的窗口长度", r.get("clip_dur_sec"), 5.6)
    ck("库里三个字段（响应≠库 = 少了一次 commit）", db(), (5.6, 2.4, 5.6))

    print("\n② 不变式：只发 clip_dur_sec，duration_sec 必须跟着走")
    patch_shot_timeline(sid, ShotTimelineIn(clip_dur_sec=2.4))
    ck("duration_sec 被回写成 clip_dur_sec", db(), (2.4, 2.4, 2.4))

    print("\n③ 小数不被抹成整秒（3.2 的两端之一，这里再确认一次）")
    patch_shot_timeline(sid, ShotTimelineIn(duration_sec=3.7, clip_dur_sec=3.7))
    ck("2 位小数原样落库", db(), (3.7, 2.4, 3.7))

    print("\n④ 窗口下限 0.1（不是 1.0）—— 0.75s 的碎片不许被拉长")
    patch_shot_timeline(sid, ShotTimelineIn(clip_dur_sec=0.75))
    ck("0.75 原样存下（floor 到 1.0 就是把想剪短的拉长了）", db(), (0.75, 2.4, 0.75))
    patch_shot_timeline(sid, ShotTimelineIn(clip_dur_sec=0.01))
    ck("低于 0.1 才被钳到 0.1", db(), (0.1, 2.4, 0.1))

    print("\n⑤ 半个窗口会被补齐（只发入点、不发长度）")
    patch_shot_timeline(sid, ShotTimelineIn(clear_clip_window=True))
    ck("先清干净", db(), (0.1, None, None))
    patch_shot_timeline(sid, ShotTimelineIn(duration_sec=4.0))
    patch_shot_timeline(sid, ShotTimelineIn(clip_in_sec=1.5))
    ck("clip_dur_sec 从 duration_sec 补齐，不留半个窗口", db(), (4.0, 1.5, 4.0))

    print("\n⑥ 取消入点：起点回 0，长度不动")
    r = patch_shot_timeline(sid, ShotTimelineIn(clear_clip_window=True))
    ck("库里窗口已清", db(), (4.0, None, None))
    ck("响应也回 None（前端据此收起「取消入点」按钮）",
       (r.get("clip_in_sec"), r.get("clip_dur_sec")), (None, None))

    print("\n⑦ 上限跟项目模型走，不是常数 15")
    patch_shot_timeline(sid, ShotTimelineIn(clip_in_sec=0.0, clip_dur_sec=999))
    d = db()
    ck("被钳到项目上限（≥15）", d[2] >= 15.0 and d[2] == d[0], True)

    print("\n⑧ reset_clip_window：只清窗口，不动 duration_sec")
    with get_session() as s:
        sh = s.get(Shot, sid)
        before = sh.duration_sec
        had = reset_clip_window(sh)
        s.commit()
    ck("回报「确实清掉了东西」（调用方据此提示用户）", had, True)
    ck("duration_sec 没被顺手清掉", db(), (before, None, None))
    with get_session() as s:
        ck("已经是空窗口时回报 False（不平白提示）",
           reset_clip_window(s.get(Shot, sid)), False)
finally:
    with get_session() as s:
        sh = s.get(Shot, sid)
        if sh: s.delete(sh)
        pr = s.get(Project, pid)
        if pr: s.delete(pr)
        s.commit()
    with get_session() as s:
        print("\n⑨ 清理：临时行已删 →",
              s.get(Shot, sid) is None and s.get(Project, pid) is None)

# ⑩ 存量数据体检。上面测的是"新写进去的对不对"，这一步测的是
# **库里已经有的那些**对不对 —— 违例行不会报错、只会在导出时悄悄变长/变短，
# 所以只能靠主动扫。窗口主要来自 split_shot，它一直维持着不变式；
# 这里若出现非零，说明有第四个写入者绕过了 patch_shot_timeline。
from sqlalchemy import select                                    # noqa: E402
with get_session() as s:
    allshots = list(s.execute(select(Shot)).scalars())
windowed = [r for r in allshots if r.clip_dur_sec is not None]
bad = [(r.id, r.duration_sec, r.clip_dur_sec) for r in windowed
       if abs((r.duration_sec or 0) - r.clip_dur_sec) > 1e-6]
half = [r.id for r in allshots
        if r.clip_in_sec is not None and r.clip_dur_sec is None]
print(f"\n⑩ 存量体检：有窗口 {len(windowed)} 行")
ck("不变式违例 0 行（非 0 = 有人绕过了 patch_shot_timeline）", bad, [])
ck("半个窗口 0 行", half, [])
leftover = [r.id for r in allshots if r.id.startswith("probe31")]
ck("没有历史遗留的临时行", leftover, [])

print("\n✅ 进程内实测全部通过" if not fails else f"\n❌ {len(fails)} 项失败：{fails}")
sys.exit(1 if fails else 0)
