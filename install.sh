#!/usr/bin/env bash
# magic-open 安装脚本（macOS + Node.js >= 18）
# 用法:
#   ./install.sh              安装到 ~/.local/bin（或 /usr/local/bin，若可写）
#   ./install.sh <目录>       安装到指定目录
#   ./install.sh --uninstall  卸载
# 同时安装缩写 mag（等价于 magic-open）；目标位置已有别的程序时不覆盖。
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)/bin/magic-open.mjs"
ALIAS="mag"

# 判断某个文件是不是 magic-open 自己（而不是恰好同名的其他程序）
is_ours() { [ -f "$1" ] && grep -q 'magic-open — 一句中文描述' "$1"; }

# --- 检查 Node ---
if ! command -v node >/dev/null 2>&1; then
  echo "❌ 未找到 node，请先安装 Node.js >= 18（https://nodejs.org 或 brew install node）" >&2
  exit 1
fi
NODE_MAJOR="$(node -e 'console.log(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "❌ 需要 Node.js >= 18，当前为 $(node -v)" >&2
  exit 1
fi

# --- 卸载 ---
if [ "${1:-}" = "--uninstall" ]; then
  for d in "$HOME/.local/bin" /usr/local/bin; do
    if [ -f "$d/magic-open" ]; then rm -f "$d/magic-open" && echo "🗑  已删除 $d/magic-open"; fi
    if is_ours "$d/$ALIAS" || [ -L "$d/$ALIAS" ]; then rm -f "$d/$ALIAS" && echo "🗑  已删除 $d/$ALIAS"; fi
  done
  exit 0
fi

# --- 选择目标目录 ---
if [ $# -ge 1 ]; then
  DEST="$1"; mkdir -p "$DEST"
elif [ -w /usr/local/bin ]; then
  DEST=/usr/local/bin
else
  DEST="$HOME/.local/bin"; mkdir -p "$DEST"
fi

# --- 安装 ---
install -m 755 "$SRC" "$DEST/magic-open"
echo "✅ 已安装到 $DEST/magic-open"

# --- 缩写 mag：目标位置已被别的程序占用时不动它，只提示 ---
if [ -e "$DEST/$ALIAS" ] && ! is_ours "$DEST/$ALIAS"; then
  echo "⚠️  $DEST/$ALIAS 已存在且不是 magic-open，未覆盖（缩写 mag 不可用，仍可用 magic-open）"
else
  ln -sf "$DEST/magic-open" "$DEST/$ALIAS"
  echo "✅ 缩写已安装: $DEST/$ALIAS"
fi

case ":$PATH:" in
  *":$DEST:"*) ;;
  *) echo "⚠️  $DEST 不在 PATH 中，请把它加入 ~/.zshrc 后 source："
     echo "       export PATH=\"$DEST:\$PATH\"" ;;
esac
echo "试用: mag --help"
