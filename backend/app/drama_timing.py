"""真人剧镜头时长估算：**按台词字数算**，不让 LLM 拍脑袋。

## 为什么需要这个模块（2026-09-01 实测，项目「9125」）

用户报告：镜头 6「人物语速异常的快」。查下去是这样的：

| 镜 | 台词字数 | 规划时长 | 折算语速 |
|---|---|---|---|
| 6 | 182 | 23.0s | **7.9 字/秒** |
| 7 | 33 | 10.0s | 3.3 字/秒 |

真人剧的音画是视频模型一体生成的（seedance 音画一体），**台词读多久是物理约束**：
给 23 秒塞 182 个字，模型只能把台词加速念完。而同一集里另一个镜头
33 个字给了 10 秒。同一部片子里两个镜头的语速差 2.4 倍，这不是"节奏设计"，
是时长没有跟内容挂钩。

根因在老的对白下限判定上——它只认**引号内**的文字：

    re.findall(r"[“「『\\"]([^”」』\\"]*)", ref)

而本系统的剧本格式是 `角色【情绪】：台词` / `角色(OS)：台词`，**一个引号都没有**。
于是 `dialog_chars` 恒为 0、对白物理下限恒为 0，秒数完全等于 LLM 报的数字。
唯一被这个正则捞到的反而是拟声词（`△“啪。”一张黑卡`）和台词里的引用
（`所有人都在规劝我“嫁人就要收心”`）——捞的全是不该算的。

所以这里重写一份**认剧本格式**的时长估算，并且它对所有视频模型完全一致：
秒数只由内容决定，模型能力只影响分组与拆分（见 routes_v2._DurWindow）。

## 估算模型

一个镜头的时间由三种内容占用：

- **同期台词**（`角色【情绪】：…`）：必须逐字念完，时间不可压缩。
- **画外音 / 独白**（`角色(OS)：…`、`(VO)`、`旁白`）：也要逐字念完，但它是
  **盖在画面上的**——与动作节拍**并行**，不叠加。
- **动作节拍**（`△…` 画面描述行）：每行给一份固定的表演时间。

    总时长 = 同期台词时长 + max(动作节拍时长, 画外音时长)

画外音与动作取 max 而不是相加，是本次修镜头 7 的关键：那一镜没有同期台词，
只有 2 个动作节拍 + 33 字独白（6.6 秒）。相加得 11.6 秒，取 max 得 6.6 秒——
独白本就是在推门、按停八音盒的过程中说的，不该另外买一份时间。
"""
from __future__ import annotations

import re
from typing import NamedTuple

#: 中文台词语速（字/秒）。与 `script_import._CHARS_PER_SEC` 同一标定
#: （RunningHub IndexTTS 实测均值 5.56、中位 5.75，取 5.0 略偏保守）。
#: 真人剧的台词由视频模型生成，语速与朗读同量级；取偏慢一侧是因为
#: **算短了必然语速失真，算长了只是节奏松一点**，两种错的代价不对称。
_SPEECH_CPS = 5.0

#: 每条台词的换口/轮次交接。三个人来回对话时这部分不可忽略。
_LINE_GAP_SEC = 0.5

#: 一条 `△` 画面描述行的表演时间。实测剧本里一条 △ 行就是一个动作
#: （「推开门」「把咖啡杯放下」），1.5 秒是能看清一个动作的下限。
_ACTION_BEAT_SEC = 1.5

#: 什么内容都没识别出来时，按原文字数兜底（沿用老实现的口径）。
_FALLBACK_CPS = 12.0
_FALLBACK_MAX = 8.0

