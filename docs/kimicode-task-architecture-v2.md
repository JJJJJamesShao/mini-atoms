# Kimi Code 任务：MetaGPT 架构补全（4h）+ Heavy Load 测试（1h）

> 目标：补全 MetaGPT 核心三件套 — Topic Pub/Sub、Agent Memory、Structured Output
> 分支：feat/agent-bus（继续在此分支开发）
> 提交：每步 --no-verify，最终统一 verify

---

## 前置状态

当前已实现（commit aaaeeb1）：
- Role 基类 + 4 预设角色
- SOP DSL + 3 套流程（web-app/game/tool）
- runSOP() 执行引擎
- 关键词路由
- 内存 EventBus（全局广播）

---

## 任务一：Topic-based EventBus（1.5h）

**目标**：把全局广播改成按 Topic 路由，实现真正的 Agent 间通信。

### 1.1 消息类型定义

**新增**：`src/lib/agent/message.ts`

```typescript
export enum MessageTopic {
  PRD = "PRD",              // 产品需求（PM → Architect）
  ARCH_SPEC = "ARCH_SPEC",  // 架构规格（Architect → Engineer）
  CODE = "CODE",            // 代码（Engineer → Reviewer）
  REVIEW = "REVIEW",        // 审查意见（Reviewer → Engineer/PM）
  SYSTEM = "SYSTEM",        // 系统事件（start/complete/error）
}

export interface TypedMessage {
  id: string;
  topic: MessageTopic;
  from: string;       // Agent 名称
  to?: string;        // 目标 Agent（可选，广播时省略）
  payload: unknown;
  timestamp: number;
  sessionId: string;
}
```

### 1.2 EventBus 增强

**修改**：`src/lib/agent/bus.ts`

当前：`bus.emit({ type, agent, ... })`
目标：
```typescript
class TypedEventBus {
  private subscribers = new Map<MessageTopic, Set<(msg: TypedMessage) => void>>();
  private history: TypedMessage[] = []; // 会话级历史
  
  // 按 Topic 订阅
  subscribe(topic: MessageTopic, handler: (msg: TypedMessage) => void): () => void;
  
  // 按 Topic 发布
  publish(topic: MessageTopic, msg: Omit<TypedMessage, "id" | "timestamp">): void;
  
  // 查询历史（用于 Agent 初始化时恢复上下文）
  queryHistory(topic: MessageTopic, sessionId: string): TypedMessage[];
  
  // 保持向后兼容：旧 emit 映射到新 publish
  emit(event: AgentEvent): void; // 内部转 publish(SYSTEM, ...)
}
```

**约束**：
- 旧代码（llm-executors.ts 等）的 `bus.emit()` 不能改，内部兼容
- 新增 `bus.publish()` 供新架构使用
- `history` 限制 100 条，防内存泄漏

### 1.3 接入执行引擎

**修改**：`src/lib/agent/engine.ts`

当前：runSOP 直接调用执行器
目标：
```typescript
// 每个步骤变成：发布消息 → 等待订阅者消费 → 收到响应
async function runSOP(...) {
  for (const step of sop.steps) {
    const topic = stepToTopic(step.name); // clarify → PRD, spec → ARCH_SPEC
    
    // 发布任务消息
    bus.publish(topic, {
      from: step.role,
      payload: { task: step.action, context: stepResults },
      sessionId,
    });
    
    // 等待对应 Agent 消费并响应
    const result = await waitForResponse(topic, sessionId, timeout);
    stepResults.set(step.name, result);
  }
}
```

**注意**：当前 SOP 是严格顺序的，不用实现真正的并行多 Agent。重点是**消息按 Topic 路由**，架构上预留并行能力。

---

## 任务二：Agent Memory 隔离（1.5h）

**目标**：每个 Agent 有自己的记忆上下文，执行时自动组装。

### 2.1 Memory 抽象

**新增**：`src/lib/agent/memory.ts`

```typescript
export interface MemoryEntry {
  id: string;
  topic: MessageTopic;
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export class AgentMemory {
  private entries: MemoryEntry[] = [];
  private maxEntries: number;
  
  constructor(options?: { maxEntries?: number }) {
    this.maxEntries = options?.maxEntries ?? 50;
  }
  
  add(entry: Omit<MemoryEntry, "id" | "timestamp">): void {
    this.entries.push({
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      ...entry,
    });
    // 裁剪旧条目
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }
  }
  
  // 查询某 Topic 的记忆
  query(topic: MessageTopic, limit?: number): MemoryEntry[];
  
  // 组装 Prompt 上下文
  buildContext(systemPrompt: string): Array<{role: string, content: string}>;
  
  // 清空
  clear(): void;
}
```

