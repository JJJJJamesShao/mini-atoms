# mini-atoms

一个智能体驱动的应用生成 Demo：用户用自然语言描述需求，系统通过「需求澄清 → 规格确认 → 代码生成 → 自动校验 → 沙箱预览」的多阶段 Agent 流水线，实时生成可交互的网页应用，支持对话式迭代与版本管理。

**技术栈**：Next.js · TypeScript · Supabase · Tailwind CSS · GLM

> **架构设计**：数据模型按多文件项目预留（`File[]` 数组），当前阶段生成单文件 HTML，接口支持未来扩展。

---

## 文档索引

| 文档                                         | 内容                                                    |
| -------------------------------------------- | ------------------------------------------------------- |
| [docs/constitution.md](docs/constitution.md) | 项目宪法：不可变契约、设计哲学、安全红线                |
| [docs/spec.md](docs/spec.md)                 | 产品规格：P0 九项用户故事、技术架构、数据模型、评审指引 |
| [docs/plan.md](docs/plan.md)                 | 实施计划：任务拆解、验收标准、时间账、降级预案          |

---

## 本地验证

每次 commit/push 前运行一键验证脚本，全部通过才可提交：

```bash
./verify.sh
```

脚本依次执行：lint → `tsc --noEmit` → 生产构建 → 测试（项目未定义 test 脚本时自动跳过）。

同一个脚本也是 CI 门禁：`.github/workflows/verify.yml` 在每个指向 main 的 PR 上运行 `./verify.sh`，`verify` 是 `protect-main` 规则集的必需状态检查——本地跑绿的代码才能在 CI 上跑绿。

此外还有两个 git hook 在提交时自动生效（需先执行 `git config core.hooksPath .githooks`）：

- **pre-commit**：对暂存文件运行 lint-staged（`eslint --fix` + `prettier --write`），格式问题自动修复，eslint error 直接拦截提交。
- **commit-msg**：校验提交信息符合 Conventional Commits 格式——`<type>(<scope 可选>): <描述>`，type 允许 `feat fix chore docs style refactor test perf ci build revert`，例如 `feat(auth): 添加登录页面`。

## 分支命名规范

- 所有新分支必须以 `feat/` 开头，新功能与 bug fix 均适用，例如 `feat/user-login`、`feat/fix-preview-crash`。
- 也可以使用 `dev` 分支，但多分支并行开发时建议优先使用 `feat/` 前缀，语义更清晰。
- 不允许直接向 `main` 推送代码，所有变更须通过 Pull Request 合入。

该规范通过两道关卡强制执行：

1. **本地 pre-push hook**：推送时校验目标分支名，不合规直接拒绝。克隆仓库后执行一次以下命令启用：

   ```bash
   git config core.hooksPath .githooks
   ```

2. **GitHub 强制检查**：仓库的 `protect-main` 规则集要求 PR 必须通过 `check-branch-name` 状态检查（见 `.github/workflows/branch-naming.yml`），即使绕过本地 hook，不合规的分支也无法合入 main。

> 注：GitHub 的「Restrict branch names」规则需要付费计划，免费账户下不可用，因此服务端采用必需状态检查的方式实现同等约束。
