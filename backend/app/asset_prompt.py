"""资产生图提示词的**唯一**构造处（Q1/Q2/Q3/Q4）。

## 为什么要单独一个模块

这些提示词原先以字面量形式散落在 `jobs.py` 的六处——`run_one_click_film` 与
`run_first_frame_pipeline` 各有一份**完全相同**的拷贝（已 diff 确认）。
改一处、漏一处，就是"一键成片修好了、首帧流水线还是老样子"，而两条路径
产出的图会不一致，排查起来极难定位。集中到这里之后，任何口径调整只有一个改点。

## 四个质量问题（用户 2026-08-28 反馈）与对应措施

**Q1 性别/年龄缺失**（女主变霸总、小孩变大人）
  原提示词只有「角色名 + 造型描述」。实测 182 条造型描述里 89% 不含年龄线索、
  85% 不含性别线索——生图模型只能靠名字猜，猜错就是女主变男人。
  `character_brief.py` 早就能判性别/年龄段/身份，但它的调用点全在提示词优化链路，
  **从未接入资产生图**。这里把 brief 作为显式参数拼进去。

**Q2 画风不统一**（真人剧出动漫风的星云塔）
  资产级提示词**一个字的风格约束都没有**，而镜头级有「电影感分镜首帧，写实摄影质感」
  （jobs.py:726）。「星云塔」这类科幻感名字，模型自然往动漫/概念图走。
  这里补统一的写实前缀，与镜头级口径对齐。

**Q3 场景描述过简**（117/117 场景 prompt 为空）
  场景侧没有任何环节产出文字描述，`Asset.prompt` 恒为空 →
  永远走 `f"影视场景参考图：{name}。"` 兜底，模型只拿到一个名字。
  本模块负责"有描述就用、没有就退化得体面"；描述的**生成**在 scene_desc.py。

**Q4 「禁止出现人物」失效**（车内场景有人）
  原文只有否定式约束。不少生图模型对中文否定词遵循度低，且缺少正向描述去压住它。
  改为「空镜头/空无一人」正向表述 + 保留否定约束双保险。

## 分层角色提示词（用户 2026-09-09 反馈：「提示词太简单，30 字上限非常荒谬」）

旧版角色提示词共 162 字，其中真正描写「这个人长什么样」的只有 21 字
（性别 + 年龄 + 一句身份）。五官/骨相/肤色这一整个维度**没有字段承载**。

现按 7 层结构拼装（层号对应用户给的模板，见
`docs/PLAN-人物档案与分层提示词.md` §3）：

| 层 | 内容 | 来源 |
|---|---|---|
| 1 画面构图 | 三视图 / 正视 / 画风 / 姓名标注 / 纯白背景 | 本模块常量 |
| 2 角色总述 | 性别·年龄 + 骨相·肤色·脸型·下颌 | brief + **档案** |
| 3 发型发饰 | 发色·发质（档案）+ 具体发型（造型描述） | **档案** + stage |
| 4 眉眼特征 | 眉·眼·眼神·鼻·唇·记忆点·妆容·气质 | **档案** |
| 5/6 服装腰饰 | 材质·颜色·领型·配饰 | `AssetStage.description` |
| 7 手位肢体 | 手位·下摆·鞋靴 | 本模块常量 |
| 兜底强制参数 | 4K·无变形·无水印 | 本模块常量 |

**不做长度截断**（用户决策：放开字数）。实测 432–459 字的提示词生图效果好、
火山私域入库过审正常、当 seedance 参考图也不漏文字不出多人。
超过 `_WARN_LEN` 只打日志，便于将来排查，不改变行为。

档案为空（老项目）时自动退回旧的扁平口径——`profile=None` 这条路径与改动前
逐字节等价，所以老项目行为完全不变。

## 场景多视角 + 影调统一（用户 2026-09-09 反馈，附设定板参考图）

用户提了三件事，都落在本模块：

**① 场景图也要多视角 + 左上角标场景名**
  `scene_prompt` 新增 `view` / `view_label` 参数，机位句由 `scene_view.VIEWS`
  提供（8 张：方位 4 + 景别 4），本模块**不自己定义视角**。场景名标注复用
  角色图那套 `_name_label` / `_text_rule`，因此场景图不再全面禁文字。
  ⚠️ 拼版设定板是**另一个产物**（`scene_board`），永不当参考图注入——
  拼版图一进参考位，模型会把格子线和中文标注抄进镜头画面。

**② 人物图里不许有场景，场景图里不许有人**
  两边原本都只有一句宽泛的否定，实测都有漏网口：
  - 人物图：三视图要求"完整露出鞋靴"，模型为了让人站住会自己补地板 + 投影，
    那块地板会随定妆图注入进每个镜头。→ `_CLEAN_BG` 点名禁地面/墙面/门窗/
    家具/环境/透视/投影。
  - 场景图：漏了人体局部（一只手/半个背影）、人像替代物（墙上人物照、人形雕塑、
    橱窗假人）。它们确实"不是人物"，但一进参考图就会在镜头里多出一个假人。
    → `_SCENE_REQUIREMENTS` 逐类点名。

**③ 不同图色调不统一**
  `character_prompt` / `scene_prompt` 都新增 `look` 参数，拼进
  `look_profile.phrase()`——全片一份调色基调（色温/反差/饱和/黑位/颗粒/镜头质感）。
  ⚠️ 它**不**统一明暗：客厅白天自然光 vs 主卧深夜床头灯是剧本要的，抹平就没戏了。
  这条边界写在 `look_profile` 模块头与 `phrase()` 的句尾声明里。
  `look=None` 时不拼任何影调句 = 改动前行为。
"""
from __future__ import annotations