### 2.2 Role 持有独立 Memory

**修改**：`src/lib/agent/role.ts`

```typescript
export class Role {
  memory: AgentMemory;
  
  constructor(public config: RoleConfig) {
    this.memory = new AgentMemory({ maxEntries: config.memoryLimit ?? 50 });
  }
  
  // 执行前：从 Bus 拉取相关 Topic 消息 → 写入 Memory
  prepareContext(bus: TypedEventBus, sessionId: string): void {
    const relevantTopics = this.getSubscribedTopics();
    for (const topic of relevantTopics) {
      const messages = bus.queryHistory(topic, sessionId);
      for (const msg of messages) {
        this.memory.add({
          topic,
          content: JSON.stringify(msg.payload),
          metadata: { from: msg.from },
        });
      }
    }
  }
  
  // 每个 Role 订阅的 Topic
  private getSubscribedTopics(): MessageTopic[] {
    const map: Record<string, MessageTopic[]> = {
      "产品经理": [MessageTopic.SYSTEM],
      "架构师": [MessageTopic.PRD],
      "前端工程师": [MessageTopic.ARCH_SPEC, MessageTopic.REVIEW],
      "代码审查员": [MessageTopic.CODE],
    };
    return map[this.config.name] ?? [];
  }
}
```

### 2.3 执行器使用 Memory

**修改**：`src/lib/agent/llm-executors.ts`

当前：
```typescript
async function generate(spec, errors) {
  const messages = buildMessages(spec, errors); // 临时组装
  return llm.chat(messages);
}
```

目标：
```typescript
async function generate(spec, errors, memory) {
  // 1. 把输入写入 Memory
  memory.add({ topic: MessageTopic.ARCH_SPEC, content: JSON.stringify(spec) });
  if (errors) {
    memory.add({ topic: MessageTopic.REVIEW, content: JSON.stringify(errors) });
  }
  
  // 2. 从 Memory 组装上下文（包含历史修正记录）
  const context = memory.buildContext(SYSTEM_GENERATE);
  
  // 3. 调用 LLM
  const result = await llm.chat(context);
  
  // 4. 把输出写入 Memory
  memory.add({ topic: MessageTopic.CODE, content: result });
  
  return result;
}
```

---

## 任务三：Structured Output（1h）

**目标**：Engineer Agent 输出结构化代码，支持真正的多文件。

### 3.1 代码结构 Schema

**新增**：`src/lib/schemas/code-artifact.ts`

```typescript
import { z } from "zod";

export const FileSchema = z.object({
  path: z.string(),           // "index.html"
  type: z.enum(["html", "css", "js", "json", "svg"]),
  content: z.string(),
  dependencies: z.array(z.string()).default([]), // 依赖的其他文件路径
});

export const CodeArtifactSchema = z.object({
  files: z.array(FileSchema).min(1),
  metadata: z.object({
    framework: z.string().nullable().default(null),
    externalDeps: z.array(z.string()).default([]),
    bundleSize: z.number().optional(),
  }).default({ framework: null, externalDeps: [] }),
  notes: z.string().optional(),
});

export type CodeArtifact = z.infer<typeof CodeArtifactSchema>;
```

### 3.2 Engineer Prompt 改造

**修改**：`src/lib/llm/prompts.ts`

新增游戏专用 prompt（结构化输出）：

```typescript
export const SYSTEM_GENERATE_GAME = `你是一位 HTML5 游戏开发专家。

## 输出格式（严格 JSON）
你必须输出合法的 JSON，格式如下：
{
  "files": [
    {
      "path": "index.html",
      "type": "html",
      "content": "<!DOCTYPE html>...",
      "dependencies": ["game.js"]
    },
    {
      "path": "game.js",
      "type": "js",
      "content": "...",
      "dependencies": []
    }
  ],
  "metadata": {
    "framework": null,
    "externalDeps": []
  },
  "notes": "游戏核心机制说明..."
}

