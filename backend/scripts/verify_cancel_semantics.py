"""verify_cancel_semantics.py — 「用户取消」不得表现为「生成失败」

## 背景（2026-09-01 生产报障）

用户点了「停止生产」，界面随后弹出红色 **生成失败** 卡片，正文是一整屏
`[{"name":"场景-AEGIS公司","error":"生成失败:已取消"},{...}]`（实测生产库里
那一条 `Job.error` 长 12,196 字节）。三个独立缺陷叠出来的：

1. `run_asset_batch` 把"全部条目都被取消"判成 `failed`；
2. 父流水线在**已被取消之后**照样新建并跑一遍子 job，于是凭空多出一条失败记录；
3. `Job.error` 里塞的是逐条目 JSON 全量。前端 `TasksDrawer` 是
   `{j.error}` 原样渲染、`useProdJobs` 只 `slice(0,120)` —— 谁都没在解析它，
   用户看到的就是被截断的半截 JSON。

顺带修掉一个由 3 引出的定时炸弹：`run_first_frame_pipeline` 收尾处
`json.loads(vj.error)` —— error 一旦不是 JSON 就在"全部跑完正要标记成功"
那一步抛 JSONDecodeError。

跑法（只读，不建任务、不发上游请求）：

    python3 scripts/verify_cancel_semantics.py
"""
import inspect
import re
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))

failed = 0


def ok(cond, label, detail=""):
    global failed
    if cond:
        print(f"  ✓ {label}" + (f"  ({detail})" if detail else ""))
    else:
        failed += 1
        print(f"  ✗ {label}" + (f"  ({detail})" if detail else ""))


from app import jobs  # noqa: E402

print("① Job.error 不再灌逐条目 JSON 全量")
src = (BACKEND / "app" / "jobs.py").read_text(encoding="utf-8")
# 只允许结构化契约那两处（asset_candidates 的 {"reason","message"}，
# routes_v2.latest_asset_candidates 确实在 json.loads 它）。
bad = [m for m in re.findall(r"error=json\.dumps\([^)]*", src)
       if "reason" not in m]
ok(not bad, "无 error=json.dumps(failed) 式的全量转储", "; ".join(bad) or "clean")
ok(not [ln for ln in src.splitlines()
        if "json.loads(vj.error)" in ln and not ln.lstrip().startswith("#")],
   "收尾不再 json.loads 子 job 的 error（否则成功那一刻抛 JSONDecodeError）")

print("② _brief_errors：短、带条目标签、能认出各 runner 的形状")
b = jobs._brief_errors
ok(b([]) == "", "空列表返回空串")
long = [{"name": f"场景-{i}", "error": "生成失败：" + "x" * 400} for i in range(40)]
out = b(long)
ok(len(out) <= jobs._ERR_TEXT_CAP, f"长度封顶 {jobs._ERR_TEXT_CAP}", f"实际 {len(out)}")
ok(out.startswith("40 项失败："), "开头给总数", out[:20])
ok("另有" in out, "超出上限的部分折叠成一句")
ok("第 7 镜" in b([{"order": 7, "error": "参考素材不可用"}]), "镜头条目用「第 N 镜」")
ok("第 3 集" in b([{"episode": 3, "error": "拆解失败"}]), "拆解条目用「第 N 集」")

print("③ 取消判定：按状态位，不按条目文案")
# run_shot_videos / run_first_frames 的取消检查点是裸 return（不记条目），
# 只能查状态位；run_asset_batch 会逐条记 _CANCELLED_MSG，两种都要覆盖。
for fn in (jobs.run_shot_videos, jobs.run_first_frames):
    s = inspect.getsource(fn)
    ok('status="cancelled"' in s, f"{fn.__name__} 有 cancelled 收尾分支")
    ok(re.search(r"if is_cancelled\(jid\)[^\n]*parent_jid[^\n]*\n\s*skipped", s)
       is not None,
       f"{fn.__name__} 的收尾判定查状态位（含 parent_jid）")
s = inspect.getsource(jobs.run_asset_batch)
ok('status="cancelled"' in s, "run_asset_batch 有 cancelled 收尾分支")
ok("_CANCELLED_MSG" in s, "run_asset_batch 按统一常量匹配取消文案")
ok(jobs._CANCELLED_MSG == "已取消", "_CANCELLED_MSG 单点定义", jobs._CANCELLED_MSG)

print("④ 已取消之后不再新建子 job")
for fn in (jobs.run_one_click_film, jobs.run_first_frame_pipeline):
    s = inspect.getsource(fn)
    # 每个 create_job("asset_batch"...) 之前 40 行内必须有一次取消检查
    for m in re.finditer(r'create_job\("asset_batch"', s):
        before = s[:m.start()].splitlines()[-40:]
        ok(any("is_cancelled" in ln or "_abort_if_cancelled" in ln for ln in before),
           f"{fn.__name__}：建 asset_batch 前有取消检查")
    ok('status == "cancelled"' in s,
       f"{fn.__name__}：子 job 被取消时按取消处理（不报失败）")

print()
print("全部通过 ✅" if not failed else f"{failed} 项失败 ❌")
sys.exit(1 if failed else 0)
