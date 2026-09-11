"""剧本导入分集解析（T-R0-02）。

移植自主平台 drama-dev/services/orchestrator/app/stages/import_script.py 的
smart_split_chapters + _cn_num_to_int，去除 orchestrator 依赖（纯函数，零外部引用）。
识别优先级：第N集/章/话/回（中文/阿拉伯数字）→ 长分隔线 → 5000字兜底 → 单集。
"""
from __future__ import annotations

import math
import re

_CN_NUM_MAP = {
    "一": 1, "二": 2, "三": 3, "四": 4, "五": 5,
    "六": 6, "七": 7, "八": 8, "九": 9, "十": 10,
    "零": 0, "壹": 1, "贰": 2, "叁": 3, "肆": 4,
    "伍": 5, "陆": 6, "柒": 7, "捌": 8, "玖": 9,
    "百": 100, "千": 1000,
}

#: 送 AI 拆解的最小正文字数。低于这个数的"集"不可能拆出有意义的镜头，
#: 而 LLM 被要求产出镜头时**不会拒绝**——它会照着标题凭空编（实测 8 个字的
#: 书名换来一整段虚构剧情 + 4 个不存在的角色）。宁可产出 0 镜也不要假数据。
#: 取 50：一句完整的场景描写通常都不止 50 字，正常正文不会被误挡。
MIN_BREAKDOWN_CHARS = 50


def is_preamble(chapter: dict) -> bool:
    """是否为「前言」（正文前的标题页/人物表/简介），不参与拆解。

    判据是 `order == 0` —— 由 smart_split_chapters 固定分配，见那里的说明。
    """
    return (chapter or {}).get("order") == 0


def too_short_to_break_down(chapter: dict) -> bool:
    """正文过短、送去拆解只会得到 AI 虚构内容的集。

    前言与过短集都归到这里，调用方统一跳过并**如实告知用户**跳过了哪几集，
    而不是静默丢弃（用户会发现集数对不上却找不到原因）。
    """
    if is_preamble(chapter):
        return True
    return len((chapter or {}).get("content") or "") < MIN_BREAKDOWN_CHARS


#: 剧本里的**标记符号**（不是字，不该被念出来）。
#: △ 是画面描述行首标记、◆/※ 等是各家剧本模板的分节符。
_MARKUP_SYMBOLS = "△▲▽▼◆◇○●■□※☆★＊*·・•"

#: 括号内**只有拉丁字母/点/空格**且很短的，是技术标注而非台词：
#: (OS)=画外音、(V.O.)=voice over、(CU)=特写、(E)=效果音。
#: 这类整体删掉——只去括号会留下 "林语OS：" 被念成"林语欧艾斯"。
#: 限定"只含拉丁字符"是为了守住一条硬边界：**绝不删任何汉字**。
_TECH_ANNOTATION = re.compile(r"[（(][A-Za-z][A-Za-z.\s]{0,5}[）)]")

#: 其余成对括号只去括号、保留内文：【冷笑】→冷笑，读出来是自然的。
_BRACKET_PAIRS = [("【", "】"), ("〖", "〗"), ("〔", "〕"), ("［", "］")]


def strip_script_markup(text: str) -> str:
    """剥离剧本标记符号，**不改动任何文字内容**。

    动机（2026-08-30 实测）：旁白 TTS 拿到的是剧本原文，含 △画面描述标记、
    【冷笑】情绪标、(OS) 技术标注。21 条已合成旁白的"原文字数/时长"标准差
    只有 0.303（6.02 字/秒），剔除这些标记后标准差飙到 1.623 ——
    只有"符号也全被念出来了"能解释这种紧致度。成片里真的在念
    "三角形林语忍着脚尖的剧痛"。

    字幕要跟音频对齐，就绕不开这件事：字幕文本必须**等于**被念出来的文本。
    所以在旁白落库时就把符号剥掉，让 AudioClip.text 同时是"送 TTS 的文本"
    和"字幕文本"这一件事。

    边界（刻意保守）：只删符号，一个汉字都不删。括号只有在内容是纯拉丁短串
    （技术标注）时才整体删除；其余括号只去括号壳、留内文。
    """
    s = text or ""
    if not s:
        return ""
    s = _TECH_ANNOTATION.sub("", s)
    for lo, hi in _BRACKET_PAIRS:
        s = s.replace(lo, "").replace(hi, "")
    s = s.translate({ord(c): None for c in _MARKUP_SYMBOLS})
    # 符号删掉后常留下 "  " 或行首空格；顺手收拾干净（不合并行，行结构是断句依据）
    s = re.sub(r"[ \t]{2,}", " ", s)
    s = "\n".join(line.strip() for line in s.split("\n"))
    return s.strip()


