#!/usr/bin/env python3
"""verify_tail_relay_off.py — N1：尾帧接力确实被拔掉了，且只拔掉了它

## 为什么这个脚本必须存在

停用一个功能有两种失败方式，**两种都不会报错**：

  · **没拔干净** —— 注入分支删了，但抽帧还在跑（每出一镜白落一个 100–300 KB 文件），
    或者接口还在下发 `prev_tail_ref`（界面照旧显示一条"承接 #N"的参考图，
    而它实际根本不会被注入 —— 这比没有更糟，那是**界面在说谎**）。
  · **拔过头** —— 把**手动**首尾帧模式（`fl2va` / `l2va`，用户自己在镜头高级设置里
    传的 `last_frame_url`）也一起当成"尾帧"删了。两者只是名字像，是完全不同的两条路。

所以这里既断言"该没的都没了"，也断言"不该动的一个没动"。

本条**唯一算数的终极证据**是"重新生成之前必被拦的镜头，过审率从 0/8 回到 9/9"，
那要真出片、要花钱、要用户点名 —— 没跑。这里退而求其次：证明注入路径在进程内
已经不存在，且参考位全额还给了定妆图。

全程不调任何模型、不发任何外部请求。建的测试项目用完即删。

    cd backend && /usr/bin/python3 scripts/verify_tail_relay_off.py
"""
from __future__ import annotations

import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import jobs, media, media_refs, routes_v2  # noqa: E402
from app.db import Project, Shot, get_session  # noqa: E402

PASS = FAIL = 0


def ok(cond: bool, name: str, extra: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"   ✅ {name}")
    else:
        FAIL += 1
        print(f"   ❌ {name}" + (f"  — {extra}" if extra else ""))


ROOT = Path(__file__).resolve().parents[2]

print("\n[1] 注入路径在进程内已不存在")
for mod, sym in ((jobs, "_prev_tail_frame"), (jobs, "_trusted_tail_ref"),
                 (jobs, "_TAIL_ASSET_CACHE"), (media, "make_tail_frame"),
                 (routes_v2, "_prev_tail_ref_view")):
    ok(not hasattr(mod, sym), f"{mod.__name__}.{sym} 已删除",
       "还在 —— 死代码会被下一个人当成'现役功能'读")

print("\n[2] 参考位全额还给定妆图")
jobs_src = Path(ROOT, "backend/app/jobs.py").read_text(encoding="utf8")
ok("_auto_inject_refs_detailed(sid, inject_cap)" in jobs_src,
   "★ 注入用的是 inject_cap 本身（不再 -1 让位给尾帧）",
   "还在按 asset_cap 注入 = 定妆图仍被挤掉一张")
ok("asset_cap" not in jobs_src, "asset_cap 这个变量已经不存在")
# 顺带：提示词对齐那条预览路径一直用的是完整 cap（从不 -1），
# 也就是说停用之前"预览注入几张"与"出片实际注入几张"本就不一致。现在真的一致了。
ok(jobs_src.count("_auto_inject_refs_detailed(sid, ") >= 2,
   "预览路径与出片路径都按完整 cap 注入（口径终于一致）")
ok("make_tail_frame" not in jobs_src, "★ 出片后不再抽尾帧（没有任何人读它，抽了就是纯浪费）")
ok("tail_ref_dropped" not in jobs_src, "版本 meta 不再写 tail_ref_dropped")
ok("shot.tail_frame_url =" not in jobs_src, "★ 不再写入 Shot.tail_frame_url")

print("\n[3] 手动首尾帧模式（fl2va / l2va）原样保留 —— 这是另一个功能")
ok('override.get("last_frame_url")' in jobs_src,
   "★ 仍从 override 读用户手传的 last_frame_url",
   "被误删了：那是用户在镜头高级设置里自己传的图，与自动接力无关")
ok('shot_gen_mode in ("fl2va", "l2va")' in jobs_src, "fl2va / l2va 的模式分支仍在")

