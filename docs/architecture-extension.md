# MetaGPT 架构扩展路线图 — mini-atoms 设计文档

> 本文档记录当前架构状态与扩展路径，供评审理解设计取舍。

---

## 一、当前架构概览（已实现）

```
用户输入 → SOP Router → SOP 配置 → runSOP() → Agent EventBus → 前端 SSE
                ↑              ↑
           selectSOP()      Role + Action
           (关键词匹配)     (PM/Architect/Engineer/Reviewer)
```

**已实现：**
- ✅ SOP 动态路由（web-app / game / tool）
- ✅ Role 角色基类（4 个预设角色）
- ✅ 顺序执行引擎（条件分支 + fix 循环）
- ✅ 内存 EventBus（emit/subscribe）
- ✅ 前端 SSE 实时推送
- ✅ Topic-based Pub/Sub 消息池（PRD/ARCH_SPEC/CODE/REVIEW/SYSTEM，v2）
- ✅ Agent Memory 隔离（每 Role 独立 AgentMemory + prepareContext 自动组装，v2）
- ✅ Engineer 结构化输出（CodeArtifact Schema，游戏 SOP 强制、其他 SOP 降级，v2）

---

## 二、四个缺失点的扩展设计

### 缺失 1：消息队列（当前为内存，无持久化）

**当前：**
```typescript
// 内存总线 —— 进程重启即丢失
const bus = new AgentEventBus(); // Map<string, Set<Handler>>
```

**问题：**
- Vercel serverless 多实例不共享内存
- 请求结束后总线销毁，无法回溯历史
- 没有消息持久化，无法做审计/回放

**扩展方案（生产环境）：**
```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Agent A    │────→│  Redis       │←────│   Agent B    │
│   (emit)     │     │  Streams     │     │  (subscribe) │
└──────────────┘     └──────────────┘     └──────────────┘
       ↑                                          ↓
       └──────────────┐              ┌─────────────┘
                        │ 消息持久化   │
                        ↓              ↓
                   ┌──────────────┐
                   │  PostgreSQL  │
                   │  messages    │
                   └──────────────┘
```

**关键设计：**
- Redis Streams：实时 pub/sub，支持消费组
- PostgreSQL：消息归档，支持按 session 查询历史
- 消息格式： `{ id, sessionId, type, payload, timestamp, ttl }`

**当前取舍（v2 已落地）：** Topic 路由已实现（`bus.publish/subscribeTopic/queryHistory`，历史上限 100 条）；
消息持久化（Redis Streams + PostgreSQL 归档）仍为生产环境扩展项。

---

### 缺失 2：Agent 输出内容限定（当前部分有 Schema）

**当前：**
| Agent | 输出 | 验证 |
|-------|------|------|
| PM (clarify) | JSON `{status, questions, summary}` | ✅ zod |
| Architect (spec) | JSON `{requirements, constraints, userStories}` | ✅ zod |
| Engineer (generate) | HTML 字符串 | ❌ 无结构化 |
| Reviewer (verify) | JSON `{pass, errors}` | ✅ zod |

**问题：**
- Engineer 输出的是纯 HTML，不是结构化数据
- 无法拆分 CSS/JS/HTML 到不同文件（当前架构支持多文件，但 LLM 不输出结构）
- 下游 Agent 无法精准消费（Reviewer 只能做语法检查，不能做语义检查）

**扩展方案：**
```typescript
// 结构化代码输出
interface CodeArtifact {
  files: Array<{
    path: string;
    type: "html" | "css" | "js" | "json";
    content: string;
    dependencies: string[]; // 依赖的其他文件
  }>;
  metadata: {
    framework: string | null;
    externalDeps: string[];
    bundleSize: number;
  };
}
```

**Prompt 改造：**
```
请按以下 JSON 格式输出代码：
{
  "files": [
    { "path": "index.html", "type": "html", "content": "..." },
    { "path": "style.css", "type": "css", "content": "..." },
    { "path": "app.js", "type": "js", "content": "..." }
  ]
}
```

**当前取舍（v2 已落地）：** `src/lib/schemas/code-artifact.ts` 已实现 CodeArtifact Schema
（files 含 path/type/content/dependencies + metadata + notes）；
游戏 SOP 强制结构化 JSON 输出（专用 prompt + zod 校验），
解析失败自动降级为单文件 HTML 包装，不阻塞流水线；
web-app/tool SOP 保持 HTML 字符串输出（代码质量优先）。

---

### 缺失 3：Agent 订阅消息的机制（当前只有广播）

**当前：**
```typescript
// 所有 Agent 收到所有消息 —— 没有过滤
bus.subscribeAll((event) => { /* 所有 Agent 处理 */ });
```

**问题：**
- 没有"类型化订阅"概念
- PM 的 clarify 输出应该只被 Architect 消费
- Architect 的 spec 输出应该只被 Engineer 消费