def _cn_num_to_int(s: str) -> int:
    """中文数字/阿拉伯数字 → int，失败返回 0。"""
    s = s.strip()
    if s.isdigit():
        return int(s)
    if s == "十":
        return 10
    if s.startswith("十") and len(s) == 2:
        return 10 + _CN_NUM_MAP.get(s[1], 0)
    if "十" in s:
        parts = s.split("十")
        tens = _CN_NUM_MAP.get(parts[0], 1) * 10 if parts[0] else 10
        ones = _CN_NUM_MAP.get(parts[1], 0) if len(parts) > 1 and parts[1] else 0
        return tens + ones
    if len(s) == 1:
        return _CN_NUM_MAP.get(s, 0)
    return 0


def smart_split_chapters(text: str) -> list[dict]:
    """智能识别分集边界。返回 [{"order","title","content","word_count"}, ...]。"""
    text = text.strip()
    if not text:
        return []

    # 模式1: 集级标记 "第X集/章/话/回"
    #
    # 注：标题尾部只允许同行匹配（[ \t] 而非 \s）。原版用 \s* 会跨过换行,
    # 把下一行正文吞进"标题"，导致单行正文的集 content 为空被丢弃（移植时修复）。
    #
    # ⚠️ 幕/场/节 是**场级**标记，不是集级。原来它们和 集/章/话/回 混在同一个
    # 字符类里，于是"第一场…第二场…"（同一集内的场次）会被当成两集切开 ——
    # 一集变 N 集，镜头编号、音频/字幕锚点、导出顺序全部跟着错位。
    # 改为两级：先找集级标记；只有完全没有集级标记时，才退而用场级
    # （那种脚本通常确实是一场一集的短剧）。
    def _find(marks: str) -> list:
        return list(re.finditer(
            r'(?:^|\n)\s*(第\s*([一二三四五六七八九十百千零壹贰叁肆伍陆柒捌玖\d]+)'
            r'\s*[' + marks + r'])[ \t]*(?:[:：、\.]?[ \t]*([^\n]{0,50}))?',
            text))

    matches = _find("集章话回")
    if len(matches) < 2:
        scene = _find("节幕场")
        # 场级标记数量占优才改用它（避免正文里偶然出现一句"第三幕"就改判）
        if len(scene) >= 2 and len(scene) > len(matches):
            matches = scene

    # 只有 1 个标记也要认：原来会掉进下面的 5000 字硬切兜底，
    # 标记被完全忽略、正文还被腰斩（B26）。
    if matches:
        chapters = []

        # 首个标记**之前**的内容：标题页、人物表、故事简介常写在这里。
        # 原来这段文本没有任何分支会产出它 —— 直接消失。
        # 更糟的是 update_episode_content 会用解析结果重写整个 raw_script
        # （"\n".join(title + content)），所以用户第一次编辑任意一集，
        # 这段前言就被**永久删除**了，没有提示也没有撤销。
        preamble = text[:matches[0].start()].strip()

        for i, m in enumerate(matches):
            start = m.end()
            end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
            content = text[start:end].strip()

            order = _cn_num_to_int(m.group(2)) or (i + 1)
            title = m.group(1).strip()
            title_part = (m.group(3) or "").strip().lstrip(":：、.").strip()
            if title_part:
                title = f"{title} {title_part}"

            # 空内容的集也保留：原来 `if content:` 会把"只有标题没有正文"的集
            # 整个丢掉，用户看到集数对不上却找不到原因。留一个空壳更诚实，
            # 也让后续重编号不会把顺序挤乱。
            chapters.append({
                "order": order, "title": title,
                "content": content, "word_count": len(content),
            })
        chapters.sort(key=lambda c: c["order"])
        for i, c in enumerate(chapters):  # 重新编号防用户写错
            c["order"] = i + 1

        # ⚠️ 前言必须在**重编号之后**才挂上，且固定 order=0（C1/C2）。
        #
        # 原来是先把前言以 order=0 塞进 chapters，再统一 `order = i + 1` 重编号——
        # 于是前言变成 order=1，剧本的「第1集」被挤成 order=2，全剧集号整体 +1。
        # 两个后果都很重：
        #   1. 前言（常常只有一行书名，实测 8 个字）被当成正常一集送去 AI 拆解，
        #      模型拿到 8 个字仍被要求产出镜头，就照着书名**虚构整段剧情**
        #      （实测「错位的十二年」凭空造出「陆远查父亲车祸」4 镜 + 4 个假角色）
        #   2. costumes.py 按「第N集」正则从剧本文本取集号，与库里 Shot.episode
        #      差 1 —— 服装识别读第 N 集的剧本、却配到第 N-1 集的镜头，
        #      全项目造型锚点整体错位一集
        #
        # order=0 是"非正片"的语义标记：调用方据此跳过拆解（见 is_preamble），
        # 文本仍完整保留供用户查阅与编辑，不会像修复前那样被静默删除。
        if preamble:
            chapters.insert(0, {
                "order": 0, "title": "前言（正文前内容）",
                "content": preamble, "word_count": len(preamble),
            })
        return chapters

    # 模式2: 长分隔线
    sep_pattern = r'\n\s*[=*\-_~]{5,}\s*\n'
    if re.search(sep_pattern, text):
        parts = [p.strip() for p in re.split(sep_pattern, text) if p.strip()]
        return [
            {"order": i + 1, "title": f"第{i + 1}集", "content": p, "word_count": len(p)}
            for i, p in enumerate(parts)
        ]

    # 模式3: 长度兜底 —— 按句界切，绝不在句子中间下刀
    if len(text) > 5000:
        return [
            {"order": i + 1, "title": f"第{i + 1}集",
             "content": c, "word_count": len(c)}
            for i, c in enumerate(_chunk_by_sentence(text))
        ]

    # 单集
    return [{"order": 1, "title": "第1集", "content": text, "word_count": len(text)}]



