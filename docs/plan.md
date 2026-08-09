# Plan — 实施计划与任务拆解

> 本文档是开发者的「执行手册」。每个任务有明确的验收标准和预估时间。

---

## 当前状态

- **已完成**：地基（脚手架、CI/CD、状态机、校验层、罐头数据、测试）
- **分支**：`feat/foundation`（待合入 main）
- **时间窗口**：≈20 小时（截止 2026-08-10）

---

## 任务清单

### ✅ T0 — 地基（已完成）

- [x] GitHub 仓库 + MIT + .gitignore
- [x] main 保护（Ruleset + pre-push + 分支命名 CI）
- [x] Kimi Code 全局规则 + orch-cli 评审体系
- [x] Next.js 脚手架 + Tailwind
- [x] Vercel 自动部署
- [x] vitest + verify.sh
- [x] 四契约 schema + 3 罐头应用 + 校验层 + 状态机
- [x] **数据模型迁移：单文件 code → File[] 文件列表**

**验收**：`./verify.sh` 全绿，26 测试通过

---

### ⬜ T1 — docs/ 三件套

**任务**：补齐项目文档（constitution/spec/plan）

**验收标准**：

- [ ] docs/constitution.md — 项目宪法（不可变契约）
- [ ] docs/spec.md — 产品规格（P0 九项 US + 架构 + 数据模型）
- [ ] docs/plan.md — 本文件，任务拆解 + 验收标准

**预估**：45min
**执行方**：本人（小爪辅助）

---

### ⬜ T2 — Supabase 建表

**任务**：创建 projects/versions/messages 三表

**验收标准**：

- [ ] 表存在且字段正确
- [ ] Supabase API 可读写
- [ ] 本地 `.env.local` 配好密钥（不提交到 git）

**表结构**：

```sql
projects: id uuid PK / user_id / title text / created_at
versions: id uuid PK / project_id FK / files jsonb / version_no int / is_snapshot bool / snapshot_name text null / created_at
messages: id uuid PK / project_id FK / role text / content text / created_at
```

**预估**：15min
**执行方**：本人

---

### ⬜ T3 — UI 骨架

**任务**：左右栏布局 + 里程碑阶段卡片 + ChatPanel + PreviewFrame

**验收标准**：

- [ ] 左侧：对话输入 + 阶段卡片（clarify→spec→approve→generate→verify→done）
- [ ] 右侧：iframe sandbox 预览
- [ ] 罐头数据驱动跑通全流程（点击待办/贪吃蛇/计时器按钮，看到完整流水线）
- [ ] 确认门 UI：三段式卡片（Requirements/Constraints/User Stories）+ 确认/修改按钮
- [ ] verify.sh 绿

**布局草图**：

```
┌──────────────────────────────┬─────────────────┐
│  ChatPanel                    │  PreviewFrame   │
│  ┌─────────────────────────┐  │                 │
│  │ 里程碑: clarify ✓       │  │  ┌───────────┐  │
│  │ spec ✓                  │  │  │ iframe    │  │
│  │ approve [确认] [修改]   │  │  │ sandbox   │  │
│  │ generate ✓              │  │  │           │  │
│  │ verify ✓                │  │  └───────────┘  │
│  │ done ✓                  │  │                 │
│  └─────────────────────────┘  │                 │
│                              │                 │
│  [输入需求...] [发送]        │                 │
└──────────────────────────────┴─────────────────┘
```

**预估**：1.5h
**执行方**：Kimi Code 任务包

---

### ⬜ T4 — 真 LLM 联调

**任务**：GLM 客户端 + prompt 模板 + 替换执行器插槽 + SSE 进度流

**验收标准**：

- [ ] `lib/llm/glm.ts` — GLM API 客户端（支持流式输出）
- [ ] clarify prompt — 带选项按钮的澄清问题生成
- [ ] spec prompt — 结构化 Requirements/Constraints/US 输出
- [ ] generate prompt — 强模板约束（单文件 HTML、内联样式、无外部依赖）
- [ ] iterate prompt — 基于对话历史的增量修改
- [ ] 替换 `canned-executors.ts` 为真实 LLM 执行器
- [ ] SSE 流：每个状态转换推送事件到前端
- [ ] Vercel 配 GLM 环境变量
- [ ] 输入"做一个待办清单"→真模型全流程走通、预览可交互

**预估**：2.5h
**执行方**：本人主导（prompt 亲自调）

---

### ⬜ T5 — 持久化

