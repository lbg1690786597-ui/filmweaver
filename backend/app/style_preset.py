"""生产模式 × 画风预设的**唯一**事实来源（用户 2026-09-09 需求 2/3）。

## 为什么需要它

在此之前，"这部戏长什么样"这件事被硬编码成了**四处互不相干的字面量**：

| 位置 | 原文 |
|---|---|
| `asset_prompt.REALISTIC_STYLE` | 「真人实拍写实风格，电影级摄影质感，高分辨率，」 |
| `asset_prompt._NO_CARTOON` / `_SCENE_REQUIREMENTS` | 「禁止卡通、动漫、插画、3D 渲染风格。」 |
| `jobs._gen_first_frame` | 「电影感分镜首帧，写实摄影质感：」 |
| `jobs._ensure_scene_anchor` | 「电影级场景基准图：」 |
| `look_profile._SYS` 第 2 条 | 「这是一部**现代都市真人实拍剧**」 |

也就是说：**画风分散在四个模块里各写一遍，还带一条自相矛盾的禁令**——
要做动漫剧，光把前缀换成「国漫赛璐璐」是没用的，`_NO_CARTOON` 会同时命令模型
「禁止动漫」，两条一起下发，模型的选择不可预期。所以画风必须整体切换：
前缀、否定项、首帧句、基准图句、影调判定的题面，一次全换。

本模块就是那个整体。任何画风相关的字面量**只允许**出现在这里，
`asset_prompt` / `jobs` / `look_profile` 都只读 `Style` 的字段。

## 与生产模式的关系

`production_mode` 在本项目里的含义是**配音策略**（2026-08 改版，见
`ProjectList.tsx` 的注释）：`drama` 台词长在镜头视频自带音轨里、
`narration` 是我们自己 TTS 合成的旁白。它**不**决定画风。

2026-09-09 起新增 `anime`（动漫剧），配音上按用户决策**沿用真人剧那套**
（音画一体），区别只在画风。所以模式 → 可选画风是一张多对多的表
（`MODE_STYLES`），而不是"一个模式一种画风"。

## 只有「都市」真正可用（用户明确要求）

`ENABLED = ("urban",)` 是**唯一开关**，与 `character_profile.ENABLED_GENRES`
同款：其余四档的提示词字面**照旧写在下面**、但运行时不可达。

- 前端把五档全部列出来，未启用的**灰掉并挂「待完善」徽章**（用户决策）。
- 后端 `resolve()` 对未启用值一律回退到 `urban`，即"存了也不生效"。
  双保险的理由：前端禁用只防新建，防不住老库里的脏值、也防不住直接打 API。

将来要放开某一档，**只需**把它加进 `ENABLED`——词表和拼装逻辑不用动。
"""
from __future__ import annotations

import logging
from dataclasses import dataclass

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class Style:
    """一套画风的全部提示词字面。

    每个字段都对应一个**具体的注入点**，缺一个就会出现"资产图是动漫、
    成片是实拍"这类割裂——正是本模块要消灭的病症。
    """

    key: str
    label: str
    desc: str
    #: 资产图/场景图的开头前缀（原 `asset_prompt.REALISTIC_STYLE`）。
    #: 以「，」结尾：调用点会直接拼接，也会 rstrip("，") 后加句号。
    prefix: str
    #: 画风否定项（原 `_NO_CARTOON`）。**必须与 prefix 同向**：
    #: 真人档禁动漫，动漫档反过来禁真人照片，绝不能两边都禁。
    negative: str
    #: 首帧图提示词的开头（原 jobs 里的「电影感分镜首帧，写实摄影质感：」）
    frame_head: str
    #: 场景基准图提示词的开头（原「电影级场景基准图：」）
    anchor_head: str
    #: 视频提示词里的画风声明。**全参考路线压根没有首帧图**，
    #: 视频模型只看提示词与定妆图，这一句不给就会回到默认实拍。
    video_line: str
    #: 质感兜底词，拼在 `_FORCED` 里的"电影质感"那一段。
    texture: str
    #: 场景图的质感兜底词。与 `texture` 分开：场景句式是
    #: 「…，{scene_texture}，真实材质纹理与光影层次，…」，套人物的
    #: 「电影质感，高清肌理」读起来不通，而动漫档更是连"摄影质感"都不该提。
    scene_texture: str
    #: 给影调判定 LLM 的题面（原 `look_profile._SYS` 里写死的
    #: 「这是一部现代都市真人实拍剧」）。古风剧被按现代都市判影调，
    #: 出来的配方是错的。
    look_hint: str


