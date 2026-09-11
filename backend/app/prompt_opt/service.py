"""提示词优化服务（T-R0-03，需求 §1.2-⑦）。

移植主平台 seedance_pe 框架，改写点：
- langchain → FW 的 LLMProvider（裸 OpenAI 兼容调用，不引新依赖）
- 框架按目标视频模型分目录：skill_assets/<framework>/（SKILL.txt + references/）
- 无框架的模型走"直通"：optimize_to_prompt 原样返回，不阻断生成链路

框架映射（模型 → 框架目录）：
- seedance 系          → seedance2（已移植，模型未接入但方法论通用，接入即插即用）
- minimax-h3-ref2v     → minimax_h3（目录预留，内容待用户提供；为空=直通）
- veo 系               → 无框架（直通）
"""
from __future__ import annotations

import os
import re
import json
import logging
from functools import lru_cache
from typing import Optional

from ..providers.llm import LLMProvider

logger = logging.getLogger("fw.prompt_opt")

_ASSETS_DIR = os.path.join(os.path.dirname(__file__), "skill_assets")

def _list_references(framework: str) -> list[str]:
    """动态扫描框架 references 目录（文件名排序）。

    不同框架的参考文档文件名各异（seedance2 六份 / minimax_h3 两份官方指南），
    不写死清单；新增框架只需放目录即生效。
    """
    ref_dir = os.path.join(_ASSETS_DIR, framework, "references")
    if not os.path.isdir(ref_dir):
        return []
    return sorted(f for f in os.listdir(ref_dir) if f.endswith(".txt"))

# model_id 前缀 → 框架目录（None=直通）
def framework_for_model(model_id: str) -> Optional[str]:
    m = (model_id or "").lower()
    if m.startswith("seedance"):
        return "seedance2"
    if m.startswith("minimax"):
        return "minimax_h3"
    return None  # veo 及未知模型：直通


def _read(path: str) -> str:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read().strip()
    except Exception as e:  # noqa: BLE001
        return f"(读取失败: {os.path.basename(path)}: {e})"


def _framework_ready(framework: str) -> bool:
    """框架目录有 SKILL.txt 才算就绪；空目录（如 minimax_h3 预留）= 未就绪→直通。"""
    return os.path.isfile(os.path.join(_ASSETS_DIR, framework, "SKILL.txt"))


#: 各框架 SKILL 里**与本项目出品要求直接冲突**的条款，必须逐条点名推翻。
#: 不点名的话，模型面对「SKILL 说要写运镜 / 要保留屏幕文字」和「硬规则说不要」
#: 会自行折中，实测就是照旧加推镜。
_SKILL_CONFLICTS = {
    "seedance2":
        "   本节推翻《技能说明》中的以下要求：「一个时间切片内只存在一种运镜方式」"
        "「每个切片指定运镜」「缺少分镜和运镜描述属于缺陷」——这些在本项目一律不适用。\n",
    "minimax_h3":
        "   本节推翻《技能说明》「写作硬规则」中的以下条款：\n"
        "     · 第 4 条「相机运动 = 运动类型 + 幅度 + 速度」——本项目默认不写相机运动，"
        "固定机位即可（原稿明确要求运镜时才写）。\n"
        "     · 第 1 条「画面可见文字用英文双引号原文保留」与第 9 条「严格保留屏幕文字」"
        "——本项目禁止画面出现任何文字，不得为了保留原文而把文字写进画面描述；"
        "台词只能作为说出来的话（<d> 标签）存在，绝不能变成屏幕文字。\n",
}


