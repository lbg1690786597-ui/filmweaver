"""人物形象档案（结构化五官/气质）——资产定妆照提示词的形象锚。

## 为什么需要这个模块（与 `character_brief` 的分工）

`character_brief` 解决的是**人称**问题：性别/年龄段/身份，让逐镜提示词不把
女主写成 he。它的 `brief` 是一句 30 字以内的自由文本，够用于"别写错代词"，
但**远不够用于生图**——用户 2026-09-09 反馈：

> 现在的人物提示词设计太简单了，30 字上限也非常荒谬。

实测一条定妆照提示词共 162 字，其中描写"这个人长什么样"的只有 21 字
（`人物设定：女性，儿童，约 4-11 岁，叶轻语的妹妹`）。
脸型/眉型/眼型/眼神/鼻梁/唇形/下颌/肤色/骨相/妆容 —— 这一整个维度
在旧结构里**没有字段可以承载**，不是写得短，是没地方写。

本模块补上这些字段。分工：

| | `character_brief` | `character_profile`（本模块） |
|---|---|---|
| 内容 | 性别 / 年龄段 / 身份职业 | 骨相·肤色·五官分项·气质·妆容·发色 |
| 粒度 | 按集 | **按项目**（一个角色一份，脸不随集数变） |
| 存储 | 进程内缓存 | **落库** `Asset.profile_json` |
| 用于 | 逐镜提示词 + 定妆照 | **只用于定妆照**（见下） |

## 为什么五官只进定妆照、不进逐镜提示词

全能参考模式下逐镜已经带了定妆图当参考。提示词里再写「丹凤眼」只会
**和参考图打架** —— 这正是 `character_brief` 模块开头记录的那个 bug 的
同构形态（提示词与参考图冲突时，模型按提示词走，参考图形同虚设）。
所以 `merge_into_brief` 只把 gender/age/气质 回灌给逐镜，五官留在本模块内。

## 为什么必须落库

档案里的 gender/age 是**可重判**的（有剧本证据、temperature=0）；
但「眼型 = 丹凤眼」是审美判断，重判几乎必然不同。若只放进程内缓存，
`systemctl restart` 之后用户点一次「重新生成」就换了张脸。
落库同时也是「用户能在 UI 里改脸」的前提 —— 那是他们真正要的控制力。

## 受限词表 + 自由补充

词表来自用户提供的属性文档，做了三处修改（见 `docs/PLAN-人物档案与分层提示词.md` §5）：

1. **年龄不用用户那 5 档**（少年/青年/轻熟/成熟/中年）——它没有幼儿/儿童/老年，
   而剧本里就有儿童与老人。年龄仍由 `character_brief._AGE_LABEL` 的 7 档承担，
   本模块不重复定义，避免两处词表漂移。
2. **气质词表按题材分档**：`清冷禁欲/温润书生/桀骜江湖` 是古风言情向的，
   现代都市短剧里硬套会把管家写成「温润书生」。
3. **妆容与记忆点可缺省**：对男性与儿童不适用。缺省即不进提示词 ——
   与其让模型看到「妆容：无」而随机发挥，不如不提（`age` 已验证过这条策略）。

严格性分两级：`gender`/`age` 由 `character_brief` 强校验（越界即"未知"）；
本模块的审美轴**允许越界值**（词表覆盖不到的特征也该写得进去），
只是 UI 上标注为"自定义"。

## 风格预设：当前只上线「现代真人」一档

用户 2026-09-09 决策：实际生效的结构里**只保留现代真人风格**，古风描述词
不投入使用，但**留在代码里备查**，等后期做其他风格预设时再启用。落地方式：

- `ENABLED_GENRES = (GENRE_MODERN,)` 是唯一开关；
- `active_genre()` 把任何题材（老档案里的 `period`/`generic`、前端回传值、
  `infer_genre` 的猜测）统一夹到已上线档，`axes_for_genre` / `_system` /
  `save_profile` / `_layer` 全部经由它取值域，没有第二条漏网路径；
- 词表只能约束"从候选里挑"，而 `_system` 有意允许越界自定义短词，
  所以 `_STYLE_NOTE` 再明文禁一次古风/动漫类用词。
"""
from __future__ import annotations