#: 说话人标签：行首的角色名 + 可选**裸** `os` 标记 + 可选 `(OS)` 技术标注
#: + 可选 `【情绪】` + 冒号。
#: 名字里不允许出现空白、标点、括号——那样能挡掉「他转身，说：」这类叙述句。
#:
#: ⚠️ 中间那个"裸标记 + 允许空格"是 2026-09-08 补的，原先没有，后果很实在：
#: 剧本里 `叶轻语os（无奈）：` 与 `叶轻语 os（冷笑）：` **两种写法混用**
#: （同一个作者、同一集里都有）。带空格的那种匹配不上 —— 名字组不许含空白，
#: 而 `os` 又不在括号里，于是整行落到 `action`、`chars=0`：
#:
#: · **台词对时长完全不可见**。这正是本模块开头要修的「语速异常的快」：
#:   3-2 那种只有一句 `楚子烨 os（阴鸷）：…` 的镜头会被当成纯动作镜，
#:   给 1.5 秒，然后模型得在 1.5 秒里念完整句独白。
#: · **字幕也拿不到这句台词**（`spoken_lines` 同样按 kind 筛）。
#:
#: 所以名字与标记之间只允许 `[ \t]`（不用 `\s`）—— 跨行会把下一行的
#: 冒号错认成本行的说话人标签。
_SPEAKER_RE = re.compile(
    r"^([^\s△▲▽▼◆◇○●■□※☆★＊*·、，。！？；：…—\-\"“”「」『』()（）【】\d]{1,10})"
    r"[ \t]*((?:os|o\.s\.?|vo|v\.o\.?|voice[ \-]?over)?)"   # 裸 os / vo（可空）
    r"[ \t]*((?:[（(][^）)\n]{0,10}[）)])*)"  # (OS) / (V.O.) / （画外音）
    r"[ \t]*((?:【[^】\n]{0,24}】)*)"         # 【冷笑】情绪标
    r"\s*[：:]", re.I)

#: 画外音/独白标记（在说话人标签的括号或情绪标里出现即算）。
_VO_MARK_RE = re.compile(
    r"os|o\.s|vo|v\.o|voice|画外|内心|心声|独白|旁白|回忆音", re.I)

#: 粘在名字尾巴上的裸标记（`叶轻语os`）。只在**取角色名**时剥，判 vo 时不能剥
#: —— 那正是判定它是独白的依据。锚在词尾，免得削掉真名里的字。
_BARE_VO_SUFFIX_RE = re.compile(r"(?:os|o\.s\.?|vo|v\.o\.?)$", re.I)

#: 镜头术语——它们后面也跟冒号（`△特写：`、`快剪：`），但不是台词。
#: 绝大多数带 `△` 前缀已被挡住，这里再兜一层，防剧本漏写 △。
_CAM_TERMS = (
    "特写", "近景", "中景", "远景", "全景", "大全", "中近", "过肩", "空镜",
    "插入", "闪回", "快剪", "蒙太奇", "镜头", "画面", "字幕", "黑场", "定格",
    "叠化", "慢镜", "升格", "俯拍", "仰拍", "航拍", "推镜", "拉镜", "摇镜",
    "跟拍", "手持", "旁白字", "转场", "淡入", "淡出", "音效", "配乐",
)

#: 引号内对白（**兜底**用）：整段剧本一条 `角色：` 都没有时才启用，
#: 用于「他说：“……”」这类小说体文本。正常剧本走说话人标签那条路。
_QUOTED_RE = re.compile(r"[“「『]([^”」』\n]{0,400})[”」』]")


class Unit(NamedTuple):
    """一个内容单元（一行台词或一行画面描述）。

    `raw` 保留**原文与分隔符**，拼起来必须严格等于原 script_ref——
    拆镜时要靠它保证"不改一个字"（拆解提示词规则 4）。
    """
    raw: str
    kind: str      # dialog | vo | action
    chars: int     # 计时用的字数（台词只算冒号之后的部分）

    @property
    def seconds(self) -> float:
        if self.kind == "blank":
            return 0.0
        if self.kind == "action":
            return _ACTION_BEAT_SEC
        return self.chars / _SPEECH_CPS + _LINE_GAP_SEC


#: 台词里的舞台指示（`（低声）`、`【冷笑】`）不发声，计时要剔掉。
_INLINE_DIR_RE = re.compile(r"[（(][^）)\n]{0,20}[）)]|【[^】\n]{0,24}】")
_NON_SPEECH_RE = re.compile(r"[\s—…·、，。！？；：\"“”「」『』()（）【】\-~～]")


def _speech_chars(text: str) -> int:
    """一句台词实际要念出来的字数。"""
    return len(_NON_SPEECH_RE.sub("", _INLINE_DIR_RE.sub("", text)))


def _boundaries(ref: str) -> list[int]:
    """切分位置：换行之后、以及每个 `△` 之前（△ 常与台词同行紧跟）。"""
    cuts = {0, len(ref)}
    for i, ch in enumerate(ref):
        if ch == "\n":
            cuts.add(i + 1)
        elif ch in "△▲":
            cuts.add(i)
    return sorted(cuts)