def _house_rules(framework: str) -> str:
    """本项目出品硬规则。放在 SKILL 与全部参考文档**之后**，冲突时以此为准。

    2026-09-02：用户反馈成片「镜头总在往人物推进」+「画面出现字幕」。
    根因不在模型而在我们喂的框架——seedance2 SKILL 要求逐切片指定运镜，
    minimax_h3 SKILL 要求保留画面可见文字。故在此逐条推翻。
    """
    en = ("   ⚠️ 本框架产出的提示词为英文，约束句也必须写成英文："
          "在正文中显式包含 "
          "「No subtitles, no captions, no on-screen text, no watermark, no logo」，"
          "并用 static camera / fixed camera / locked-off shot 表达固定机位。\n"
          if framework == "minimax_h3" else "")
    return (
        "\n\n========== 出品硬规则（本项目覆盖规则；与上面《技能说明》和参考文档"
        "冲突时，一律以本节为准）==========\n"
        + _SKILL_CONFLICTS.get(framework, "")
        + "1. 机位默认固定。除非原稿明确写了运镜（例如「镜头跟着他穿过走廊」），"
        "否则每个时间切片一律写成固定机位：只交代景别（特写/近景/中景/全景/远景）"
        "与角度（平视/俯拍/仰拍/过肩），不写推、拉、摇、移、跟、环绕、变焦，"
        "也不写 push in / pull back / dolly / zoom / pan / track / orbit。\n"
        "   本项目是对白驱动的短剧，靠表演与剪接叙事；默认给推镜会让每一个镜头"
        "都在往人脸上怼，成片非常怪。时长要靠人物动作与表演铺满，"
        "不是靠镜头运动铺满。\n"
        "2. 画面内禁止出现任何文字（字幕/标题/字卡/水印/logo/招牌特写文字）。"
        "最终提示词必须显式包含「无字幕，无文字，无水印，无logo」。"
        "本项目有独立的字幕系统，模型烧进画面里的字幕全部是废片。\n"
        + en
        + "3. 禁止使用【】。在 Seedance 语法里【】的含义是"
        "「把这段文字作为字幕显示在画面上」（见参考文档的字符使用规范）。"
        "原稿里的【】其实是表演提示或台词，照抄会被直接烧成字幕。"
        "表演提示改写成普通描述文字；台词按各框架的台词语法写"
        "（Seedance 用 {}，海螺用 <d> 标签），绝不能放进【】。\n"
    )


#: 3.9 走位台账：让优化器**顺带**产出"本镜结束时谁在哪"。
#:
#: 为什么塞进这一次调用而不是单开一次：它已经在这一步把整镜的画面从头到尾
#: 想过一遍了，结尾谁站在哪是它手上现成的信息；单开一次调用要重新喂一遍
#: 上下文，既多花一次钱，也会给 LLM 网关多压一份并发（并发数是用户统一
#: 掌控的，任何"顺手多发一个请求"都不该由这里决定）。
#:
#: 放在提示词代码块**之后**，且用独立的 fenced 块，抽取时才不会与正文打架
#: （`extract_optimized_prompt` 取的是**第一个**代码块，顺序必须是正文在前）。
_BLOCKING_REQUIREMENT = (
    "\n4) 最后再输出一个**独立的** ```json 代码块，内容是本镜**结束那一刻**"
    "画面里每个在场角色的位置状态，供下一个镜头衔接使用。格式：\n"
    '```json\n'
    '{"blocking": {"角色名": {"pos": "在画面中的位置与所处陈设，'
    '如「画面左侧，长餐桌北侧座位」", "posture": "坐 / 站 / 俯身 等",'
    ' "facing": "面向谁或朝哪个方向"}}}\n'
    '```\n'
    "要求：\n"
    "  · 只写**位置、姿态、朝向**三项，不要写情绪、服装、台词"
    "（那些各有各的来源，混进来只会打架）；\n"
    "  · 本镜画面里出现的角色**全部**都要有，包括没有台词只是坐着的；\n"
    "  · 写「结束那一刻」的状态，不是开头的，也不是中间的；\n"
    "  · 位置要写得能让另一个人照着复现（「左侧」「餐桌北侧」这种相对关系），"
    "不要写「在房间里」这种没有信息量的话。\n"
)