import asyncio
import json
import logging
import uuid

from .db import Asset, Project, get_session

log = logging.getLogger(__name__)

#: 档案结构版本。将来加轴/改语义时靠它区分，不靠"字段在不在"去猜。
SCHEMA_VERSION = 1

# ---------------------------------------------------------------- 词表

#: 题材档 = 未来的**风格预设**。`内核人设`/`神态常态`/`妆容风格` 三轴按题材取
#: 值域——其余轴（脸型/眉型/…）是纯生理描述，与题材无关，不分档。
GENRE_MODERN = "modern"
GENRE_PERIOD = "period"
GENRE_GENERIC = "generic"

#: ⚠️ **当前只上线「现代真人」一档**（用户 2026-09-09 决策）。
#: 古装档的词表下面**照旧保留，但对运行时不可达**：`ACTIVE_GENRE` 会把任何
#: 题材（含老档案里存的 `period` / `generic`）一律夹到现代档。
#:
#: 为什么不是直接删掉古装词：后期规划里还有别的风格预设（古装、玄幻、年代…），
#: 那些词表是有价值的素材；删了将来要重写，留着又不能让它悄悄生效——
#: 所以用"保留数据 + 一个开关关死入口"，而不是注释掉或删除。
#:
#: 做风格预设时**只需**改这两行（把 period 加进 ENABLED_GENRES、让
#: ACTIVE_GENRE 重新由 infer_genre / 用户所选预设决定），词表和拼装逻辑不用动。
ENABLED_GENRES = (GENRE_MODERN,)

_PERSONA = {
    GENRE_MODERN: ["清冷禁欲", "明艳张扬", "温润儒雅", "暴戾权谋", "破碎病弱",
                   "桀骜不驯", "温婉知性", "慵懒贵气", "精明市侩", "憨直朴实"],
    # —— 以下古装档为"后期风格预设"预留，当前不可达（见 ENABLED_GENRES）——
    GENRE_PERIOD: ["清冷禁欲", "妖冶妩媚", "温润书生", "暴戾权谋", "破碎病弱",
                   "桀骜江湖", "温婉闺秀", "慵懒贵气"],
}
_PERSONA[GENRE_GENERIC] = sorted(set(_PERSONA[GENRE_MODERN]) |
                                 set(_PERSONA[GENRE_PERIOD]))

_DEMEANOR = {
    GENRE_MODERN: ["疏离寡言", "慵懒漫不经心", "隐忍克制", "凌厉压迫",
                   "温柔无害", "阴郁寡欢", "明艳张扬", "精干利落"],
    GENRE_PERIOD: ["疏离寡言", "慵懒漫不经心", "隐忍克制", "凌厉压迫",
                   "温柔无害", "阴郁寡欢", "明艳张扬"],
}
_DEMEANOR[GENRE_GENERIC] = sorted(set(_DEMEANOR[GENRE_MODERN]) |
                                  set(_DEMEANOR[GENRE_PERIOD]))

#: 妆容同样分题材：实测模型给现代剧的女二选了「淡古风妆」——词表里有它，
#: 模型就有权选它，结果定妆图的妆面和剧情年代打架。把不合题材的取值
#: 从值域里删掉，比在提示词里叮嘱模型「注意年代」可靠。
_MAKEUP = {
    GENRE_MODERN: ["伪素颜", "淡妆通勤", "浓艳华妆", "无妆感", "冷感寡妆",
                   "破碎弱妆", "精致全妆"],
    GENRE_PERIOD: ["伪素颜", "淡古风妆", "浓艳华妆", "无妆感", "冷感寡妆",
                   "破碎弱妆"],
}
_MAKEUP[GENRE_GENERIC] = sorted(set(_MAKEUP[GENRE_MODERN]) |
                                set(_MAKEUP[GENRE_PERIOD]))

