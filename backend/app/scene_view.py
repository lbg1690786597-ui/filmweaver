"""场景资产的**多视角 / 多景别**参考图（用户 2026-09-09 需求，附设定板参考图）。

## 为什么一张场景图不够

改之前每个场景资产只有 `Asset.image_url` 一张图，而它会被
`jobs._auto_inject_refs_detailed` 当作该场景**所有镜头**的参考图。后果：
镜头一换机位（反打、侧拍、推特写），模型手里只有一个方向的照片，
只能**现编**这个房间的其它面——同一个客厅在不同镜头里可以不是同一个客厅。

多视角参考图正是解这个的：给足 4 个方位 + 4 个景别，逐镜按需要挑最贴切的一张。

## ⚠️ 参考图集 ≠ 设定板（这条决定了整个模块的形态）

用户给的参考图是一张**拼版设定板**（多视角/景别/材质/色彩分格 + 中文标注）。
它**不能**直接当场景资产图用，因为资产图会被原样注入每个镜头 →
模型会照抄格子线和中文标签，每个镜头都变成拼版画。

所以拆成两个产物，职责不可混：

| 产物 | 内容 | 用途 | 注入模型？ |
|---|---|---|---|
| **参考图集**（本模块） | 8 张**各自独立、画面干净**的单幅图 | 逐镜注入 + 美术参考 | ✅ 每镜挑 1 张 |
| **设定板**（`scene_board`） | 服务端把这 8 张拼成参考图那种版式 | 只给人看 / 美术交付 | ❌ 永不注入 |

## 八张是哪八张

对齐用户给的参考图：4 张「多视角参考」+ 4 张「景别参考」。

- **方位视角**：模型并不知道虚构房间里哪边是北，所以 4 张的价值**不在绝对方位**，
  而在它们是互相差 90°/180° 的一组自洽视角。因此第一张（`angle_n`）被定为
  **主视角 = 基准图**，其余三张的提示词都写成"相对主视角旋转多少度"，
  并且生图时以基准图为参考（见 `jobs._gen_scene`）——这样四张才是同一个房间。
  `angle_s` 就是**反打**（180°），拍对话戏最常用的那一档。
- **景别**：远景/中景/近景/特写，全部从主视角方位拍，只改焦段与距离。
  其中 `frame_detail`（特写）同时充当参考图里的「材质参考」——
  材质不需要第 9 张图，最能体现材质的就是特写。

参考图里的「色彩参考」「元素参考」「场景设定信息」不是生成的图，
而是设定板上由这 8 张图**派生**出来的（取色 + 文字），见 `scene_board`。

## 主视角为什么必须写回 `Asset.image_url`

`readiness.locations_no_image`、资产页缩略图、`_auto_inject_refs_detailed` 的
兜底分支全都读 `Asset.image_url`。主视角写回去，这些既有逻辑一行不用改也仍然正确；
不写回去，整个项目会报"所有场景都没图"。
"""
from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass

log = logging.getLogger(__name__)

#: 视角组：方位（互相旋转的一组自洽视角）
KIND_ANGLE = "angle"
#: 视角组：景别（同一方位，改焦段与距离）
KIND_FRAMING = "framing"


@dataclass(frozen=True)
class View:
    key: str
    #: 标在图片左上角、也用于设定板分格的短标签。
    label: str
    kind: str
    #: 拼进提示词的机位/景别句（本模块是这句话的唯一来源）。
    phrase: str
    #: 排序（设定板按它排版，生图按它定顺序）。
    sort: int
    #: True = 主视角/基准图。有且仅有一个。
    primary: bool = False
    #: 该景别对应的剧本关键词（逐镜匹配用）。方位视角为空元组。
    keywords: tuple[str, ...] = ()


