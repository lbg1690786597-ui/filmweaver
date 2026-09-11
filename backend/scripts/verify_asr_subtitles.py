"""自动字幕验证：音源选择 + 字幕切分（6.0，真机 bug）。

背景（2026-09-07 用户反馈，五集真人剧验证片）：
  「前几个片段出现了字幕和音频不匹配的问题。而后面又有一些片段
   （例如 #19「林语眼神透着轻蔑」）把明显不是台词的文本也作为字幕了；
   而 #23 之后的片段则几乎没有字幕。」

根因不是"时间算错了"，是**真人剧在产品里压根没有字幕生成通路**：
`run_auto_subtitles` 只转写 `audio_clips`（TTS 旁白），而真人剧的音画由
seedance 一体生成，`audio_clips` 恒为空 —— 于是它永远报
「没有可识别的旁白音频。请先在「音频」面板合成 AI 配音。」
（一句对真人剧无法执行的建议）。用户看到的那些字幕是验证期用脚本按**字数
估算**写进库的，三个症状全是"字幕不是从声音来的"派生出来的。

修法是转写**镜头视频自带的音轨**。本脚本守住其中两块**不需要花 ASR 的钱、
不需要起后端**就能验证的纯逻辑：

  A. `_pick_asr_source` —— 音源选择。错一次的代价就是整个模式没有字幕，
     所以它被抽成纯函数并在此表驱动覆盖。
  B. `_split_cue` —— 把 ASR 的**声学**分段切成能读完的字幕。
     用例文本全部取自真机那一批的真实返回（含退化成"26 秒一整条"的那些）。
  C. `_wash_punct` —— 出字幕前洗掉标点（2026-09-07 用户要求：
     「自动识别的字幕应该洗掉标点，如果用户想要标点可以自己手动加」）。
     它必须夹在"装箱之后、分摊时长之前"，两个方向都会出错，故单列。

跑法：python3 scripts/verify_asr_subtitles.py
（ASR 参数那一层——简体提示词——是网络行为，测不进纯逻辑脚本，
  实测数据记在 providers/asr.py 的 SIMPLIFIED_ZH_PROMPT 注释里。）
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.jobs import (_CUE_DROP_PUNCT, _CUE_MAX_CHARS,  # noqa: E402
                      _CUE_MIN_SEC, _pick_asr_source, _split_cue, _wash_punct)
from app.providers.asr import SIMPLIFIED_ZH_PROMPT  # noqa: E402

FAILS: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    print(f"{'✅' if cond else '❌'} {name}" + (f"  {detail}" if detail else ""))
    if not cond:
        FAILS.append(name)


# ---------------------------------------------------------------- A. 音源选择
print("\n① 音源选择：模式决定转写谁的声音")

NARR = [("/a.mp3", 1, 0.0), ("/b.mp3", 3, 1.5)]
VIDS = [("/v1.mp4", 1, 0.0), ("/v2.mp4", 2, 0.0)]

t, fv, lb = _pick_asr_source("drama", [], VIDS)
check("1 真人剧（无旁白，真实形态）→ 镜头原声",
      t == VIDS and fv is True and lb == "镜头原声", lb)

# 这一条是本次 bug 的核心：真人剧**即使**有旁白段也不能用旁白——
# 台词在视频音轨里，旁白顶多是额外配音，拿它当字幕源会漏掉全部台词。
t, fv, lb = _pick_asr_source("drama", NARR, VIDS)
check("2 真人剧即使有旁白也仍走镜头原声（台词只在视频音轨里）",
      t == VIDS and fv is True, lb)

t, fv, lb = _pick_asr_source("narration", NARR, VIDS)
check("3 解说剧有旁白 → 旁白（文本已知，比识别准；且 b-roll 本来无声）",
      t == NARR and fv is False and lb == "旁白", lb)

t, fv, lb = _pick_asr_source("narration", [], VIDS)
check("4 解说剧没有旁白 → 退到镜头原声，而不是报「请先合成配音」",
      t == VIDS and fv is True, lb)

t, fv, lb = _pick_asr_source("", [], [])
check("5 两样都没有 → 空 targets，由调用方报「先生成镜头视频」",
      t == [] and fv is True)

t, fv, lb = _pick_asr_source("", NARR, [])
check("6 模式字段为空（老项目）时按有什么用什么", t == NARR and fv is False)


# ---------------------------------------------------------------- B. 字幕切分
print("\n② 字幕切分：声学分段 → 能读完的字幕")


def probe(name: str, text: str, start: float, span: float,
          want_min: int = 1) -> list[tuple[str, float, float]]:
    out = _split_cue(text, start, span)
    ok = True
    why = []
    if any(len(x) > _CUE_MAX_CHARS for x, _, _ in out):
        ok = False
        why.append(f"有超过 {_CUE_MAX_CHARS} 字的条目")
    # 自动字幕**一律不带标点**（2026-09-07 用户要求：想要标点自己手动加）。
    # 这一条对每个用例都查，因为标点会从任何一条新增的切分分支里漏回来。
    dirty = [x for x, _, _ in out if any(ch in _CUE_DROP_PUNCT for ch in x)]
    if dirty:
        ok = False
        why.append(f"仍带标点: {dirty[0]}")
    # 时长守恒：切分只在**一条分段内部**重新分配，不许多占也不许少占——
    # 少占会在字幕间留下空洞，多占会压到下一条上。
    if abs(sum(d for _, _, d in out) - max(span, _CUE_MIN_SEC)) > 1e-6:
        ok = False
        why.append("时长和 != 原分段跨度")
    if any(b < a for (_, a, _), (_, b, _) in zip(out, out[1:])):
        ok = False
        why.append("起点非递增")
    if any(d < _CUE_MIN_SEC - 1e-9 for _, _, d in out) and len(out) == 1:
        ok = False
        why.append(f"单条时长低于 {_CUE_MIN_SEC}s")
    if len(out) < want_min:
        ok = False
        why.append(f"只切出 {len(out)} 条，至少该有 {want_min} 条")
    check(name, ok, "；".join(why) or f"{len(out)} 条")
    for x, s, d in out:
        print(f"       {s:6.2f} +{d:5.2f} ({len(x):2d}字) {x}")
    return out


# 真机返回原文（项目 13fd3b2ba28e）。#26 是最坏的那条：26 秒、55 字、
# 无 segments —— 旧代码会把它写成一条 **0.3 秒**的字幕（end 缺失 → max(0.3, 0)），
# 55 个字闪 0.3 秒，比没有字幕更糟。
probe("7 短句原样保留（不该被切）", "少夫人", 3.0, 2.0)
probe("8 26 秒一整条 → 切成多条且每条读得完",
      "小雨你認識阿誠多久了也不算久那孩子是不是很悶是挺悶的說話像在開會"
      "他從小就這樣不愛說話什麼事都往心裡層可他心不會", 0.0, 26.08, want_min=3)
probe("9 空格分句（whisper 中文常见）能切开",
      "林小姐 我知道你不想嫁 但我有两个条件 听完你再拒绝不迟 陆先生请说 我洗耳恭听",
      0.0, 12.06, want_min=2)
probe("10 逗号/句号分句", "朋友啊,快坐,阿晨那孩子就是太忙了,总不让人省心。 "
      "他工作性质特殊,也是没办法。", 0.0, 18.08, want_min=2)

# end 缺失（span<=0）时不许产出 0 秒字幕：那等于闪都不闪。
out = probe("11 跨度为 0 时兜到最短可读时长", "喂", 5.0, 0.0)
check("12 兜底时长恰好是 _CUE_MIN_SEC",
      len(out) == 1 and abs(out[0][2] - _CUE_MIN_SEC) < 1e-6)

check("13 空文本不产出条目（ASR 会回空串分段）", _split_cue("   ", 0.0, 5.0) == [])

# 并句时补分隔符：小句边界原本是空格，直接粘起来会变成
# 「林小姐我知道你不想嫁但我有两个条件」——比切碎更难读。
merged = _split_cue("林小姐 我知道你不想嫁 但我有两个条件", 0.0, 6.0)
check("14 并句时补回分隔符，不把两句粘成一坨",
      all(" " in x or len(x) <= 10 for x, _, _ in merged), merged[0][0])

# 无标点长句（AI 语音常见）只能硬切，但绝不能因此超长
hard = _split_cue("啊" * 71, 0.0, 10.0)
check("15 完全无标点的长句硬切后仍每条不超长",
      hard and all(len(x) <= _CUE_MAX_CHARS for x, _, _ in hard)
      and "".join(x for x, _, _ in hard) == "啊" * 71,
      f"{len(hard)} 条，字数无损")

check("16 起点是绝对量（叠加了传入的 offset）",
      _split_cue("test", 7.25, 1.0)[0][1] == 7.25,
      "字幕锚定「镜头 order + 镜内偏移」，offset 必须原样带上，"
      "否则按集导出会整体漂掉")


# ---------------------------------------------------------------- C. 洗标点
print("\n③ 洗标点：自动字幕不带标点（想要的用户自己手动加）")

# 真机原文（项目 13fd3b2ba28e 的 #7）。旧版原样烧进画面，逗号句号全在。
one = _split_cue("她很好,很想你。", 0.0, 3.0)
check("17 短句早退路径也洗（这条最容易漏：它不进切分逻辑）",
      one == [("她很好 很想你", 0.0, 3.0)], str(one))

check("18 句中标点换成空格、首尾标点直接消失",
      _wash_punct("朋友啊，快坐，阿晨那孩子就是太忙了。") == "朋友啊 快坐 阿晨那孩子就是太忙了",
      _wash_punct("朋友啊，快坐，阿晨那孩子就是太忙了。"))

check("19 整段只有标点时不产出条目（ASR 偶尔回一个 「。」）",
      _split_cue("。", 0.0, 5.0) == [] and _split_cue("…… ，", 0.0, 5.0) == [])

# 内容符号不能误洗：`·` 是人名间隔号，百分号/字母/数字都是台词内容。
check("20 刻意保留的内容符号不被误洗",
      _wash_punct("阿·晨说 KPI 涨了 30% 还有 A-3 号房") == "阿·晨说 KPI 涨了 30% 还有 A-3 号房",
      _wash_punct("阿·晨说 KPI 涨了 30% 还有 A-3 号房"))

# 洗在**装箱之后**：标点是唯一可靠的断句信号，先洗就退化成硬切了。
# 这一条同时守住"洗完仍然是按标点切出来的多条"，而不是按 20 字硬切。
punchy = _split_cue("朋友啊,快坐,阿晨那孩子就是太忙了,总不让人省心。 "
                    "他工作性质特殊,也是没办法。", 0.0, 18.08)
check("21 洗标点排在装箱之后，仍按标点切出多条（不是退化成 20 字硬切）",
      len(punchy) >= 3 and all("," not in x and "。" not in x for x, _, _ in punchy)
      and abs(sum(d for _, _, d in punchy) - 18.08) < 1e-6,
      f"{len(punchy)} 条")


# ---------------------------------------------------------------- D. 提示词
print("\n④ 简体提示词（实测数据见 asr.py 注释）")
check("22 提示词本身是简体、带标点的台词口吻（whisper 把它当风格样本续写）",
      bool(SIMPLIFIED_ZH_PROMPT.strip())
      and "简体" in SIMPLIFIED_ZH_PROMPT
      and SIMPLIFIED_ZH_PROMPT.rstrip()[-1] in "。！？.",
      SIMPLIFIED_ZH_PROMPT)

print()
if FAILS:
    print(f"❌ {len(FAILS)} 项失败: {' / '.join(FAILS)}")
    sys.exit(1)
print("✅ 全部通过")
