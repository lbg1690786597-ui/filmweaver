"""verify_optimistic_lock.py — `transform_meta` 的乐观锁（批次 2 / 2.3）

## 验收标准（批次 2 原文）

  「两个客户端同时改同一镜头，后写的必须被拒绝并提示，而不是静默覆盖」

本脚本**真的跑一遍那个场景**：在一个临时 SQLite 库里建项目和镜头，
然后用两个各自持有版本号的"客户端"依次调用 `patch_shot_timeline`
（进程内直调路由函数，不起服务、不发网络请求、不签发任何令牌）。
断言的不只是"回了 409"，还包括**库里的值没被改动** ——
"拒绝"如果只是回了个状态码而数据已经写进去了，那才是最坏的情况。

覆盖的边界（每一条都对应一种会把锁做成摆设或做成故障的写法）：

  ① 后写方被拒 + 库里仍是先写方的值        —— 核心验收
  ② 被拒后不带 base 重试能成功            —— 否则用户被锁死在 409 里
  ③ 只改时长/顺序的调用不受影响           —— 否则时间轴拖拽会莫名 409
  ④ 冲突时**整笔**拒绝，时长也不许落库     —— 不能出现"半成功"的保存
  ⑤ 不带 base = 老客户端，跳过校验         —— 向后兼容
  ⑥ 同一内容的两次写不冲突                 —— 内容哈希方案的应得好处
  ⑦ /detail 与 PATCH 响应给出同一个版本号  —— 客户端拿不到 rev 就无从比对

跑法（不碰 dev/prod 任何数据库，用 tempfile）：

    cd /root/filmweaver-dev/backend && python3 scripts/verify_optimistic_lock.py
"""
import json
import os
import sys
import tempfile
import uuid
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))

# ⚠️ 必须在 import app.db 之前设好：engine 是模块级 create_engine，
# 导入那一刻就把 URL 定死了。放在 import 之后设等于什么都没做，
# 而后果是这个脚本会往**真实的 dev 库**里建测试项目。
_TMP = tempfile.mkdtemp(prefix="fw_lock_verify_")
os.environ["FW_DATABASE_URL"] = f"sqlite:///{_TMP}/verify.db"

from app.db import Base, Project, Shot, engine, get_session   # noqa: E402
from app import routes_v2 as R                                # noqa: E402
from fastapi import HTTPException                             # noqa: E402

failed = 0


def ok(cond, label, detail=""):
    global failed
    if cond:
        print(f"  ✓ {label}" + (f"  ({detail})" if detail else ""))
    else:
        failed += 1
        print(f"  ✗ {label}" + (f"  — {detail}" if detail else ""))


def patch(shot_id, **kw):
    """调路由函数，返回 (响应, 状态码)；抛 HTTPException 时状态码取自异常。"""
    try:
        return R.patch_shot_timeline(shot_id, R.ShotTimelineIn(**kw)), 200
    except HTTPException as e:
        return e.detail, e.status_code


def db_shot(shot_id):
    with get_session() as s:
        sh = s.get(Shot, shot_id)
        return (sh.transform_meta, sh.duration_sec)


# --------------------------------------------------------- 准备
print("\n[0] 临时库（不碰 dev/prod）")
ok(str(engine.url).startswith(f"sqlite:///{_TMP}"), "engine 指向临时库", str(engine.url))
ok("filmweaver_dev.db" not in str(engine.url)
   and "filmweaver_prod.db" not in str(engine.url), "既不是 dev 库也不是 prod 库")

Base.metadata.create_all(engine)
PID = uuid.uuid4().hex[:12]
SID = uuid.uuid4().hex[:12]
with get_session() as s:
    s.add(Project(id=PID, title="__verify_optimistic_lock__"))
    s.add(Shot(id=SID, project_id=PID, order=1, episode=1,
               script_ref="第1镜", duration_sec=5.0))
    s.commit()
ok(db_shot(SID) == (None, 5.0), "镜头就绪：还没有任何画面调整")

# --------------------------------------------------------- ⑦ 版本号的下发
print("\n[1] 版本号从哪来：/detail 与 PATCH 响应必须给同一个")
d = R.project_detail(PID)
sh_view = next(x for x in d["shots"] if x["id"] == SID)
ok("transform_rev" in sh_view, "/detail 下发 transform_rev")
rev0 = sh_view.get("transform_rev")
ok(rev0 == "0", "没有调整时版本号是稳定的 '0'（首次写入才有得可比）", str(rev0))

# --------------------------------------------------------- ① 核心验收
print("\n[2] 两个客户端同时改同一镜头：后写的被拒，且库里是先写方的值")
# 两端各自打开了同一个镜头，手里都是 rev0
a_base = b_base = rev0

