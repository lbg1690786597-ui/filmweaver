#!/usr/bin/env bash
# 网页预览一键部署（dev 提效）：构建前端 → 发布到 FW 后端 /app 静态目录。
# 用法: bash preview.sh          # 约 10 秒后浏览器刷新 http://118.196.33.51:9080/fw/app/ 即见最新 UI
# 说明: 仅前端改动用此通道即时预览；Tauri 专属能力(更新器/本机渲染)在浏览器自动降级。
set -euo pipefail
cd "$(dirname "$0")"

# base 用相对路径 → 产物同时兼容 /fw/app/ 反代访问与本地 file://
npx vite build --base=./ 2>&1 | tail -1

DEST=/root/filmweaver-data/webapp
mkdir -p "$DEST"
rm -rf "$DEST"/*
cp -r dist/* "$DEST"/
rm -rf dist

echo "✅ 已发布: http://118.196.33.51:9080/fw/app/  (Ctrl+F5 强刷)"