def _classify(chunk: str) -> tuple[str, int]:
    """判定一个片段是 台词 / 画外音 / 动作 / 空白，并给出计时字数。"""
    body = chunk.strip()
    if not body:
        return ("blank", 0)
    if body[0] in "△▲▽▼":
        return ("action", 0)
    m = _SPEAKER_RE.match(body)
    if m and not any(t in m.group(1) for t in _CAM_TERMS):
        # 四个组都要进 tag：裸 `os`(2)、括号标注(3)、【情绪】(4)，
        # 外加名字本身(1)（`叶轻语os` 这种没空格的写法里 os 被并进名字组）。
        tag = (m.group(2) or "") + (m.group(3) or "") + (m.group(4) or "") + m.group(1)
        kind = "vo" if _VO_MARK_RE.search(tag) else "dialog"
        return (kind, _speech_chars(body[m.end():]))
    return ("action", 0)


def spoken_text(chunk: str) -> str:
    """一个单元里**真正会被念出来**的那段文字（去掉说话人标签与舞台指示）。

    与 `_speech_chars` 的区别是**保留标点**：字幕分条完全依赖句读
    （`align.ts:splitIntoCues` 先按 `。！？` 再按 `，、；` 断），
    在这里就把标点洗掉，下游只能按字数硬断，一句话会被切在莫名其妙的地方。
    标点由前端在**分条之后**才洗（`washPunct`）。

    只处理 `dialog` / `vo` 单元；其他 kind 传进来返回空串。
    """
    body = (chunk or "").strip()
    if not body:
        return ""
    m = _SPEAKER_RE.match(body)
    if not m or any(t in m.group(1) for t in _CAM_TERMS):
        return ""
    return _INLINE_DIR_RE.sub("", body[m.end():]).strip()


def spoken_lines(ref: str) -> list[str]:
    """`script_ref` 里按顺序被念出来的台词（同期台词 + 画外音/独白）。

    这是"已有文本本地对齐字幕"在真人剧上的**文本来源**。真人剧的音画由
    seedance 一体生成，念的就是这些行 —— 文本已知，所以不需要 ASR 去猜
    （理由见 `align.ts` 头注释；ASR 还会把人名听错，而原文一个字都不会错）。

    刻意**包含** `vo`（`角色os：…` 独白）：它同样会被念出来、同样要出字幕。
    刻意**排除**：
      · `△/▲` 画面描述 —— 那是给视频模型看的表演指示，没人念它。
        （2026-09-07 那批错字幕的成因之一就是把它当台词烧进了画面。）
      · `【字幕：楚子烨：楚家假少爷】` 这类**角色名条**（`_CAM_TERMS` 含"字幕"，
        且行首 `【` 本就进不了名字组）—— 它是设计成一直挂在画面上的标签，
        不跟着声轨走，硬塞进强制对齐只会挤掉真台词的时间。
        目前它需要用户手工加为 `title` 字幕，属已知缺口。
    """
    out: list[str] = []
    for u in split_units(ref or ""):
        if u.kind not in ("dialog", "vo"):
            continue
        t = spoken_text(u.raw)
        if t:
            out.append(t)
    return out


def speaker_of(chunk: str) -> str:
    """一个单元的说话人名（不是台词行则返回空串）。

    名字取 `_SPEAKER_RE` 的第 1 组，但要**把粘在名字上的裸 os/vo 标记剥掉**：
    剧本里 `叶轻语os（无奈）：` 这种没空格的写法，正则会把 `os` 并进名字组
    （见该正则的注释），直接拿来当角色名就会匹配不上资产库里的「叶轻语」。
    """
    body = (chunk or "").strip()
    if not body:
        return ""
    m = _SPEAKER_RE.match(body)
    if not m or any(t in m.group(1) for t in _CAM_TERMS):
        return ""
    return _BARE_VO_SUFFIX_RE.sub("", m.group(1)).strip()


def speaker_seconds(ref: str) -> dict[str, float]:
    """`script_ref` 里每个角色的**说话时长**（秒），按发言量降序取用。

    给"这一镜该参考谁的音色"用：一镜多人时，戏份最重的那个说了算，
    而不是"第一个出现的"——第一句常常是一句「嗯。」。
    同期台词与独白都算（都要发声）。
    """
    out: dict[str, float] = {}
    for u in split_units(ref or ""):
        if u.kind not in ("dialog", "vo"):
            continue
        name = speaker_of(u.raw)
        if name:
            out[name] = out.get(name, 0.0) + u.seconds
    return out