r, st = patch(SID, transform_meta={"opacity": 50}, base_transform_rev=a_base)
ok(st == 200, "A 先写：成功", str(st))
rev1 = r.get("transform_rev") if isinstance(r, dict) else None
ok(bool(rev1) and rev1 != rev0, "A 写完版本号变了", f"{rev0} → {rev1}")
ok(json.loads(db_shot(SID)[0]) == {"opacity": 50}, "库里是 A 的值")

r, st = patch(SID, transform_meta={"scale": 120}, base_transform_rev=b_base)
ok(st == 409, "B 后写：被拒绝（409），而不是静默覆盖", str(st))
ok(isinstance(r, str) and "其他窗口" in r, "拒绝理由是人话，不是裸状态码", str(r)[:80])
ok(json.loads(db_shot(SID)[0]) == {"opacity": 50},
   "**库里仍是 A 的值** —— 拒绝是真的没写，不只是回了个状态码")

# --------------------------------------------------------- ④ 不许半成功
print("\n[3] 冲突时整笔拒绝：同一次请求里的时长也不许落库")
r, st = patch(SID, transform_meta={"scale": 120}, base_transform_rev=b_base,
              duration_sec=9.0)
ok(st == 409, "画面冲突 → 整笔 409", str(st))
ok(db_shot(SID)[1] == 5.0,
   "时长没变（若先改时长再校验画面，用户会拿到一次半成功的保存）", str(db_shot(SID)[1]))

# --------------------------------------------------------- ③ 不牵连其他字段
print("\n[4] 只改时长/顺序的调用不受锁影响（时间轴拖拽每天都在走这条）")
r, st = patch(SID, duration_sec=8.0, base_transform_rev="陈旧的版本号")
ok(st == 200, "没带 transform_meta → 不做并发校验", str(st))
ok(db_shot(SID)[1] == 8.0, "时长真的改了", str(db_shot(SID)[1]))
ok(json.loads(db_shot(SID)[0]) == {"opacity": 50}, "画面没被顺手动过")

# --------------------------------------------------------- ② 被拒后能继续干活
print("\n[5] B 被提示后再操作一次：不带 base → 以他的版本为准")
r, st = patch(SID, transform_meta={"scale": 120})
ok(st == 200, "重试成功（客户端 409 后 forget 了 base，见 lib/shotRev.ts）", str(st))
ok(json.loads(db_shot(SID)[0]) == {"scale": 120}, "现在库里是 B 的值")
rev2 = r.get("transform_rev") if isinstance(r, dict) else None
ok(bool(rev2) and rev2 not in (rev0, rev1), "版本号又变了", f"{rev1} → {rev2}")

# --------------------------------------------------------- ⑤ 向后兼容
print("\n[6] 老客户端（完全不发 base）照旧能存")
r, st = patch(SID, transform_meta={"scale": 130})
ok(st == 200 and json.loads(db_shot(SID)[0]) == {"scale": 130},
   "不带 base = 关掉乐观锁，不是拒绝")

# --------------------------------------------------------- ⑥ 相同内容不假冲突
print("\n[7] 两端把同一个值各写一遍：内容相同 → 不该冒出假冲突")
cur = R.transform_rev(db_shot(SID)[0])
r, st = patch(SID, transform_meta={"scale": 130}, base_transform_rev=cur)
ok(st == 200, "写入完全相同的内容，成功", str(st))
ok(R.transform_rev(db_shot(SID)[0]) == cur,
   "内容没变 → 版本号也没变（内容哈希的应得好处：列式版本号在这里会误报冲突）")

# --------------------------------------------------------- 清除调整
print("\n[8] 清除全部调整（传 {}）也走同一把锁")
r, st = patch(SID, transform_meta={}, base_transform_rev=cur)
ok(st == 200 and db_shot(SID)[0] is None, "空字典 = 清除，落 NULL")
ok(R.transform_rev(None) == "0", "清空后版本号回到 '0'")
r, st = patch(SID, transform_meta={"scale": 140}, base_transform_rev=cur)
ok(st == 409, "拿清除前的旧版本号再写 → 409（清除也是一次改动）", str(st))

# --------------------------------------------------------- 收尾
with get_session() as s:
    for sh in s.query(Shot).filter(Shot.project_id == PID).all():
        s.delete(sh)
    p = s.get(Project, PID)
    if p:
        s.delete(p)
    s.commit()
engine.dispose()
for f in Path(_TMP).glob("*"):
    f.unlink()
Path(_TMP).rmdir()
ok(not Path(_TMP).exists(), "临时库已删干净")

print("\n✅ 2.3 通过：后写方被 409 拒绝，且库里仍是先写方的值"
      if failed == 0 else f"\n❌ {failed} 项失败")
sys.exit(0 if failed == 0 else 1)
