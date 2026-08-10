# Kimi Code Prompt — 实时代码摘要进度提示

## 任务

在 Agent 流水线的生成阶段，增加**异步代码摘要**机制：

- 后端定期将已生成的代码片段发送给快模型（Qwen 3.6 Flash）
- 快模型返回当前正在生成哪部分代码的摘要
- 摘要通过 SSE 推送到前端，显示在版本卡片或进度区域

## 背景

当前问题：用户看到"Engineer 正在生成代码..."但不知道具体在干什么。对于复杂任务（生成 5000+ 行代码），用户会感到"卡住"。

**目标**：让用户看到类似这样的进度提示：

```
Engineer 正在生成代码...
  → 正在构建 HTML 骨架和 CSS 样式...
  → 正在添加游戏网格渲染逻辑...
  → 正在实现键盘事件处理...
  → 正在添加得分和动画效果...
```

## 技术方案

### 架构图

```
[GLM-5.2 流式生成] ──→ [收集器] ──→ [主输出]
       │                    │
       │          （每 3000 字符 or 每 10 秒）
       │                    ▼
       │            [摘要触发器]
       │                    │
       │                    ▼
       │            [Qwen 3.6 Flash]
       │            "总结这段代码在做什么"
       │                    │
       │                    ▼
       └───────────→ [SSE 推送]
                         │
                         ▼
                    [前端进度显示]
```

### 关键设计

1. **异步非阻塞**：摘要请求不阻塞主生成流程
2. **节流控制**：最多每 10 秒 or 每 3000 字符触发一次
3. **快模型**：Qwen 3.6 Flash（成本低、速度快）
4. **前端覆盖**：新的摘要覆盖旧的，始终显示最新进度

## 需要修改的文件

### 1. `src/lib/agent/llm-executors.ts`

在 `collectStreamWithProgress` 中添加摘要逻辑：

```typescript
/**
 * 异步代码摘要器
 * 定期将已收集的代码发送给快模型，获取进度摘要
 */
class CodeSummarizer {
  private lastSummaryTime = 0;
  private lastSummaryLength = 0;
  private isSummarizing = false;

  // 触发条件
  private readonly MIN_INTERVAL = 10000; // 最少 10s 间隔
  private readonly MIN_CHARS = 3000; // 最少新增 3000 字符

  async maybeSummarize(content: string, onSummary: (summary: string) => void) {
    const now = Date.now();
    const newChars = content.length - this.lastSummaryLength;

    // 节流：时间间隔 + 新增字符数
    if (now - this.lastSummaryTime < this.MIN_INTERVAL) return;
    if (newChars < this.MIN_CHARS) return;
    if (this.isSummarizing) return; // 避免并发

    this.isSummarizing = true;
    this.lastSummaryTime = now;
    this.lastSummaryLength = content.length;

    try {
      // 截取最近生成的代码（避免超长）
      const snippet = content.slice(-4000); // 最后 4000 字符
      const summary = await this.summarize(snippet);
      onSummary(summary);
    } catch (e) {
      // 摘要失败静默处理，不影响主流程
      console.warn("[Summarizer] failed:", e);
    } finally {
      this.isSummarizing = false;
    }
  }

  private async summarize(snippet: string): Promise<string> {
    const messages = [
      {
        role: "system" as const,
        content: `你是一位代码分析助手。请用一句话（不超过 20 个字）总结这段代码正在实现什么功能。只输出总结，不要解释。`,
      },
      {
        role: "user" as const,
        content: `代码片段：\n${snippet.slice(-2000)}`, // 最后 2000 字符
      },
    ];

    const response = await chat(MODEL_ROUTING.clarify, messages);
    return response.choices[0]?.message?.content?.trim() || "";
  }
}
```

在 `collectStreamWithProgress` 中集成：

```typescript
const summarizer = new CodeSummarizer();

for await (const chunk of stream) {
  // ... 原有收集逻辑 ...

  // 触发摘要（异步，不阻塞）
  void summarizer.maybeSummarize(content, (summary) => {
    bus?.emit({
      type: "agent:summary",
      agent: "engineer",
      role: "前端工程师",
      message: summary,
    });
  });
}
```

### 2. `src/lib/agent/bus.ts`

确认 `AgentEvent` 类型支持 `summary`：

```typescript
export type AgentEvent =
  | { type: "agent:start"; ... }
  | { type: "agent:progress"; ... }
  | { type: "agent:thinking"; ... }
  | { type: "agent:summary"; agent: string; role: string; message: string; }  // 新增
  | { type: "agent:complete"; ... }
  | { type: "agent:error"; ... }
  | { type: "file:generated"; ... };
```

### 3. `src/app/hooks/useWorkspace.ts`

处理 `agent:summary` 事件：

```typescript
case "agent:summary":
  if (isActive) {
    setExecutionLogs((prev) => [
      ...prev,
      { agent: payload.agent, role: payload.role, message: payload.message },
    ]);
    // 更新当前版本的 note 显示摘要
    setProject((prev) => {
      if (!prev) return prev;
      const versions = [...prev.versions];
      const idx = versions.findIndex((v) => v.id === activeVersionId.current);
      if (idx !== -1) {
        versions[idx] = {
          ...versions[idx],
          note: payload.message, // 用摘要覆盖 note
        };
      }
      return { ...prev, versions };
    });
  }
  break;
```

### 4. `src/app/components/VersionCard.tsx`

显示摘要信息：

```typescript
// 在运行中状态下显示当前摘要
{version.status === "running" && version.note && (
  <div className="mt-1 flex items-center gap-1 text-[10px] text-blue-600">
    <span className="animate-pulse">●</span>
    <span>{version.note}</span>
  </div>
)}
```

## 关键约束

1. **不能阻塞主生成流程**：摘要是异步的，用 `void summarizer.maybeSummarize()`
2. **不能影响 token 消耗**：摘要用 Qwen 3.6 Flash（便宜快），不用 GLM-5.2
3. **失败静默处理**：摘要失败不影响主流程
4. **节流控制**：避免频繁调用快模型

## 测试步骤

1. 启动项目，登录后生成一个复杂应用（如"做一个俄罗斯方块"）
2. 观察版本卡片下方是否出现进度摘要
3. 检查网络请求：应该有对 Qwen 3.6 Flash 的调用
4. 确认主生成流程不受阻塞

## 验收标准

- [ ] 生成过程中版本卡片显示进度摘要（如"正在添加键盘控制..."）
- [ ] 摘要每 10s 或每 3000 字符更新一次
- [ ] 摘要请求不阻塞主生成流程
- [ ] 摘要失败不影响生成
- [ ] 67 个测试全部通过