**任务**：项目列表 + 版本存取 + 刷新不丢

**验收标准**：

- [ ] 项目列表页：展示所有项目（标题 + 最后修改时间）
- [ ] 创建项目：输入需求后自动保存到 Supabase
- [ ] 版本自动存档：每次生成后自动创建新版本
- [ ] 刷新页面：项目状态从 Supabase 恢复
- [ ] 确认门持久化：approve 决策保存到 messages 表

**预估**：2h
**执行方**：Kimi Code 任务包

---

### ⬜ T6 — 账号体系

**任务**：Supabase Auth 邮箱注册 + role 字段 + 限流

**验收标准**：

- [ ] 注册页：邮箱 + 密码，默认 free 角色
- [ ] 登录页：邮箱 + 密码
- [ ] role 字段：free / paid（DeepWisdom 团队预创建）
- [ ] 限流：free 每日 5 次生成、极速档、保留 3 个版本
- [ ] 中间件：未登录重定向到登录页

**预估**：1.5h
**执行方**：Kimi Code 任务包

---

### ⬜ T7 — 对话式迭代 + 双层版本

**任务**：生成后继续对话修改 + 自动存档 + 命名快照

**验收标准**：

- [ ] 生成完成后，输入框可用，可继续对话
- [ ] "改成深色模式"→生成新版本，自动存档为 v2, v3...
- [ ] 用户可手动命名快照："深色模式定稿"
- [ ] 快照置顶显示，可回切
- [ ] 版本列表：自动版本（v1, v2...）+ 快照（命名）

**预估**：1.5h
**执行方**：Kimi Code 任务包

---

### ⬜ T8 — 延展：版本 Diff 可视化

**任务**：jsdiff 并排高亮改动行

**验收标准**：

- [ ] 选择两个版本，显示并排 Diff
- [ ] 新增行绿色高亮，删除行红色高亮
- [ ] 可切换回预览视图

**预估**：1h
**执行方**：Kimi Code 任务包

---

### ⬜ T9 — 冻结与修刺

**任务**：US 逐条自测 + 修 bug

**验收标准**：

- [ ] P0 九项 US 全部手动过一遍
- [ ] 发现 bug → 修 → 再测
- [ ] verify.sh 绿
- [ ] 性能：首屏 <3s，生成流程 <30s

**预估**：1.5h
**执行方**：本人

---

### ⬜ T10 — 说明文档 + README

**任务**：评审能按文档跑通

**验收标准**：

- [ ] README：项目简介 + 运行方式 + 技术栈 + 截图
- [ ] docs/：任务拆解与取舍、AI Native 过程、校验方法论、Atoms 体验观察、已知限制
- [ ] 提交前检查：无密钥泄露、无个人信息

**预估**：1.5h
**执行方**：本人主导

---

### ⬜ T11 — 提交

**任务**：repo 转 public + 飞书文档贴链接 + 发 HR

**验收标准**：

- [ ] GitHub 仓库转 public
- [ ] 检查 .env.local / 密钥 / 个人信息
- [ ] 飞书笔试文档创建副本，贴链接
- [ ] 发 HR

**预估**：30min
**执行方**：本人

---

## 时间账

| 阶段   | 任务 | 预估  | 累计  |
| ------ | ---- | ----- | ----- |
| 文档   | T1   | 45min | 45min |
| 数据   | T2   | 15min | 1h    |
| 骨架   | T3   | 1.5h  | 2.5h  |
| LLM    | T4   | 2.5h  | 5h    |
| 持久化 | T5   | 2h    | 7h    |
| 账号   | T6   | 1.5h  | 8.5h  |
| 迭代   | T7   | 1.5h  | 10h   |
| Diff   | T8   | 1h    | 11h   |
| 冻结   | T9   | 1.5h  | 12.5h |
| 文档   | T10  | 1.5h  | 14h   |
| 提交   | T11  | 30min | 14.5h |

**总预估：14.5h + 3h 缓冲 = 17.5h**，剩余 20h 可行。

---

## 降级预案

若时间不足，按序砍：

1. T8（Diff 可视化）— 延展能力，可弃
2. T7 命名快照 — 保留自动存档，弃命名
3. T6 账号限流 — 保留注册登录，弃限流档位
4. T5 确认门持久化 — 保留 UI，不存数据库

**绝对不可砍**：T3（UI 骨架）、T4（LLM 联调）、T9（自测）、T10（文档）

---

_最后更新：2026-08-09_
