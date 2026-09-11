#!/usr/bin/env python3
"""verify_scene_canon.py — U3 场景归一「预览 + 逐组确认」的后端语义验证

## 为什么要有这个脚本

场景归一是**有损**的：同一归一名下的多行 `Asset(kind="location")` 会被合并成一行，
多余的那行直接 `session.delete()`。被删的那行可能已经出过图、花过钱，而且删了就没了。

所以这条链路上有两件事必须钉死，且都**不会报错**：

  · **预览与执行不同口径** —— 预览说"保留 A、删掉 B"，执行时却删了 A。
    两处各写一遍留存优先级就会这样漂移，所以 `_keep_rank` 是共用的，这里验证它。
  · **收敛越界** —— 用户确认的是一组，执行时却把库里其它组（早先 `stages_draft`
    内部跑 AI 归一写下的、用户从没看过的别名）一起收敛了，顺带删掉别的资产行。
    这就是 `scoped_assets=True` / `only_canon` 存在的唯一理由。

全程**不调模型**：分组直接用手写的，验的是"给定分组后会发生什么"。
建的测试项目用完即删（`finally` 里清，断言失败也不留垃圾）。

    cd backend && /usr/bin/python3 scripts/verify_scene_canon.py
"""
from __future__ import annotations

import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.db import Asset, Project, SceneAlias, Shot, get_session  # noqa: E402
from app.scenes import (apply_scene_groups, canonical_map,  # noqa: E402
                        preview_groups, set_alias)

PASS = FAIL = 0


def ok(cond: bool, name: str, extra: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"   ✅ {name}")
    else:
        FAIL += 1
        print(f"   ❌ {name}" + (f"  — {extra}" if extra else ""))


#: 同一个客厅的三种写法（第 3 种带集场号，确定性清洗就能并掉前两种之外的差异）
LIVING = ["日 内 楚家公馆-客厅", "楚家公馆 客厅", "1-3 夜 内 楚家公馆 客厅"]
STREET = "外 老城区街道"
#: 与本次确认无关的另一组（模拟库里早先由 AI 写下、用户没看过的别名）
OTHER = ["星云塔顶层 星空餐厅", "夜 内 星云塔 星空餐厅"]

pid = "t" + uuid.uuid4().hex[:11]


def seed() -> None:
    with get_session() as s:
        s.add(Project(id=pid, title="_归一测试（脚本自动清理）",
                      base_aspect="9:16", production_mode="live_action"))
        order = 0
        for loc, n in [(LIVING[0], 3), (LIVING[1], 2), (LIVING[2], 1),
                       (STREET, 4), (OTHER[0], 2), (OTHER[1], 1)]:
            for _ in range(n):
                order += 1
                s.add(Shot(id=uuid.uuid4().hex[:12], project_id=pid,
                           order=order, episode=1, location=loc,
                           script_ref=f"第{order}镜", status="pending"))
        # 场景资产：两行指向同一个客厅 —— 一行有图（且叫原名）、一行无图但已叫归一名。
        # 这正是"合并会删掉哪一行"最容易搞错的组合。
        s.add(Asset(id=uuid.uuid4().hex[:12], project_id=pid, kind="location",
                    name=LIVING[0], image_url="/fw/media/generated/living_old.jpg"))
        s.add(Asset(id=uuid.uuid4().hex[:12], project_id=pid, kind="location",
                    name="楚家公馆 客厅"))
        # 另一组也有两行重复资产，用来验证"没确认的组不会被顺带合并"
        s.add(Asset(id=uuid.uuid4().hex[:12], project_id=pid, kind="location",
                    name=OTHER[0], image_url="/fw/media/generated/rest_a.jpg"))
        s.add(Asset(id=uuid.uuid4().hex[:12], project_id=pid, kind="location",
                    name=OTHER[1], image_url="/fw/media/generated/rest_b.jpg"))
        # 早先 AI 归一写下的别名（用户没看过）：让 OTHER 两个写法已经同归一名，
        # 于是"全项目收敛"会立刻删掉其中一行 —— 这是越界的可观测后果
        set_alias(s, pid, OTHER[0], "星云塔顶层 星空餐厅", source="ai")
        set_alias(s, pid, OTHER[1], "星云塔顶层 星空餐厅", source="ai")
        s.commit()