**扩展方案（Topic-based Pub/Sub）：**
```typescript
// 消息类型定义
enum MessageType {
  PRD = "PRD",           // 产品需求文档
  ARCH_SPEC = "ARCH_SPEC", // 架构规格
  CODE = "CODE",         // 代码
  REVIEW = "REVIEW",     // 审查意见
}

// Agent 订阅声明
const architect = new Agent({
  role: "架构师",
  subscribe: [MessageType.PRD],     // 只订阅 PRD
  publish: [MessageType.ARCH_SPEC], // 只发布架构规格
});

const engineer = new Agent({
  role: "前端工程师",
  subscribe: [MessageType.ARCH_SPEC], // 只订阅架构规格
  publish: [MessageType.CODE],        // 只发布代码
});
```

**消息总线增强：**
```typescript
class TypedEventBus {
  subscribe<T extends MessageType>(
    type: T, 
    handler: (msg: MessageMap[T]) => void
  ) { ... }
  
  publish<T extends MessageType>(
    type: T, 
    msg: Omit<MessageMap[T], "id" | "timestamp">
  ) { ... }
}
```

**当前取舍（v2 已落地）：** Topic-based Pub/Sub 已实现。
`message.ts` 定义 MessageTopic（PRD/ARCH_SPEC/CODE/REVIEW/SYSTEM）与 TypedMessage；
引擎每步产物按 Topic 发布，Role 按声明的订阅表消费（架构师订 PRD、工程师订 ARCH_SPEC+REVIEW、审查员订 CODE）；
旧 `emit()` 广播保留并兼容映射进 SYSTEM Topic。
SOP 仍为严格顺序执行，并行多 Agent 为后续扩展项。

---

### 缺失 4：记忆内容（当前无上下文记忆）

**当前：**
- 每个请求独立，无跨请求记忆
- 用户说"改成深色" → 系统不知道"改哪个项目"
- 无法做迭代式开发（v1 → v2 → v3）

**扩展方案（三层记忆）：**

```
┌─────────────────────────────────────────────┐
│  L1 短期记忆（Session 级）                    │
│  - 当前对话历史                               │
│  - 最近 3 轮用户输入 + Agent 输出              │
│  - 存储：Redis（5min TTL）                    │
├─────────────────────────────────────────────┤
│  L2 项目记忆（Project 级）                    │
│  - 项目所有版本快照                           │
│  - 用户主动命名的 milestone                   │
│  - 存储：PostgreSQL versions 表               │
├─────────────────────────────────────────────┤
│  L3 长期记忆（User 级）                       │
│  - 用户偏好（风格、常用组件）                  │
│  - 跨项目学习                                 │
│  - 存储：PostgreSQL user_preferences 表       │
└─────────────────────────────────────────────┘
```

**迭代对话实现：**
```typescript
// 用户输入："改成深色模式"
// 系统行为：
1. 从 L2 读取最近版本（v1 的代码）
2. 组装上下文：{ original: v1.code, request: "改成深色模式" }
3. 调用 Engineer Agent：基于 v1 生成 v2
4. 保存 v2 到 L2
```

**当前取舍（v2 部分落地）：** 运行级记忆已实现——每个 Role 持有独立 `AgentMemory`
（容量裁剪防泄漏），执行前 `prepareContext` 从 Bus 拉取订阅 Topic 历史自动组装上下文，
执行器把节点输入/输出写入对应 Memory；`createRoles()` 保证单次运行内与跨会话隔离。
跨请求记忆仍为 L2（PostgreSQL 版本表），L1 跨轮会话记忆 / L3 用户偏好为后续扩展项。

---

## 三、扩展路径总结

| 组件 | 当前（v2） | 生产环境 |
|------|-----------|---------|
| 消息队列 | 内存 EventBus + Topic 路由 + 会话历史（100 条上限） | Redis Streams + PostgreSQL 归档 |
| 输出限定 | 游戏 SOP 结构化 JSON（CodeArtifact），其他 SOP HTML 降级 | 全 SOP 结构化输出 |
| 订阅机制 | Topic-based Pub/Sub + SOP 顺序执行 | Topic 路由 + 并行多 Agent |
| 记忆系统 | 运行级 AgentMemory（Role 隔离）+ L2 项目级（versions 表） | L1 跨轮 + L2 + L3 三层记忆 |

---

## 四、评审视角：为什么当前取舍是正确的

**48h 笔试的核心考察点：**
1. **AI Native 工程化能力** — ✅ SOP 配置 + Role 抽象 + 执行引擎
2. **取舍判断力** — ✅ 知道什么该做、什么该留文档
3. **架构扩展性** — ✅ 接口预留，文档说明扩展路径

**如果强行做满四个缺失点：**
- 时间不够，代码粗糙
- 测试覆盖不足，demo 翻车
- 说明文档没时间写，评审看不懂

**当前策略：**
- 代码展示"能跑通的核心闭环"
- 文档展示"知道完整架构长什么样"
- 面试时口述"如果给我 2 周，我会这样扩展"

---

*文档版本：v2.0 — 2026-08-10（Topic Pub/Sub、Agent Memory、Structured Output 已落地）*