print("\n[4] 接口不再下发已死的字段")
pid = f"vt{uuid.uuid4().hex[:10]}"
try:
    with get_session() as s:
        s.add(Project(id=pid, title="_尾帧停用验证"))
        for i in (1, 2):
            s.add(Shot(id=f"{pid}-s{i}", project_id=pid, order=i, episode=1,
                       script_ref=f"L{i}",
                       location="日 内 客厅", link_to_prev="continuous",
                       # 故意给上一镜塞一条历史尾帧：就算库里有值也不该再冒出来
                       tail_frame_url=("/fw/media/generated/tail_deadbeef01.jpg"
                                       if i == 1 else None)))
        s.commit()

    detail = routes_v2.project_detail(pid)
    shots = detail.get("shots") or []
    ok(len(shots) == 2, f"detail 正常返回（{len(shots)} 镜）")
    keys = set().union(*[set(x.keys()) for x in shots]) if shots else set()
    ok("prev_tail_ref" not in keys,
       "★ detail 不再下发 prev_tail_ref（否则界面会显示一条实际不会注入的参考图）")
    ok("tail_frame_url" not in keys,
       "★ detail 不再下发 tail_frame_url（存量 277 条已无任何消费者）")
finally:
    with get_session() as s:
        s.query(Shot).filter(Shot.project_id == pid).delete()
        obj = s.get(Project, pid)
        if obj:
            s.delete(obj)
        s.commit()

print("\n[5] 存量数据仍受保护（停用 ≠ 顺手删数据）")
cols = {c.kind for c in media_refs.URL_COLUMNS}
ok("shot_tail_frame" in cols,
   "★ Shot.tail_frame_url 仍登记为引用列 —— 摘掉它，277 个文件立刻变孤儿，"
   "用户点一次「清理缓存」就是静默数据删除")
ok(Path(ROOT, "backend/scripts/purge_tail_frames.py").exists(),
   "要腾空间时有据可依的出口存在（默认只报数，--yes 才执行）")

print("\n[6] 连续段判据收回一处（B2 随本条消失）")
cont_src = Path(ROOT, "backend/app/continuity.py").read_text(encoding="utf8")
ok("def continuous_runs" in cont_src, "continuity.continuous_runs 仍是那一份")
ok("_prev_tail_frame" not in jobs_src and "_prev_tail_frame" not in cont_src,
   "★ 第二份判据（按 location 原名比对、不排除 is_special）已随尾帧接力一并消失")

print("\n[7] 决策留痕（防止下一个人再发明一遍）")
doc = Path(ROOT, "docs/DECISION-2026-09-11-尾帧接力停用.md")
ok(doc.exists(), "决策文档存在")
text = doc.read_text(encoding="utf8") if doc.exists() else ""
ok("8/8" in text and "9/9" in text, "★ 实测结论（8/8 被拦 vs 9/9 通过）留在文档里")
for f in ("backend/app/db.py", "backend/app/media_refs.py",
          "backend/app/migrations.py", "backend/app/media.py"):
    ok("DECISION-2026-09-11-尾帧接力停用" in Path(ROOT, f).read_text(encoding="utf8"),
       f"{f} 的残留处指回决策文档")

print("\n[8] 前端也干净（残留的 UI 会让用户以为功能还在）")
# 前端这几条本该放 desktop/scripts/verify-*.ts，但它们全是"某个字符串不存在"的
# 静态断言，且与上面后端那几条是同一件事的两半 —— 拆成两个文件反而会各自漂移。
fe = [q for q in Path(ROOT, "desktop/src").rglob("*.ts*")]
hits = {str(q.relative_to(ROOT)): t for q in fe
        for t in ("prev_tail_ref", "tail_frame_url")
        if t in q.read_text(encoding="utf8")}
ok(not hits, "★ desktop/src 里没有任何 prev_tail_ref / tail_frame_url 残留",
   f"{hits}")
insp = Path(ROOT, "desktop/src/features/inspector/Inspector.tsx").read_text(encoding="utf8")
ok("承接 #" not in insp, "「🔗 承接 #N」chip 已移除")
ok("fw-insp-chip.tail" not in
   Path(ROOT, "desktop/src/features/inspector/Inspector.css").read_text(encoding="utf8"),
   "对应的 CSS 规则也清了（留着会在 verify-css-coverage 里当未使用样式报出来）")
bench = Path(ROOT, "desktop/scripts/bench/shotsBenchEntry.tsx").read_text(encoding="utf8")
ok("prev_tail_ref" not in bench, "性能基准的假数据同步删了字段（否则 tsc 会红）")

print(f"\n{PASS} ✅ / {FAIL} ❌")
print("✅ 注入路径已彻底关闭，参考位全额归还定妆图，手动首尾帧模式未受影响，"
      "存量数据仍受引用保护。" if FAIL == 0
      else "❌ 有断言不过 —— 停用没做干净比不停更糟（界面或代码会继续误导）。")
sys.exit(0 if FAIL == 0 else 1)
