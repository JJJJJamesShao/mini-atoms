# Agent 消息总线设计 — 最小可行方案

> 目标：1-2h 内构建内存级 EventBus + Agent 订阅机制，不改变现有接口

---

## 核心问题

当前架构是**单线程顺序执行**：
```
runPipeline → clarify → spec → approve → generate → verify → done
```

问题是：
1. generate 节点阻塞 30-60s，期间前端收不到任何事件
2. 没有"子 Agent"概念，无法并行/异步处理
3. 前端只能通过 SSE 被动接收，无法主动查询执行队列状态

---

## 设计方案：内存 EventBus

### 架构图

```
┌─────────────────────────────────────────────┐
│              EventBus (内存)                 │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐       │
│  │clarify  │ │spec     │ │generate │ ...    │
│  │Agent    │ │Agent    │ │Agent    │        │
│  └────┬────┘ └────┬────┘ └────┬────┘       │
│       │           │           │             │
│       └───────────┴───────────┘             │
│                   │                         │
│              ┌────┴────┐                    │
│              │ emit()  │ ──→ 前端 SSE       │
│              └─────────┘                    │
└─────────────────────────────────────────────┘
```

### 关键设计

**1. Agent 定义**
```typescript
interface Agent {
  name: string;
  role: string;  // "产品经理" / "架构师" / "工程师"
  execute: (context: Context) => Promise<Result>;
}
```

**2. 事件类型**
```typescript
type AgentEvent = 
  | { type: "agent:start"; agent: string; input: unknown }
  | { type: "agent:thinking"; agent: string; message: string }
  | { type: "agent:progress"; agent: string; percent: number }
  | { type: "agent:complete"; agent: string; output: unknown }
  | { type: "agent:error"; agent: string; error: string }
```

**3. EventBus**
```typescript
class AgentEventBus {
  private listeners = new Map<string, Set<(event: AgentEvent) => void>>();
  
  subscribe(agent: string, callback: (event: AgentEvent) => void) {
    // 前端 SSE 订阅 / 其他 Agent 订阅
  }
  
  emit(event: AgentEvent) {
    // 广播给所有订阅者
  }
}
```

---

## 为什么这是"最小可行"

| 方案 | 时间 | 复杂度 | 效果 |
|------|------|--------|------|
| 内存 EventBus | 1h | 低 | 解决实时性问题 |
| Redis Pub/Sub | 3h | 中 | 支持多实例，但过度 |
| 重写为 LangChain/AutoGen | 8h+ | 高 | 太重，时间不够 |

**选择内存 EventBus 的理由：**
- Vercel 是单实例（Hobby），内存共享
- 不需要持久化，SSE 连接期间有效即可
- 改动最小，不破坏现有接口

---

## 实施步骤

### Step 1: 创建 EventBus（15min）

```typescript
// src/lib/agent/bus.ts
export class AgentEventBus {
  private listeners = new Map<string, Set<(event: AgentEvent) => void>>();
  private globalListeners = new Set<(event: AgentEvent) => void>();

  subscribe(agent: string, cb: (e: AgentEvent) => void) {
    if (!this.listeners.has(agent)) this.listeners.set(agent, new Set());
    this.listeners.get(agent)!.add(cb);
    return () => this.listeners.get(agent)?.delete(cb);
  }

  subscribeAll(cb: (e: AgentEvent) => void) {
    this.globalListeners.add(cb);
    return () => this.globalListeners.delete(cb);
  }

  emit(event: AgentEvent) {
    this.globalListeners.forEach(cb => cb(event));
    this.listeners.get(event.agent)?.forEach(cb => cb(event));
  }
}

export const bus = new AgentEventBus();
```

### Step 2: 包装执行器为 Agent（30min）

```typescript
// src/lib/agent/actors.ts
export function createAgentExecutors(bus: AgentEventBus): Executors {
  return {
    clarify: async (input) => {
      bus.emit({ type: "agent:start", agent: "clarify", input });
      const result = await llm.clarify(input);
      bus.emit({ type: "agent:complete", agent: "clarify", output: result });
      return result;
    },
    generate: async (spec, errors) => {
      bus.emit({ type: "agent:start", agent: "generate", input: spec });
      
      // 模拟进度事件（实际 LLM 不支持，但可以给前端反馈）
      const progressInterval = setInterval(() => {
        bus.emit({ type: "agent:thinking", agent: "generate", message: "正在生成代码..." });
      }, 3000);
      
      const result = await llm.generate(spec, errors);
      clearInterval(progressInterval);
      
      bus.emit({ type: "agent:complete", agent: "generate", output: result });
      return result;
    },
    // ... 其他节点
  };
}
```

### Step 3: API Route 接入 Bus（15min）

```typescript
// app/api/pipeline/route.ts
const bus = new AgentEventBus();

// 流水线执行时，bus 事件自动推送到 SSE
bus.subscribeAll((event) => {
  send({ type: "agent_event", ...event });
});

const executors = createAgentExecutors(bus);
```

### Step 4: 前端解析 Agent 事件（30min）

```typescript
// useWorkspace.ts
if (event.type === "agent_event") {
  const ae = event.payload as AgentEvent;
  if (ae.type === "agent:thinking") {
    setStage(ae.agent, "active", ae.message);
  }
}
```

---

## 产出

实施后，用户会看到：

```
[需求澄清] ✓ 完成
[规格生成] ✓ 完成
[规格确认] ⏳ 等待用户...
[代码生成] 🔄 正在生成代码... (已用时 12s)
```

generate 阶段每 3 秒刷新一次"正在生成代码..."，用户知道系统在干活。

---

## 时间估算

- Step 1: 15min
- Step 2: 30min
- Step 3: 15min
- Step 4: 30min
- 测试: 30min

**总计：约 2h**

---

## 风险

- 内存 EventBus 在 Vercel 冷启动时会丢失状态 → 可接受（每次请求独立）
- generate 阶段的 progress 事件是模拟的（LLM 不支持真进度）→ 可接受（至少让用户知道在跑）

---

*设计时间：2026-08-10 00:30*
