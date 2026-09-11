"""audit_probe.py — 2026-09-11 复审的基线探针 + 回归断言

两个用途，一份代码：

1. **基线快照**：打印 `docs/AUDIT-2026-09-11-全面复审.md`「实测基线」那一节的数字，
   修完任何一条后拿同样口径复测。
2. **回归断言**：S1（引用集漏检）的守卫。它钉住的是一类**不报错的数据丢失** ——
   引用集漏一列，"清理缓存"就把在用文件删掉，而用户只会在几天后发现
   出片质量变差或某张图 404，根本联系不到自己点过清理。

## S1 的历史（为什么这个脚本必须存在）

`media._referenced_filenames` 曾自己维护一份列清单，漏掉四处：

    SceneView.image_url     180 张里 157 张漏出引用集（7 张已进当前删除清单）
    Shot.tail_frame_url     277 / 277 全漏
    Asset.board_url         1 / 1 全漏
    Job.result（生图候选）   91 个 URL 全漏 —— 资产弹窗还能翻回来接着挑的候选图

这些文件正好是 `img_*.png`，在 `_GENERATED_PREFIXES` 白名单内 —— 也就是
**清理缓存一点就真删**。150 张只是被 24h 年龄窗暂时挡着，不是安全。

修法不是补三行列名（半年后必复发），而是把清单提成
`app/media_refs.py` 的 `URL_COLUMNS`，让清孤儿 / 删素材守卫 / 彻底删项目
三处全部从它派生。本脚本的 §1 就是验证"派生"真的生效：

    对 URL_COLUMNS 里每一列，逐列断言"该列的每个非空 URL 都在引用集内"。

这样写的好处是**加新列时不用改本脚本**：新列一进 URL_COLUMNS 就自动被检查。

运行：/usr/bin/python3 scripts/audit_probe.py   （cwd = backend/）
      仓内 backend/.venv 是陈旧的、没装 fastapi，必须用 /usr/bin/python3。
"""

import os
import sys
import time
from collections import Counter

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app import media, media_refs  # noqa: E402
from app.db import (  # noqa: E402
    Project, Shot, get_session,
)

_pass = 0
_fail = 0


def ok(cond, msg):
    global _pass, _fail
    if cond:
        _pass += 1
        print(f"  ✅ {msg}")
    else:
        _fail += 1
        print(f"  ❌ {msg}")


def mb(n: int) -> str:
    return f"{n / 1024 / 1024:.1f} MB"


session = get_session()

# ──────────────────────────────────────────────────────────────
print("\n【0】库规模")
# ──────────────────────────────────────────────────────────────
n_proj = session.query(Project).count()
n_shot = session.query(Shot).count()
n_cont = session.query(Shot).filter(Shot.link_to_prev == "continuous").count()
n_tail = session.query(Shot).filter(
    Shot.tail_frame_url.isnot(None), Shot.tail_frame_url != "").count()
print(f"  总项目 {n_proj}   总镜头 {n_shot}   continuous 镜 {n_cont}   已存尾帧 {n_tail}")

# ──────────────────────────────────────────────────────────────
print("\n【1】引用集覆盖度（S1 回归断言）")
print("     逐列检查 media_refs.URL_COLUMNS 的每个非空 URL 是否都进了引用集。")
print("     加新列时本节自动覆盖它，不需要改本脚本。")
# ──────────────────────────────────────────────────────────────
refs = media_refs.referenced_filenames(session)
print(f"  引用集共 {len(refs)} 个文件名\n")

for spec in media_refs.URL_COLUMNS:
    if spec.expand is not None:
        q = session.query(spec.model).filter(spec.column.isnot(None))
        if spec.row_filter is not None:
            q = q.filter(spec.row_filter)
        vals = [u for r in q.all()
                for u in spec.expand(getattr(r, spec.column.key))]
    else:
        q = (session.query(spec.column)
             .filter(spec.column.isnot(None), spec.column != ""))
        if spec.row_filter is not None:
            q = q.filter(spec.row_filter)
        vals = [v for (v,) in q.all()]
    if not vals:
        print(f"  ·  {spec.table}.{spec.column.key} → 0 条，跳过")
        continue
    missing = [v for v in vals if v.rsplit("/", 1)[-1].split("?")[0] not in refs]
    ok(not missing,
       f"{spec.table}.{spec.column.key}：漏检 {len(missing)}/{len(vals)}"
       + (f"（例：{missing[0][-40:]}）" if missing else ""))

# ──────────────────────────────────────────────────────────────
print("\n【2】三处清单的一致性（S1 的承重部分）")
print("     清孤儿 / 删素材守卫 / 彻底删项目必须看同一份列清单。")
# ──────────────────────────────────────────────────────────────
ok(media._referenced_filenames(session) == media_refs.referenced_filenames(session),
   "media._referenced_filenames 与 media_refs 同源")

from app import project_purge  # noqa: E402
purge_all = {u for _p, u in project_purge._iter_urls(session, None) if u}
refs_all = {u for _p, u in media_refs.iter_urls(session, None) if u}
ok(purge_all == refs_all,
   f"project_purge._iter_urls 与 media_refs 同源（各 {len(purge_all)} / {len(refs_all)} 个 URL）")

