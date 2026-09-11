"""continuity.py — 镜头之间的连贯性推导（3.9）

解决用户实测到的两类穿帮，两者根子是同一件事：**连续镜头之间没有可传递的状态**。

## 一、在场角色断续（「林母只出现在一个片段里」）

拆解提示词只要求 LLM 列"本镜有戏份的角色"，坐在桌边不说话的人不会进
`characters`。实测项目「真人剧-验证片（五集）」：

    镜1  林语、陆沉、林母      ← 林母踩林语的脚、压低身子警告她
    镜2  陆沉、林语            ← 剧本里**一个字的离场描写都没有**
    镜3  陆沉、林语
    镜4  陆沉、林语
    镜5  林语、陆沉、林母      ← 又回来了
    镜6  林语、陆沉
    镜7  陆沉、林语

同样的形态在镜 8→9（餐厅包厢）、镜 19→21（林家餐厅）各复现一次。
后果是链式的：不在 `characters` → 定妆图不注入 → 提示词不提她 →
模型照着"两人对坐"画，人就没了。镜 2 实际下发的提示词就是
「@图片1 陆沉 与 @图片2 林语 对面而坐」——整幅画面里没有林母的任何位置。

**做法**：在同一场连续戏内，把先出现过的角色向后传播，直到剧本出现明确的
离场描写为止。结果写进 `Shot.present_characters`（L1.5），不碰拆解真值。

## 二、人物位置在相邻镜之间跳变

`jobs._scene_run_ctx` 早就写了「人物的座次、站位、朝向与距离延续上一镜结尾」，
但那是一句**没有事实支撑的空话**：优化器拿到的三样东西里，通用约束句不含
事实、recap 是剧本原文（剧本几乎不写走位）、anchor 是**段首**的提示词
（到第 5 镜早就失真了）。而尾帧图作为众多参考图之一，权重被定妆图稀释，
模型只当风格参考，不当位置约束。

**做法**：让每一镜产出一份"结束时刻各角色在哪"的台账（`Shot.blocking_out`），
下一镜把它当作"开场必须与之一致"的硬事实注入。台账由提示词优化那一次调用
**顺带**产出（见 prompt_opt.service 的输出要求第 4 段），不额外发起任何请求
——既不花钱，也不动任何并发数。

本模块只做纯推导与读写，不调用 LLM、不碰网络，便于单测。
"""

from __future__ import annotations

import json
import logging

logger = logging.getLogger(__name__)

#: 离场描写的判据。命中即认为该角色**从本镜结束时起**不再在场，停止向后传播。
#:
#: 只收"人离开了这个空间"的写法，不收"转身""起身"这类**还在场**的动作 ——
#: 宁可漏判（继续传播，最多多注入一张定妆图）也不可错判（一错就是人凭空消失，
#: 而那正是本模块要修的毛病）。
_EXIT_PATTERNS = (
    "走出", "离开", "离去", "走了", "出门", "夺门", "摔门",
    "转身走", "转身离", "起身离", "拂袖", "退出",
    "下车", "上车走", "驶离", "扬长而去", "头也不回地走",
    "被带走", "被拖走", "送走", "目送",
    "挂断", "挂了电话", "退出房间", "退下",
)

#: 台账里每个角色允许的字段。多余的键一律丢掉 ——
#: LLM 很爱自作主张加 "emotion" / "costume" 之类，那些各有各的真源
#: （情绪在剧本里、服装在定妆图里），混进走位台账只会与它们打架。
_BLOCKING_FIELDS = ("pos", "posture", "facing")


def parse_characters(raw: str | None) -> list[str]:
    """把 `Shot.characters` / `present_characters` 解析成干净的字符串列表。

    解析失败一律当空 —— 这两列历史上都是 LLM 产出后落库的，脏数据必须
    降级为"没有推导"而不是抛异常把出片链路打断。
    """
    try:
        v = json.loads(raw or "[]")
    except (ValueError, TypeError):
        return []
    if not isinstance(v, list):
        return []
    out: list[str] = []
    for c in v:
        if isinstance(c, str) and c.strip() and c.strip() not in out:
            out.append(c.strip())
    return out