@lru_cache(maxsize=8)
def build_system_prompt(framework: str) -> str:
    """组装 system prompt = SKILL 方法论 + 全部参考文档。进程级缓存。"""
    base = os.path.join(_ASSETS_DIR, framework)
    skill = _read(os.path.join(base, "SKILL.txt"))
    parts = [
        "你是视频提示词优化专家。严格遵循下方《技能说明》的工作流程与硬性约束, "
        "并在每次优化前充分参考随附的全部参考文档。",
        "\n\n========== 技能说明 (SKILL) ==========\n",
        skill,
        "\n\n========== 参考文档 (references, 每次优化必须依据) ==========\n",
    ]
    ref_dir = os.path.join(base, "references")
    for fn in _list_references(framework):
        parts.append(f"\n\n### 参考文档: {fn}\n{_read(os.path.join(ref_dir, fn))}\n")
    parts.append(_house_rules(framework))
    parts.append(
        "\n\n========== 输出要求 ==========\n"
        "按 SKILL 第五步输出: 1) 问题分析  2) 优化后的标准提示词(放在代码块中, "
        "内部禁止出现任何特殊图标符号)  3) 优化说明。"
        "严格保留用户原始意图、台词与音频信息, 不得丢弃。\n"
        + _BLOCKING_REQUIREMENT
    )
    return "".join(parts)


def get_status() -> dict:
    """各框架就绪状态（/v2/prompt-opt/status 用）。"""
    frameworks = {}
    for fw in ("seedance2", "minimax_h3"):
        skill_ok = _framework_ready(fw)
        refs = _list_references(fw)
        frameworks[fw] = {
            "ready": skill_ok,
            "skill_present": skill_ok,
            "references_present": len(refs),
            "references": refs,
            "mode": "optimize" if skill_ok else "passthrough",
        }
    frameworks["veo"] = {"ready": False, "mode": "passthrough",
                         "note": "veo 通道无框架, 提示词直通"}
    return {"frameworks": frameworks}


def extract_optimized_prompt(markdown: str) -> Optional[str]:
    """从优化结果 markdown 抽出第一个代码块的纯文本（最终喂模型的提示词）。

    ⚠️ 取**第一个**：3.9 起输出要求里多了一个走位台账的 ```json 块，
    它按要求排在正文之后。顺序一旦反过来，下发给视频模型的就会是一段 JSON。
    `extract_blocking` 因此只认带 `"blocking"` 键的块，两边各自站得住。
    """
    if not markdown:
        return None
    blocks = re.findall(r"```(?:[a-zA-Z]*)\s*(.*?)```", markdown, re.DOTALL)
    for b in blocks:
        t = b.strip()
        # 台账块不能被当成提示词。哪怕它意外排在了前面，这里也要跳过 ——
        # 下发一段 `{"blocking": ...}` 给视频模型是纯粹的废片。
        if t.startswith("{") and '"blocking"' in t:
            continue
        if t:
            return t
    return None


def extract_blocking(markdown: str) -> Optional[dict]:
    """从优化结果里抽出走位台账（`{"blocking": {...}}` 那个 json 块）。

    抽不到返回 None —— 台账是**锦上添花**，没有它只会退回原来的通用约束，
    绝不能因此让出片失败。所以这里对任何异常都吞掉。

    只认带 `blocking` 键的对象：模型偶尔会把提示词也包成 ```json，
    按"最后一个代码块"取会把正文当台账。
    """
    if not markdown:
        return None
    for b in re.findall(r"```(?:[a-zA-Z]*)\s*(.*?)```", markdown, re.DOTALL):
        t = b.strip()
        if not t.startswith("{") or '"blocking"' not in t:
            continue
        try:
            obj = json.loads(t)
        except (ValueError, TypeError):
            continue
        blk = obj.get("blocking") if isinstance(obj, dict) else None
        if isinstance(blk, dict) and blk:
            return blk
    return None


async def optimize_to_prompt(
    raw_prompt: str,
    *,
    video_model_id: str,
    llm_model_id: str | None = None,
    extra_context: Optional[str] = None,
) -> str:
    """按目标视频模型选框架优化提示词；无框架/失败一律返回原稿（不阻断生成）。"""
    prompt, _, _ = await optimize_full(
        raw_prompt, video_model_id=video_model_id,
        llm_model_id=llm_model_id, extra_context=extra_context)
    return prompt


