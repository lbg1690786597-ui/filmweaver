"""全片影调档案（Look）——把"不同图画面色调不统一"收敛到一份可编辑的规格上。

## 问题定位（2026-09-09 用户反馈：「不同图片画面色调不统一」）

查完全链路，色调漂移有四个来源，本模块只解决第一个，但它是最大的那个：

1. **提示词里一个字的影调约束都没有**。`asset_prompt.REALISTIC_STYLE` 只说
   「真人实拍写实风格，电影级摄影质感，高分辨率」——白平衡、对比、饱和度、
   黑位、颗粒、镜头质感**全部未定**。生图模型于是每张图自己决定一套，
   同一个项目里必然出现一张偏冷一张偏暖。
2. 资产生图恒用全局默认模型（`run_asset_batch` 的 payload 少传 `model_id`），
   镜头图用项目模型 → 两者不同型号时质感必然两套。**在 jobs.py 侧修**。
3. 场景图彼此没有参考链（角色图有基准图链，见 `jobs._gen_character`）→
   每个场景的 Look 各自独立。**在 jobs.py 侧加 `_gen_scene` 基准链**。
4. 后处理色彩匹配。**刻意不做在参考图上**：参考图会被逐镜注入，
   在它上面烘一层滤镜等于把滤镜传播进每一个镜头，且不可逆。
   只在设定板缩略图 / 成片调色环节做。

## ⚠️ 要统一的是 Look，不是光线情境

这是本模块最容易被用错的地方，所以写在最前面：

| | 该不该统一 | 例子 |
|---|---|---|
| **Look（调色基调）** | **该统一** | 白平衡基准、对比曲线、饱和度、黑位、颗粒、镜头质感 |
| **光线情境** | **不该统一** | 客厅白天自然光 vs 主卧深夜床头灯；日/夜、明/暗、光源方向 |

实测本项目 5 个场景描述里，客厅是「白天自然光透落地窗」、主卧是「深夜仅一盏
铜质床头灯」——这是**剧本要的**。把它们拉成一样亮，画面统一了，戏没了。

所以 `phrase()` 产出的句子明确写着"这是调色基调，不改变本镜既有的光线情境"。
落地方式是"在既有光线情境之上套用同一套调色基调"，而不是"所有图一个亮度"。

## 为什么挂在项目上而不是镜头上

一份 Look 就是一部戏的"洗印厂配方"，全片唯一。挂镜头 = N 份配方 = 又不统一了。
存储与 `Asset.profile_json`（人物档案）同构：`projects.look_json`，
幂等补列，不新开表。

## 与人物档案的关系

架构刻意照抄 `character_profile`：受限词表 + 自由补充 + 单次 LLM 生成 +
`confirmed` 保护 + 前端下拉从后端取值域（前端不硬编码任何词）。
两者一起构成"全项目一份、用户可编辑、直接决定出图"的两份规格：
`character_profile` 管**人长什么样**，本模块管**画面什么调**。
"""
from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass

log = logging.getLogger(__name__)

#: 档案结构版本。将来加轴/改值域时用它判断老档案要不要重生成。
SCHEMA_VERSION = 1

#: 单轴取值长度上限（自定义值也钳到这个长度）。与 character_profile 同口径。
AXIS_MAX_LEN = 24
#: 自由补充上限。
EXTRA_MAX_LEN = 200


@dataclass(frozen=True)
class Axis:
    key: str
    label: str
    values: tuple[str, ...]
    #: 拼进提示词的短语模板，`{}` 处填取值。
    phrase: str


#: 影调八轴。选轴标准：**必须是"看一眼就能判断两张图是不是一套"的属性**。
#: 刻意不收"亮度/曝光"——那是光线情境（日戏夜戏本就不同亮度），
#: 收进来就会把剧本要的明暗差异一起抹平（见模块头的表）。
AXES: tuple[Axis, ...] = (
    Axis("palette", "主色调倾向",
         ("中性自然", "冷蓝调", "暖橙调", "青橙对比", "低饱和灰调",
          "暖金怀旧", "冷绿冷调", "水泥灰蓝"),
         "整体色调{}"),
    Axis("white_balance", "白平衡基准",
         ("标准日光白平衡", "略偏冷白平衡", "略偏暖白平衡", "钨丝灯暖白平衡"),
         "{}"),
    Axis("contrast", "反差",
         ("中等反差", "低反差柔和", "高反差硬朗", "柔和胶片反差"),
         "{}"),
    Axis("saturation", "饱和度",
         ("自然饱和", "低饱和克制", "高饱和浓烈", "肤色饱和其余克制"),
         "{}"),
    Axis("black_level", "黑位",
         ("标准黑位", "通透浅黑位", "深沉压黑位", "胶片抬升黑位"),
         "{}"),
    Axis("grain", "颗粒质感",
         ("干净无颗粒", "轻微胶片颗粒", "明显胶片颗粒"),
         "{}"),
    Axis("lens", "镜头质感",
         ("标准电影镜头", "大光圈浅景深", "广角纪实", "长焦压缩空间"),
         "{}"),
    Axis("reference", "影调参考",
         ("现代都市剧标准影调", "高级质感商业广告影调", "冷峻悬疑影调",
          "日系清透影调", "港片霓虹影调", "好莱坞青橙影调"),
         "参考{}"),
)

