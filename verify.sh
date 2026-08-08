#!/usr/bin/env bash
# 本地一键验证：lint → tsc → build → test（有测试才跑）。
# 对应全局规则「代码修改后的本地验证」：commit/push 前必须通过本脚本。
set -euo pipefail
cd "$(dirname "$0")"

step() { echo; echo "==> $1"; }

step "1/4 lint"
npm run lint

step "2/4 tsc --noEmit"
npx tsc --noEmit

step "3/4 build"
npm run build

step "4/4 test（无测试则跳过）"
if npm run | grep -qE '^\s+test\s*$'; then
  npm test --if-present
else
  echo "未定义 test 脚本，跳过。"
fi

echo
echo "✔ 全部验证通过"
