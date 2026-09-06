#!/usr/bin/env bash
# 取回内置字幕字体（思源黑体 / 思源宋体，SIL OFL 1.1）。
#
# 字体二进制不进 git（46MB，见 src-tauri/resources/fonts/README.md），
# 所以新 clone 后、出正式安装包前需要跑一次。
#
# 优先从本机 fonts-noto-cjk 包里拷（Linux 开发机通常已装）；
# 没有就从 Google 的官方仓库下载。
set -euo pipefail

DEST="$(cd "$(dirname "$0")/.." && pwd)/src-tauri/resources/fonts"
mkdir -p "$DEST"

SYS="/usr/share/fonts/opentype/noto"
BASE="https://raw.githubusercontent.com/notofonts/noto-cjk/main"

fetch() {           # $1=文件名  $2=远端相对路径
  local f="$1" rel="$2"
  if [ -s "$DEST/$f" ]; then echo "✓ 已存在 $f"; return; fi
  if [ -f "$SYS/$f" ]; then
    cp "$SYS/$f" "$DEST/$f"; echo "✓ 从本机字体拷贝 $f"; return
  fi
  echo "↓ 下载 $f …"
  curl -fL --retry 3 -o "$DEST/$f" "$BASE/$rel"
}

fetch NotoSansCJK-Regular.ttc  "Sans/OTC/NotoSansCJK-Regular.ttc"
fetch NotoSerifCJK-Regular.ttc "Serif/OTC/NotoSerifCJK-Regular.ttc"

if [ ! -s "$DEST/LICENSE-Noto-CJK.txt" ]; then
  if [ -f /usr/share/doc/fonts-noto-cjk/copyright ]; then
    cp /usr/share/doc/fonts-noto-cjk/copyright "$DEST/LICENSE-Noto-CJK.txt"
  else
    # 仓库根没有 LICENSE（实测 404），OFL 正文在各字型子目录下。
    # 这条分支平时不会走（该文件是入 git 的），但 set -e 下走错就是整条 CI 红。
    curl -fL --retry 3 -o "$DEST/LICENSE-Noto-CJK.txt" "$BASE/Sans/LICENSE"
  fi
fi

# ---- 硬断言：宁可不出包，也不出一个"内置字体"是空壳的包 ----
#
# 这个脚本以前在 CI 和 package.json 里**零引用**，于是安装包里
# resources/fonts/ 只有 README + LICENSE。而运行时 resolveResource 只拼路径、
# 不校验存在，libass 找不到 Noto 就静默换字形：用户选了「思源黑体（内置）」，
# 导出成功，字幕却是别的字体，全程没有一条提示。
# 所以取回之后必须当场断言，而不是等用户来发现。
# 下限 1MB：真实体积 19MB / 26MB，够宽松，又能挡住"下了半截"和占位空文件。
MIN_BYTES=1000000
bad=0
for f in NotoSansCJK-Regular.ttc NotoSerifCJK-Regular.ttc; do
  sz=$(wc -c < "$DEST/$f" 2>/dev/null || echo 0)
  if [ "$sz" -lt "$MIN_BYTES" ]; then
    echo "❌ $f 缺失或残缺（$sz 字节 < $MIN_BYTES）" >&2
    bad=1
  else
    echo "✓ $f  $sz 字节"
  fi
done
if [ "$bad" != 0 ]; then
  echo "内置字体不完整——若这是出包流程，请修好再打包（安装包里的「内置字体」" >&2
  echo "选项会静默回落系统字体，用户看不到任何提示）。" >&2
  exit 1
fi

echo "完成。目录内容："
ls -la "$DEST"