def cleanup() -> None:
    with get_session() as s:
        s.query(Shot).filter(Shot.project_id == pid).delete()
        s.query(Asset).filter(Asset.project_id == pid).delete()
        s.query(SceneAlias).filter(SceneAlias.project_id == pid).delete()
        p = s.get(Project, pid)
        if p:
            s.delete(p)
        s.commit()


try:
    seed()
    print(f"\n测试项目 {pid}（14 镜 / 4 个场景资产 / 2 条 AI 别名）")

    # ── [1] 预览：只算不写 ────────────────────────────────────────────
    print("\n[1] 预览（不写库）")
    group = {"canonical": "楚家公馆 客厅", "members": LIVING}
    with get_session() as s:
        before_alias = s.query(SceneAlias).filter(
            SceneAlias.project_id == pid).count()
        pv = preview_groups(s, pid, [group, {"canonical": "老城区街道",
                                             "members": [STREET]}])
    with get_session() as s:
        ok(s.query(SceneAlias).filter(SceneAlias.project_id == pid).count()
           == before_alias, "★ 预览一条别名都没写（有损动作不能在「看一眼」时发生）")
        ok(s.query(Asset).filter(Asset.project_id == pid).count() == 4,
           "预览一行资产都没删")

    g = next(x for x in pv if x["canonical"] == "楚家公馆 客厅")
    ok(g["shots"] == 6, f"客厅组镜头数 6（实得 {g['shots']}）")
    ok([m["raw_name"] for m in g["members"]] == LIVING, "成员齐全且保序")
    ok({m["raw_name"]: m["shots"] for m in g["members"]}
       == {LIVING[0]: 3, LIVING[1]: 2, LIVING[2]: 1}, "每个写法的镜头数正确")
    ok(g["changed"] is True, "客厅组有实际变化")
    ok([m["will_change"] for m in g["members"]] == [True, False, False],
       "★ 只有带「日 内」前缀那个写法会变（另两个确定性清洗后已是归一名）",
       str([m["current_canonical"] for m in g["members"]]))
    ok(g["locked"] == [], "没有人工锁定的成员")
    street = next(x for x in pv if x["canonical"] == "老城区街道")
    # 「外 老城区街道」被确定性清洗后本来就等于「老城区街道」——所以这一组
    # **没有任何变化**，但镜头数照样要报（界面用它显示"这个场景有 4 镜"）
    ok(street["changed"] is False and street["shots"] == 4,
       "★ 已经是归一名的组报 changed=False，但影响镜头数照样给（4 镜）",
       f"changed={street['changed']} shots={street['shots']}")
    ok(pv[0]["changed"] is True, "有变化的组排在前面（无变化的沉到后面）")

    # ── [2] 预览里的资产合并（不可逆那一段）────────────────────────────
    print("\n[2] 资产合并预览 = 执行时真正会删的那行")
    am = g["asset_merges"]
    ok(bool(am), "客厅组报出了资产合并")
    ok(am["keep"]["name"] == "楚家公馆 客厅",
       "★ 保留的是已叫归一名那行（与 _keep_rank 一致）", str(am))
    ok([d["name"] for d in am["drop"]] == [LIVING[0]],
       "被删的是叫原名那行", str(am))
    ok(am["drop"][0]["has_image"] is True,
       "★ 明确报出「被删那行有图」（用户据此决定要不要先换图）")
    ok(not street["asset_merges"], "街道组没有资产要合并 → 不报")

    # ── [3] 执行：只动确认过的那一组 ───────────────────────────────────
    print("\n[3] 逐组确认执行（scoped）")
    with get_session() as s:
        res = apply_scene_groups(s, pid, [group], source="manual",
                                 scoped_assets=True)
        s.commit()
    ok(res["updated"] >= 1, f"写了 {res['updated']} 条别名")
    with get_session() as s:
        rows = {r.raw_name: (r.canonical, r.source) for r in
                s.query(SceneAlias).filter(SceneAlias.project_id == pid).all()}
        ok(all(rows.get(m, ("", ""))[0] == "楚家公馆 客厅" for m in LIVING),
           "三种写法都归到同一个归一名", str(rows))
        ok(all(rows.get(m, ("", ""))[1] == "manual" for m in LIVING),
           "★ 源是 manual（AI 重跑归一不会推翻用户逐组确认的结果）")
        names = sorted(a.name for a in s.query(Asset).filter(
            Asset.project_id == pid).all())
        ok(names.count("楚家公馆 客厅") == 1 and LIVING[0] not in names,
           "客厅资产合并成一行", str(names))
        keep = s.query(Asset).filter(Asset.project_id == pid,
                                     Asset.name == "楚家公馆 客厅").first()
        ok(keep.image_url == "/fw/media/generated/living_old.jpg",
           "★ 留存行补上了被删行的图（合并只补空位，不丢已有产出）")
        ok(len([a for a in s.query(Asset).filter(Asset.project_id == pid).all()
                if a.name in OTHER]) == 2,
           "★★ 没确认的那组资产**一行都没动**（scoped 生效；全项目收敛会在这里删掉一行）",
           str(names))
        ok(rows.get(OTHER[0], ("", ""))[1] == "ai",
           "没确认的组仍是 ai 源，没被这次确认改写")
        # 镜头本身不动：归一是"映射"，不改 Shot.location（镜头留在原名空间）
        locs = {sh.location for sh in s.query(Shot).filter(
            Shot.project_id == pid).all()}
        ok(set(LIVING).issubset(locs),
           "★ 镜头的 location 原值未被改写（所以误合并可以改回来）")
        cm = canonical_map(s, pid)
        ok(all(cm[m] == "楚家公馆 客厅" for m in LIVING),
           "canonical_map 反映新映射（服装继承/场景基准帧据此判同一空间）")

    # ── [4] 幂等 ──────────────────────────────────────────────────────
    print("\n[4] 幂等")
    with get_session() as s:
        again = apply_scene_groups(s, pid, [group], source="manual",
                                   scoped_assets=True)
        s.commit()
    ok(again["updated"] == 0, f"再执行一次写 0 条（实得 {again['updated']}）")
    ok(again["assets"]["merged"] == 0, "再执行一次不删任何资产")
    with get_session() as s:
        pv2 = preview_groups(s, pid, [group])
        g2 = next(x for x in pv2 if x["canonical"] == "楚家公馆 客厅")
        ok(g2["changed"] is False,
           "★ 已生效的组预览显示「无变化」（界面据此不再催用户确认）")
        ok(not g2["asset_merges"], "已合并过 → 不再报资产合并")

    # ── [5] 推翻人工映射必须被标出来 ────────────────────────────────────
    print("\n[5] 人工锁定的成员会被标出")
    with get_session() as s:
        set_alias(s, pid, STREET, "老城区街道 南段", source="manual")
        s.commit()
        pv3 = preview_groups(s, pid, [{"canonical": "老城区街道",
                                       "members": [STREET]}])
    g3 = pv3[0]
    ok(g3["locked"] == [STREET],
       "★ 该成员已被人工改成别的归一名 → 列进 locked（确认就是推翻自己的手改）")
    ok(g3["members"][0]["source"] == "manual", "成员上也带出 source")
finally:
    cleanup()
    with get_session() as s:
        left = s.get(Project, pid)
    print(f"\n测试项目已清理：{'❌ 仍在' if left else '✅ 已删净'}")

print(f"\n{PASS} ✅ / {FAIL} ❌")
print("✅ 预览只读、报出的保留/删除与执行一致、确认只动那一组。" if not FAIL
      else "❌ 有断言不过 —— 别接前端，先看上面第一条 ❌。")
sys.exit(0 if FAIL == 0 else 1)
