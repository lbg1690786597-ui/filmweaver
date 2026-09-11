"""资产改名的连带迁移（R1）。

## 为什么改名不能只改 Asset.name

`Asset.name` 不只是显示用的标签，它是**连接键**：镜头与资产的关联全靠名字相等
（全库 12 处 `Asset.name == ...` 查询）。只改 Asset 那一行的后果：

    把「陆明」改名为「陆医生」
      → 208 个镜头的 Shot.characters 仍是「陆明」
      → jobs.py 的 `Asset.name == c` 匹配 0 条
      → 这些镜头的定妆图**全部注入不到**，静默失效、无任何报错
      → 另有 43 个 AssetStage.character_name 一起失联

用户看到的是"改了个名字，然后出片突然没有人物一致性了"，几乎不可能反查到原因。

## 方案 B：改名即迁移

在**同一个事务**里把所有引用一起改掉，语义上真的是"把这个角色改叫别的"：

| 表 / 字段                        | 角色 | 场景 |
|----------------------------------|:----:|:----:|
| `Asset.name`                     |  ✓   |  ✓   |
| `Shot.characters`（JSON 数组）    |  ✓   |      |
| `Shot.location`                  |      |  ✓   |
| `Shot.ref_overrides`（JSON add/remove） | ✓ |      |
| `AssetStage.character_name`      |  ✓   |      |
| `AssetStage.location`（绑定场景） |      |  ✓   |
| `CharacterAlias.raw_name/canonical` | ✓ |      |
| `SceneAlias.raw_name/canonical`  |      |  ✓   |
| `SceneAnchor.location/canonical` |      |  ✓   |

漏改任何一处都是静默断链，所以这里**逐表列全**，并在返回值里报告每张表改了几行——
调用方（和用户）能当场看到"这次改名影响了 208 个镜头 + 43 个造型阶段"，
而不是改完什么都不知道。
"""
from __future__ import annotations

import json
import logging

from .db import (Asset, AssetStage, CharacterAlias, SceneAlias, SceneAnchor,
                 Shot)

log = logging.getLogger(__name__)


def _rename_in_json_list(raw: str | None, old: str, new: str) -> tuple[str | None, bool]:
    """把 JSON 数组文本里的 old 换成 new。返回 (新文本, 是否改动)。"""
    if not raw:
        return raw, False
    try:
        arr = json.loads(raw)
    except (ValueError, TypeError):
        return raw, False
    if not isinstance(arr, list) or old not in arr:
        return raw, False
    # 去重：改名后可能与已有项撞名（把「小陆」改成「陆明」而该镜本就有「陆明」）
    seen, out = set(), []
    for x in arr:
        v = new if x == old else x
        if v not in seen:
            seen.add(v)
            out.append(v)
    return json.dumps(out, ensure_ascii=False), True


def _rename_in_ref_overrides(raw: str | None, old: str, new: str
                             ) -> tuple[str | None, bool]:
    """ref_overrides 是 `{"add": [...], "remove": [...]}`，两个数组都要改。"""
    if not raw:
        return raw, False
    try:
        ov = json.loads(raw)
    except (ValueError, TypeError):
        return raw, False
    if not isinstance(ov, dict):
        return raw, False
    changed = False
    for key in ("add", "remove"):
        arr = ov.get(key)
        if isinstance(arr, list) and old in arr:
            seen, out = set(), []
            for x in arr:
                v = new if x == old else x
                if v not in seen:
                    seen.add(v)
                    out.append(v)
            ov[key] = out
            changed = True
    return (json.dumps(ov, ensure_ascii=False), True) if changed else (raw, False)


def rename_asset_everywhere(session, project_id: str, kind: str,
                            old: str, new: str) -> dict[str, int]:
    """把一个资产名在**所有引用处**改掉。调用方负责 commit。

    `kind`：`character` 走角色相关的表，`location` 走场景相关的表。
    返回 `{表名: 改动行数}`——报给用户看"这次改名影响了多少东西"。
    """
    counts: dict[str, int] = {}

    def bump(k: str, n: int = 1) -> None:
        if n:
            counts[k] = counts.get(k, 0) + n

    if kind == "character":
        for sh in session.query(Shot).filter(Shot.project_id == project_id).all():
            new_chars, c1 = _rename_in_json_list(sh.characters, old, new)
            if c1:
                sh.characters = new_chars
                bump("shots.characters")
            new_ov, c2 = _rename_in_ref_overrides(sh.ref_overrides, old, new)
            if c2:
                sh.ref_overrides = new_ov
                bump("shots.ref_overrides")

        n = (session.query(AssetStage)
             .filter(AssetStage.project_id == project_id,
                     AssetStage.character_name == old)
             .update({AssetStage.character_name: new}, synchronize_session=False))
        bump("asset_stages.character_name", n)

        for col in (CharacterAlias.raw_name, CharacterAlias.canonical):
            n = (session.query(CharacterAlias)
                 .filter(CharacterAlias.project_id == project_id, col == old)
                 .update({col: new}, synchronize_session=False))
            bump(f"character_aliases.{col.key}", n)

    elif kind == "location":
        n = (session.query(Shot)
             .filter(Shot.project_id == project_id, Shot.location == old)
             .update({Shot.location: new}, synchronize_session=False))
        bump("shots.location", n)

        n = (session.query(AssetStage)
             .filter(AssetStage.project_id == project_id,
                     AssetStage.location == old)
             .update({AssetStage.location: new}, synchronize_session=False))
        bump("asset_stages.location", n)

        for col in (SceneAlias.raw_name, SceneAlias.canonical):
            n = (session.query(SceneAlias)
                 .filter(SceneAlias.project_id == project_id, col == old)
                 .update({col: new}, synchronize_session=False))
            bump(f"scene_aliases.{col.key}", n)

        for col in (SceneAnchor.location, SceneAnchor.canonical):
            n = (session.query(SceneAnchor)
                 .filter(SceneAnchor.project_id == project_id, col == old)
                 .update({col: new}, synchronize_session=False))
            bump(f"scene_anchors.{col.key}", n)

    # 最后改 Asset 本身：放在最后是为了让上面的查询都还能按旧名匹配到
    n = (session.query(Asset)
         .filter(Asset.project_id == project_id, Asset.kind == kind,
                 Asset.name == old)
         .update({Asset.name: new}, synchronize_session=False))
    bump("assets.name", n)

    log.info("[rename] 项目 %s 把 %s「%s」改名为「%s」：%s",
             project_id, kind, old, new, counts)
    return counts
