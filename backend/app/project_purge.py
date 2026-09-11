"""项目彻底删除（回收站第二段）：删库行 + 只删该项目**独占**的磁盘文件。

## 为什么这件事需要一个独立模块

媒体目录是**扁平**的（见 `media.py`：`uploads/` `generated/` `outputs/` 各一个
大平铺目录，文件名是随机 id），**没有按项目分目录**。所以"删掉这个项目的文件"
没有 `rm -rf <项目目录>` 这种捷径，只能把该项目在十来张表里留下的 URL 逐条
收集出来，再反查每个 URL 还有没有别的项目在用。

这段逻辑既不属于路由（它有自己的 5700 行），也不属于 `media.py`（那是上传/
转码/导出），单独成模块。

## 「只删独占文件」是用户的明确裁定

同一个 URL 完全可能被多个项目引用（用户把一段素材插进两个项目的镜头轨、
同一段参考音色喂给两个项目的角色）。删项目 A 时把文件 unlink 掉，项目 B 的
镜头轨就变成放不出画面的死链，而且**要等到导出时才炸**，报错里只有一个文件
路径，用户根本联系不到"我上周删过一个项目"。

所以本模块的核心是 `url_owners()`：先建全库 URL → 项目集合的索引，
只有 owners 恰好等于 `{被删项目}` 的文件才真删，其余计入 `shared_skipped`
原样保留（磁盘上留几个孤儿文件，远好过弄坏另一个项目）。

## 不在清理范围内的东西

`outputs/` 里的**导出成片**没有落任何库，没有一张表记录它属于哪个项目，
因此无法归属、也就无法按项目清理。它们仍由设置里的「清理缓存」
（`media.cleanup_outputs`）负责。前端确认框必须写明这一点，否则用户会以为
"彻底删除"能连成片一起清、然后奇怪磁盘为什么没降下来。
"""
from __future__ import annotations

import logging
from pathlib import Path

from sqlalchemy import delete

from .db import (
    Asset,
    AssetStage,
    AudioClip,
    CharacterAlias,
    Job,
    MediaClip,
    Project,
    SceneAlias,
    SceneAnchor,
    SceneView,
    Shot,
    ShotVersion,
    SubtitleClip,
    Transition,
)
from .media import _resolve_local

logger = logging.getLogger(__name__)

#: 按 project_id 直接删的表。顺序无所谓（SQLite 无外键约束），
#: 但**必须列全** —— 漏一张表就是永久残留的孤儿行，且没有任何界面能看到它们。
#: 新增带 project_id 的表时**务必**加进来（这是唯一的清单）。
_PROJECT_TABLES: list[tuple[str, type]] = [
    ("shots", Shot),
    ("assets", Asset),
    ("asset_stages", AssetStage),
    ("scene_views", SceneView),
    ("scene_anchors", SceneAnchor),
    ("scene_aliases", SceneAlias),
    ("character_aliases", CharacterAlias),
    ("media_clips", MediaClip),
    ("audio_clips", AudioClip),
    ("subtitle_clips", SubtitleClip),
    ("transitions", Transition),
    ("jobs", Job),
]


def _iter_urls(session, project_id: str | None):
    """产出 `(拥有它的项目 id, URL)`。`project_id=None` = 扫全库。

    两种模式共用同一段列清单是刻意的：如果"收集本项目的 URL"和"扫全库建索引"
    各写一份列名，两边一旦漂移（比如新加了一列只补了其中一处），
    结果就是把别的项目正在用的文件当成独占文件删掉 —— 这类 bug 不会报错，
    只会在几天后表现为另一个项目突然放不出画面。

    ⚠️ 2026-09-11：这段清单原本写在本文件里，是全工程**三份**清单中唯一齐全的
    那份；另两份（`media._referenced_filenames` 清孤儿、`media._find_references`
    删素材守卫）各自漏了不同的列。清单已提到 `media_refs.URL_COLUMNS`，三处
    全部从它派生。**加列只改那一处，不要回到这里硬写列名。**
    """
    from .media_refs import iter_urls
    return iter_urls(session, project_id)


def collect_urls(session, project_id: str) -> set[str]:
    """该项目引用的全部媒体 URL（不判断是否独占）。"""
    return {u for _pid, u in _iter_urls(session, project_id)
            if isinstance(u, str) and u}