import logging

from . import character_profile as cp
from . import look_profile as lp
from . import style_preset as sp

log = logging.getLogger(__name__)

#: 统一画风前缀（Q2）。与镜头级 `jobs._gen_first_frame` 的首帧句保持同一口径，
#: 确保资产图与成片画面不会一个写实一个动漫。
#:
#: ⚠️ 2026-09-09：画风改由**项目级预设**决定（`style_preset`），本常量退化为
#: "没有画风信息时的兜底" = 都市档，与改动前逐字节等价。新代码请走
#: `character_prompt(style=…)` / `scene_prompt(style=…)`，不要再读这个常量：
#: 画风不是一个前缀就能换的，还牵着否定项（见 `_no_cartoon`）、首帧句、
#: 场景基准图句与影调题面，必须整体切换。
REALISTIC_STYLE = sp.DEFAULT.prefix

#: 提示词长度告警线。**不截断**，只记日志：用户明确要求放开字数上限，
#: 而实测四百多字的提示词一切正常。这条线只用于将来排查"图突然变差"时
#: 快速确认是不是提示词失控膨胀了。
_WARN_LEN = 1200

#: 角色定妆照的固定要求（构图/背景/细节）——**无档案时的旧口径**，保持不变，
#: 以便老项目行为逐字节等价。有档案时走新口径（见 `character_prompt`）。
#: `{neg}` 由项目画风填（`style_preset.Style.negative`）——都市档填进去
#: 正是原文的「禁止卡通、动漫、插画、3D 渲染风格」。
_CHAR_REQUIREMENTS_FMT = (
    "要求：全身站姿、正面、纯色背景、光线均匀，"
    "完整呈现服装/发型/妆容细节，{neg}，"
    "禁止文字与水印。"
)


def _char_requirements(st: sp.Style) -> str:
    return _CHAR_REQUIREMENTS_FMT.format(neg=st.negative.rstrip("。"))

#: 第 1 层 画面构图：三视图。
#: 实测（`docs/PLAN-人物档案与分层提示词.md` §2）三视图不影响火山私域入库过审，
#: 当 seedance 参考图也不会被理解成"画面里有三个人"；且因为人像撑满画幅高度，
#: 正面像的**脸部像素反而比单人居中构图更大**。
_VIEW_THREE = (
    "画面构图：水平正视，全身立绘三视图——同一角色的正面、侧面、背面"
    "三个全身站姿并排排列，比例一致、光线一致、为同一个人。"
)

