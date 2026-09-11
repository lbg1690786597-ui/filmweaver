"""P2-5 SSE 事件总线（修 G3 实时性 / F2 密集轮询）。

进程内线程安全环形缓冲：发布方（jobs 执行链，可能在线程池里跑的同步函数）
append 即返回，订阅方（SSE 端点的 async 生成器）按 seq 游标增量取——
不用 asyncio.Queue 是因为发布方不总在事件循环线程上，跨线程投递反而复杂。
MVP 单进程（uvicorn 单 worker）内存即可；多进程时换 redis pub/sub，接口不变。

## 缓冲**按项目分桶**，且溢出可感知（B20）

原来是一条全局 `deque(maxlen=1000)`，两个缺陷叠加：

1. **跨项目互挤**：所有项目共享 1000 个槽。一个 1400 镜的项目在出片时，
   每镜的 shot/job 事件轮番刷，几秒就把 1000 槽填满 —— 另一个项目的
   订阅者明明很空闲，它的事件却被挤掉了。项目越多越严重。
2. **溢出静默**：`poll` 无论如何都把游标推到**全局最新 seq**，于是被挤掉的
   那段事件对订阅者完全不可见：既没报错也没标记，前端只是"某些状态没更新"，
   要等 15s 兜底轮询才慢慢对上，看起来像卡顿或掉状态，无从排查。

现在：每个项目一个独立环形桶（互不影响），并记录该项目**被挤掉的最大 seq**；
订阅者游标落在被挤掉的区间里时，poll 报 `dropped=True`，SSE 端点据此下发一条
`resync` 事件让前端做一次全量刷新 —— 丢事件从"静默失真"变成"明确重同步"。
"""
from __future__ import annotations

import json
import logging
import threading
from collections import OrderedDict, deque

logger = logging.getLogger(__name__)

#: 单项目环形容量。SSE 每 0.5s 取一次，500 条足够覆盖任何一次取件间隔；
#: 真被打满也不再影响别的项目，且会被 dropped 标记出来。
BUF_PER_PROJECT = 500

#: 最多同时跟踪多少个项目的缓冲（LRU 淘汰最久未发布的那个）。
#: 防止长驻进程里项目反复新建/删除导致 dict 无界增长。
#: 内存上界 ≈ MAX_PROJECTS × BUF_PER_PROJECT 条事件。
MAX_PROJECTS = 64

_lock = threading.Lock()
_seq = 0                      # 全局单调游标（跨项目共用，保证 seq 全局可比）

#: project_id -> deque[(seq, event, data_json)]；OrderedDict 充当 LRU
_BUFS: "OrderedDict[str, deque[tuple[int, str, str]]]" = OrderedDict()
#: project_id -> 该项目**已被挤出缓冲**的最大 seq（0 = 从未溢出）
_EVICTED: dict[str, int] = {}


def publish(project_id: str | None, event: str, data: dict) -> None:
    """发布一条项目事件；project_id 缺失（如无归属的 compose）静默跳过。"""
    if not project_id:
        return
    global _seq
    with _lock:
        _seq += 1
        buf = _BUFS.get(project_id)
        if buf is None:
            buf = deque(maxlen=BUF_PER_PROJECT)
            _BUFS[project_id] = buf
            # 超出跟踪上限：淘汰最久未发布的项目（连同它的溢出水位）。
            # 该项目若仍有订阅者，下次 poll 会因缓冲为空而正常返回空列表；
            # 状态由 15s 兜底轮询与快照接口兜住，不会错到无法收敛。
            while len(_BUFS) > MAX_PROJECTS:
                old_pid, _ = _BUFS.popitem(last=False)
                _EVICTED.pop(old_pid, None)
        _BUFS.move_to_end(project_id)          # 标记为最近活跃
        # deque 满时 append 会静默丢弃最左端 —— 丢之前把它的 seq 记成溢出水位，
        # 这是 poll 能判断"订阅者错过了事件"的唯一依据。
        if len(buf) == buf.maxlen:
            evicted_seq = buf[0][0]
            prev = _EVICTED.get(project_id, 0)
            if evicted_seq > prev:
                _EVICTED[project_id] = evicted_seq
                if prev == 0:
                    logger.warning(
                        "[events] 项目 %s 事件缓冲溢出（容量 %d），订阅者将收到 resync",
                        project_id, buf.maxlen)
        buf.append((_seq, event, json.dumps(data, ensure_ascii=False)))


def tail_seq() -> int:
    """当前最新 seq（SSE 连接时作为初始游标：历史由快照承载，只推增量）。"""
    with _lock:
        return _seq


def poll(project_id: str, after_seq: int) -> tuple[int, list[tuple[int, str, str]], bool]:
    """取本项目 seq > after_seq 的事件。

    返回 `(新游标, [(seq, event, data_json)], dropped)`：
      · 新游标取全局最新 seq，保证无匹配事件时游标也前进（不重复扫描）
      · dropped=True 表示 after_seq 之后确实有本项目事件被挤出了缓冲，
        调用方应让客户端做一次全量重同步，而不是假装什么都没丢
    """
    with _lock:
        last = _seq
        buf = _BUFS.get(project_id)
        out = [(s, ev, d) for (s, ev, d) in buf if s > after_seq] if buf else []
        # 订阅者游标停在溢出水位之前 → (after_seq, evicted] 这段本项目事件已丢失
        dropped = after_seq < _EVICTED.get(project_id, 0)
    return last, out, dropped


def stats() -> dict:
    """诊断用：当前缓冲占用与溢出情况（不含事件内容）。"""
    with _lock:
        return {
            "projects": len(_BUFS),
            "seq": _seq,
            "buffered": {pid: len(b) for pid, b in _BUFS.items()},
            "overflowed": dict(_EVICTED),
        }
