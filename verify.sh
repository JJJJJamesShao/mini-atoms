#!/usr/bin/env bash
# 本地一键验证：lint → tsc → test → build。
# 对应全局规则「代码修改后的本地验证」：commit/push 前必须通过本脚本。
set -euo pipefail
cd "$(dirname "$0")"

step() { echo; echo "==> $1"; }

step "1/4 lint"
npm run lint

step "2/4 tsc --noEmit"
# LayoutProps/PageProps 等全局类型助手由 next typegen 生成（.next/ 被 gitignore，
# CI 等干净环境下必须先 typegen，否则 tsc 报 Cannot find name 'LayoutProps'）
npx next typegen
npx tsc --noEmit

step "3/4 test"
npm test

step "4/4 build"
npm run build

echo
echo "✔ 全部验证通过"