#: 第 1 层 纯白背景（用户要求）。比旧的「纯色背景」更严：
#: 「纯色」模型常给成浅灰渐变或带影棚投影，抠不干净。
#:
#: ⚠️ 2026-09-09 追加"**人物图里不许有场景**"（用户要求）：原文只禁了
#: 「陈设、道具、纹理、渐变」，但三视图要求"完整露出鞋靴"，模型为了让人站住
#: 很容易自己补一块地板 + 投影 + 一点墙角透视——那就是场景，一旦这张图被逐镜
#: 注入，那块地板会跟着进每一个镜头，和真正的场景参考图打架。
#: 所以要把"没有地面/没有空间感"明写出来，而不是指望"纯白"能推出这一层。
_CLEAN_BG = (
    "背景为**纯白色干净空白背景**，无任何陈设、道具、纹理与渐变，"
    "光线均匀无投影。"
    "**画面中不得出现任何场景元素**：没有地面与地平线、没有地板、没有墙面与墙角、"
    "没有门窗、没有家具与摆件、没有室内外环境、没有天空与风景、没有空间透视与景深，"
    "人物如同抠图般悬浮在纯白底上，脚下不画阴影与倒影。"
)

#: 第 7 层 手位与肢体（恒定部分；下摆/鞋靴的具体样式由造型描述给）。
_LIMBS = "双手自然垂放于身侧、五指完整不遮挡服装，双脚站姿平稳、完整露出鞋靴。"

#: 固定兜底强制参数（用户给的模板原文，实测不影响过审）。
#: `{tex}` 由项目画风填；都市档填「电影质感，高清肌理」= 原文。
_FORCED_FMT = (
    "4K 超清，极致细节，{tex}，五官精准固定，面部对称自然，"
    "人体结构标准，无变形、无崩坏、无穿模、无水印、无 LOGO、无虚影重影，"
    "光影通透层次高级，材质纹理真实。"
)


def _forced(st: sp.Style) -> str:
    return _FORCED_FMT.format(tex=st.texture)

#: 画风否定项（原常量退化为都市档兜底）。**必须与画风前缀同向**：
#: 动漫档的 `negative` 是「禁止真人实拍照片感」，照抄这条真人档的
#: 「禁止动漫」会与自己的前缀直接对撞，模型二选一、行为不可预期。
_NO_CARTOON = sp.DEFAULT.negative


def _name_label(name: str, *, what: str = "角色姓名") -> str:
    """左上角名称标注（用户要求）。角色图标姓名，场景图标场景名。

    ⚠️ 这条与旧的「禁止文字与水印」**直接矛盾**，两条并存会让模型二选一、
    行为不可预期。所以新口径里文字规则改成"只允许这一处文字"
    （见 `_text_rule`），而不是简单叠加。
    """
    return (f"在图片**左上角**用清晰的黑色中文字体标注{what}「{name}」，"
            "字号适中、位于画面边角的空白/低信息区域，不遮挡主体。")


def _text_rule(what: str = "角色姓名") -> str:
    """文字规则：开一个口子给名称标注，其余一律禁止。

    场景图从 2026-09-09 起**也**走这条（此前是全面禁文字）——用户要求场景图
    同样在左上角标场景名。风险已单独实测：见 `docs/PLAN-场景多视角与影调统一.md`。
    """
    return f"除左上角的{what}标注外，禁止出现任何其他文字、字母、数字、水印与 LOGO。"


