# Constitution — mini-atoms 项目宪法

> 本文档是项目的「不可变契约」。任何技术决策若与本文冲突，优先修改代码而非修改本文。

---

## 1. 产品定义

mini-atoms 是一个 **AI Native 应用生成平台 Demo**：用户用自然语言描述需求，系统通过多阶段 Agent 流水线实时生成可交互的网页应用，支持对话式迭代与版本管理。

**核心叙事**：不是「AI 写代码」，而是「用户与 AI 协作，把想法变成可运行的产品」。

---

## 2. 设计哲学

### 2.1 架构预留 > 当前实现

- 数据模型和流水线接口按**多文件项目**设计（`File[]` 数组）
- 当前阶段生成器只输出单文件 `index.html`，但接口不限制文件数量
- 说明文档中必须明确交代这一取舍

### 2.2 Mock-First 开发

- 所有节点执行器先写罐头实现，接口稳定后再替换为真实 LLM
- 罐头实现与 LLM 实现通过依赖注入互换，主循环零改动

### 2.3 零模型校验层

- `verify` 节点必须是确定性代码（acorn 语法检查 + 结构规则），不得调用 LLM
- 理由：代码校验需要 100% 可重复，不能依赖模型随机性

### 2.4 确认门（Approve Gate）

- 规格确认节点是**强制阻断点**，用户必须看到 Requirements/Constraints/User Stories 三段式卡片并主动确认
- 确认后才进入生成阶段，未确认则回退到 clarify

---

## 3. 技术约束

| 约束         | 值                                      | 理由            |
| ------------ | --------------------------------------- | --------------- |
| 生成物格式   | `File[]`（当前只有 index.html）         | 预留多文件扩展  |
| 校验规则     | 单文件 <200KB、无外部资源、DOCTYPE 必需 | 沙箱安全 + 性能 |
| 状态机       | 9 状态，转移表硬编码                    | 可预测、可测试  |
| Fix 上限     | 2 次                                    | 防止无限循环    |
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
  created_at: timestamp;
}

// 项目
interface Project {
  id: uuid;
  user_id: uuid;
  title: string;
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

---

_最后更新：2026-08-09_