def split_units(ref: str) -> list[Unit]:
    """把 script_ref 切成内容单元；`''.join(u.raw)` 严格等于 ref。

    空白片段并入 `blank` 单元（0 秒）而不是丢弃——拆镜时要靠 raw 还原原文。
    """
    ref = ref or ""
    cuts = _boundaries(ref)
    out: list[Unit] = []
    for a, b in zip(cuts, cuts[1:]):
        chunk = ref[a:b]
        kind, chars = _classify(chunk)
        out.append(Unit(chunk, kind, chars))
    return out


def units_seconds(units: list[Unit]) -> float:
    """一组单元的内容时长：同期台词 + max(动作, 画外音)。"""
    speech = sum(u.seconds for u in units if u.kind == "dialog")
    action = sum(u.seconds for u in units if u.kind == "action")
    vo = sum(u.seconds for u in units if u.kind == "vo")
    return speech + max(action, vo)


def estimate_seconds(ref: str) -> float:
    """镜头内容值多少秒（**纯内容，不做任何区间钳制**）。

    识别不到任何台词/动作时（例如纯小说体文本）退回引号对白 + 字数兜底，
    与老实现口径一致，保证不会因为格式不认识而给出 0。
    """
    ref = ref or ""
    if not ref.strip():
        return 0.0
    units = split_units(ref)
    sec = units_seconds(units)
    if any(u.kind in ("dialog", "vo") for u in units):
        return sec
    quoted = sum(_speech_chars(m) for m in _QUOTED_RE.findall(ref))
    if quoted:
        sec = max(sec, quoted / _SPEECH_CPS + _LINE_GAP_SEC)
    return max(sec, min(len(ref) / _FALLBACK_CPS, _FALLBACK_MAX), 2.0)


def reconcile(est: float, ai_sec: float | None) -> float:
    """把 LLM 报的秒数收进内容允许的范围。

    - **下限 = est**：台词念不完是硬伤（镜头 6 的 7.9 字/秒就是这么来的）。
    - **上限 = max(est*1.35, est+2.0)**：留一点表演/停顿余量，但不容许
      33 个字的独白撑成 10 秒（镜头 7）。短镜头用 +2.0 那一支，
      否则 6.6 秒的镜头上限只有 8.9 秒，比例项会过于苛刻。

    LLM 的判断在这个区间内仍然有效——它比字数更懂哪一镜该留白。
    """
    hi = max(est * 1.35, est + 2.0)
    if not ai_sec or ai_sec <= 0:
        return est
    return min(max(float(ai_sec), est), hi)


def split_ref_by_cap(ref: str, cap_sec: float) -> list[tuple[str, float]]:
    """把超长镜头按内容单元切成若干段，每段尽量不超过 cap_sec。

    贪心首次适配：对**连续区间划分**而言这就是最优解（段数最少）——
    每多切一刀就多一个上下文断点，段数最少即断点最少。

    返回 `[(片段原文, 内容秒数), …]`，片段拼接后严格等于 ref。
    单个单元本身就超 cap（一大段独白）时它自成一段并超出——
    此时切开也没用，只能交给上层钳制。
    """
    units = split_units(ref)
    if not units or estimate_seconds(ref) <= cap_sec:
        return [(ref, estimate_seconds(ref))]

    groups: list[list[Unit]] = []
    cur: list[Unit] = []
    for u in units:
        if cur and units_seconds(cur + [u]) > cap_sec and u.kind != "blank":
            groups.append(cur)
            cur = [u]
        else:
            cur.append(u)
    if cur:
        groups.append(cur)

    # 只有空白/动作的尾段无法独立成镜，并回上一段
    merged: list[list[Unit]] = []
    for g in groups:
        if merged and not any(x.kind in ("dialog", "vo") for x in g) \
                and units_seconds(merged[-1] + g) <= cap_sec * 1.15:
            merged[-1] = merged[-1] + g
        else:
            merged.append(g)

    return [("".join(u.raw for u in g), units_seconds(g)) for g in merged]
