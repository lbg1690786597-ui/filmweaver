"""镜头「已过期」的**原因**及其消解规则（单一事实来源）。

## 为什么需要拆出原因（P2-15）

`Shot.stale` 原本是个裸 bool，四个地方都往里写 1，但它们要求用户做的事**完全不同**：

| 置 stale 的场景 | 用户真正要做的 |
|---|---|
| 改了某集正文（`update_episode_content`） | **重拆本集** —— 镜头切分本身就不对了 |
| 改了单镜的 script_ref / 场景 / 衔接（`PATCH /shots/{id}`） | **按新拆解重出提示词**，再出片 |
| 旁白拆段改写了 script_ref（narration split） | 同上 |
| 旁白时长变了（`_sync_shot_duration`） | **只需重出片**，提示词一字不用改 |

而 UI 只有一句「⚠ 所属集剧本已修改，本镜拆解已过期」——旁白时长变了也这么说，
而且引导用户去点「↻ 重新拆解本集」，那会把已出的片全作废，代价与病因完全不匹配。

更严重的是 `run_shot_videos` **只清 `refs_stale`、从不清 `stale`**：

- 重出片解决得了的「时长变了」，出完片旗标还挂着，永远洗不掉；
- 反过来，改了剧本之后直接点「重新生成」，`run_shot_videos` 会把
  `pregen = shot.gen_prompt`（**旧**提示词）当优化基线，新的 script_ref
  一个字都到不了模型——用户看着片子重出了、内容还是旧的，且无任何报错。

所以「原因」不是给 UI 加文案用的枚举，它决定**两条真实的代码分支**：
重生成时提示词从哪儿取（`needs_prompt_rebuild`）、以及出片后旗标能不能清
（`clears_on_regen`）。

## 取值按「补救动作」命名，而不是按「什么变了」命名

按病因命名（`script_changed` / `duration_changed`）会让每个读它的地方
都得再翻译一次"那我该干嘛"，翻译早晚漂移。按药方命名，判断即答案：

    rebreak  > reprompt > regen
    需重拆本集  需重出提示词  只需重出片

`stale=1` 而 `stale_reason IS NULL` = 本次改动之前留下的老数据。一律**按最保守
处理**（等同 `rebreak`：不自动清、不自动改提示词基线），保证老库行为与改动前**逐字一致**。
"""
from __future__ import annotations

#: 需重拆本集：集正文变了，镜头切分本身失效（重出片/重出提示词都救不了）
REBREAK = "rebreak"
#: 需重出提示词：本镜 script_ref/场景/衔接变了，现有 gen_prompt 基于旧拆解
REPROMPT = "reprompt"
#: 只需重出片：画面依据没变，只是时长/参数要重对（提示词照用）
REGEN = "regen"

#: 严重度。数字只用于比较，不落库（落库的是字符串，方便直接读库排查）。
_RANK = {REGEN: 1, REPROMPT: 2, REBREAK: 3}

#: 给用户看的一句话。**后端出文案**是为了单一真源：前端曾自己拼过一份，
#: 与后端语义各漂一半。前端优先用它，拿不到（老后端）才回落自己那句。
_LABEL = {
    REBREAK: "本集正文已修改，镜头切分已过期（需重新拆解本集）",
    REPROMPT: "本镜拆解已修改，提示词基于旧拆解（需重新生成提示词后再出片）",
    REGEN: "旁白时长已变，现有视频与新时长对不上（重新生成即可）",
}


def rank(reason: str | None) -> int:
    """严重度；未知/NULL 按最高处理（保守：老数据不被自动清掉）。"""
    return _RANK.get(reason or "", _RANK[REBREAK])


def stronger(a: str | None, b: str | None) -> str | None:
    """取更严重的那个原因。

    ⚠️ 只升不降是硬要求：先改了正文（rebreak）、又碰了旁白时长（regen），
    若后者覆盖前者，用户就再也看不到"该重拆"这件事了，而重出片救不了切分。
    """
    if a is None or b is None:
        # NULL 是"老数据/未知"，按 rebreak 级处理；此时保留 NULL 而不是
        # 伪造一个 rebreak——不知道就别编，读的地方已按最保守分支处理。
        return None
    return a if rank(a) >= rank(b) else b


def mark_stale(shot, reason: str) -> None:
    """标记过期。已有更严重的原因时**保留原因**，只确保 stale=1。"""
    if reason not in _RANK:
        raise ValueError(f"未知的 stale_reason: {reason!r}")
    if shot.stale:
        shot.stale_reason = stronger(getattr(shot, "stale_reason", None), reason)
    else:
        shot.stale_reason = reason
    shot.stale = 1


def clear_stale(shot) -> None:
    """彻底清除过期标记（提示词与画面都已按最新拆解重做）。"""
    shot.stale = 0
    shot.stale_reason = None


def clears_on_regen(reason: str | None) -> bool:
    """重新出片成功后，这个原因能否被清掉？

    - `regen`：能——病因就是"片子旧了"，新片一出即痊愈
    - `reprompt`：能——但**前提是**这次出片确实按新 script_ref 重出了提示词，
      即调用方必须先走 `needs_prompt_rebuild` 那条分支。两者是一对，别只用其中一个
    - `rebreak` / NULL：不能——切分没变，出多少次片都还是错的切分
    """
    return reason in (REPROMPT, REGEN)


def needs_prompt_rebuild(reason: str | None) -> bool:
    """出片前必须丢弃 `gen_prompt`、从 `script_ref` 重新优化？

    `reprompt` 的病因正是"gen_prompt 基于旧拆解"，拿它当基线等于把病因当药。
    `rebreak`/NULL 也是"拆解变了"，同样不该信旧提示词。只有 `regen` 例外
    （画面依据没变），以及未标 stale 的正常镜头。

    ⚠️ 调用方必须先判 `shot.stale` —— 没过期的镜头 `stale_reason` 也是 NULL，
    若不先判 stale，这里会把**全部正常镜头**都判成"要重建提示词"，
    等于给每次出片凭空加一次文本模型调用。
    """
    return reason != REGEN


def after_reprompt(reason: str | None) -> str | None:
    """跑完「重新生成提示词」之后，原因降级到哪一档。

    `reprompt` 的诉求已被满足，剩下的只是"片子还是旧的" → `regen`。
    `rebreak` 不动：提示词再对，切分还是错的。NULL 不动（不知道就别猜）。
    """
    return REGEN if reason == REPROMPT else reason


def label(reason: str | None) -> str | None:
    """给用户看的一句话；NULL/未知返回 None（前端回落自己的兜底文案）。"""
    return _LABEL.get(reason or "") or None