#: 值域随题材变的轴。其余轴（骨相/五官等）与题材无关，各题材共用一份。
_BY_GENRE = {"persona": _PERSONA, "demeanor": _DEMEANOR, "makeup": _MAKEUP}


class Axis:
    """一条档案轴。

    `layer` 决定它拼进 7 层提示词模板的哪一层（见 `asset_prompt`）；
    `optional=True` 的轴缺省时**整项不进提示词**，不写「未知」。
    """

    __slots__ = ("key", "label", "values", "layer", "phrase", "optional")

    def __init__(self, key: str, label: str, values, layer: str,
                 phrase: str, optional: bool = False):
        self.key = key
        self.label = label
        self.values = values          # list[str] | None（None = 纯自由文本轴）
        self.layer = layer            # overview | hair | face
        self.phrase = phrase          # 拼进提示词的模板，`{}` 处填值
        self.optional = optional


#: 全部审美轴，**顺序即提示词里的出现顺序**。
#: `phrase` 刻意写成完整短句而不是「键：值」——生图模型对自然语言的遵循度
#: 明显高于键值对（镜头级提示词早已是这个口径）。
AXES: list[Axis] = [
    # 第 2 层 角色总述
    Axis("build", "身高骨相",
         ["骨感", "肉感", "匀称", "瘦削", "丰腴", "硬朗", "柔和"],
         "overview", "{}的身形"),
    Axis("skin", "肤色",
         ["冷白皮", "暖白皮", "自然黄皮", "浅麦色", "病态苍白", "冷调寡白"],
         "overview", "肤色为{}"),
    Axis("face_shape", "脸型",
         ["鹅蛋脸", "瓜子脸", "方圆脸", "长脸", "圆脸", "窄长脸", "短幼脸", "菱形脸"],
         "overview", "{}"),
    Axis("jaw", "下颌",
         ["下颌线条锋利", "下颌线条柔和", "尖下巴", "方圆下颌",
          "下颌紧致冷硬", "下颌柔和幼态"],
         "overview", "{}"),
    # 第 3 层 发型发饰（只放**不随造型变**的发色与发丝质感；
    # 具体发型由 AssetStage.description 逐造型给，见 asset_prompt 的注释）
    Axis("hair_color", "发色",
         ["纯黑", "黑褐", "深棕", "浅棕", "亚麻棕", "花白", "全白", "挑染"],
         "hair", "发色{}"),
    Axis("hair_texture", "发丝质感",
         ["顺直服帖", "自然微卷", "蓬松丰厚", "细软稀疏", "干枯凌乱", "油亮光泽"],
         "hair", "发丝{}", optional=True),
    # 第 4 层 眉眼特征
    Axis("brow", "眉型",
         ["平眉", "剑眉", "远山眉", "柳叶眉", "挑眉", "浅淡雾眉", "浓黑粗眉", "下垂哀眉"],
         "face", "{}"),
    Axis("eye_shape", "眼型",
         ["丹凤眼", "桃花眼", "杏眼", "狐狸眼", "狭长凤眼", "圆鹿眼", "下垂狗狗眼", "冷吊眼"],
         "face", "{}"),
    Axis("gaze", "眼神",
         ["眼尾上挑", "眼尾下压", "眼距偏宽", "眼距偏窄", "低眉垂眼",
          "直视冷冽", "水光朦胧", "眼神慵懒"],
         "face", "{}"),
    Axis("nose", "鼻梁",
         ["高挺直鼻", "秀气小鼻", "微驼鼻", "圆润短鼻", "冷硬高鼻"],
         "face", "{}"),
    Axis("lips", "唇形",
         ["薄唇", "厚唇", "唇珠明显", "M唇", "淡抿唇", "微张欲念唇", "浅淡素唇"],
         "face", "{}"),
    # 记忆点必须是"能一眼认出这个人"的具体特征。原参考词表里的「寡淡无妆」
    # 已换掉：它描述的是妆容（与 makeup 轴重复，实测拼出「寡淡无妆，无妆感」），
    # 且"没有妆"本身不构成记忆点。
    Axis("mark", "独有记忆点",
         ["泪痣", "唇下痣", "眼下暗沉", "浅淡雀斑", "眉骨突出", "卧蚕明显",
          "颊侧梨涡", "眉尾小疤"],
         "face", "{}", optional=True),
    # 妆容与气质两轴题材相关，values 在 axes_for_genre 里按题材替换
    Axis("makeup", "妆容风格", None, "face", "{}", optional=True),
    Axis("persona", "内核人设", None, "face", "整体气质{}"),
    Axis("demeanor", "神态常态", None, "face", "神态{}"),
]