def mentions_exit(text: str, name: str) -> bool:
    """`text` 里是否写了 `name` 这个角色离场。

    判据要求**离场词与角色名同句**：整段里出现"走出"就把所有人都判离场的话，
    一个人出门会导致整桌人从下一镜起全部消失 —— 比原来的毛病还严重。

    句子切分用中英文句末标点 + 换行；剧本里的"△"是动作行标记，也当分隔符
    （一行一个动作，跨行的主语通常已经变了）。
    """
    if not text or not name:
        return False
    seps = "。！？；\n\r△!?;"
    cur = ""
    for ch in text:
        if ch in seps:
            if name in cur and any(p in cur for p in _EXIT_PATTERNS):
                return True
            cur = ""
        else:
            cur += ch
    return bool(name in cur and any(p in cur for p in _EXIT_PATTERNS))


class ShotLike:
    """`derive_present_characters` 需要的最小镜头形状（便于单测不依赖 ORM）。

    真实调用传的就是 `db.Shot`；这里只是把用到的字段写出来当文档。
    """

    id: str
    order: int
    location: str | None
    link_to_prev: str | None
    characters: str | None
    script_ref: str | None


def derive_present_characters(
    run: list, *, canon_of=None,
) -> dict[str, list[str]]:
    """对**一整段连续同场戏**推导每镜的在场角色补充集（L1.5）。

    `run` 是按 order 升序、已经确认属于同一连续段的镜头列表
    （判据由调用方给，与 `jobs._scene_run_ctx` 同源：`link_to_prev=="continuous"`
    且归一场景名相同）。`canon_of` 可选，仅用于在本函数内二次校验场景一致性。

    返回 `{shot_id: [补充进来的角色名]}` —— **只含推导出来的部分**，
    不含该镜 `characters` 里本来就有的人。没有补充的镜头不出现在结果里。

    规则：
      1. 段首镜不补（它是这场戏的起点，谁在场以拆解为准）；
      2. 某角色在段内第 k 镜出现过，则第 k+1..n 镜都补上他，
         直到某一镜的 `script_ref` 里出现**与他同句**的离场描写为止
         （含那一镜：那一镜他还在场，是在这一镜里走的，下一镜起才移除）；
      3. 已经在 `characters` 里的不重复补。

    ⚠️ 不做"跨段传播"：换了场景或标了 transition，人物位置本就该重新安排，
    这时补人反而会把上一场的人塞进新场景（比原来的毛病更难查）。
    """
    if len(run) < 2:
        return {}

    out: dict[str, list[str]] = {}
    # 累积"到目前为止仍在场"的人，按首次出现顺序
    carried: list[str] = []
    # 本镜结束后要移除的人（在本镜里离场的）
    for i, sh in enumerate(run):
        own = parse_characters(getattr(sh, "characters", None))
        if i > 0 and carried:
            extra = [c for c in carried if c not in own]
            if extra:
                out[sh.id] = extra
        # 更新累积集：本镜自己列出的人加进来
        for c in own:
            if c not in carried:
                carried.append(c)
        # 本镜里写了离场的人，从下一镜起不再传播
        ref = (getattr(sh, "script_ref", None) or "")
        if ref and carried:
            gone = [c for c in carried if mentions_exit(ref, c)]
            if gone:
                logger.info("镜 #%s 检出离场：%s",
                            getattr(sh, "order", "?"), "、".join(gone))
                carried = [c for c in carried if c not in gone]
    return out


