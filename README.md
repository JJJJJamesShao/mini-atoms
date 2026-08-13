# mini-atoms

> 一个 **AI Agent 驱动** 的应用生成系统。用户用自然语言描述需求，多角色 Agent 流水线自动完成需求澄清 → 架构规格 → 代码生成 → 语法校验 → 沙箱预览，支持**对话式迭代**、**增量修改**与**版本管理**。

**在线体验**: [https://mini-atoms.vercel.app](https://mini-atoms.vercel.app)

## Demo

![数独生成 + 迭代修改](docs/demo.gif)

_输入 "做一个数独游戏" → Agent 流水线自动生成 → 输入 "把背景改成深蓝色" → 基于现有代码增量修改_

📹 [完整录屏演示 (demo.mov)](docs/demo.mov)

---

## 30 秒速览

```
用户: "做一个 2048 游戏，深色主题"
  ↓
[PM Agent] 澄清需求 → 确认游戏机制、交互方式
  ↓
[Architect Agent] 输出规格 → HTML5 Canvas + 原生 JS，4×4 网格
  ↓
[Engineer Agent] 生成代码 → 单文件 HTML，~500 行
  ↓
[Reviewer Agent] 自动校验 → 语法 ✅ 安全 ✅ 结构 ✅
  ↓
沙箱预览 → 可玩的 2048 游戏
  ↓
用户: "把背景改成深蓝色" → 增量修改（Locate→Patch→Apply）→ 版本 2
```

---

## 架构设计

### 系统架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                         用户交互层                                    │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐            │
│  │ 需求输入  │  │ 规格确认  │  │ 对话迭代  │  │ 版本切换  │            │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘            │
└───────┼─────────────┼─────────────┼─────────────┼──────────────────┘
        │             │             │             │
        ▼             ▼             ▼             ▼
┌─────────────────────────────────────────────────────────────────────┐
│                       Agent 流水线引擎                                │
│                                                                      │
│   ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌────────┐          │
│   │  PM     │───→│Architect│───→│Engineer │───→│Reviewer│          │
│   │ 需求澄清 │    │ 规格生成 │    │ 代码生成 │    │ 自动校验│          │
│   └────┬────┘    └────┬────┘    └────┬────┘    └───┬────┘          │
│        │              │              │             │               │
│        └──────────────┴──────────────┘             │               │
│                    Memory 共享                      │               │
│   ┌──────────────────────────────────────────────┐ │               │
│   │ Topic-based Memory Pool                       │ │               │
│   │ • REQUIREMENT  : 用户需求历史                  │ │               │
│   │ • ARCH_SPEC    : 架构规格文档                  │ │               │
│   │ • CODE         : 代码产物                     │ │               │
│   │ • REVIEW       : 校验结果与修复记录            │ │               │
│   └──────────────────────────────────────────────┘ │               │
│                                                     │               │
│   ┌─────────────────────────────────────────────────┘               │
│   │ SOP 路由（按需求复杂度自动选择）                                  │
│   │ • web-app     : clarify→spec→approve→generate→verify→done      │
│   │ • game/tool   : clarify→spec→generate→verify→done（跳过确认）  │
│   │ • fullstack   : 多阶段分层生成（schema→shell→pages→merge）     │
│   │ • modify      : locate→patch→apply→verify（增量修改）          │
│   └─────────────────────────────────────────────────────────────────┘
│                                                                      │
│   ┌────────────────────────────────────────────────────────────────┐│
│   │ Patch 修复循环（最多 5 轮）                                      ││
│   │ 校验失败 → Search/Replace Patch → 应用 → 再次校验               ││
│   └────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         持久化层                                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐            │
│  │ projects │  │ versions │  │ messages │  │ gates    │            │
│  │ 项目元数据 │  │ 版本文件 │  │ 对话历史 │  │ 确认门   │            │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘            │
│                                                                      │
│  Supabase (PostgreSQL + Row Level Security)                          │
└─────────────────────────────────────────────────────────────────────┘
```

### 核心设计决策

#### 1. 单文件 HTML 架构（当前阶段）

**约束**: `iframe srcDoc` 无 base URL，无法加载相对路径资源。

**方案**:

- LLM 输出结构化 JSON（CodeArtifact），支持多文件组织
- 后端 `mergeToSingleHtml` 自动内联 CSS/JS，合并为单文件
- 前端通过 `srcDoc` 注入 iframe 渲染

**未来扩展**: 接入 WebContainers 或云端沙箱后可升级为多文件项目。

#### 2. Search/Replace Patch 修复

**问题**: 校验失败后完整重写代码，token 浪费且易引入新问题。

**方案**:

```
传统: 生成 → 校验失败 → 完整重写(8万字符) → 校验
 ours: 生成 → 校验失败 → Patch(几百字符) → 校验
```

LLM 输出 `SEARCH/REPLACE` 指令，后端精确替换：

```
<<<<<<< SEARCH
body { background: white; }
=======
body { background: #1a1a2e; }
>>>>>>> REPLACE
```

**收益**: 修复轮次从 2-3 轮降至 1-2 轮，token 消耗降低 90%+。

#### 3. 增量修改小循环（Modify SOP）

**问题**: 用户说"把背景改成蓝色"时，传统方案要么完整重写（慢+贵），要么直接 Patch（锚点匹配率低）。

**方案**: 引入 **Locate→Patch→Apply→Verify** 小循环：

```
Locate（快模型）: "用户要改背景色，目标在第 45 行的 CSS 块"
     ↓
Patch（强模型）: "生成精确的 SEARCH/REPLACE 指令"
     ↓
Apply（零 LLM）: "三级模糊匹配（精确→行尾归一化→忽略缩进）"
     ↓
Verify（零 LLM）: "语法/安全/结构校验"
     ↓
done / fix-patch（最多 5 轮）
```

**收益**: 修改只需几百字符的 Patch，而非完整重写；Apply 三级匹配降低锚点漂移导致的失败率。

#### 4. 对话式迭代

**问题**: follow-up 时 LLM 看不到之前的代码，只能从头生成。

**方案**:

- `sendFollowUp` 将当前版本 HTML 传入后端
- 有现有代码 → 走 **Modify SOP**（locate→patch→apply）
- 无现有代码 → 走完整生成流程
- 追加版本到现有项目，不创建新项目

**效果**: "把背景改成蓝色" → 只改背景色，保留所有游戏逻辑。

#### 5. 多 Provider 降级与 GLM 韧性

**问题**: 单一 LLM 服务不稳定，长内容生成易超时；GLM 深度思考阶段可静默数分钟，海外节点直连原生端点不可达。

**方案**:

| 节点         | 主模型              | 降级路径                    |
| ------------ | ------------------- | --------------------------- |
| clarify/spec | Qwen 3.6 Flash (快) | 坏 JSON 多级解析 + 自动重试 |
| generate/fix | GLM-5.2             | 百炼 Qwen 3.8 Max           |
| locate/patch | Qwen 3.8 Max        | 百炼 Qwen 系列              |

- **思考过程可见**：`reasoning_content` 实时流式展示（"思考中：..."），不再死寂等待
- **首 token 看门狗**：200s 无任何响应 → 主动断连切换百炼兜底，避免挂起到被平台强杀
- **显式失败**：输出触及 max_tokens 截断（`finish_reason=length`）立即报错，不再空转修复烧 token

#### 6. 两阶段生成（思考/出码拆分）

**问题**: GLM 的 max_tokens 对**思考+正文合并计费**，深度思考挤占输出预算，长代码生成触及 128K 上限被截断。

**方案**:

```
阶段 1（思考期）: thinking 开启，32K 预算 → 输出完整实现方案 + 自估代码量
     ↓
阶段 2（出码期）: thinking 关闭，100K 预算独占 → 按方案直接输出代码
```

出码期首字节从 ~193s 降至秒级，思考不再挤占输出预算，等效突破单次内容上限。

---

## 核心特性

### 🎯 多阶段 Agent 流水线

- **PM Agent**: 需求澄清，提取关键约束
- **Architect Agent**: 输出结构化规格（requirements + constraints）
- **Engineer Agent**: 代码生成，支持结构化 JSON / 纯 HTML 两种模式
- **Reviewer Agent**: 三级校验（syntax → security → structure）

### 🔄 对话式迭代

基于现有代码的增量修改：

```
版本 1: 2048 游戏（白色主题）
  ↓ "把背景改成深蓝色"
版本 2: 2048 游戏（深蓝主题）← 只改了 CSS，游戏逻辑完全保留
  ↓ "加一个最高分记录"
版本 3: 2048 游戏（深蓝主题 + 最高分）← 只加了 localStorage 逻辑
```

### 🛠️ 增量修改引擎（Modify SOP）

| 阶段   | 职责             | 说明                                   |
| ------ | ---------------- | -------------------------------------- |
| Locate | 定位改动范围     | 快模型识别需要修改的代码区域           |
| Patch  | 生成修改指令     | 强模型输出 SEARCH/REPLACE 块           |
| Apply  | 应用补丁         | 三级模糊匹配：精确→行尾归一化→忽略缩进 |
| Verify | 校验修改后的代码 | 语法/安全/结构校验                     |

### 🛡️ 自动代码校验

| 层级      | 校验项                  | 示例                               |
| --------- | ----------------------- | ---------------------------------- |
| Syntax    | JS 语法（acorn）        | `var x = ;` → 第 5 行第 9 列错误   |
| Security  | XSS 向量、危险标签      | `<iframe>`、`javascript:` 协议禁止 |
| Structure | DOCTYPE、外部资源、大小 | `<script src="...">` 禁止、< 200KB |

错误携带精确位置 + 代码片段 + 修复建议，支持 LLM 精准定位。

### 📦 版本管理

- 每次生成创建一个版本
- 版本间可切换预览
- 支持从任意历史版本分叉修改
- 刷新后版本历史完整恢复（含进行中的确认门）
- 支持置顶常用项目
- 删除废弃项目

### 📊 执行过程可解释

- 实时阶段卡片：clarify → spec → approve → generate → verify → done
- 执行日志面板：每个 Agent 的输入/输出/耗时
- 思考过程展示：GLM 深度思考的 reasoning 实时流式可见
- 异步代码摘要：generate 阶段每 3 秒刷新"正在做什么"的提示

---

## 技术栈

| 层级       | 技术                                                   |
| ---------- | ------------------------------------------------------ |
| 前端       | Next.js 15 · React 19 · TypeScript · Tailwind CSS      |
| Agent 引擎 | 自研 SOP 引擎 · 多角色 Memory 隔离 · EventBus 实时推送 |
| LLM        | GLM-5.2 · 百炼 Qwen (OpenAI 兼容) · 自动降级           |
| 持久化     | Supabase (PostgreSQL + Auth + RLS)                     |
| 部署       | Vercel                                                 |

---

## 快速开始

### 环境变量

创建 `.env.local`，填入：

```bash
# Supabase（持久化 + Auth）
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SECRET_KEY=your-service-role-key

# LLM — GLM（generate 节点主模型）
GLM_API_KEY=your-glm-key
# GLM_BASE_URL 缺省为智谱原生端点；海外部署（如 Vercel）需指向百炼代理
GLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4

# LLM — 百炼代理（clarify/spec/locate/patch + generate 兜底）
ANTHROPIC_AUTH_TOKEN=your-bailian-token
ANTHROPIC_BASE_URL=your-bailian-proxy-url

# E2E 黑箱测试（可选，仅 npm run test:e2e 需要）
E2E_TEST_EMAIL=your-test-account
E2E_TEST_PASSWORD=your-test-password
```

### 数据库初始化

在 Supabase Dashboard → SQL Editor 执行：

```bash
supabase/migrations/000_core_tables.sql  # projects / versions / messages
supabase/migrations/001_rbac.sql         # profiles / usage / gates
```

### 本地运行

```bash
npm install
npm run dev
```

访问 http://localhost:3000

---

## 测试

```bash
npm test            # 单元/集成测试（171 个，19 个文件）
npm run test:e2e    # E2E 黑箱流程测试（自起 dev server，烧真实 LLM 额度）
./verify.sh         # L1 门禁：lint → tsc → test → build
```

| 测试模块  | 覆盖内容                                                          |
| --------- | ----------------------------------------------------------------- |
| SOP 引擎  | 正常流程 / 失败重试 / 确认门 / 多轮修复 / Modify SOP              |
| 架构隔离  | 角色 Memory 隔离 / CodeArtifact 解析 / Topic 消息池               |
| 代码校验  | 语法 / 安全 / 结构校验 / 错误定位                                 |
| LLM 韧性  | 思考展示 / 首 token 看门狗 / 百炼兜底 / 两阶段生成 / 截断显式失败 |
| JSON 容错 | 坏 JSON 多级解析 / 截断重试                                       |
| 数据库    | 项目 / 版本 / 消息 / 用户 / 限流                                  |
| E2E 黑箱  | 注册登录 → 新建生成 → follow-up 修改 → 刷新恢复                   |

---

## 项目结构

```
mini-atoms/
├── src/
│   ├── app/                    # Next.js App Router
│   │   ├── api/               # API 路由
│   │   │   ├── pipeline/      # Agent 流水线 SSE
│   │   │   ├── projects/      # 项目管理
│   │   │   └── users/         # 用户计数
│   │   ├── auth/              # 登录 / 注册
│   │   ├── components/        # UI 组件
│   │   └── hooks/             # useWorkspace
│   ├── lib/
│   │   ├── agent/             # Agent 引擎核心
│   │   │   ├── engine.ts      # SOP 执行引擎
│   │   │   ├── llm-executors.ts  # LLM 调用执行器（含 locate/patch/apply）
│   │   │   ├── patch.ts       # Search/Replace Patch + 三级模糊匹配
│   │   │   ├── sop.ts         # SOP 配置（web-app/game/fullstack/modify）
│   │   │   ├── bus.ts         # Agent EventBus
│   │   │   ├── role.ts        # 角色定义
│   │   │   └── router.ts      # SOP 路由
│   │   ├── db/                # 数据库操作
│   │   ├── llm/               # LLM 客户端
│   │   ├── schemas/           # 类型定义 + CodeArtifact
│   │   ├── verify/            # 代码校验
│   │   └── supabase/          # Supabase 客户端
│   └── tests/                 # 测试
├── supabase/
│   └── migrations/            # 数据库迁移
└── docs/                      # 设计文档
```

---

## 文档

- [CHANGELOG.md](CHANGELOG.md) — 迭代日志
- [docs/spec.md](docs/spec.md) — 系统规格文档
- [docs/constitution.md](docs/constitution.md) — 项目宪法（不可变契约）
- [docs/plan.md](docs/plan.md) — 实施计划与任务拆解
- [docs/manual-test-plan.md](docs/manual-test-plan.md) — 手动测试方案

---

## 演进历程

mini-atoms 在 48 小时笔试期间经历了 **40+ PR** 的持续迭代，核心演进路径：

| 阶段         | 重点                                             | 代表 PR      |
| ------------ | ------------------------------------------------ | ------------ |
| **T0 地基**  | 脚手架、CI/CD、SOP 状态机、校验层                | #13-#15      |
| **核心闭环** | LLM 联调、前端接入、对话式迭代                   | #16-#20      |
| **稳定性**   | SSE 心跳保活、流式化、断流兜底                   | #29-#33      |
| **持久化**   | 过程数据落库、确认门持久化、刷新恢复             | #27, #31     |
| **复杂任务** | 多阶段 SOP、分层生成、缺页检测                   | #32          |
| **增量修改** | Locate→Patch→Apply 小循环、三级模糊匹配          | #34          |
| **测试体系** | E2E 黑箱 harness、手动测试 SOP、可观测性         | #38-#40      |
| **LLM 韧性** | JSON 容错、思考展示、首 token 看门狗、两阶段生成 | #37, #41-#42 |

---

## 未来方向

| 方向            | 说明                                          |
| --------------- | --------------------------------------------- |
| 多文件项目      | 接入 WebContainers / Sandpack，突破单文件限制 |
| 专用 Apply 模型 | 像 Cursor 那样用专门模型做代码变更应用        |
| 代码覆盖率测试  | verify 阶段注入测试用例并运行                 |
| 用户反馈循环    | 点击"这个不对"自动触发修复                    |
| 实时协作        | 多人同时编辑同一代码                          |

---

**License**: MIT