_AXIS_BY_KEY = {a.key: a for a in AXES}

#: 每轴取值的长度上限。允许越界值（自定义特征），但不允许模型在某一轴上
#: 写出一整段散文——那会让"可枚举、可下拉、可校验"的结构失去意义。
AXIS_MAX_LEN = 24

#: 自由补充的长度上限。词表覆盖不到的特征（疤痕/义眼/发型细节）写这里。
#: 给得宽松：用户明确要求放开字数，不再吝惜提示词长度。
EXTRA_MAX_LEN = 200


def active_genre(genre: str | None = None) -> str:
    """把任意题材夹到**已上线**的风格预设。

    当前只上线现代真人一档，所以无论传进来什么（老档案里的 `period`、
    `generic`，或前端回传的空值），都返回 `modern`。这是古装词表唯一的入口，
    夹在这里就不会有第二处漏网——`axes_for_genre` / `_system` / `_parse` /
    `_layer` 全部经由它取值域。
    """
    g = genre if genre in (GENRE_MODERN, GENRE_PERIOD, GENRE_GENERIC) else None
    if g in ENABLED_GENRES:
        return g
    return ENABLED_GENRES[0]


def axes_for_genre(genre: str) -> list[Axis]:
    """按题材返回轴定义（气质两轴 + 妆容的值域随题材变，其余轴不变）。"""
    g = active_genre(genre)
    out: list[Axis] = []
    for a in AXES:
        vals = _BY_GENRE.get(a.key)
        if vals is None:
            out.append(a)
        else:
            # 注意保留 optional：makeup 是可缺省轴，重建时漏掉会让男性角色
            # 被迫写「妆容：无」。
            out.append(Axis(a.key, a.label, vals[g], a.layer, a.phrase,
                            optional=a.optional))
    return out


def is_custom(key: str, value: str, genre: str = GENRE_MODERN) -> bool:
    """该取值是否不在**当前生效**词表内（UI 据此标「自定义」）。

    默认值用现代档而非 generic：generic 是三档的并集，含古装词，
    拿它当默认会让古装词被判成"非自定义"——那等于把关掉的预设漏出来。
    """
    for a in axes_for_genre(genre):
        if a.key == key:
            return bool(value) and bool(a.values) and value not in a.values
    return False


# ---------------------------------------------------------------- 题材推断

#: 古装题材的指示词。为后期风格预设保留——当前 `infer_genre` 不会返回古装档
#: （见 `ENABLED_GENRES`），这份指示词表只是把"怎么判"先记下来。
#: 纯启发式：判错的后果只是气质词表选了另一档（值域更贴或更不贴），
#: 不会让流程失败，所以不值得为它多花一次 LLM 调用。
_PERIOD_HINTS = ("皇上", "陛下", "娘娘", "王爷", "将军府", "丞相", "太子",
                 "格格", "公主", "宫女", "太监", "客栈", "镖局", "江湖",
                 "长袍", "马褂", "旗袍", "汉服", "唐装", "衙门", "县令")