def url_owners(session) -> dict[str, set[str]]:
    """全库 URL → 引用它的项目 id 集合。

    每张表**只扫一遍**（把 project_id 一起 select 出来分组），而不是
    "对每个项目各跑一次收集"——后者在 60+ 项目的库上是几百次查询，
    且随项目数线性劣化。
    """
    owners: dict[str, set[str]] = {}
    for pid, u in _iter_urls(session, None):
        if isinstance(u, str) and u and pid:
            owners.setdefault(u, set()).add(pid)
    return owners


def exclusive_files(session, project_id: str) -> tuple[list[Path], int, int]:
    """该项目**独占**的本地文件。

    :returns: (文件路径列表, 总字节数, 被跳过的共享/外链 URL 数)

    跳过的两类：
      · 被别的项目也引用的 URL（删了会弄坏那个项目）
      · `_resolve_local` 解析不出本地路径的 URL（http 外链、或越界路径被拒）
    """
    owners = url_owners(session)
    files: list[Path] = []
    total = 0
    skipped = 0
    seen: set[Path] = set()
    for url in collect_urls(session, project_id):
        if owners.get(url, set()) - {project_id}:
            skipped += 1            # 还有别的项目在用
            continue
        p = _resolve_local(url)
        if p is None or p in seen:
            if p is None:
                skipped += 1        # 外链/越界，不归我们管
            continue
        seen.add(p)
        try:
            if p.is_file():
                total += p.stat().st_size
                files.append(p)
        except OSError:             # 文件已被清理缓存删掉等，不算失败
            continue
    return files, total, skipped


def _row_counts(session, project_id: str) -> dict[str, int]:
    """各表将被删除的行数（只列非零的，给确认框看）。"""
    rows: dict[str, int] = {}
    for name, model in _PROJECT_TABLES:
        n = session.query(model).filter(model.project_id == project_id).count()
        if n:
            rows[name] = n
    n_ver = (session.query(ShotVersion)
             .filter(ShotVersion.shot_id.in_(
                 session.query(Shot.id).filter(Shot.project_id == project_id)))
             .count())
    if n_ver:
        rows["shot_versions"] = n_ver
    return rows


def preview(session, project_id: str) -> dict:
    """彻底删除会发生什么（只算不删）。前端拿它填确认框里的具体数字。"""
    files, total, skipped = exclusive_files(session, project_id)
    return {
        "files": len(files),
        "bytes": total,
        "shared_skipped": skipped,
        "rows": _row_counts(session, project_id),
    }


def purge(session, project_id: str) -> dict:
    """真正清盘：删库行 + unlink 独占文件。调用方须保证项目已在回收站。

    ⚠️ **顺序是承重的**：先算好文件集、再删库行、最后才 unlink。
    反过来（先删文件后删库行）一旦中途失败，留下的是一堆指向不存在文件的
    库行 —— 项目还在列表里、点进去每个镜头都是死链，比彻底删干净糟得多。
    反之若 unlink 阶段失败，残留的只是几个没人引用的孤儿文件，
    「清理缓存」还能兜底。
    """
    # 全库 owner 索引只扫这一次；删完行之后再算就什么都查不到了
    files, total, skipped = exclusive_files(session, project_id)
    rows = _row_counts(session, project_id)

    # shot_versions 没有 project_id，必须在 shots 被删**之前**按 shot_id 删干净，
    # 否则子查询就查不到任何 shot 了，版本行会永久残留。
    shot_ids = [s[0] for s in
                session.query(Shot.id).filter(Shot.project_id == project_id).all()]
    if shot_ids:
        session.execute(delete(ShotVersion).where(ShotVersion.shot_id.in_(shot_ids)))
    for _name, model in _PROJECT_TABLES:
        session.execute(delete(model).where(model.project_id == project_id))
    proj = session.get(Project, project_id)
    if proj:
        session.delete(proj)
    session.commit()

    deleted = 0
    for f in files:
        try:
            f.unlink(missing_ok=True)
            deleted += 1
        except OSError as exc:
            logger.warning("[purge] 删文件失败(已跳过): %s | %s", f, exc)
    return {
        "rows": rows,
        "files_deleted": deleted,
        "bytes_freed": total,
        "shared_skipped": skipped,
    }