_BY_KEY = {a.key: a for a in AXES}


def axes_payload() -> list[dict]:
    """下发给前端的词表（前端不硬编码任何词，与人物档案同口径）。"""
    return [{"key": a.key, "label": a.label, "values": list(a.values)} for a in AXES]


def is_custom(key: str, value: str) -> bool:
    """该取值是否越界（不在词表里）。越界值**保留不丢**，仅在 UI 上标注。"""
    a = _BY_KEY.get(key)
    if a is None:
        return True
    return (value or "").strip() not in a.values


def _clip(s: str, n: int) -> str:
    t = (s or "").strip()
    return t[:n] if len(t) > n else t


def decode(raw: str | None) -> dict | None:
    """`projects.look_json` → dict。坏 JSON 当没有（不让脏数据把出图链路带崩）。"""
    if not (raw or "").strip():
        return None
    try:
        d = json.loads(raw)
    except (ValueError, TypeError):
        log.warning("[look] look_json 解析失败，按无档案处理")
        return None
    return d if isinstance(d, dict) else None


def has_content(look: dict | None) -> bool:
    """有没有任何可用内容。空档案时所有 `phrase()` 返回空串，出图退回旧口径。"""
    if not look:
        return False
    axes = look.get("axes") or {}
    return bool(any((v or "").strip() for v in axes.values())
                or (look.get("extra") or "").strip())


def sanitize(axes: dict | None, extra: str | None = None) -> tuple[dict, str]:
    """入库前的兜底：丢掉非词表的 key、钳长度。越界**取值**保留（只标不丢）。"""
    out: dict[str, str] = {}
    for k, v in (axes or {}).items():
        if k not in _BY_KEY:
            continue                        # 非词表 key 是脏数据，丢
        val = _clip(str(v or ""), AXIS_MAX_LEN)
        if val:
            out[k] = val
    return out, _clip(str(extra or ""), EXTRA_MAX_LEN)


# ---------------------------------------------------------------- 提示词短语

#: 影调句的前缀。写成"全片统一"是给模型的强约束——它要理解这不是本张图的
#: 自由发挥空间。
_HEAD = "全片统一影调（Look）："

#: 这句话是本模块的**要害**，删了就会把剧本要的明暗差异抹平（见模块头）。
#: 放在影调句尾部而不是开头：模型对句尾的"例外声明"遵循度实测更好，
#: 放开头容易被后面的具体色调词盖过去。
_TAIL = (
    "以上是**调色基调**，仅决定色温/反差/饱和/黑位/质感，"
    "**不改变**本画面既有的光线情境（日景/夜景、明亮/昏暗、光源方向与数量）——"
    "在既有光线情境之上套用同一套调色基调。"
)


def phrase(look: dict | None) -> str:
    """影调档案 → 一句可直接拼进任何生图提示词的话。空档案返回空串。

    调用点（全部经由这里，没有第二处拼影调的地方）：
    `asset_prompt.character_prompt` / `asset_prompt.scene_prompt` /
    `jobs` 首帧提示词。
    """
    if not has_content(look):
        return ""
    axes = look.get("axes") or {}
    bits: list[str] = []
    for a in AXES:                          # 按 AXES 顺序，不按 dict 顺序：
        v = (axes.get(a.key) or "").strip()  # 同一份档案每次拼出的字面必须一致
        if v:
            bits.append(a.phrase.format(v))
    extra = (look.get("extra") or "").strip()
    if extra:
        bits.append(extra.rstrip("。"))
    if not bits:
        return ""
    return f"{_HEAD}{'，'.join(bits)}。{_TAIL}"


# ---------------------------------------------------------------- LLM 生成

#: 判影调的系统提示词。`{style_hint}` 由**项目画风**填（`style_preset.Style.look_hint`）——
#: 原文这里写死「这是一部现代都市真人实拍剧」，古装剧/动漫剧被按现代都市判影调，
#: 出来的配方从根上就是错的。
#:
#: ⚠️ 用 `str.replace` 而不是 `str.format` 占位：本串里有 `{"axes": …}` 这段
#: JSON 样例，`format` 会把它当占位符炸掉。
_SYS_FMT = (
    "你是影视剧的调色指导（DI colorist）。读下面的剧本片段，为这部戏定一套"
    "**全片统一的影调（Look）**，也就是洗印厂配方。\n"
    "\n"
    "严格按 JSON 输出，不要 markdown 代码块、不要任何解释文字：\n"
    '{"axes": {"轴key": "取值", ...}, "extra": "补充说明", "reason": "一句话依据"}\n'
    "\n"
    "规则：\n"
    "1. 每个轴**优先**从给定候选值里选一个；候选覆盖不到时可以另写一个短词"
    "（不超过 12 字），但不要滥用。\n"
    "2. {style_hint}\n"
    "3. `extra` 写候选值表达不了的整片质感补充（不超过 80 字），没有就给空串。\n"
    "4. ⚠️ **不要**写具体某场戏的明暗（如「夜戏偏暗」）——影调是全片一套配方，"
    "日戏夜戏的明暗差异由各自的光线情境决定，不属于这里。\n"
    "5. 八个轴都要给值，不要留空。\n"
)


