"""verify_stage_softdelete.py — 造型阶段的删除是**可撤销**的（2026-09-09 需求 2）

用户原话：「阶段删除后似乎没有撤销删除的能力」。以前 `DELETE /v2/stages/{id}`
是真删（`session.delete`），误删一个已出定妆图的阶段就把那张图彻底丢了——
"重跑服装识别"并不能找回来：那是按剧本**重新规划**，产出的是新 id、没有图的
阶段，要重新花钱生图，名字与集区间都可能与用户删掉的那条不同。

现在改成墓碑（`AssetStage.deleted_at` + `app/stage_gate.py` 统一闸门）。
本脚本钉住的是墓碑必须同时满足的两组性质：

  · 立刻**失效**：不进轨道、不算缺图缺口、不当基准脸、不能编辑/合并
  · 完好**可逆**：行与图都在，restore 后原样回来

外加两个"最容易悄悄失效"的点：

  · 造型规划里那句清理 `.delete()` 必须带 `deleted_at.is_(None)`，
    否则用户点一次「服装识别」就把恢复入口删干净了（F 段）
  · 恢复可能撞车：墓碑刻意**不占**集区间，所以删完之后用户可能在同一段集里
    建了新造型。此时必须 409 并**点名**撞的是谁，不能悄悄恢复出两套并存的
    造型——那样生图/注入只能随机挑一套（E 段）

跑法（在 backend/ 下）：
    PYTHONPATH=. python3 scripts/verify_stage_softdelete.py

直连路由函数、自造数据，不签发任何令牌；用一次性项目，跑完删干净，不碰用户项目。
"""

import asyncio
import uuid
from fastapi import HTTPException

from app.db import Asset, AssetStage, Project, get_session
from app import routes_v2 as R
from app.readiness import compute_readiness

pid = "T" + uuid.uuid4().hex[:11]
S1 = "S1" + uuid.uuid4().hex[:10]
S2 = "S2" + uuid.uuid4().hex[:10]
ok = fail = 0

def check(label, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1; print(f"  ✅ {label} {extra}")
    else:
        fail += 1; print(f"  ❌ {label} {extra}")

with get_session() as s:
    s.add(Project(id=pid, title="__stage_softdelete_probe__"))
    s.add(Asset(id="A" + uuid.uuid4().hex[:11], project_id=pid,
                kind="character", name="阿测", image_url=None))
    s.add(AssetStage(id=S1, project_id=pid, character_name="阿测",
                     stage_name="校服", ep_from=1, ep_to=3,
                     image_url="/media/fake1.png", status="confirmed"))
    s.add(AssetStage(id=S2, project_id=pid, character_name="阿测",
                     stage_name="西装", ep_from=4, ep_to=6,
                     image_url="/media/fake2.png", status="confirmed"))
    s.commit()

print("── A. 删除是软的，且立刻从在用列表消失 ──")
r = R.delete_stage(S1)
check("delete 返回软删信息", r["ok"] and r.get("deleted_at") and r.get("kept_image") is True, r)
with get_session() as s:
    row = s.get(AssetStage, S1)
    check("数据库行还在（不是真删）", row is not None)
    check("图还挂在行上（恢复后可用）", row.image_url == "/media/fake1.png")
    check("deleted_at 已写", bool(row.deleted_at))

ls = R.list_stages(pid)
alive_ids = [x["id"] for x in ls["stages"] if not x.get("virtual")]
check("stages 里没有墓碑", S1 not in alive_ids and S2 in alive_ids, alive_ids)
check("deleted_stages 里有它", [x["id"] for x in ls["deleted_stages"]] == [S1])
check("墓碑带图（用户靠图认造型）",
      ls["deleted_stages"][0]["image_url"] == "/media/fake1.png")

print("── B. 幂等与编辑闸门 ──")
r2 = R.delete_stage(S1)
check("重复删不报错", r2.get("already_deleted") is True)
try:
    # patch_stage 是 async 路由：必须 await，否则协程根本没跑，
    # 断言等于没测（上一版就在这儿假绿）。
    asyncio.run(R.patch_stage(S1, R.StagePatchIn(stage_name="改名试试")))
    check("墓碑不可编辑", False, "竟然改成功了")
except HTTPException as e:
    check("墓碑不可编辑", e.status_code == 409, e.detail)
try:
    R.merge_stages(R.StageMergeIn(stage_ids=[S1, S2]))
    check("墓碑不可参与合并", False, "竟然合并成功了")
except HTTPException as e:
    check("墓碑不可参与合并", e.status_code == 409, e.detail)

print("── C. 不再计入缺口 / 不再当基准脸 ──")
with get_session() as s:
    s.get(AssetStage, S2).image_url = None
    s.commit()
rd = compute_readiness(pid)
ids = [x["id"] for x in rd["assets"]["stages_no_image"]]
check("readiness 只报在用的缺图阶段", ids == [] or S1 not in ids, ids)
check("costumes.stages_total 不含墓碑", rd["costumes"]["stages_total"] == 1,
      rd["costumes"]["stages_total"])
from app.asset_ref import character_base_ref
with get_session() as s:
    ref = character_base_ref(s, pid, "阿测")
check("删掉的造型不再当基准脸", ref is None, repr(ref))
with get_session() as s:
    s.get(AssetStage, S2).image_url = "/media/fake2.png"
    s.commit()

print("── D. 撤销删除 ──")
r3 = R.restore_stage(S1)
check("restore 成功", r3["ok"] and r3["stage"]["id"] == S1)
ls2 = R.list_stages(pid)
check("恢复后回到在用列表",
      S1 in [x["id"] for x in ls2["stages"] if not x.get("virtual")])
check("恢复后墓碑组空了", ls2["deleted_stages"] == [])
check("图原样回来", next(x for x in ls2["stages"] if x["id"] == S1)["image_url"]
      == "/media/fake1.png")
check("重复恢复不报错", R.restore_stage(S1).get("already_alive") is True)

print("── E. 区间被后建阶段占了 → 409 且点名撞的是谁 ──")
R.delete_stage(S1)
S3 = "S3" + uuid.uuid4().hex[:10]
with get_session() as s:
    s.add(AssetStage(id=S3, project_id=pid, character_name="阿测",
                     stage_name="新校服", ep_from=2, ep_to=3, status="draft"))
    s.commit()
try:
    R.restore_stage(S1)
    check("区间冲突时拒绝恢复", False, "竟然恢复成功了")
except HTTPException as e:
    check("区间冲突时拒绝恢复", e.status_code == 409, "")
    check("提示里点名了撞的那条", "新校服" in e.detail and "第2-3集" in e.detail, e.detail)

print("── F. 重跑造型规划不会抹掉墓碑（否则恢复入口没了）──")
with get_session() as s:
    # 造型规划里那句 delete()：只清"在用且无图"的阶段
    n = s.query(AssetStage).filter(
        AssetStage.project_id == pid,
        AssetStage.deleted_at.is_(None),
        AssetStage.image_url.is_(None)).delete()
    s.commit()
    check("清理只删在用无图行", n == 1, f"删了 {n} 行（新校服）")
    check("墓碑仍在", s.get(AssetStage, S1) is not None)

# 清场
with get_session() as s:
    s.query(AssetStage).filter(AssetStage.project_id == pid).delete()
    s.query(Asset).filter(Asset.project_id == pid).delete()
    s.query(Project).filter(Project.id == pid).delete()
    s.commit()
print(f"\n{'✅ 全部通过' if not fail else f'❌ {fail} 项失败'}（{ok} 项通过）")