def period_hits(script: str) -> int:
    """剧本命中了几个古装指示词。当前只用于日志/将来的风格预设建议。"""
    text = script or ""
    return sum(1 for w in _PERIOD_HINTS if w in text)


def infer_genre(script: str) -> str:
    """推断该用哪档风格预设。

    ⚠️ 当前只上线现代真人一档，所以**恒返回 modern**（`active_genre` 兜底）。
    古装判据保留在 `period_hits` 里：命中 ≥2 个指示词才算古装（单个易误判），
    等风格预设上线后把它接回来即可。
    """
    hits = period_hits(script)
    guess = GENRE_PERIOD if hits >= 2 else GENRE_MODERN
    g = active_genre(guess)
    if g != guess:
        log.info("[profiles] 剧本命中 %d 个古装指示词，但古装预设未上线，"
                 "按 %s 生成", hits, g)
    return g


# ---------------------------------------------------------------- LLM

#: 每档风格预设给模型的画风约束。词表只能管"从候选值里挑"的情况——
#: `_system` 允许模型给越界的自定义短词（这是有意的，覆盖不到的特征要留口），
#: 而那正是古风词可能溜进来的路。所以词表之外再明说一遍画风。
_STYLE_NOTE = {
    GENRE_MODERN: (
        "⚠️ 本片是**现代都市真人实拍**风格。档案里不要出现古风/古装/仙侠/动漫/"
        "游戏立绘类的描述词（如「温润书生」「妖冶妩媚」「古风妆」「侠客」"
        "「江湖」「云鬓」「二次元」），发色也不要写不自然的染色（蓝/紫/银）。"
        "自己另写的短词同样要守这条。"),
    GENRE_PERIOD: (
        "⚠️ 本片是**古装真人实拍**风格。不要出现现代物件与现代妆造词"
        "（如「通勤妆」「运动短发」「西装头」），也不要动漫/游戏立绘类描述词。"),
}


def _system(genre: str) -> str:
    """按题材拼系统提示词（把该题材的值域直接写进去）。"""
    lines = [
        "你是影视人物造型设计师。下面给你一部剧的剧本和角色名单，"
        "请为**每个**角色设计一套固定的外貌档案，用于生成角色定妆图。",
        "",
        "这套档案是该角色**全剧统一**的长相，与他穿什么衣服无关——"
        "不要写服装（服装由别处逐场景提供），只写长相、五官、气质。",
        "",
        "每一项都要填。请优先从给定的候选值里挑一个；"
        "剧本里的角色确实有候选值覆盖不到的特征时，可以自己写一个"
        f"（不超过 {AXIS_MAX_LEN} 字的短词），但不要写成句子。",
        "",
    ]
    for a in axes_for_genre(genre):
        vals = "／".join(a.values) if a.values else "（自由填写）"
        opt = "（可留空字符串）" if a.optional else ""
        lines.append(f"- {a.key}（{a.label}）{opt}：{vals}")
    note = _STYLE_NOTE.get(active_genre(genre))
    if note:
        lines += ["", note]
    lines += [
        "",
        f"- extra（自由补充，可留空）：候选值放不下的独有特征，"
        f"不超过 {EXTRA_MAX_LEN} 字。例如疤痕、义眼、胎记、特殊发型、"
        f"标志性配饰。没有就留空字符串。",
        "",
        "判定依据只能是剧本：角色的身份、辈分、他人对其外貌的描述、"
        "台词透出的性格。剧本没有明确写外貌时，按其身份与性格做**合理且稳定**"
        "的设计（管家沉稳、少爷张扬），不要随机。",
        "",
        "⚠️ 同一部剧里不同角色的档案要**互相区分开**：不要给所有人都写"
        "「鹅蛋脸 + 杏眼 + 薄唇」。观众要能一眼分辨谁是谁，"
        "这正是这份档案存在的目的。",
        "",
        '严格输出 JSON：{"角色名":{"build":"匀称","skin":"自然黄皮",'
        '"face_shape":"鹅蛋脸", ...,"extra":""}}。'
        "只为给定的角色名输出，不要新增、不要改名。"
        "只输出 JSON，不要 markdown 代码块、不要解释。",
    ]
    return "\n".join(lines)