#: ---- 真人实拍档 ----------------------------------------------------------

#: 现代都市。**这一档是今天唯一实际可用的**，其字面必须与改动前
#: 逐字等价（`prefix` / `negative` / `frame_head` / `anchor_head`
#: 都照抄原文），否则老项目的出图口径会静默改变。
URBAN = Style(
    key="urban",
    label="都市",
    desc="现代都市真人实拍，电影级摄影质感",
    prefix="真人实拍写实风格，电影级摄影质感，高分辨率，",
    negative="禁止卡通、动漫、插画、3D 渲染风格。",
    frame_head="电影感分镜首帧，写实摄影质感",
    anchor_head="电影级场景基准图",
    video_line="全片画风：现代都市真人实拍，电影级摄影质感，禁止动漫/插画/3D 渲染风格。",
    texture="电影质感，高清肌理",
    scene_texture="电影级摄影质感",
    look_hint="这是一部**现代都市真人实拍剧**。不要给古风/动漫/游戏/赛博朋克类的影调。",
)

#: 古风。词表已写好但 **不在 ENABLED 里**（用户："先把前端做好后面再完善"）。
#: 与 `character_profile.GENRE_PERIOD` 的古装词表是同一批预留，将来一并放开。
PERIOD = Style(
    key="period",
    label="古风",
    desc="古装/仙侠真人实拍，古典摄影质感",
    prefix="古装真人实拍写实风格，电影级摄影质感，东方古典美学，高分辨率，",
    negative="禁止卡通、动漫、插画、3D 渲染风格，禁止现代服饰、现代建筑与现代器物。",
    frame_head="电影感古装分镜首帧，写实摄影质感",
    anchor_head="电影级古装场景基准图",
    video_line=("全片画风：古装真人实拍，东方古典美学，电影级摄影质感；"
                "禁止出现现代服饰、现代建筑、现代器物，禁止动漫/插画/3D 渲染风格。"),
    texture="电影质感，丝绢与木石肌理",
    scene_texture="电影级摄影质感，东方古典建筑与器物质感",
    look_hint="这是一部**古装/仙侠真人实拍剧**。影调偏东方古典，不要给现代都市/赛博朋克类的影调。",
)

#: ---- 动漫档 --------------------------------------------------------------
#: 三档都**不在 ENABLED 里**。注意它们的 `negative` 与真人档**方向相反**——
#: 这正是"画风必须整体切换"的最直观证据：沿用真人档的
#: 「禁止动漫、3D 渲染」会与自己的前缀直接对撞。

ANIME_3D = Style(
    key="anime_3d",
    label="3D写实",
    desc="3D 渲染写实动画，皮克斯/写实 CG 质感",
    prefix="3D 渲染动画风格，写实 CG 质感，影视级三维动画，高分辨率，",
    negative="禁止真人实拍照片感，禁止 2D 手绘、赛璐璐与平涂插画风格。",
    frame_head="三维动画分镜首帧，写实 CG 渲染质感",
    anchor_head="三维动画场景基准图",
    video_line=("全片画风：3D 渲染写实动画，影视级三维动画质感；"
                "禁止真人实拍照片感，禁止 2D 手绘与赛璐璐平涂。"),
    texture="影视级三维渲染质感，次表面散射与真实材质",
    scene_texture="影视级三维渲染质感",
    look_hint="这是一部**3D 写实动画剧**。影调按三维动画电影的调色给，不要按真人实拍给。",
)