def character_prompt(title: str, name: str, *, stage_name: str | None = None,
                     description: str | None = None,
                     brief: str | None = None,
                     profile: dict | None = None,
                     look: dict | None = None,
                     style: sp.Style | None = None) -> str:
    """角色定妆照提示词。

    `brief`：来自 `character_brief` 的「性别 + 年龄段 + 身份气质」一句话（Q1）。
    它必须排在造型描述**之前**——模型对提示词前段的遵循度更高，而"这是个什么人"
    比"穿什么衣服"更根本：性别错了，衣服再准也是错的。

    `profile`：来自 `character_profile` 的结构化形象档案（骨相/肤色/五官/气质）。
    **为空时整段退回旧的扁平口径**，老项目行为不变。

    `look`：来自 `look_profile` 的全片影调档案。为空时不拼任何影调句
    （= 改动前行为）。⚠️ 影调只管调色基调，不管明暗光线情境，见 look_profile 模块头。

    `style`：项目画风预设（`style_preset.Style`）。为空 = 都市档，
    与改动前**逐字节等价**。画风一换是**整体换**：前缀、否定项、质感兜底
    三处一起走，单换前缀会与残留的「禁止动漫」自相矛盾。
    """
    st = style or sp.DEFAULT
    look_line = lp.phrase(look)
    if not cp.has_content(profile):
        # 旧路径（无形象档案）。`look` 也为空、画风为都市档时**逐字节等价于
        # 改动前**——老项目行为不变。
        who = f"{name}（{stage_name}）" if stage_name else name
        parts = [st.prefix, f"影视剧《{title}》角色定妆照：{who}。"]
        if brief:
            parts.append(f"人物设定：{brief}。")
        if description:
            parts.append(description if description.endswith(("。", "！", "？"))
                         else description + "。")
        parts.append(_char_requirements(st))
        if look_line:
            parts.append(look_line)
        return "".join(parts)

    who = f"{name}（{stage_name}）" if stage_name else name
    parts = [
        # 第 1 层 画面构图
        st.prefix.rstrip("，") + "。",
        _VIEW_THREE,
        f"影视剧《{title}》角色定妆照：{who}。",
    ]

    # 第 2 层 角色总述：brief（性别/年龄/身份）在前，档案的骨相五官紧随
    overview = cp.layer_overview(profile)
    if brief and overview:
        parts.append(f"人物设定：{brief}；{overview}。")
    elif brief:
        parts.append(f"人物设定：{brief}。")
    elif overview:
        parts.append(f"人物设定：{overview}。")

    # 第 3 层 发色发质。**只有恒定属性**——具体发型（马尾/丸子头）随造型变，
    # 由下面的 description 提供，不能写死在档案里。
    hair = cp.layer_hair(profile)
    if hair:
        parts.append(f"{hair}。")

    # 第 4 层 眉眼五官 + 妆容 + 气质
    face = cp.layer_face(profile)
    if face:
        parts.append(f"{face}。")

    # 档案的自由补充（词表覆盖不到的独有特征：疤痕/义眼/胎记）
    extra = cp.layer_extra(profile)
    if extra:
        parts.append(extra if extra.endswith(("。", "！", "？")) else extra + "。")

    # 第 5/6 层 服装与腰饰（逐造型，来自 costumes.py）
    if description:
        parts.append(description if description.endswith(("。", "！", "？"))
                     else description + "。")

    # 第 7 层 + 背景 + 文字 + 兜底 + 影调
    parts += [_LIMBS, _CLEAN_BG, _name_label(name), _text_rule(),
              st.negative, _forced(st)]
    if look_line:
        # 影调放最后：它是"整张图怎么调色"的全局声明，前面的具体描写不该被它切断。
        parts.append(look_line)

    out = "".join(parts)
    if len(out) > _WARN_LEN:
        # 不截断，只记一笔：提示词长是设计意图，失控膨胀才是问题
        log.warning("[asset_prompt] 角色提示词偏长（%d 字）：%s（%s）",
                    len(out), name, stage_name or "-")
    return out


#: 场景参考图的固定要求。Q4：正向的「空镜头/空无一人」写在前面，
#: 否定式「禁止出现人物」保留在后面兜底——两者叠加比单靠否定可靠得多。
#:
#: ⚠️ 2026-09-09 硬化（用户要求"确保场景资产图中没有人物"）：原文只禁了
#: 「人物、人影、人物剪影」，漏了三类**实测会漏网**的东西——
#:   ① 人体局部：一只手、一双脚、半个背影（模型认为"没画整个人"就算合规）
#:   ② 人像替代物：墙上的人物照片/海报/画像、人形雕塑、橱窗模特/假人
#:      （它们确实不是"人物"，但一进参考图，逐镜就会多出一个假人）
#:   ③ 有人在场的证据：正在冒烟的香烟、刚坐过的凹陷沙发这类"人刚离开"暗示
#: 这三类都必须点名，靠一句"禁止人物"推不出来。
_SCENE_REQUIREMENTS_FMT = (
    "要求：**空镜头，画面中空无一人**，只拍摄空间本身；"
    "完整呈现空间布局、陈设、材质与光线氛围；"
    "禁止出现任何人物、人影或人物剪影，"
    "也禁止任何**人体局部**（手、手臂、脚、腿、背影、半身），"
    "禁止任何**人像替代物**（墙上的人物照片/海报/画像/壁画、人形雕塑与胸像、"
    "服装模特与人体模型、镜中人影），"
    "禁止动物出现在画面中；"
    "{neg}"
)