# 硬编码兜底：万一有人把列清单又拆回去，这几条会先炸
for table, col in (("scene_views", "image_url"), ("shots", "tail_frame_url"),
                   ("assets", "board_url"), ("jobs", "result")):
    ok(any(s.table == table and s.column.key == col for s in media_refs.URL_COLUMNS),
       f"{table}.{col} 在 URL_COLUMNS 里（这四列是 2026-09-11 补的，别再漏）")

# ──────────────────────────────────────────────────────────────
print("\n【3】孤儿清理清单")
# ──────────────────────────────────────────────────────────────
t0 = time.time()
files, nbytes = media._scan_generated_orphans(0)
dt = (time.time() - t0) * 1000
pref = Counter(f.name.split("_", 1)[0] for f in files)
print(f"  清单 {len(files)} 个 / {mb(nbytes)}   （扫描 {dt:.0f} ms）")
print("  前缀分布 " + " / ".join(f"{k} {v}" for k, v in pref.most_common()))

# 清单里绝不允许出现任何仍被引用的文件。这是"清理缓存"安全性的**唯一**判据。
still_ref = [f.name for f in files if f.name in refs]
ok(not still_ref,
   f"清单里在用文件 {len(still_ref)} 个"
   + (f"（例：{still_ref[:3]}）" if still_ref else ""))

# 单独点名 SceneView：这是 S1 当初真实命中的那一类
sv_urls = {v.rsplit("/", 1)[-1].split("?")[0]
           for (v,) in session.query(media_refs.SceneView.image_url)
           .filter(media_refs.SceneView.image_url.isnot(None),
                   media_refs.SceneView.image_url != "").all()}
sv_hit = [f.name for f in files if f.name in sv_urls]
ok(not sv_hit, f"清单里 SceneView 在用图 {len(sv_hit)} 张（修复前是 7 张）")

# 单独点名生图候选：这些只存在 Job.result 里，资产弹窗还能翻回来接着挑，
# 而且每张都是花过钱的产出。删掉 = 一排 404 破图。
cand_urls = {u.rsplit("/", 1)[-1].split("?")[0]
             for r in session.query(media_refs.Job)
             .filter(media_refs.Job.kind == "asset_candidates",
                     media_refs.Job.result.isnot(None)).all()
             for u in media_refs._candidate_urls(r.result)}
cand_hit = [f.name for f in files if f.name in cand_urls]
ok(not cand_hit,
   f"清单里生图候选图 {len(cand_hit)} 张（共 {len(cand_urls)} 张候选）")

# 反向：曾经永远回收不掉的四个前缀，现在应当能进清单
prefix_now = {p for p in ("tail_", "shotaudio_", "board_", "ref_")
              if p in media._GENERATED_PREFIXES}
ok(prefix_now == {"tail_", "shotaudio_", "board_", "ref_"},
   f"tail_/shotaudio_/board_/ref_ 已纳入回收白名单（当前 {sorted(prefix_now)}）")

# ──────────────────────────────────────────────────────────────
print("\n【4】连续段判据分歧（B2）")
# ──────────────────────────────────────────────────────────────
from app import scenes  # noqa: E402

same_raw = diff_raw_same_canon = 0
for (pid,) in session.query(Project.id).all():
    shots = (session.query(Shot).filter(Shot.project_id == pid)
             .order_by(Shot.order).all())
    canon = scenes.canonical_map(session, pid, shots)
    for a, b in zip(shots, shots[1:]):
        if b.link_to_prev != "continuous":
            continue
        la, lb = (a.location or ""), (b.location or "")
        if la == lb:
            same_raw += 1
        else:
            if canon.get(la, la) == canon.get(lb, lb):
                diff_raw_same_canon += 1
print(f"  相邻 continuous 对：原名相同 {same_raw} / 原名不同但归一后相同 {diff_raw_same_canon}")
print("  （B2 的第二份判据来自尾帧接力，已于 2026-09-11 随 N1 一并删除；"
      "现在全工程只剩 continuity.continuous_runs 一份，本行只作场景归一覆盖度参考）")

# ──────────────────────────────────────────────────────────────
print("\n【5】尾帧注入影响面（N1，已停用）")
# ──────────────────────────────────────────────────────────────
# 注入路径已删除，这里只报存量数据的规模（供决定要不要跑 purge_tail_frames.py）。
# 「注入路径确实关掉了」由 scripts/verify_tail_relay_off.py 断言，不在本脚本重复。
legacy = (session.query(Shot)
          .filter(Shot.tail_frame_url.isnot(None), Shot.tail_frame_url != "").count())
print(f"  存量历史尾帧行：{legacy}（不再新增；清空并回收用 scripts/purge_tail_frames.py）")

# ──────────────────────────────────────────────────────────────
print(f"\n审计探针：{_pass} ✅ / {_fail} ❌")
if _fail:
    print("\n❌ 引用集有漏检 —— 在修好之前**不要让用户点「清理缓存」**，"
          "那会真实删除仍在使用的媒体文件。")
    sys.exit(1)
print("\n✅ 引用集完整：URL_COLUMNS 每一列的每个 URL 都进了引用集；"
      "清孤儿/删素材守卫/彻底删项目三处同源；孤儿清单里没有任何仍被引用的文件。")
