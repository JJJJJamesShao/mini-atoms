# Constitution — mini-atoms 项目宪法

> 本文档是项目的「不可变契约」。任何技术决策若与本文冲突，优先修改代码而非修改本文。

---

## 1. 产品定义

mini-atoms 是一个 **AI Native 应用生成平台 Demo**：用户用自然语言描述需求，系统通过多阶段 Agent 流水线实时生成可交互的网页应用，支持对话式迭代、增量修改与版本管理。

**核心叙事**：不是「AI 写代码」，而是「用户与 AI 协作，把想法变成可运行的产品」。

---

## 2. 设计哲学

### 2.1 架构预留 > 当前实现

- 数据模型和流水线接口按**多文件项目**设计（`File[]` 数组）
- 当前阶段生成器只输出单文件 `index.html`，但接口不限制文件数量
- SOP 引擎支持多阶段分层生成（schema→shell→pages→merge）
- 说明文档中必须明确交代这一取舍

### 2.2 Mock-First 开发

- 所有节点执行器先写罐头实现，接口稳定后再替换为真实 LLM
- 罐头实现与 LLM 实现通过依赖注入互换，主循环零改动

### 2.3 零模型校验层

- `verify` 节点必须是确定性代码（acorn 语法检查 + 结构规则），不得调用 LLM
- `apply` 节点必须是确定性字符串操作（三级模糊匹配），不得调用 LLM
- 理由：代码校验和补丁应用需要 100% 可重复，不能依赖模型随机性

### 2.4 确认门（Approve Gate）

- 规格确认节点是**首次生成时的强制阻断点**，用户必须看到 Requirements/Constraints/User Stories 三段式卡片并主动确认
- 确认后才进入生成阶段，未确认则回退到 clarify
- **增量修改（Modify SOP）不需要确认门**：修改是对既有规格的增量，直接 locate→patch→apply

### 2.5 增量修改的保底策略

- Modify SOP 的 locate→patch→apply→verify 循环最多 5 次
- 次数用尽 → **fail 保留旧版本**，不自动回退完整重写
- 理由：完整重写曾引发 300s 超时误杀，且违背"增量修改"的设计初衷
- 用户可重新发起修改，或切换策略走完整生成

### 2.6 用户打断机制（未来扩展）

> 这是 Atoms / MetaGPT 等框架当前未充分解决的问题，也是我们产品的差异化思考。

**问题**：用户在流水线执行过程中（如 generate 节点正在调用 LLM），发送了新消息。新消息可能：

- **意图修正**："等一下，把背景改成深蓝色"——修改当前生成
- **意图切换**："先别做这个了，帮我做个计时器"——放弃当前任务，启动新任务
- **无关插话**："今天天气怎么样"——与当前任务无关

**现状分析**：

- MetaGPT 的 Role/Action 架构是**顺序执行**的，外部输入无法中断正在进行的 Action
- Atoms 的节点流水线一旦启动，同样**没有中途干预点**（除了 approve 确认门）
- 这导致用户体验的"失控感"——AI 在干活，用户想改但改不了，只能等它跑完

**设计方向**（预留架构，当前不实现）：

```typescript
// 流水线支持「可中断节点」标记
interface NodeConfig {
  cancellable: boolean; // 该节点是否可被用户新消息打断
}

// 中断事件
interface InterruptEvent {
  type: "user_message";
  content: string;
  intent: "amend" | "switch" | "unrelated"; // 意图分类（由快模型判断）
}

// 中断后的处理策略
const INTERRUPT_STRATEGY = {
  amend: "保留上下文，注入新约束，重新从 clarify 开始", // 修正当前任务
  switch: "存档当前任务为草稿，启动新流水线", // 切换任务
  unrelated: "挂起当前任务，回答插话，询问是否恢复", // 无关插话
};
```

**为什么这是 Atoms 的真实痛点**：

- Atoms 当前的全量重写模式意味着用户的每次修改都看不到"改了什么"
- 如果用户在 generate 过程中想修正，只能等生成完再提新需求 → 浪费 token
- 打断机制 + Diff 可视化 = 让用户真正掌控生成过程

**当前取舍**：48h 内不实现打断机制，但数据模型预留（messages 表已设计，未来可存中断事件），并在说明文档中明确阐述这一产品思考。

---

## 3. 技术约束

| 约束         | 值                                      | 理由            |
| ------------ | --------------------------------------- | --------------- |
| 生成物格式   | `File[]`（当前只有 index.html）         | 预留多文件扩展  |
| 校验规则     | 单文件 <200KB、无外部资源、DOCTYPE 必需 | 沙箱安全 + 性能 |
| 状态机       | 4 套 SOP 配置化                         | 可扩展、可路由  |
| Fix 上限     | 5 次                                    | 防止无限循环    |
| 节点模型路由 | clarify=快 / generate=强 / verify=零    | 成本与质量平衡  |

---

## 4. 数据契约

```typescript
// 版本快照
interface Version {
  id: uuid;
  project_id: uuid;
  files: { path: string; content: string }[]; // ← 关键：文件列表
  version_no: int;
  is_snapshot: boolean;
  snapshot_name: string | null;
  // 过程数据（供刷新回放）
  request: string | null;
  notes: string | null;
  spec: SpecOutput | null;
  stages: StageState[] | null;
  logs: ProcessLog[] | null;
  parent_version_no: int | null; // ← 分叉基准
  questions: string[] | null;
  stage_outputs: Record<string, unknown> | null;
  created_at: timestamp;
}

// 项目
interface Project {
  id: uuid;
  user_id: uuid;
  title: string;
  pinned: boolean;
  created_at: timestamp;
}

// 对话消息
interface Message {
  id: uuid;
  project_id: uuid;
  role: "user" | "assistant" | "system";
  content: string;
  created_at: timestamp;
}

// 确认门（刷新恢复）
interface Gate {
  id: uuid;
  session_id: string;
  project_id: uuid | null;
  user_id: uuid;
  type: "approve";
  status: "pending" | "approved" | "rejected" | "expired";
  payload: { spec?: SpecOutput; input?: string; baseVersionNo?: number | null };
  expires_at: timestamp;
  created_at: timestamp;
}
```

---

## 5. 信息流分层

| 层级      | 内容                                 | UI 表现              |
| --------- | ------------------------------------ | -------------------- |
| L1 里程碑 | 阶段卡片（clarify→spec→approve→...） | 默认展开，纵向时间线 |
| L2 产物   | 各节点输出（规格、代码、校验结果）   | 折叠，点击展开       |
| L3 调试   | 原始 prompt、token 消耗、模型版本    | 不进 UI，只进日志    |

---

## 6. 降级纪律

- T-6h 必须锁定**保底版**：核心闭环 + 持久化 + 在线 + 说明文档
- 延展能力（Diff 可视化、模板库）可弃，说明文档不可弃
- 同一问题修 3 次不过 → 写 BLOCKER.md 停手

---

## 7. 安全红线

- API 密钥（GLM/Supabase）只进 Vercel 环境变量和本地 `.env.local`
- 前端绝不直接暴露密钥
- 沙箱预览使用 iframe sandbox + CSP，禁止外部脚本执行
- 增量修改的 Patch 必须经过 verify 校验后才落库，防止注入

---

_最后更新：2026-08-12_
