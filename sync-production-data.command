#!/bin/zsh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

if command -v pnpm >/dev/null 2>&1; then
  pnpm sync:production-data "$@"
elif command -v corepack >/dev/null 2>&1; then
  corepack pnpm sync:production-data "$@"
else
  echo "找不到 pnpm 或 corepack，请先安装 Node.js/pnpm。"
  read -r "?按回车关闭窗口..."
  exit 1
fi

status=$?
if [[ $status -eq 0 ]]; then
  echo
  read -r "?同步完成，按回车关闭窗口..."
else
  echo
  read -r "?同步失败，按回车关闭窗口..."
fi

exit $status