THICK_PAINT = Style(
    key="thick_paint",
    label="厚涂",
    desc="厚涂插画风，笔触厚重、光影浓郁",
    prefix="厚涂插画风格，浓郁厚重笔触，数字绘画质感，高分辨率，",
    negative="禁止真人实拍照片感，禁止 3D 渲染塑料感，禁止赛璐璐平涂与线稿感。",
    frame_head="厚涂插画分镜首帧，绘画质感",
    anchor_head="厚涂插画场景基准图",
    video_line=("全片画风：厚涂插画，浓郁厚重笔触与绘画质感；"
                "禁止真人实拍照片感，禁止 3D 渲染塑料感。"),
    texture="厚涂笔触层次，颜料堆叠质感",
    scene_texture="厚涂绘画质感，笔触层次分明",
    look_hint="这是一部**厚涂插画风动画剧**。影调按厚涂绘画的浓郁色彩给，不要按真人实拍给。",
)

GUOMAN = Style(
    key="guoman",
    label="国漫",
    desc="国漫赛璐璐风，干净线条 + 通透平涂",
    prefix="国漫赛璐璐动画风格，干净清晰线条，通透平涂上色，高分辨率，",
    negative="禁止真人实拍照片感，禁止 3D 渲染，禁止厚涂油画笔触。",
    frame_head="国漫动画分镜首帧，赛璐璐平涂质感",
    anchor_head="国漫动画场景基准图",
    video_line=("全片画风：国漫赛璐璐动画，干净线条与通透平涂；"
                "禁止真人实拍照片感，禁止 3D 渲染与厚涂笔触。"),
    texture="赛璐璐平涂色块，干净线条与通透高光",
    scene_texture="赛璐璐平涂质感，干净线条",
    look_hint="这是一部**国漫赛璐璐风动画剧**。影调按国漫动画的通透色彩给，不要按真人实拍给。",
)


STYLES: dict[str, Style] = {
    s.key: s for s in (URBAN, PERIOD, ANIME_3D, THICK_PAINT, GUOMAN)
}

#: 唯一开关（见模块头）。放开某档只改这一行。
ENABLED: tuple[str, ...] = ("urban",)

#: 无画风信息时的兜底 = 改动前的行为（老项目一行不改）。
DEFAULT = URBAN


@dataclass(frozen=True)
class Mode:
    """生产模式 = 配音策略（**不是**画风），外加它允许的画风清单。"""

    key: str
    label: str
    #: 该模式下可选的画风（顺序即前端展示顺序，第一个是默认）
    styles: tuple[str, ...]


#: 模式 → 可选画风。
#:
#: `narration`（解说剧）沿用真人档：它是"实拍画面 + 我们合成的旁白"，
#: 画风需求与真人剧一致。用户只点名了真人剧与动漫剧的风格清单，
#: 解说剧按同为实拍来归档（如需独立清单，改这一行即可）。
MODES: tuple[Mode, ...] = (
    Mode("drama", "真人剧", ("urban", "period")),
    Mode("narration", "解说剧", ("urban", "period")),
    Mode("anime", "动漫剧", ("anime_3d", "thick_paint", "guoman")),
)

BY_MODE: dict[str, Mode] = {m.key: m for m in MODES}


def is_enabled(key: str | None) -> bool:
    return (key or "") in ENABLED


def styles_of(mode: str | None) -> tuple[str, ...]:
    """该模式可选的画风 key。未知模式退回 drama 的清单。"""
    m = BY_MODE.get((mode or "").strip() or "drama") or BY_MODE["drama"]
    return m.styles