def _sys(style_hint: str | None) -> str:
    from . import style_preset as sp
    return _SYS_FMT.replace("{style_hint}", style_hint or sp.DEFAULT.look_hint)


def _candidates_block() -> str:
    lines = [f"- {a.key}（{a.label}）候选：{ '、'.join(a.values) }" for a in AXES]
    return "\n".join(lines)


#: 喂给模型的剧本片段上限。定影调只需要"这是什么戏、什么年代、什么气质"，
#: 前几千字足够；给全本纯属烧 token。
_SCRIPT_CAP = 4000


async def derive(title: str, script: str | None,
                 style_hint: str | None = None) -> dict | None:
    """从剧本判一套 Look。失败返回 None（调用方保持无档案，出图退回旧口径）。

    `style_hint`：该项目画风给判定 LLM 的题面（`style_preset.Style.look_hint`）。
    为空 = 都市档题面，与改动前等价。

    失败一律吞掉：影调档案是**质量增强**，渠道抽风不该让用户生不出图。
    """
    from .providers.llm import LLMProvider
    from . import style_preset as sp
    hint = style_hint or sp.DEFAULT.look_hint
    text = (script or "").strip()[:_SCRIPT_CAP]
    user = (f"剧名：《{title}》\n\n"
            f"可选取值：\n{_candidates_block()}\n\n"
            f"剧本片段：\n{text if text else f'（无剧本，按该片种的通用影调给：{hint}）'}")
    try:
        llm = LLMProvider()
        raw = await llm.complete(_sys(hint), user)
    except Exception as e:                  # noqa: BLE001
        log.warning("[look] 影调档案生成失败：%s", e)
        return None
    return _parse(raw)


def _parse(raw: str | None) -> dict | None:
    """宽容解析：模型偶尔会裹 ```json 代码块或前后加话。"""
    t = (raw or "").strip()
    if not t:
        return None
    if "```" in t:                          # 剥代码块
        seg = t.split("```")
        for s in seg:
            s = s.strip()
            if s.startswith("json"):
                s = s[4:].strip()
            if s.startswith("{"):
                t = s
                break
    i, j = t.find("{"), t.rfind("}")
    if i < 0 or j < i:
        log.warning("[look] 模型输出里找不到 JSON：%s", t[:120])
        return None
    try:
        d = json.loads(t[i:j + 1])
    except ValueError as e:
        log.warning("[look] JSON 解析失败：%s | %s", e, t[i:j + 1][:120])
        return None
    if not isinstance(d, dict):
        return None
    axes, extra = sanitize(d.get("axes"), d.get("extra"))
    if not axes:
        return None
    return {"version": SCHEMA_VERSION, "axes": axes, "extra": extra,
            "reason": _clip(str(d.get("reason") or ""), 120),
            "status": "draft"}


# ---------------------------------------------------------------- 读写

#: 与 character_profile 同款：同一项目并发跑一键成片时别重复调 LLM。
_LOCK = asyncio.Lock()


def load(project_id: str) -> dict | None:
    """读项目影调档案。没有返回 None。"""
    from .db import Project, get_session
    with get_session() as session:
        p = session.get(Project, project_id)
        return decode(p.look_json) if p else None


def save(project_id: str, look: dict, *, confirmed: bool = False) -> dict | None:
    """写项目影调档案。`confirmed=True` = 用户手改过，重生成不覆盖。"""
    from .db import Project, get_session
    axes, extra = sanitize(look.get("axes"), look.get("extra"))
    if not axes and not extra:
        return None
    doc = {"version": SCHEMA_VERSION, "axes": axes, "extra": extra,
           "reason": _clip(str(look.get("reason") or ""), 120),
           "status": "confirmed" if confirmed else (look.get("status") or "draft")}
    with get_session() as session:
        p = session.get(Project, project_id)
        if p is None:
            return None
        p.look_json = json.dumps(doc, ensure_ascii=False)
        session.commit()
    return doc


async def ensure(project_id: str) -> dict | None:
    """一键成片入口调这个：没有档案就生成一份并落库；已有（含用户确认的）直接返回。

    与 `character_profile.ensure_profiles` 同款语义——**绝不覆盖已有档案**，
    尤其是 `status=confirmed` 的：用户手调过的影调比 AI 猜的金贵。
    """
    from .db import Project, get_session
    from . import style_preset as sp
    async with _LOCK:
        with get_session() as session:
            p = session.get(Project, project_id)
            if p is None:
                return None
            existing = decode(p.look_json)
            title = p.title or "未命名"
            script = p.optimized_script or p.raw_script
            # 画风题面就地取：古装剧被按现代都市判影调，配方从根上就是错的。
            hint = sp.resolve(p.production_mode, p.art_style).look_hint
        if has_content(existing):
            return existing
        look = await derive(title, script, hint)
        if look is None:
            return None
        return save(project_id, look)
