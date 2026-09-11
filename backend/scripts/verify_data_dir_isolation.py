"""verify_data_dir_isolation.py — dev / prod 数据目录隔离的进程内验收

## 为什么要有这个脚本

2026-08-28 拆 prod 时把数据根目录做成了可配置项（`FW_DATA_DIR`），
但只改了 `media.py` / `main.py` 两处，`providers/image.py` 与
`providers/video.py` 各自留着一份**硬编码**的
`Path("/root/filmweaver-data/generated")`。后果在生产上是这样连锁的：

1. 生产用户生成的每一张图 / 每一条视频都写进了 **dev** 的数据目录；
2. 但落库的 `/fw/media/generated/xxx.png` 由 prod 进程的 StaticFiles
   与 `media._resolve_local` 按 **prod** 的 data_dir 解析 → 文件不存在；
3. 于是前端图全 404，出片时 RunningHub 上传参考图那一步抛
   `RuntimeError: 参考素材不可用: /fw/media/generated/img_xxx.png`，
   整批镜头失败。

这类 bug 靠读代码很难发现（两个字面量分散在 providers 里，且 dev 环境下
两个路径恰好相等，本地怎么测都是对的）。所以固化成断言：

    python3 scripts/verify_data_dir_isolation.py

只读、不写任何文件、不发任何上游请求。
"""
import os
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


print("① 源码里不得再有硬编码的数据目录字面量")
# 注释里提到路径是允许的（本次修复正是靠注释解释原委），只禁可执行的字面量：
# 形如 Path("/root/filmweaver-data...") 或 "/root/filmweaver-prod-data..." 赋值。
_BAD = re.compile(r'^[^#]*Path\(\s*["\']/root/filmweaver-(prod-)?data')
hits = []
for f in (BACKEND / "app").rglob("*.py"):
    for i, line in enumerate(f.read_text(encoding="utf-8").splitlines(), 1):
        if _BAD.search(line):
            hits.append(f"{f.relative_to(BACKEND)}:{i}")
ok(not hits, "app/ 下无 Path('/root/filmweaver-*data') 硬编码", ", ".join(hits) or "clean")

print("② 各落盘点用的是同一个 GENERATED_DIR 对象")
from app import media                      # noqa: E402
from app.providers import image as p_image  # noqa: E402
from app.providers import video as p_video  # noqa: E402
from app.providers import video_seedance as p_seed  # noqa: E402
from app.providers import video_runninghub as p_rh  # noqa: E402

for name, mod in (("providers.image", p_image), ("providers.video", p_video),
                  ("providers.video_seedance", p_seed),
                  ("providers.video_runninghub", p_rh)):
    got = getattr(mod, "GENERATED_DIR", None)
    ok(got is media.GENERATED_DIR, f"{name}.GENERATED_DIR is media.GENERATED_DIR",
       str(got))

print("③ GENERATED_DIR 随 settings.data_dir 走")
from app.config import get_settings  # noqa: E402
s = get_settings()
ok(media.DATA_DIR == Path(s.data_dir), "media.DATA_DIR == settings.data_dir",
   str(media.DATA_DIR))
ok(media.GENERATED_DIR == Path(s.data_dir) / "generated",
   "GENERATED_DIR 在 data_dir 之下", str(media.GENERATED_DIR))

print("④ prod 配置下解析出的目录必须是 prod 的（模拟 FW_DATA_DIR）")
# 只在**子进程**里改环境变量：get_settings 有 lru_cache，本进程改了会污染后续断言。
import subprocess  # noqa: E402
probe = (
    "import sys;sys.path.insert(0,%r)\n"
    "from app import media\n"
    "from app.providers import image as i, video as v\n"
    "print(media.GENERATED_DIR);print(i.GENERATED_DIR);print(v.GENERATED_DIR)\n"
    % str(BACKEND)
)
env = {**os.environ, "FW_DATA_DIR": "/root/filmweaver-prod-data"}
r = subprocess.run([sys.executable, "-c", probe], capture_output=True, text=True,
                   env=env, cwd=str(BACKEND))
lines = [x for x in r.stdout.strip().splitlines() if x.startswith("/")]
ok(len(lines) == 3 and all(x == "/root/filmweaver-prod-data/generated" for x in lines),
   "FW_DATA_DIR=prod 时三处都指向 prod 目录",
   " | ".join(lines) or r.stderr.strip()[-200:])

print()
print("全部通过 ✅" if not failed else f"{failed} 项失败 ❌")
sys.exit(1 if failed else 0)