def _scene_requirements(st: sp.Style) -> str:
    """场景图固定要求。`{neg}` 是画风否定项。

    ⚠️ 与改动前有**一处**字面差异：原文这里写的是「禁止卡通、动漫、插画风格。」
    （比角色图那句少了「3D 渲染」）。现在两处统一用画风的同一句否定，
    都市档因此多禁了「3D 渲染」。这是同向收紧、且正是场景图常见的
    "出成 CG 概念图"那种废片，故不为保留字面差异而拆出第二套否定词。
    """
    return _SCENE_REQUIREMENTS_FMT.format(neg=st.negative)


#: 场景图的兜底强制参数。与角色图的 `_forced` 分开写：场景没有"五官精准固定
#: / 人体结构标准"这回事，照抄过来等于在明令"画面无人"的同时又提了一遍人体，
#: 属于自相矛盾的指令（正是 Q4 那类失效的成因）。
_SCENE_FORCED_FMT = (
    "4K 超清，极致细节，{tex}，真实材质纹理与光影层次，"
    "透视准确、结构合理，无变形、无崩坏、无水印、无 LOGO、无虚影重影。"
)


def _scene_forced(st: sp.Style) -> str:
    return _SCENE_FORCED_FMT.format(tex=st.scene_texture)


def scene_prompt(name: str, *, description: str | None = None,
                 title: str | None = None,
                 view: str | None = None,
                 view_label: str | None = None,
                 look: dict | None = None,
                 style: sp.Style | None = None,
                 label_name: bool = True) -> str:
    """场景参考图提示词。

    `description` 有值时用它（Q3 由 scene_desc.py 产出并写进 `Asset.prompt`）；
    没有就只报场景名——那是**降级**行为，不是正常路径。

    `view` / `view_label`：机位句与短标签，来自 `scene_view.VIEWS`
    （唯一来源，本模块不自己定义视角）。都为空时退回旧的「标准全景机位」，
    与改动前等价——所以没启用多视角的调用点行为不变。

    `look`：全片影调档案短语（`look_profile`）。让 8 张视图 + 各场景之间
    共用同一套调色基调。⚠️ 不改变各场景自己的日/夜光线情境。

    `label_name`：是否在左上角标场景名（用户 2026-09-09 要求，默认开）。
    关掉它是留给"要拿这张图当纯净底图"的场合——一旦标了字，
    这张图当参考图时就有把字带进画面的风险，虽然角色图实测没带，
    但两种图不能互相担保结论。

    `style`：项目画风预设，为空 = 都市档（与改动前等价）。
    """
    st = style or sp.DEFAULT
    head = f"影视剧《{title}》场景参考图：{name}。" if title else f"影视场景参考图：{name}。"
    parts = [st.prefix, head]
    # 机位/景别句紧跟标题：它决定"这张图是这个空间的哪一面"，
    # 必须排在空间描述之前，否则模型先按描述定好构图再被机位句拉偏。
    parts.append(f"画面构图：{view}" if view else "标准全景机位。")
    if description:
        parts.append(description if description.endswith(("。", "！", "？"))
                     else description + "。")
    parts.append(_scene_requirements(st))
    if label_name:
        tag = f"{name}·{view_label}" if view_label else name
        parts += [_name_label(tag, what="场景名称"), _text_rule("场景名称")]
    else:
        parts.append("禁止出现任何文字、字母、数字、水印与 LOGO。")
    parts.append(_scene_forced(st))
    look_line = lp.phrase(look)
    if look_line:
        parts.append(look_line)
    out = "".join(parts)
    if len(out) > _WARN_LEN:
        log.warning("[asset_prompt] 场景提示词偏长（%d 字）：%s（%s）",
                    len(out), name, view_label or "-")
    return out