def _chunk_by_sentence(text: str, target: int = 5000) -> list[str]:
    """无任何集标记的长文兜底切分：只在段末/句末下刀。

    原来是 text[i*5000:(i+1)*5000] —— 硬切，必然切在句子甚至词语中间，
    被切开的那句话在相邻两"集"里各剩半截，拆解时两边都读不懂，
    而用户完全看不出发生了什么。
    """
    units: list[str] = []
    for para in text.split("\n"):
        if len(para) <= target:
            units.append(para)
            continue
        # 超长段落（无换行的大段文字）内部再按句末切
        buf = ""
        for ch in para:
            buf += ch
            if ch in _SENT_ENDS and len(buf) >= target // 2:
                units.append(buf)
                buf = ""
        if buf:
            units.append(buf)

    chunks: list[str] = []
    cur = ""
    for u in units:
        if cur and len(cur) + len(u) + 1 > target:
            chunks.append(cur.strip())
            cur = ""
        cur += u + "\n"
    if cur.strip():
        chunks.append(cur.strip())
    return [c for c in chunks if c]

# ---- 长文预分块（拆解防丢剧情 + 防 LLM 输出截断）----
_SENT_ENDS = "。！？…"


def split_for_ai(text: str, max_chars: int = 2800) -> list[str]:
    """把长文按句界切成 ≤max_chars 的块（在。！？…或换行处切，不切断剧情）。

    动机：整集 9000+ 字直喂 LLM 有两个问题——
    1) 输出镜头数过多，超过模型单次输出上限被拦腰截断（JSON 解析 502）；
    2) 长上下文中间部分注意力稀释，拆解粒度变粗、剧情被略过。
    分块后逐块拆解再合并，粒度稳定且不丢内容。
    """
    text = text.strip()
    if len(text) <= max_chars:
        return [text] if text else []
    chunks: list[str] = []
    buf = ""
    # 先按段落，段内再按句子
    for para in text.split("\n"):
        para = para.strip()
        if not para:
            continue
        pieces: list[str] = []
        if len(para) <= max_chars:
            pieces = [para]
        else:
            sent = ""
            for ch in para:
                sent += ch
                if ch in _SENT_ENDS and len(sent) >= 200:
                    pieces.append(sent)
                    sent = ""
            if sent:
                pieces.append(sent)
        for p in pieces:
            if len(buf) + len(p) + 1 > max_chars and buf:
                chunks.append(buf)
                buf = p
            else:
                buf = f"{buf}\n{p}" if buf else p
    if buf:
        chunks.append(buf)
    return chunks


