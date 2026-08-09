# 用户打断机制 — 产品思考文档

> 本文档记录 mini-atoms 在用户打断机制方向上的产品思考与架构预留。

---

## 1. 问题定义

在对话式 AI 应用生成系统中，用户在流水线执行过程中（如 `generate` 节点正在调用 LLM 生成代码时），发送了新消息。新消息可能对应三种意图：

| 意图类型              | 示例                           | 系统应如何响应                                    |
| --------------------- | ------------------------------ | ------------------------------------------------- |
| **修正（Amend）**     | "等一下，把背景改成深蓝色"     | 保留当前上下文，注入新约束，重新从 `clarify` 开始 |
| **切换（Switch）**    | "先别做这个了，帮我做个计时器" | 存档当前任务为草稿，启动全新流水线                |
| **无关（Unrelated）** | "今天天气怎么样"               | 挂起当前任务，回答插话，询问用户是否恢复之前任务  |

---

## 2. 为什么是 Atoms / MetaGPT 的真实痛点

**MetaGPT 的架构限制**：

- Role → Action 的调用链是**顺序执行**的，Action 一旦开始执行，外部输入无法中断
- 没有「可中断节点」的概念，也没有「任务栈」来管理并发意图

**Atoms 的体验观察**：

- 用户在生成过程中看到进度条，但没有「停止」或「修改」按钮
- 如果用户想改需求，只能等当前生成完成后，再发起新一轮对话
- 结果是：token 浪费（生成了一半不要了）、时间浪费、用户挫败感

> 这与传统 IDE 的体验形成对比：程序员写代码时可以随时 `Ctrl+C` 中断编译，但 AI Agent 流水线没有等价的「中断」机制。

---

## 3. 设计方向（预留架构）

```typescript
// 节点配置：标记该节点是否可被用户消息打断
interface NodeConfig {
  cancellable: boolean; // 默认 false，generate/fix 阶段设为 true
}

// 中断事件
interface InterruptEvent {
  type: "user_message";
  content: string;
  timestamp: number;
  intent: "amend" | "switch" | "unrelated"; // 由轻量模型实时分类
}

// 流水线上下文增强
interface PipelineContext {
  taskStack: Task[]; // 任务栈，支持嵌套/挂起
  interruptedAt: number; // 中断时间点
  checkpoint: PipelineState; // 中断前的检查点状态
}

// 中断后的处理策略
const INTERRUPT_STRATEGY = {
  amend: {
    action: "INJECT_CONSTRAINT",
    description: "保留 spec 上下文，追加新约束，重新 generate",
    preserve: ["clarify", "spec"],
    restartFrom: "generate",
  },
  switch: {
    action: "ARCHIVE_AND_RESTART",
    description: "当前任务存档为 draft，启动新流水线",
    preserve: [], // 不保留，但存入 drafts 表
    restartFrom: "clarify",
  },
  unrelated: {
    action: "SUSPEND_AND_RESPOND",
    description: "挂起当前任务，回答插话，询问是否恢复",
    preserve: ["all"], // 保持完整状态
    restartFrom: "resume", // 用户选择恢复时从 checkpoint 继续
  },
};
```

---

## 4. 信息流变化

当前信息流是「单线程」：

```
clarify → spec → approve → generate → verify → done
```

引入打断机制后变为「可抢占式」：

```
clarify → spec → approve → generate ──┬──→ verify → done
                                      │
                         (用户新消息) → 意图分类
                                      │
                                      ├──→ amend: 注入约束，重新 generate
                                      ├──→ switch: 存档，新 clarify
                                      └──→ unrelated: 挂起，回答，询问恢复
```

---

## 5. 数据模型预留

当前数据库已支持（无需改动）：

- `projects` 表：可新增 `status: 'active' | 'draft' | 'archived'`
- `messages` 表：可存中断事件（`role: 'system'`, `content: JSON.stringify(interruptEvent)`）
- 未来新增 `drafts` 表：挂起任务的快照

---

## 6. 当前取舍

| 维度   | 决策                                                  |
| ------ | ----------------------------------------------------- |
| 48h 内 | **不实现**，复杂度超出时间窗口                        |
| 架构   | **已预留**：messages 表可存中断事件，节点接口支持扩展 |
| 文档   | **必须阐述**：体现产品洞察力和差异化思考              |

---

## 7. 与 Atoms / MetaGPT 的对比

| 能力         | MetaGPT   | Atoms（当前）   | mini-atoms（设计预留）    |
| ------------ | --------- | --------------- | ------------------------- |
| 流水线可视化 | ❌ 无     | ✅ 有进度条     | ✅ 阶段卡片               |
| 中途确认门   | ❌ 无     | ✅ approve 节点 | ✅ approve 节点           |
| 用户打断     | ❌ 不支持 | ❌ 不支持       | 🔮 预留架构               |
| 意图分类     | ❌ 无     | ❌ 无           | 🔮 amend/switch/unrelated |
| 任务栈       | ❌ 无     | ❌ 无           | 🔮 taskStack + checkpoint |

---

_最后更新：2026-08-09_