## 约束
- 无外部依赖，原生 JS + Canvas
- 包含完整的游戏循环、碰撞检测、得分系统
- 支持键盘和触摸控制
- 单文件优先（index.html 内联所有代码）
`;
```

### 3.3 执行器解析结构化输出

**修改**：`src/lib/agent/llm-executors.ts`

```typescript
async function generate(spec, errors, memory) {
  const response = await llm.chat(context);
  
  // 尝试解析 JSON
  try {
    const parsed = JSON.parse(response);
    const validated = CodeArtifactSchema.parse(parsed);
    return validated;
  } catch {
    // 降级：把纯 HTML 包装成单文件 CodeArtifact
    return {
      files: [{ path: "index.html", type: "html", content: response, dependencies: [] }],
      metadata: { framework: null, externalDeps: [] },
    };
  }
}
```

**约束**：
- 游戏 SOP 强制结构化输出
- 其他 SOP 保持兼容（降级到单文件 HTML）

---

## 任务四：Heavy Load 测试（1h）

**目标**：验证架构在高并发/大输入下的稳定性。

### 4.1 并发测试

**新增**：`tests/heavy-load.test.ts`

```typescript
describe("Heavy Load", () => {
  it("10 个并发请求", async () => {
    const inputs = Array(10).fill("做一个计算器");
    const results = await Promise.all(inputs.map(i => runPipeline(i, executors)));
    expect(results.every(r => r.finalState === "done")).toBe(true);
  });
  
  it("超大输入（5000 字符）", async () => {
    const input = "x".repeat(5000);
    const result = await runPipeline(input, executors);
    expect(result.finalState).toBe("done");
  });
  
  it("内存泄漏检测", async () => {
    const initialMemory = process.memoryUsage().heapUsed;
    for (let i = 0; i < 50; i++) {
      await runPipeline("做一个待办清单", executors);
    }
    const finalMemory = process.memoryUsage().heapUsed;
    // 内存增长应 < 50MB
    expect(finalMemory - initialMemory).toBeLessThan(50 * 1024 * 1024);
  });
});
```

### 4.2 手动压力测试

终端执行：
```bash
# 连续 20 次生成
for i in {1..20}; do
  echo "{"input": "做一个数独游戏 $i"}" | curl -s -X POST https://mini-atoms-five.vercel.app/api/pipeline -d @- &
done
wait
```

### 4.3 观察指标

- [ ] 20 次请求全部成功（最终状态 done）
- [ ] 无内存泄漏（Vercel 日志无 OOM）
- [ ] 响应时间 < 60s（LLM 调用 + 校验）
- [ ] 前端 SSE 无断连

---

## 验收标准（必须全过）

### 代码
- [ ] Topic Pub/Sub 工作（PM 发布 PRD，Architect 能订阅到）
- [ ] Agent Memory 隔离（每个 Role 有自己的记忆）
- [ ] Structured Output 解析成功（游戏 SOP 输出 JSON）
- [ ] 旧 API 兼容（现有测试不挂）

### 测试
- [ ] ./verify.sh 全绿
- [ ] npm run build 成功
- [ ] heavy-load.test.ts 通过
- [ ] 手动 20 次压力测试通过

### 文档
- [ ] 更新 docs/architecture-extension.md（标记已实现的模块）

---

## 禁止

- ❌ 不要改 src/lib/schemas/ 现有接口（新增文件可以）
- ❌ 不要改 src/lib/verify/ 校验层
- ❌ 不要改 src/app/components/ UI 组件
- ❌ 不要引入新 npm 依赖

---

## 时间分配

| 任务 | 时间 | 截止 | 检查点 |
|------|------|------|--------|
| Topic Pub/Sub | 1.5h | 02:55 | Bus 测试通过 |
| Agent Memory | 1.5h | 04:25 | Memory 测试通过 |
| Structured Output | 1h | 05:25 | 游戏 SOP 输出 JSON |
| Heavy Load 测试 | 1h | 06:25 | 20 次并发通过 |
| 缓冲/文档 | 1.5h | 07:55 | 最终 verify |

---

## 降级预案

如果超时：
1. 优先保 Topic Pub/Sub（架构核心）
2. 其次保 Agent Memory（实用）
3. Structured Output 可降级（保持现有 HTML 输出，只加 Schema 定义不启用）

---

*任务包版本：v2.0 — 2026-08-10 01:40*