def default_style(mode: str | None) -> str:
    """该模式的默认画风：**优先给已启用的那一档**。

    动漫剧三档全部未启用，此时给它自己的第一档（`anime_3d`）作为"标称默认"——
    前端展示用。真正出图时 `resolve()` 仍会因为它未启用而回退到 `urban`，
    两者不矛盾：一个是"这个模式名义上默认哪档"，一个是"实际能生成什么"。
    """
    keys = styles_of(mode)
    for k in keys:
        if is_enabled(k):
            return k
    return keys[0] if keys else DEFAULT.key


def resolve(mode: str | None = None, key: str | None = None) -> Style:
    """(模式, 画风 key) → 实际生效的 `Style`。**永不抛异常、永不返回 None**。

    回退链：未启用/未知/为空 → 该模式的已启用默认档 → `DEFAULT`（都市）。

    为什么未启用值也要回退而不是报错：这个函数在出图链路的最里层，
    抛异常等于让一条脏数据阻断整批生成。回退到都市只是"画风没生效"，
    用户看得见、也能自己改；抛异常则是整个项目生不出图。
    """
    k = (key or "").strip()
    if k and is_enabled(k) and k in STYLES:
        return STYLES[k]
    if k and k in STYLES and not is_enabled(k):
        # 只在有明确脏值时记一笔，避免老项目（key 为空）每张图刷一行日志
        log.info("[style] 画风 %r 尚未启用，本次回退到 %s", k, DEFAULT.key)
    d = default_style(mode)
    if is_enabled(d):
        return STYLES[d]
    return DEFAULT


def load(project_id: str) -> Style:
    """读项目的实际生效画风。读不到一律给 `DEFAULT`（= 改动前行为）。

    与 `look_profile.load` 同款的**同步读库**：画风的注入点在 `jobs` 里有
    多处（首帧、场景基准帧、视频提示词、五处资产图），逐个把参数传下来
    必然漏掉一两处，而漏掉的那条路径出的图就是"画风没生效"的。
    读一行 SQLite 的开销可忽略。
    """
    try:
        from .db import Project, get_session
        with get_session() as session:
            p = session.get(Project, project_id)
            if not p:
                return DEFAULT
            return resolve(p.production_mode, p.art_style)
    except Exception as e:                  # noqa: BLE001 画风是增强项，绝不阻断出图
        log.warning("[style] 读取项目画风失败，本次用默认档: %r", e)
        return DEFAULT


def sanitize(mode: str | None, key: str | None) -> str | None:
    """入库前清洗用户传来的画风 key。

    **保留未启用的合法 key**（不改写成 urban）：用户在前端选了"古风"这件事
    本身是有意义的意图记录，等古风放开后无需重新设置。真正的"现在生成什么"
    由 `resolve()` 决定，两者分工明确。

    不合法（不属于该模式、或压根不存在）→ None，即"没设置"。
    """
    k = (key or "").strip()
    if not k:
        return None
    if k not in STYLES:
        return None
    if k not in styles_of(mode):
        return None
    return k


def catalog() -> dict:
    """下发给前端的完整目录（前端**不硬编码**任何画风名与可用性）。

    `enabled=False` 的项前端要**列出但禁用 + 挂「待完善」徽章**（用户决策）：
    看得见规划、点不动，就不会有人建出一个生成结果不对的项目。
    """
    return {
        "modes": [
            {
                "key": m.key,
                "label": m.label,
                # 该模式下有任何一档可用，这个模式才是可用的。动漫剧三档全未启用
                # → 模式本身也禁用，否则用户能建出一个"画风必然回退成实拍"的动漫项目。
                "enabled": any(is_enabled(k) for k in m.styles),
                "default": default_style(m.key),
                "styles": [
                    {
                        "key": k,
                        "label": STYLES[k].label,
                        "desc": STYLES[k].desc,
                        "enabled": is_enabled(k),
                    }
                    for k in m.styles if k in STYLES
                ],
            }
            for m in MODES
        ],
    }