def _parse(raw: str, names: list[str], genre: str) -> dict[str, dict]:
    """解析模型返回。越界值保留（自定义特征），只做长度钳制。"""
    text = (raw or "").strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:]
    start, end = text.find("{"), text.rfind("}")
    if start >= 0 and end > start:
        text = text[start:end + 1]
    try:
        data = json.loads(text)
    except (ValueError, TypeError):
        return {}
    if not isinstance(data, dict):
        return {}

    out: dict[str, dict] = {}
    for n in names:
        v = data.get(n)
        if not isinstance(v, dict):
            continue
        axes: dict[str, str] = {}
        for a in axes_for_genre(genre):
            val = v.get(a.key)
            if not isinstance(val, str):
                continue
            val = val.strip()[:AXIS_MAX_LEN]
            # 模型偶尔用「未知」「无」表示"没填"。必填轴上这等于没给，
            # 留空比写「未知」好：`layer_*` 会跳过空值，而「未知」会
            # 原样进提示词让模型自由发挥（age 那次已验证过这个坑）。
            if val in ("", "未知", "无", "不详", "N/A", "null"):
                continue
            axes[a.key] = val
        extra = v.get("extra")
        extra = extra.strip()[:EXTRA_MAX_LEN] if isinstance(extra, str) else ""
        if not axes and not extra:
            continue
        out[n] = {"v": SCHEMA_VERSION, "genre": genre,
                  "axes": axes, "extra": extra, "status": "draft"}
    return out


_LOCK = asyncio.Lock()


async def _generate(project_id: str, names: list[str], script: str,
                    genre: str, model_id: str | None) -> dict[str, dict]:
    """一次调用把全部角色的档案判出来。失败返回 {}（不阻断出图链路）。

    刻意**不**按角色拆成 N 次调用：同一次调用里模型能看到全部角色，
    才做得到「互相区分开」（见 `_system` 的最后一条要求）。
    拆开调用每次都只看到一个人，必然人人都是鹅蛋脸杏眼。
    """
    from .providers.llm import LLMProvider
    try:
        llm = LLMProvider(model_id=model_id)
        raw = await llm.complete(
            _system(genre),
            f"角色名单：{'、'.join(names)}\n\n剧本：\n{script}",
            temperature=0.4, allow_truncated=True)
        return _parse(raw, names, genre)
    except Exception as e:  # noqa: BLE001
        log.warning("[profile %s] 形象档案生成失败，退回无档案: %r", project_id, e)
        return {}


# ---------------------------------------------------------------- 读写库

def load_profiles(project_id: str) -> dict[str, dict]:
    """读该项目已落库的全部角色形象档案 `{角色名: 档案}`。"""
    from . import asset_gate
    out: dict[str, dict] = {}
    with get_session() as session:
        # 被用户删掉的角色不出档案：档案会被拼进提示词，出档案 = 它还在出图。
        rows = asset_gate.alive(
            session.query(Asset)
            .filter(Asset.project_id == project_id,
                    Asset.kind == "character",
                    Asset.profile_json.isnot(None))).all()
        for a in rows:
            p = decode(a.profile_json)
            if p:
                out[a.name] = p
    return out


def decode(blob: str | None) -> dict | None:
    """宽容解析 profile_json。坏数据当没有——档案是增强项，不该让页面打不开。"""
    if not blob:
        return None
    try:
        d = json.loads(blob)
    except (ValueError, TypeError):
        return None
    if not isinstance(d, dict) or not isinstance(d.get("axes"), dict):
        return None
    return d