#: 八视图。**顺序即生成顺序**：primary 必须排第一（`jobs._gen_scene` 依赖这点）。
VIEWS: tuple[View, ...] = (
    View("angle_n", "主视角·全景", KIND_ANGLE,
         "机位位于空间南侧、水平面向北侧，视线高度约 1.6 米，标准全景机位，"
         "完整呈现这个空间的**主视角全景**——本图定义该空间的基准方位。",
         0, primary=True),
    View("angle_s", "反打视角·全景", KIND_ANGLE,
         "机位与主视角**完全反打**（相对主视角旋转 180°，即站在主视角所拍的那面墙前"
         "回头拍摄），视线高度约 1.6 米，标准全景机位，呈现主视角背后的那一半空间。",
         1),
    View("angle_e", "右侧视角·全景", KIND_ANGLE,
         "机位相对主视角**顺时针旋转 90°**（面向主视角画面右手边的那面墙），"
         "视线高度约 1.6 米，标准全景机位。",
         2),
    View("angle_w", "左侧视角·全景", KIND_ANGLE,
         "机位相对主视角**逆时针旋转 90°**（面向主视角画面左手边的那面墙），"
         "视线高度约 1.6 米，标准全景机位。",
         3),
    View("frame_wide", "远景", KIND_FRAMING,
         "**远景（Extreme Wide Shot）**：从主视角方位大幅后退拍摄，把整个空间连同它"
         "与外部环境的关系一起收进画面，强调空间的体量、位置与周边关系。",
         4, keywords=("远景", "大远景", "全景", "大全景", "航拍", "俯拍全景")),
    View("frame_medium", "中景", KIND_FRAMING,
         "**中景（Medium Shot）**：从主视角方位拍摄这个空间最核心的功能区域"
         "（如客厅的沙发茶几区、卧室的床头区），视野约占整个空间的三分之一。",
         5, keywords=("中景", "中近景")),
    View("frame_close", "近景", KIND_FRAMING,
         "**近景（Close Shot）**：贴近拍摄空间里最具代表性的一件主陈设"
         "（家具/器物/门窗），主体撑满画面，背景是这个空间自身的虚化环境。",
         6, keywords=("近景",)),
    View("frame_detail", "特写·材质", KIND_FRAMING,
         "**特写（Close-up / 材质参考）**：微距级别的局部细节，拍摄这个空间里最能"
         "体现**材质与年代感**的表面（木纹/石材/布料/金属/墙面肌理），"
         "填满整个画面，清晰呈现纹理、颗粒、磨损与反光。",
         7, keywords=("特写", "大特写", "微距", "细节")),
)

BY_KEY = {v.key: v for v in VIEWS}
PRIMARY = next(v for v in VIEWS if v.primary)
#: 一个场景的参考图张数（= 生图成本倍数，改这里就是改钱）。
VIEW_COUNT = len(VIEWS)


def views_payload() -> list[dict]:
    """下发给前端的视图定义（前端不硬编码任何标签）。"""
    return [{"key": v.key, "label": v.label, "kind": v.kind,
             "sort": v.sort, "primary": v.primary} for v in VIEWS]


# ---------------------------------------------------------------- 逐镜挑图

#: 景别关键词 → view_key。按**最长关键词优先**匹配，
#: 否则「大远景」会先命中「远景」——两者其实是同一档，无害；
#: 但「中近景」若先命中「近景」就错档了，所以必须长的先来。
_KW_TO_KEY: tuple[tuple[str, str], ...] = tuple(
    sorted(((kw, v.key) for v in VIEWS for kw in v.keywords),
           key=lambda x: -len(x[0])))


def framing_of_text(text: str | None) -> str | None:
    """从镜头文本里认景别，返回 view_key；认不出返回 None。

    ⚠️ 实测本项目 19 个镜头里只有 3 个写了景别关键词（16%）。所以这是
    **锦上添花**：认出来就用更贴切的那张，认不出就用主视角全景——
    绝不能因为认不出而不注入图。
    """
    t = (text or "")
    if not t:
        return None
    for kw, key in _KW_TO_KEY:
        if kw in t:
            return key
    return None