#: 解说旁白单段的最短字数。低于这个数的段落合并进相邻段——
#: 一两个字单独合成一条 TTS 既浪费调用，听感上也是突兀的碎句。
_MIN_NARRATION_CHARS = 8

#: 中文 TTS 语速（字/秒），**均值**。用于估算一段文字大概读多久。
#:
#: 【2026-08-29 实测标定】scripts/probe_tts_rate.py，16 样本并发，
#: RunningHub IndexTTS-1.5：
#:   实测区间 4.47~6.50 字/秒，均值 5.56、中位 5.75
#:   线性拟合 时长 ≈ 0.1693 × 字数 + 0.08（R 很高，173字→29.69s 完全落线）
#:   4.47 那个离群点是 4 字短句（起止静音占比大），长句稳定在 5.8~5.9
#: 取 5.0（略低于均值，长句实测更接近 5.8，短句偏慢）。
_CHARS_PER_SEC = 5.0

#: 反推"一段最多能塞多少字"时用的**最慢**语速。
#:
#: 方向性是关键：算字数上限必须假设 TTS 读得慢（字少→段短→安全），
#: 而不能用均值。若用 5.0 反推 38s 得 190 字，真遇上 4.47 字/秒的段
#: 就要读 42.5s，超出包线 12% —— 视频直接爆显存。
#: 用实测最慢的 4.47：最坏情况刚好贴线，正常情况段偏短，代价只是
#: 多切一两个镜头。两种错的代价严重不对称，必须往安全侧偏。
_CHARS_PER_SEC_SLOW = 4.47

#: 单段旁白的**兜底**时长上限（秒）。
#:
#: ⚠️ 正常路径不该用这个常量——请用 max_narration_sec(megapixels, instance)
#: 按项目实际分辨率算。解说剧的正确策略是**在用户选定的分辨率下尽可能出长镜**：
#: 同样一段剧本，0.5MP 能一镜 38s，1.0MP 只能 18s，切成两倍多的镜头不但更贵、
#: 更慢，画面也更碎。分辨率是用户的选择，镜头长度应当跟着它走，而不是反过来
#: 用一个写死的 12s 把所有分辨率一刀切。
#:
#: 这里保留 12.0 仅作为拿不到分辨率信息时的保守兜底（比默认机型 plus 的
#: 1.0MP 档 18s 更紧，因为拿不到分辨率就无从判断是不是 2.0MP）。
_MAX_NARRATION_SEC = 12.0

#: 拆镜时给显存包线留的安全余量（秒）。
#: 实测包线是"这个时长能出片"的临界值，紧贴着排会因 TTS 语速波动
#: （实测 4.47~6.50 字/秒）偶发越界。留 2s：0.5MP 实测 40s → 按 38s 设计。
_DURATION_HEADROOM_SEC = 2.0


def with_headroom(raw_seconds: float) -> float:
    """给"模型宣称能出多长"扣掉安全余量，得到拆镜实际敢用的上限。

    单独抽出来是因为**每一条**得到上限的路径都必须扣：无论上限来自显存包线
    还是模型硬钳（seedance 15s / veo 8s），TTS 语速波动（实测 4.47~6.50 字/秒）
    都一样存在。漏扣的那条路径就是下一次音画对不上的地方。
    """
    return max(3.0, raw_seconds - _DURATION_HEADROOM_SEC)


def max_narration_sec(megapixels: float | None = None,
                      instance_type: str = "") -> float:
    """该分辨率下单镜可用的最长时长（秒），已扣安全余量。

    解说剧按这个值拆镜——**在用户选定的分辨率下尽可能拉长**，
    而不是拿固定秒数一刀切。实测（probe_video_limits.py，72 点）：
        default(24G): 0.5MP→30s  1.0MP→15s  2.0MP→5s   （预算 15 MP·s）
        plus/ultra:   0.5MP→40s  1.0MP→20s  2.0MP→8s   （预算 20 MP·s）

    `instance_type` 留空 = 跟随实际调用的默认机型（plus，48G）。
    这一点必须与提交视频任务时用的机型一致：拆镜按 default 算、
    实际却跑 plus，等于白白多切 1/3 的镜头。
    """
    if not megapixels or megapixels <= 0:
        return _MAX_NARRATION_SEC
    # 延迟导入：script_import 是纯函数模块，被 CLI/测试直接引用，
    # 顶层依赖 providers 会把 httpx 等一并拖进来。
    from .providers.video_runninghub import max_seconds_for
    raw = max_seconds_for(megapixels, instance_type)
    return with_headroom(raw)