def save_profile(project_id: str, name: str, profile: dict) -> bool:
    """写单个角色的档案（用户手改走这里）。返回是否写成功。

    手改的一律标 `status="confirmed"`：自动生成不会覆盖它
    （与 `AssetStage.status` 的人工确认保护同款）。
    """
    axes: dict[str, str] = {}
    for k, v in (profile.get("axes") or {}).items():
        if k in _AXIS_BY_KEY and isinstance(v, str) and v.strip():
            axes[k] = v.strip()[:AXIS_MAX_LEN]
    extra = profile.get("extra")
    extra = extra.strip()[:EXTRA_MAX_LEN] if isinstance(extra, str) else ""
    # 手改保存时也把题材夹到已上线的预设：否则前端回传一个旧的 `period`
    # 就能把关掉的古装词表写回库里。
    genre = active_genre(profile.get("genre"))
    with get_session() as session:
        a = (session.query(Asset)
             .filter(Asset.project_id == project_id,
                     Asset.kind == "character", Asset.name == name).first())
        if a is None:
            return False
        a.profile_json = json.dumps(
            {"v": SCHEMA_VERSION, "genre": genre, "axes": axes,
             "extra": extra, "status": "confirmed"}, ensure_ascii=False)
        session.commit()
    return True


async def ensure_profiles(project_id: str, names: list[str] | None = None,
                          model_id: str | None = None) -> dict[str, dict]:
    """确保这些角色都有形象档案，缺的补齐并落库。返回全部可用档案。

    - `names=None`：为该项目**全部**角色资产补齐。
    - 已有档案的角色一律跳过（无论 draft 还是 confirmed）：档案是"这个人长什么样"，
      一旦定下来就不该被下一次点击悄悄改掉——那等于换脸。要重生成得走
      用户显式操作（前端「重新生成档案」，即先清空 profile_json 再调本函数）。
    - 任何失败都不抛：拿不到档案就退回"只有性别年龄"的旧提示词行为。
    """
    async with _LOCK:            # 同项目并发调用只跑一次（一键成片有两条入口）
        with get_session() as session:
            proj = session.get(Project, project_id)
            if proj is None:
                return {}
            script = (proj.optimized_script or proj.raw_script or "")
            rows = (session.query(Asset)
                    .filter(Asset.project_id == project_id,
                            Asset.kind == "character").all())
            existing = {a.name: decode(a.profile_json) for a in rows}
            # 用户删掉的角色：既不出档案也不补档案。`names` 由调用方传进来时
            # 可能仍带着它（readiness 之外还有几条入口），所以在这里统一减。
            from . import asset_gate
            gone = asset_gate.deleted_names(session, project_id, "character")

        have = {n: p for n, p in existing.items() if p and n not in gone}
        # names 里可能有还没建资产行的角色（拆解一般会建，但增量拆解/手工加角色
        # 会漏）。仍然为其生成——落库时补建行，否则每次点一键成片都要重跑一次
        # LLM 且结果永远存不下来。
        want = [n for n in (names if names is not None else list(existing))
                if n and n not in gone and not existing.get(n)]
        if not want or not script.strip():
            return have

        genre = infer_genre(script)
        # 剧本给足上下文，但不整本灌：档案只需要人物的身份与性格线索，
        # 而超长上下文会显著拉高单次调用的失败率（costumes 逐集扫也是这个道理）。
        got = await _generate(project_id, want, script[:12000], genre, model_id)
        if not got:
            return have

        with get_session() as session:
            for n, p in got.items():
                a = (session.query(Asset)
                     .filter(Asset.project_id == project_id,
                             Asset.kind == "character", Asset.name == n).first())
                if a is None:
                    a = Asset(id=uuid.uuid4().hex[:12], project_id=project_id,
                              kind="character", name=n)
                    session.add(a)
                a.profile_json = json.dumps(p, ensure_ascii=False)
            session.commit()
        log.info("[profile %s] 形象档案生成 %d/%d 个角色（题材=%s）",
                 project_id, len(got), len(want), genre)
        have.update(got)
        return have


