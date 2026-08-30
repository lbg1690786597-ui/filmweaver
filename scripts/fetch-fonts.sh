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
    curl -fL --retry 3 -o "$DEST/LICENSE-Noto-CJK.txt" "$BASE/LICENSE"
  fi
fi

echo "完成。目录内容："
ls -la "$DEST"
