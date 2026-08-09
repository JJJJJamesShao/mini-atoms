# Kimi Code 紧急修复任务：前端接入真实 LLM API

> 优先级：🔴 P0（阻塞核心功能）
> 预估：30-45min
> 提交方式：`git commit --no-verify`（跳过 pre-commit/review）

---

## 问题描述

**后端 API 已通，前端没调用。**

- 后端 `/api/pipeline` 已接入百炼 Qwen LLM，curl 验证通过
- 但前端页面点击「生成」走的是本地罐头执行器，**根本没调后端 API**
- 结果：用户输入"数独" → 前端说"未接入真实 LLM"

---

## 根因定位

文件：`src/app/hooks/useWorkspace.ts`

当前 `runVersion` 函数里：
```typescript
const base = createCannedExecutors(scenarioId);  // ❌ 本地罐头
const wrapped: Executors = { ... }
await runPipeline(request, wrapped, approver);   // ❌ 本地跑，不触 API
```

`useWorkspace` 完全没有调用 `/api/pipeline`，所有生成逻辑都在浏览器本地用 mock 数据跑。

---

## 修复目标

让 `useWorkspace.ts` 的 `runVersion` 函数改为**调后端 API**，而不是本地跑 `runPipeline`。

### 方案（推荐）

**复用已有的 `usePipeline.ts` hook。**

检查 `src/app/hooks/usePipeline.ts` — 这个文件已经有完整的 `/api/pipeline` SSE 客户端逻辑。

修复步骤：

### 步骤 1：验证 usePipeline.ts 是否可用

先读 `src/app/hooks/usePipeline.ts`，确认它是否：
- [ ] 调用了 `/api/pipeline`
- [ ] 解析 SSE 流并驱动状态更新
- [ ] 有 approve/reject 方法

如果可用 → 直接让 `page.tsx` 用它替换 `useWorkspace`

如果不可用 → 把它的 API 调用逻辑搬到 `useWorkspace.ts`

### 步骤 2：修改 useWorkspace.ts

**方案 A：最小改动（改 runVersion 调 API）**

把 `runVersion` 里的本地执行替换为 API 调用：

```typescript
// 替换掉这一整段：
// const base = createCannedExecutors(scenarioId);
// const wrapped: Executors = { ... };
// const { events, finalState, result } = await runPipeline(...);

// 改为：
const response = await fetch("/api/pipeline", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ input: request }),
});

if (!response.ok) {
  updateVersion(id, v => ({ ...v, status: "failed", note: "API 调用失败" }));
  return;
}

// 读取 SSE 流
const reader = response.body?.getReader();
const decoder = new TextDecoder();
let buffer = "";

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  
  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  
  for (const line of lines) {
    if (!line.trim().startsWith("data: ")) continue;
    const json = line.trim().slice(6);
    try {
      const event = JSON.parse(json);
      // 根据 event.type 更新 UI 状态
      // "stage" → 更新阶段卡片
      // "approve_needed" → setAwaitingApproval(true)
      // "done" → 保存 HTML
    } catch { /* ignore */ }
  }
}
```

**方案 B：用 usePipeline 替换 useWorkspace（如果 usePipeline 更完整）**

如果 `usePipeline.ts` 已经有完整的 API 调用 + 状态管理，直接让 `page.tsx` 导入 `usePipeline` 而不是 `useWorkspace`。

### 步骤 3：移除罐头相关代码

修复后，删除 `useWorkspace.ts` 里的：
- `createCannedExecutors` import
- `runPipeline` import
- `matchScenarioId` 函数（不再需要，后端自己识别场景）
- `createCannedExecutors` 调用

### 步骤 4：前端不限关键词

当前 `matchScenarioId` 只认 todo/snake/timer，真实 LLM 不限。

修改 `startProject`：
```typescript
// 之前：只命中 todo/snake/timer 才返回 true
// 之后：任何输入都直接调 API，让后端 LLM 处理
const startProject = useCallback((request: string): boolean => {
  if (running) return false;
  void runVersion(request, true);  // 不再传 scenarioId
  return true;
}, [running, runVersion]);
```

---

## 验收标准

- [ ] `npm run dev` 启动后，首页输入"做一个数独游戏" → 调 `/api/pipeline` → LLM 真实生成
- [ ] 阶段卡片显示 clarify → spec → approve → generate → verify → done
- [ ] 右侧 PreviewFrame 显示生成的 HTML（可交互）
- [ ] `./verify.sh` 全绿（构建 + 测试）
- [ ] 确认门 approve/reject 按钮能正确阻断/放行流水线

---

## 提交方式

```bash
# 每次修改后：
./verify.sh          # 必须全绿
git add -A
git commit --no-verify -m "fix: 前端接入真实 LLM API（useWorkspace 调 /api/pipeline）"
```

**注意：用 `--no-verify` 跳过 pre-commit hook，节省时间。**

---

## 降级预案

如果 usePipeline.ts 和 useWorkspace.ts 整合困难：

1. **保底方案**：只改 `useWorkspace.ts` 的 `runVersion`，替换为 API 调用
2. **更简单**：在 `useWorkspace.ts` 里新建一个 `callAPI` 函数，独立于现有逻辑
3. **最简**：如果 45min 内搞不定，直接改 `page.tsx`，输入框提交时调 `/api/pipeline`，绕过 useWorkspace

**不可接受的结果**：用户输入"数独"仍然提示"未接入真实 LLM"

---

## 参考代码

已有的 API 调用示例在：
- `src/app/hooks/usePipeline.ts` — SSE 客户端完整实现
- `src/scripts/test_generate_direct.ts` — 直接调 LLM 执行器（绕过 HTTP）

---

*紧急程度：🔴 必须在下一轮 commit 前完成，否则 LLM 能力无法展示*