def estimate_tts_seconds(text: str) -> float:
    """按字数估算 TTS 时长（秒）。切分阶段用它做时长预算。"""
    n = len((text or "").strip())
    return n / _CHARS_PER_SEC if n else 0.0


def narration_parts_needed(text: str, max_sec: float = _MAX_NARRATION_SEC) -> int:
    """这段文字至少要切成几段，才能让每段都不超过 max_sec。

    解说剧的镜头数**不该**由拆镜结果单方面决定：旁白读完要多久是硬约束，
    一段 60 字的话无论分给几个镜头，总得有人把它读完。
    调用方据此把镜头数补到足够多。
    """
    if not (text or "").strip():
        return 0
    return max(1, math.ceil(estimate_tts_seconds(text) / max(0.5, max_sec)))


def split_narration(text: str, parts: int,
                    max_sec: float | None = _MAX_NARRATION_SEC) -> list[str]:
    """把一集剧本正文切成解说旁白，**只在句子边界切**。

    解说剧的旁白直接照读剧本原文，所以这里不做任何语义改写，
    只解决"一段连续文字怎么分配到 N 个镜头"。

    为什么按句子边界而不是硬截字符：硬截会把句子劈成两半，
    TTS 合成出来就是半句话戛然而止、下一镜接着后半句，听感直接崩掉。
    宁可各段字数不均，也不能切碎句子（用户明确要求）。

    `max_sec`：单段时长上限（按 _CHARS_PER_SEC 估算）。**返回的段数可能
    多于 `parts`** —— 剧本要读多久是硬约束，镜头数不该单方面决定它。
    实测出现过 35s 的段直接把视频生成打爆显存，所以这里宁可多切几段。
    传 None 关闭时长约束（只按 parts 均分，老行为）。

    算法：先按句末标点切成句子，再贪心装箱——累计字数超过
    "剩余字数 / 剩余段数" 就换下一段；若某段估算时长超上限则提前收口。

    返回列表长度 ≥ parts（不足补空串），调用方按下标对应镜头，
    超出的部分需要自己补镜头。
    """
    text = (text or "").strip()
    if parts <= 0:
        return []
    if not text:
        return [""] * parts

    # 时长约束优先：要读 60s 的文字塞进 3 个镜头，每镜 20s 必爆显存。
    # 先把段数抬到"每段都不超时长上限"所需的数量。
    if max_sec and max_sec > 0:
        parts = max(parts, narration_parts_needed(text, max_sec))

    # 1) 切句：句末标点后断开；换行也算边界（剧本里常一句一行）
    sentences: list[str] = []
    buf = ""
    for ch in text:
        if ch == "\n":
            if buf.strip():
                sentences.append(buf.strip())
            buf = ""
            continue
        buf += ch
        if ch in _SENT_ENDS:
            sentences.append(buf.strip())
            buf = ""
    if buf.strip():
        sentences.append(buf.strip())
    if not sentences:
        return [""] * parts

    # 句子数还没镜头多：有几句给几句，剩下的镜头没有旁白（留白，不报错）
    if len(sentences) <= parts:
        return sentences + [""] * (parts - len(sentences))

    # 2) 贪心装箱：目标随剩余量动态重算，避免误差累积到最后一段。
    #    同时受 max_sec 硬约束——超时长就提前收口，哪怕字数还没到目标。
    #    ⚠️ 字数上限用**最慢**语速反推：读得慢的段字数少才安全。
    #    用均值反推会让慢段超出包线（38s 档差 12%），直接爆显存。
    cap_chars = (int(max_sec * _CHARS_PER_SEC_SLOW)
                 if (max_sec and max_sec > 0) else None)
    out: list[str] = []
    idx = 0
    for slot in range(parts):
        remain_slots = parts - slot
        remain_chars = sum(len(s) for s in sentences[idx:])
        if remain_chars <= 0:
            out.append("")
            continue
        target = max(1, remain_chars // remain_slots)
        if cap_chars:
            target = min(target, cap_chars)
        cur = ""
        # 至少取一句：否则句子比槽多的时候会空转，剩余全压到最后一段
        while idx < len(sentences):
            nxt = sentences[idx]
            # 已经装了内容、再加会超上限 → 收口留给下一段。
            # 单句本身就超上限的情况只能整句放进去（不能切碎句子），
            # 这种超长句由调用方在回写时长时兜底钳制。
            if cur and cap_chars and len(cur) + len(nxt) > cap_chars:
                break
            cur += nxt
            idx += 1
            if len(cur) >= target:
                break
        out.append(cur)

    # ⚠️ 剩余句子必须继续开新段，**不能**一股脑塞进最后一段。
    # 原实现在最后一个槽位做 "".join(sentences[idx:])，估算偏差稍大就会
    # 攒出一个超长段——实测就是这样产出 35s 片段把视频生成打爆显存的。
    while idx < len(sentences):
        cur = ""
        while idx < len(sentences):
            nxt = sentences[idx]
            if cur and cap_chars and len(cur) + len(nxt) > cap_chars:
                break
            cur += nxt
            idx += 1
        out.append(cur)

    while len(out) < parts:
        out.append("")

    # 3) 过短段并入前一段（避免一两个字单独合成一条 TTS）。
    #    但并入后不能把前段顶过上限——那等于把刚防住的超长段又造回来。
    for i in range(1, len(out)):
        if out[i] and len(out[i]) < _MIN_NARRATION_CHARS:
            if cap_chars and len(out[i - 1]) + len(out[i]) > cap_chars:
                continue
            out[i - 1] += out[i]
            out[i] = ""
    return out


#: 只保留"会被念出来"的字符：汉字 + 字母数字。
#: 标点/空白/换行都不算——TTS 不念它们，`split_narration` 也会在装箱时
#: 把换行吃掉，所以拿原串直接比对必然不等。做覆盖率与对齐断言一律先过这个。
_SPOKEN_RE = re.compile(r'[一-鿿0-9A-Za-z]')


def spoken_chars(text: str) -> str:
    """抽出文本里"会被念出来"的字符序列，用于覆盖率统计与对齐断言。"""
    return "".join(_SPOKEN_RE.findall(text or ""))


def plan_narration_by_shot(refs: list[str],
                           max_sec: float | None) -> list[list[str]]:
    """每镜 `script_ref` → 该镜的旁白段列表（通常 1 段）。

    ## 为什么必须以 script_ref 为准

    此前旁白是把**整集正文**丢给 `split_narration` 重新切一遍的。于是同一份
    文本存在两套互不相干的边界：画面按 AI 拆解的叙事节拍切，旁白按
    "剩余字数/剩余段数" 贪心装箱切。对不齐是必然的，不是偶发 bug ——
    实测项目 930 的镜 3 画面演的是原文第 380-582 字，配的旁白却是第 250-319 字。

    唯一正确的不变式是：**第 N 镜的旁白 == 第 N 镜画面所依据的那段原文**。
    `script_ref` 按定义就是这段文本，所以这里直接拿它当旁白，1:1 绑定。

    ## 读不完怎么办

    拆镜提示词是按"7-15 秒**视频**"设计的，而旁白时长上限由视频模型的显存包线
    决定（720p 海螺 H3 只有 19.1s ≈ 85 字），一镜 116 字要读 26 秒——读不完。
    缺口用**拆成更多镜头**补（用户决策）：按句界拆开，调用方据此插入克隆镜，
    画面全程有运动。

    段数用**最慢**语速 `_CHARS_PER_SEC_SLOW` 反推，与 `split_narration` 内部的
    `cap_chars` 同源；用均值反推会让慢段贴不住包线（见该常量注释）。

    返回值与 `refs` 等长；空 ref 对应空列表（该镜没有旁白，不报错）。
    """
    cap_chars = (int(max_sec * _CHARS_PER_SEC_SLOW)
                 if (max_sec and max_sec > 0) else None)
    out: list[list[str]] = []
    for ref in refs:
        t = (ref or "").strip()
        if not t:
            out.append([])
            continue
        n = (math.ceil(len(spoken_chars(t)) / cap_chars)
             if cap_chars else 1)
        if n <= 1:
            # 读得完就**原样保留**，不进装箱——装箱会顺手吃掉换行与首尾空白，
            # 让 "旁白 == script_ref" 这条不变式变成"约等于"，断言就没法做硬比对了。
            out.append([t])
            continue
        segs = [s for s in split_narration(t, n, max_sec=max_sec) if s.strip()]
        # split_narration 极端情况下可能一段都产不出（整段无句末标点且被并空）,
        # 那就退回整段——宁可这一镜偏长（回写时长时有 cap 兜底），也不能丢文字。
        out.append(segs or [t])
    return out