def parse_blocking(raw: str | None) -> dict[str, dict[str, str]]:
    """解析 `Shot.blocking_out`，只保留白名单字段且值必须是非空字符串。

    脏数据一律降级为"没有台账"：宁可退回原来的通用约束，也不能把
    `{"林母": {"pos": null}}` 这种半残的东西拼进提示词——那会让模型
    看到一句「林母：位置 None」，比不写更糟。
    """
    try:
        v = json.loads(raw or "")
    except (ValueError, TypeError):
        return {}
    if not isinstance(v, dict):
        return {}
    out: dict[str, dict[str, str]] = {}
    for name, val in v.items():
        if not isinstance(name, str) or not name.strip():
            continue
        if not isinstance(val, dict):
            continue
        fields = {k: val[k].strip() for k in _BLOCKING_FIELDS
                  if isinstance(val.get(k), str) and val[k].strip()}
        if fields.get("pos"):     # 没有位置就等于没说，丢掉
            out[name.strip()] = fields
    return out


def blocking_text(blocking: dict[str, dict[str, str]]) -> str:
    """把台账渲染成给提示词优化器看的一段中文。空台账返回空串。"""
    if not blocking:
        return ""
    lines = []
    for name, f in blocking.items():
        bits = [f["pos"]]
        if f.get("posture"):
            bits.append(f["posture"])
        if f.get("facing"):
            bits.append(f["facing"])
        lines.append(f"  · {name}：{'，'.join(bits)}")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# 连续段切分：**全工程唯一**的一份
# ---------------------------------------------------------------------------

def continuous_runs(session, project_id: str) -> list[list]:
    """把项目的有效镜头切成若干「同场连续戏」段，按 order 升序返回。

    判据（与 3.9 之前 `jobs._scene_run_ctx` 内联的那份逐字同义，现在只此一份）：
      · 相邻两镜 order 相邻（都取自过滤后的有效镜头序列）
      · 后一镜 `link_to_prev == "continuous"`
      · 两镜的**归一场景名**相同（`scenes.canonical_of`）

    ⚠️ **不按集过滤**（这是 912 项目留下的关键教训）：该项目镜 1-4 属第 1 集、
    镜 5-6 属第 2 集，却同属场景「半岛酒店顶楼餐厅」且镜 5 的 link_to_prev
    就是 continuous。这里的"集"是长剧本的切块，一场戏跨块继续是常态；
    按集拦住等于在最需要连贯的地方断掉。

    单镜成段（长度 1）也会返回 —— 调用方各自决定要不要忽略：
    走位注入需要"上一镜"，在场推导也需要，两者都会跳过长度 1 的段；
    但保留它能让调用方看到完整切分，便于排查。
    """
    from .db import Shot
    from .scenes import canonical_of

    rows = (session.query(Shot)
            .filter(Shot.project_id == project_id,
                    Shot.disabled == 0, Shot.is_special == 0)
            .order_by(Shot.order).all())
    if not rows:
        return []
    canons = {r.id: canonical_of(session, r.project_id, r.location) for r in rows}

    runs: list[list] = [[rows[0]]]
    for prev, cur in zip(rows, rows[1:]):
        same = bool(canons.get(cur.id)) and canons.get(cur.id) == canons.get(prev.id)
        if (cur.link_to_prev or "") == "continuous" and same:
            runs[-1].append(cur)
        else:
            runs.append([cur])
    return runs


def refresh_present_characters(session, project_id: str) -> int:
    """重算整个项目的在场推导（L1.5），写回 `Shot.present_characters`。

    返回被改动的镜头数。**幂等**：同样的输入重复跑结果一致，可以在拆解后、
    人工修正拆解后、以及出片前反复调用。

    调用方负责 commit —— 拆解那边整段都在 `_BREAKDOWN_DB_LOCK` 里一次性提交，
    这里再自己 commit 会把那个事务切开。
    """
    changed = 0
    for run in continuous_runs(session, project_id):
        derived = derive_present_characters(run)
        for sh in run:
            want = derived.get(sh.id, [])
            new = json.dumps(want, ensure_ascii=False) if want else None
            if (sh.present_characters or None) != new:
                sh.present_characters = new
                changed += 1
    if changed:
        logger.info("项目 %s 在场推导更新了 %d 个镜头", project_id, changed)
    return changed