def pick_for_shot(session, asset_id: str, *, shot=None) -> tuple[str | None, str | None]:
    """给一个镜头挑这个场景最贴切的一张参考图。

    返回 `(image_url, view_label)`；一张可用的都没有时返回 `(None, None)`，
    调用方回退到 `Asset.image_url`。

    优先级：
      ① 镜头文本（gen_prompt / script_ref）里认出的景别对应的那张
      ② 主视角全景（`angle_n`）
      ③ 任意一张有图的（顺序按 VIEWS，即方位优先于景别）

    **只挑一张**。场景不能占掉多个参考位——厂商上限只有 4 张
    （`video_seedance.max_reference_images`），角色一致性权重更高。
    """
    rows = list_views(session, asset_id)
    have = {r.view_key: r.image_url for r in rows if (r.image_url or "").strip()}
    if not have:
        return None, None
    want = None
    if shot is not None:
        # gen_prompt 是出片实际下发的稿子，比原始剧本片段更贴近画面；两者都看。
        want = (framing_of_text(getattr(shot, "gen_prompt", None))
                or framing_of_text(getattr(shot, "script_ref", None)))
    for key in ([want] if want else []) + [PRIMARY.key] + [v.key for v in VIEWS]:
        if key and key in have:
            return have[key], BY_KEY[key].label
    return None, None


# ---------------------------------------------------------------- 读写

def list_views(session, asset_id: str) -> list:
    """按 sort 取一个场景资产的全部视图行。"""
    from .db import SceneView
    return (session.query(SceneView)
            .filter(SceneView.asset_id == asset_id)
            .order_by(SceneView.sort).all())


def ensure_views(session, asset) -> list:
    """补齐一个场景资产的 8 行视图（幂等）。调用方负责 commit。

    **认领已有的主视角图**：老项目的场景资产已经有一张 `Asset.image_url` 了
    （那就是它的主视角全景）。不认领的话会当成"主视角缺图"再花一次钱
    生成同一个房间的同一个角度——这与 `scenes.ensure_location_asset`
    认领老资产行是同一个理由。
    """
    from .db import SceneView
    existing = {r.view_key: r for r in list_views(session, asset.id)}
    out: list = []
    for v in VIEWS:
        row = existing.get(v.key)
        if row is None:
            row = SceneView(id=uuid.uuid4().hex[:12], project_id=asset.project_id,
                            asset_id=asset.id, view_key=v.key, kind=v.kind,
                            label=v.label, sort=v.sort)
            # 主视角认领 Asset 上已有的那张图
            if v.primary and (asset.image_url or "").strip():
                row.image_url = asset.image_url
            session.add(row)
        else:
            # 标签/排序随词表演进（用户看到的标签由代码定，不由老数据定）
            row.label, row.sort, row.kind = v.label, v.sort, v.kind
            if v.primary and not (row.image_url or "").strip() \
                    and (asset.image_url or "").strip():
                row.image_url = asset.image_url
        out.append(row)
    return out


def missing_views(session, asset) -> list:
    """还没有图的视图行（= 本次要生成的那几张）。"""
    rows = ensure_views(session, asset)
    return [r for r in rows if not (r.image_url or "").strip()]


def base_ref(session, asset_id: str) -> str | None:
    """这个场景的**基准图**（主视角全景）URL，作为其余 7 张的参考图。

    与 `asset_ref.character_base_ref` 同款作用：让同一个空间的 8 张图
    是同一个空间，而不是 8 个长得像的房间。
    """
    from .db import SceneView
    r = (session.query(SceneView)
         .filter(SceneView.asset_id == asset_id,
                 SceneView.view_key == PRIMARY.key).first())
    return r.image_url if r and (r.image_url or "").strip() else None


def sync_primary_to_asset(session, asset) -> bool:
    """把主视角图写回 `Asset.image_url`（既有逻辑全读那一列，见模块头）。

    返回是否有改动。调用方负责 commit。
    """
    url = base_ref(session, asset.id)
    if url and asset.image_url != url:
        asset.image_url = url
        return True
    return False


def progress(session, asset_id: str) -> dict:
    """`{"done": n, "total": 8}`，给前端画进度与"补齐缺失视角"按钮用。"""
    rows = list_views(session, asset_id)
    done = sum(1 for r in rows if (r.image_url or "").strip())
    return {"done": done, "total": VIEW_COUNT}
