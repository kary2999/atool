#!/usr/bin/env bash
# 打包 DevToolbox 扩展为可上架的 zip，版本号取自 manifest.json。
# 只含扩展运行所需文件，排除 git/CI/文档/开发脚本等。
# 用法：bash scripts/build.sh   →  产出 devtoolbox-v<version>.zip
set -euo pipefail

cd "$(dirname "$0")/.."

# 从 manifest.json 提取版本号（不依赖 node）
VERSION=$(grep '"version"' manifest.json | head -1 | sed -E 's/[^0-9.]*([0-9]+\.[0-9]+\.[0-9]+).*/\1/')
if [ -z "$VERSION" ]; then
  echo "✗ 无法从 manifest.json 解析 version" >&2
  exit 1
fi

OUT="devtoolbox-v${VERSION}.zip"
rm -f "$OUT"

# 排除非运行文件：版本控制、CI、Claude 内部、文档、打包脚本、旧 zip、Markdown、图标生成脚本等
zip -r -q "$OUT" . \
  -x '.git/*' \
     '.github/*' \
     '.claude/*' \
     'docs/*' \
     'scripts/*' \
     'node_modules/*' \
     '*.zip' \
     '*.md' \
     'gen-icons.js' \
     '.gitignore' \
     '.DS_Store' \
     '*/.DS_Store'

echo "✓ 已打包：$OUT"
echo "  包含文件："
unzip -l "$OUT" | awk 'NR>3 && $4!="" {print "    " $4}' | grep -v '^    $' || true