# ---------------------------------------------------------------- 提示词拼装

def _phrase(axis: Axis, val: str) -> str:
    """把取值套进该轴的短语模板。

    ⚠️ 模板前缀与取值**可能重复**（`下颌{}` + 自定义值「下颌略方」→「下颌下颌略方」）。
    词表内的值已规避，但模型可以给越界的自定义值，所以这里必须兜住：
    取值已自带前缀时就不再加。
    """
    if "{}" not in axis.phrase:
        return val
    prefix = axis.phrase.split("{}", 1)[0]
    if prefix and val.startswith(prefix):
        return axis.phrase.format(val[len(prefix):])
    return axis.phrase.format(val)


def _layer(profile: dict | None, layer: str) -> str:
    """取某一层的短语，按 AXES 顺序拼成一句。无内容返回空串。"""
    if not profile:
        return ""
    axes = profile.get("axes") or {}
    genre = active_genre(profile.get("genre"))
    parts: list[str] = []
    for a in axes_for_genre(genre):
        if a.layer != layer:
            continue
        v = (axes.get(a.key) or "").strip()
        if v:
            parts.append(_phrase(a, v))
    return "，".join(parts)


def layer_overview(profile: dict | None) -> str:
    """第 2 层 角色总述（骨相 / 肤色 / 脸型 / 下颌）。"""
    return _layer(profile, "overview")


def layer_hair(profile: dict | None) -> str:
    """第 3 层 发色与发丝质感（**不含发型**——发型逐造型变，见 asset_prompt）。"""
    return _layer(profile, "hair")


def layer_face(profile: dict | None) -> str:
    """第 4 层 眉眼五官 + 妆容 + 气质。"""
    return _layer(profile, "face")


def layer_extra(profile: dict | None) -> str:
    """自由补充（词表放不下的独有特征）。"""
    return ((profile or {}).get("extra") or "").strip()


def has_content(profile: dict | None) -> bool:
    """这份档案里有没有任何能写进提示词的东西。"""
    return bool(layer_overview(profile) or layer_hair(profile)
                or layer_face(profile) or layer_extra(profile))


# ---------------------------------------------------------------- 回灌逐镜

#: 允许进入**逐镜**提示词的轴。只有气质两轴 —— 五官刻意排除：
#: 逐镜已带定妆图当参考，提示词里再写「丹凤眼」只会和参考图打架
#: （见模块开头）。气质是表演指导，不描述长相，与参考图不冲突。
_SHOT_SAFE_AXES = ("persona", "demeanor")


def merge_into_brief(brief: dict[str, dict],
                     profiles: dict[str, dict]) -> dict[str, dict]:
    """把档案里的气质回灌进 `character_brief` 的 brief 字典，供逐镜提示词用。

    返回**新字典**，不改入参：调用方常把同一份 brief 同时用于别处。
    只动 brief 文本（追加气质词），不动 gender/age —— 那两项的事实来源
    仍是 `character_brief`，两处各判一遍只会打架。
    """
    out: dict[str, dict] = {k: dict(v) for k, v in (brief or {}).items()}
    for name, p in (profiles or {}).items():
        axes = (p or {}).get("axes") or {}
        words = [axes[k].strip() for k in _SHOT_SAFE_AXES
                 if (axes.get(k) or "").strip()]
        if not words:
            continue
        row = out.setdefault(name, {"gender": "未知", "age": "未知", "brief": ""})
        desc = (row.get("brief") or "").strip()
        tail = "／".join(words)
        row["brief"] = f"{desc}，气质{tail}" if desc else f"气质{tail}"
    return out