async def optimize_full(
    raw_prompt: str,
    *,
    video_model_id: str,
    llm_model_id: str | None = None,
    extra_context: Optional[str] = None,
) -> tuple[str, Optional[str], Optional[dict]]:
    """优化提示词，并**顺带**取回本镜结尾的走位台账。

    返回 `(提示词, 降级原因或 None, 走位台账或 None)`。

    ## 为什么台账搭在这一次调用上

    这一步模型已经把整镜的画面从头到尾想过一遍，"结尾谁站在哪"是它手上现成的
    信息。单开一次调用要重新喂一遍上下文：多花一次钱，还会给 LLM 网关多压
    一份并发——而并发数是用户统一掌控的，不该由这里擅自多发请求。

    ## 三者的失败是独立的

    · 优化调用失败 → 回退原稿 + 记降级原因（台账自然也没有）
    · 抽不到提示词 → 回退原稿 + 记降级原因
    · **只是抽不到台账** → 不算降级：下一镜退回原来的通用位置约束而已，
      绝不能因此让出片失败。所以台账为 None 时 reason 保持 None。
    """
    raw = (raw_prompt or "").strip()
    if not raw:
        return raw, None, None
    framework = framework_for_model(video_model_id)
    if not framework or not _framework_ready(framework):
        return raw, None, None  # 直通：本就没有框架，不算降级

    system_prompt = build_system_prompt(framework)
    # 补充背景的优先级必须高于原稿：它承载的是参考图实际造型、人物性别档案、
    # 目标时长这类**原稿写错了也必须纠正**的硬事实（原稿是拆解时写的，那时
    # 资产还不存在）。不写明优先级，模型会把原稿里的错误服装/错误性别照抄下来。
    human = raw if not extra_context else (
        f"{raw}\n\n[补充背景与硬性约束——优先级高于上面的原稿，"
        f"与原稿冲突时一律以此为准]\n{extra_context.strip()}")
    try:
        llm = LLMProvider(model_id=llm_model_id)
        md = await llm.complete(system_prompt, human, temperature=0.3)
    except Exception as e:  # noqa: BLE001
        reason = f"优化调用失败({type(e).__name__}: {str(e)[:160]})，已回退原稿"
        logger.warning("提示词优化降级：%s（框架 %s，模型 %s）",
                       reason, framework, video_model_id)
        return raw, reason, None    # 优化失败回退原稿，生成链路不中断
    out = extract_optimized_prompt(md)
    # 台账抽取与提示词**互不影响**：抽不到台账只是少一段下一镜的位置约束，
    # 不是降级；抽不到提示词才是降级。两件事不能共用一个 reason。
    blocking = extract_blocking(md)
    if not out:
        reason = "优化结果里没有代码块，无法提取提示词，已回退原稿"
        logger.warning("提示词优化降级：%s（框架 %s，模型 %s，原始回复前120字：%s）",
                       reason, framework, video_model_id, (md or "")[:120])
        return raw, reason, blocking
    return out, None, blocking


async def optimize_to_prompt_detailed(
    raw_prompt: str,
    *,
    video_model_id: str,
    llm_model_id: str | None = None,
    extra_context: Optional[str] = None,
) -> tuple[str, Optional[str]]:
    """同 `optimize_full`，但不要走位台账。老调用方保持二元组不变。

    为什么要把降级原因返回出去：优化失败时静默 `return raw` 意味着上面辛苦
    组装的参考图造型、人物档案、服装锚定硬约束**一条都没生效**，而用户看到的
    表现只是"提示词跟资产图又对不上了"，无从判断是模型没听话还是压根没调成。
    调用方应把原因写进 shot_versions.meta，让这次降级可追溯。
    """
    prompt, reason, _ = await optimize_full(
        raw_prompt, video_model_id=video_model_id,
        llm_model_id=llm_model_id, extra_context=extra_context)
    return prompt, reason
