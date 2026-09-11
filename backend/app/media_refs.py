"""媒体 URL 列清单 —— 全工程**唯一**的一份。

## 为什么必须只有一份

"哪些表的哪些列存着媒体文件 URL"这个问题，历史上有**三份各自维护**的答案：

| 用处 | 位置 | 当时漏了什么 |
|---|---|---|
| 清理孤儿文件时判断"还有没有人在用" | `media._referenced_filenames` | `SceneView.image_url`、`Shot.tail_frame_url`、`Asset.board_url`、生图候选 |
| 删素材时的 409 引用守卫 | `media._find_references` | `AssetStage.image_url`、`SceneView.image_url`、`Shot.tail_frame_url`、LUT、生图候选 |
| 彻底删项目时算"独占文件" | `project_purge._iter_urls` | 生图候选（其余是全的） |

漏列的后果**不对称，且都不报错**：

- 漏在"引用集"里 → 在用的文件被当孤儿**删掉**。2026-09-11 实测：`SceneView`
  有图 180 张，157 张不在引用集内，其中 7 张已经进了删除清单 —— 用户点一次
  设置里的「清理缓存」就是真实数据丢失，而且因为出片时 `scene_view.pick_for_shot`
  要按机位从这 8 张里挑参考图注入，表现是**生成质量静默劣化**，连报错都没有。
  同一批还漏了 `asset_candidates` 任务里的生图候选（91 个 URL）：它们只存在
  `Job.result` 里，资产弹窗靠 `GET /v2/assets/candidates` 翻回来接着挑，
  删了就是一排 404 破图 —— 每张都是花过钱的产出。
- 漏在"引用守卫"里 → 删素材时不该放过的放过了，引用变死链，等到导出/生成才炸。
- 漏在"独占文件"里 → 把别的项目正在用的文件删掉（`_iter_urls` 靠 docstring
  反复强调"两种模式共用同一段列清单是刻意的"守住了大部分列）。

只补几行列名治不了本：下一个人加一张带图的表时，还是只会想到改他正在看的那一处。
所以把清单变成**数据**（`URL_COLUMNS`），三个用处全部从它派生 —— 加一列就自动
被三处同时认识。

## 加一列时要做什么

往 `URL_COLUMNS` 里加一条，填好 `label`（删素材的 409 清单要给人看懂），跑
`python3 scripts/audit_probe.py` 确认"漏检"几行仍是 0。**不要**去动 `media.py`
或 `project_purge.py` 里的任何列名。
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Callable

from .db import (
    Asset,
    AssetStage,
    AudioClip,
    Job,
    MediaClip,
    Project,
    SceneAnchor,
    SceneView,
    Shot,
    ShotVersion,
)


def _json_dict(raw: str | None) -> dict:
    """宽容地把一列 JSON 文本读成 dict。坏数据当空处理 —— 这些列都是
    历史遗留数据多、schema 松散的地方，一条脏行不该让整个清理流程崩掉。
    """
    if not raw:
        return {}
    try:
        val = json.loads(raw)
    except (ValueError, TypeError):
        return {}
    return val if isinstance(val, dict) else {}


def _lut_urls(transform_meta: str | None) -> list[str]:
    """从镜头的 transform_meta JSON 里取出 LUT 文件 URL（调色用的 .cube）。

    前端传什么就存什么，只有解析 JSON 才看得见。不取它的话，
    用户上传过 LUT 的项目删完仍会在 uploads/ 里留下 .cube 文件，
    而且永远没人能再找到它们。
    """
    lut = _json_dict(transform_meta).get("lut")
    return [lut] if isinstance(lut, str) and lut else []


def _candidate_urls(result: str | None) -> list[str]:
    """从 `asset_candidates` 任务的 result 里取出候选图 URL。

    ⚠️ 这些是**活引用**，不是日志。资产弹窗打开时会调
    `GET /v2/assets/candidates`（`routes_v2.latest_asset_candidates`）把上次
    那几张候选重新摆出来接着挑 —— 候选图**不落资产表**，只有被点选的那张
    才写进 `Asset.image_url`/`AssetStage.image_url`。也就是说 `Job.result`
    是关窗之后唯一能把它们找回来的地方，删了就是一排 404 破图，
    而且每张都是花过钱的生图产出。

    2026-09-11 实测：库里 `asset_candidates` 的 result 共 91 个候选 URL。
    """
    urls = _json_dict(result).get("urls")
    if not isinstance(urls, list):
        return []
    return [u for u in urls if isinstance(u, str) and u]


def _job_label(row: Any) -> str:
    p = _json_dict(row.payload)
    name = p.get("name")
    return f"资产「{name}」的生图候选" if name else f"生图候选（任务 {row.id}）"


def _shot_label(row: Any, what: str) -> str:
    return f"第 {row.order} 镜的{what}"


def _snippet(text: str | None, n: int = 12) -> str:
    """旁白正文摘要。空文本时给"（无文本）"而不是空引号 —— 自动字幕与
    纯音效行的 text 本来就可能是空的，`旁白音频「…」` 用户看不出是哪一条。
    """
    t = (text or "").strip()
    if not t:
        return "（无文本）"
    return t[:n] + "…" if len(t) > n else t


@dataclass(frozen=True)
class UrlColumn:
    """一个存媒体 URL 的列。"""

    #: 表名（分组展示与审计脚本用）
    table: str
    #: ORM 模型
    model: type
    #: 存 URL 的列。`expand` 非空时这里是承载它的原始列（如 transform_meta）
    column: Any
    #: 回给前端的类型串（`delete_clip` 的 409 清单按它区分图标/文案）
    kind: str
    #: 拿 ORM 行产出一句人能看懂的话，用在删素材的 409 清单里
    label: Callable[[Any], str]
    #: 该表的项目归属列。`join` 非空时忽略本字段
    project_col: Any = None
    #: `(模型, onclause, 项目列)` —— 本表没有 project_id，得 join 过去
    join: tuple[type, Any, Any] | None = None
    #: join 用 LEFT OUTER（父行可能已被删，但子行仍在库里引用着文件）
    outer: bool = False
    #: 列里存的不是单个 URL（而是一段 JSON）时的展开器：值 → 0..N 个 URL。
    #: 用它的列无法用 `WHERE col == url` 反查，只能扫表逐行展开比对，
    #: 所以能用 `row_filter` 在 SQL 层缩小范围的一定要缩。
    expand: Callable[[Any], list[str]] | None = None
    #: 只有满足此条件的行才算引用（SQLAlchemy 条件表达式）。
    #: 用在一列对不同行含义不同的场合：`Job.result` 只在
    #: `kind == "asset_candidates"` 时存着界面还能翻回来的活引用。
    row_filter: Any = None


#: 全工程唯一的媒体 URL 列清单。**新增存 URL 的列时只改这里。**
URL_COLUMNS: tuple[UrlColumn, ...] = (
    # ---- 镜头 ----
    UrlColumn("shots", Shot, Shot.video_url, "shot",
              lambda r: f"第 {r.order} 镜（{r.special_name or '外部素材'}）",
              project_col=Shot.project_id),
    UrlColumn("shots", Shot, Shot.thumb_url, "shot_thumb",
              lambda r: _shot_label(r, "缩略图"), project_col=Shot.project_id),
    UrlColumn("shots", Shot, Shot.first_frame_url, "shot_first_frame",
              lambda r: _shot_label(r, "首帧图"), project_col=Shot.project_id),
    # 尾帧：字段已于 2026-09-11 停用（尾帧接力被判定为净负面，见
    # docs/DECISION-2026-09-11-尾帧接力停用.md），不再写入新值。
    # 但**这条登记必须留着**：存量 277 条 URL 还在库里，摘掉登记等于把这些文件
    # 变成孤儿，用户点一次「清理缓存」就静默删掉。要腾空间走
    # backend/scripts/purge_tail_frames.py（先清列再回收，可审可控）。
    UrlColumn("shots", Shot, Shot.tail_frame_url, "shot_tail_frame",
              lambda r: _shot_label(r, "尾帧图（历史，已停用）"), project_col=Shot.project_id),
    UrlColumn("shots", Shot, Shot.transform_meta, "shot_lut",
              lambda r: _shot_label(r, "调色 LUT"),
              project_col=Shot.project_id, expand=_lut_urls),

    # ---- 版本历史：shot_versions 没有 project_id，只能经 shots join 回去 ----
    # 漏了这张表 = 每个镜头的每个历史版本（一个 mp4 + 一张缩略图）全部残留，
    # 通常比"当前采用版本"多出好几倍的体积，是清盘效果的大头。
    #
    # ⚠️ 必须是 **OUTER** join（`outer=True`）。用 inner join 时，父镜头已被删掉的
    # 孤儿版本行会被整行丢弃 —— 实测库里有 20 条这种行，带着 20 个 video_url 与
    # 15 个 thumb_url、盘上 34 个文件还在。它们对引用集不可见，就会被「清理缓存」
    # 删掉，留下 35 条指向不存在文件的库行，正是这套机制本来要防的死链。
    # 归属（`url_owners` / `exclusive_files`）那边本就只认 pid 非空的行，
    # 所以 outer join 带来的 `pid=None` 不会让任何文件被误判成某个项目的独占文件。
    UrlColumn("shot_versions", ShotVersion, ShotVersion.video_url, "shot_version",
              lambda r: f"镜头历史版本 v{r.version_no}",
              join=(Shot, Shot.id == ShotVersion.shot_id, Shot.project_id),
              outer=True),
    UrlColumn("shot_versions", ShotVersion, ShotVersion.thumb_url, "shot_version_thumb",
              lambda r: f"镜头历史版本 v{r.version_no} 的缩略图",
              join=(Shot, Shot.id == ShotVersion.shot_id, Shot.project_id),
              outer=True),

    # ---- 资产 ----
    UrlColumn("assets", Asset, Asset.image_url, "asset_image",
              lambda r: f"资产「{r.name}」的图片", project_col=Asset.project_id),
    UrlColumn("assets", Asset, Asset.voice_url, "asset_voice",
              lambda r: f"资产「{r.name}」的音色", project_col=Asset.project_id),
    UrlColumn("assets", Asset, Asset.board_url, "asset_board",
              lambda r: f"资产「{r.name}」的设定板", project_col=Asset.project_id),
    UrlColumn("asset_stages", AssetStage, AssetStage.image_url, "asset_stage",
              lambda r: f"角色「{r.character_name}」造型「{r.stage_name}」的定妆图",
              project_col=AssetStage.project_id),
    UrlColumn("scene_views", SceneView, SceneView.image_url, "scene_view",
              lambda r: f"场景视角「{r.label or r.view_key}」的参考图",
              project_col=SceneView.project_id),
    UrlColumn("scene_anchors", SceneAnchor, SceneAnchor.image_url, "scene_anchor",
              lambda r: f"场景「{r.location}」第 {r.episode} 集的锚点图",
              project_col=SceneAnchor.project_id),

    # ---- 素材池 ----
    UrlColumn("media_clips", MediaClip, MediaClip.url, "media_clip",
              lambda r: f"素材「{r.name}」", project_col=MediaClip.project_id),

    # ---- 音频（合成产物 + 参考音色）----
    UrlColumn("audio_clips", AudioClip, AudioClip.url, "audio",
              lambda r: f"旁白音频「{_snippet(r.text)}」",
              project_col=AudioClip.project_id),
    UrlColumn("audio_clips", AudioClip, AudioClip.voice_ref_url, "voice_ref",
              lambda r: f"旁白「{_snippet(r.text)}」的参考音色",
              project_col=AudioClip.project_id),

    # ---- 项目自身（解说音色）。注意归属列是 id 而不是 project_id ----
    UrlColumn("projects", Project, Project.narration_voice_url, "project_voice",
              lambda r: f"项目「{r.title}」的解说音色", project_col=Project.id),

    # ---- 生图候选（任务表里唯一的活引用）----
    # 2026-09-11 补。`Job.result` 绝大多数 kind 都只是**历史日志**
    # （`first_frames` 记着当时产出的首帧、`shot_videos` 记着逐镜明细……），
    # 界面上没有任何路径能翻回去看，前端唯一读 `job.result` 的地方
    # （`useProdJobs.warnFrameIssues`）只取 `bare_shots`/`blocked_shots`
    # 两个数字数组。那些 URL 刻意**不**算引用，否则任务表会把每一张被替换掉的
    # 旧图永久钉在磁盘上，清理缓存就再也释放不了空间。
    #
    # `asset_candidates` 是例外：它的 `result.urls` 有专门的回看端点
    # （见 `_candidate_urls` 的说明），必须算引用。靠 `row_filter` 在 SQL 层
    # 把范围缩到这一个 kind，别让另外几百行 result 参与 JSON 解析。
    UrlColumn("jobs", Job, Job.result, "asset_candidate", _job_label,
              project_col=Job.project_id,
              expand=_candidate_urls, row_filter=Job.kind == "asset_candidates"),
)


def iter_urls(session, project_id: str | None = None):
    """产出 `(拥有它的项目 id, URL)`。`project_id=None` = 扫全库。

    只 select 需要的两列（不取整行 ORM 对象）：全库 8000+ 镜头时，
    整行取出来再读两个字段是几十倍的开销，而这个函数在清理缓存、
    彻底删项目、审计探针三条路上都会被调。
    """
    for spec in URL_COLUMNS:
        if spec.join is not None:
            model, onclause, pcol = spec.join
            q = session.query(pcol, spec.column)
            q = (q.outerjoin(model, onclause) if spec.outer
                 else q.join(model, onclause))
        else:
            pcol = spec.project_col
            q = session.query(pcol, spec.column)
        if spec.row_filter is not None:
            q = q.filter(spec.row_filter)
        if project_id is not None:
            q = q.filter(pcol == project_id)
        for pid, raw in q.all():
            if spec.expand is not None:
                for url in spec.expand(raw):
                    yield pid, url
            elif isinstance(raw, str) and raw:
                yield pid, raw


def referenced_filenames(session) -> set[str]:
    """全库被引用到的媒体**文件名**（不含路径与 query）。

    清理孤儿文件时用它当"还有人在用"的判据。凡是出现在这里的文件一律不删。

    ⚠️ 刻意**不过滤墓碑**（`Asset.deleted_at` / `AssetStage.deleted_at`）：
    软删的阶段也算"被引用"。过滤掉的话，用户删一个造型阶段，下次媒体清理就把
    那张定妆图从磁盘上抹掉，restore 回来是一条指向 404 的记录 —— 软删就白软了。
    """
    return {u.rsplit("/", 1)[-1].split("?")[0] for _pid, u in iter_urls(session)}


def find_references(session, url: str, *, limit: int | None = None,
                    exclude: tuple[str, str] | None = None) -> list[dict]:
    """列出仍在引用该 URL 的对象，供删除前的 409 清单使用。

    :param limit: 命中这么多条就停（前端只展示前 20 条，没必要把全库扫穿）
    :param exclude: `(表名, 行 id)` —— 把"正在被删的那一行自己"排除掉。
        `delete_clip` 删的是 `media_clips` 行，而 `MediaClip.url` 本身就在
        `URL_COLUMNS` 里，不排除的话它会把自己算成引用者、**任何素材都删不掉**
        （永远 409）。按 `(表, id)` 而不是按表排除：同一个 URL 被重复登记成两条
        素材时，另一条仍是真实引用，必须拦。

    带 `expand` 的列（transform_meta → LUT、jobs.result → 候选图）无法用
    `WHERE col == url` 反查，只能把该表扫一遍逐行展开比对；`row_filter`
    会先在 SQL 层把行数压下来。这只发生在"用户点删除某个素材"这一刻，
    代价可以接受。
    """
    refs: list[dict] = []
    if not url:
        return refs
    for spec in URL_COLUMNS:
        if limit is not None and len(refs) >= limit:
            break
        if spec.expand is not None:
            q = session.query(spec.model).filter(spec.column.isnot(None))
            if spec.row_filter is not None:
                q = q.filter(spec.row_filter)
            rows = [r for r in q.all()
                    if url in spec.expand(getattr(r, spec.column.key))]
        else:
            q = session.query(spec.model).filter(spec.column == url)
            if spec.row_filter is not None:
                q = q.filter(spec.row_filter)
            rows = q.all()
        for r in rows:
            if exclude and exclude[0] == spec.table and exclude[1] == r.id:
                continue
            refs.append({"type": spec.kind, "id": r.id,
                         "table": spec.table, "label": spec.label(r)})
            if limit is not None and len(refs) >= limit:
                break
    return refs
