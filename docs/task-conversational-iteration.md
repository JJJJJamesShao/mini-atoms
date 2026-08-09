# 任务：对话式迭代 — 基于现有代码的增量修改

## 背景

当前 `sendFollowUp` 只传递用户输入字符串，不传递当前版本的 HTML 代码。LLM 每次 follow-up 都从头生成页面，无法基于现有代码做精准修改。

**当前行为**：

```
用户: "把背景改成蓝色"
→ POST /api/pipeline { input: "把背景改成蓝色" }
→ LLM 看不到之前的代码，只能从头猜一个蓝色背景的页面
```

**期望行为**：

```
用户: "把背景改成蓝色"
→ POST /api/pipeline { input: "把背景改成蓝色", currentFiles: [{ path: "index.html", content: "<!DOCTYPE...>" }] }
→ LLM 基于现有代码，输出 Patch 修改背景色
```

## 改动范围

### 1. API 层 — `POST /api/pipeline`

**接收参数扩展**：

```typescript
interface PipelineRequest {
  input: string; // 用户输入（已有）
  projectId?: string; // 现有项目 ID（follow-up 时传入）
  currentFiles?: File[]; // 当前代码文件（follow-up 时传入）
}
```

**逻辑**：

- 如果 `projectId` 存在 → 追加版本（创建 messages + 新版本），不创建新项目
- 如果 `currentFiles` 存在 → 作为 generate 阶段的初始代码传入
- 生成完成后，如果 `projectId` 存在 → 追加版本到该项目

### 2. 前端 Hook — `useWorkspace.ts`

**`sendFollowUp` 修改**：

```typescript
const sendFollowUp = useCallback(
  (request: string) => {
    if (running || !project) return;
    const currentHtml = project.versions[selectedVersionId]?.html;
    void runVersion(request, false, currentHtml);
  },
  [running, project, selectedVersionId, runVersion],
);
```

**`runVersion` 修改**：

- 新增 `currentHtml?: string` 参数
- POST body 增加 `currentFiles` 字段

### 3. Prompt 层 — `buildGeneratePrompt`

**新增 Follow-Up System Prompt**：

````
你收到了一份现有代码和用户的修改需求。
请基于现有代码进行精确修改，只改动需求相关的部分，保持其他代码不变。

现有代码：
```html
{{currentHtml}}
````

修改需求：{{input}}

输出格式：使用 Search/Replace Patch 格式输出修改指令。

````

### 4. Engine 层 — `runSOP`

**`executeStep` 修改**：
- `generate` 步骤接收 `currentFiles` 参数
- 传入 `executors.generate(spec, errors, currentFiles, attempt)`

### 5. LLM Executors — `generate` 方法

**已有支持**：
- `currentFiles` 参数已有（用于 Patch 修复）
- 如果 `currentFiles` 存在 → 走 Patch 模式
- 需要确认：Patch prompt 是否适合 follow-up 场景

**可能需要调整**：
- follow-up 的 Patch prompt 和 fix 的 Patch prompt 略有不同
- fix 的 prompt 强调"修复错误"
- follow-up 的 prompt 强调"按需求修改"

## 验收标准

1. 生成一个待办清单应用
2. 输入 "把背景改成深蓝色"
3. LLM 应该基于现有代码，只修改背景色相关 CSS
4. 预览 iframe 显示修改后的页面，保留所有原有功能（添加/删除/完成待办）
5. 侧栏显示新版本，可以切换回旧版本对比

## 技术细节

### 版本追加逻辑

```typescript
// 新项目（首次生成）
const project = await createProject(input, user.id);
await createVersion(project.id, result.files, 1);

// 现有项目（follow-up）
const versions = await getVersions(projectId);
const nextVersionNo = versions.length + 1;
await createVersion(projectId, result.files, nextVersionNo);
````

### 消息追加逻辑

```typescript
// 每次交互都追加消息
await createMessage(projectId, "user", input);
await createMessage(projectId, "assistant", result.notes || "生成完成");
```

### Memory 处理

- follow-up 时不清除 Memory，让 LLM 看到完整对话历史
- 但 `currentFiles` 优先于 Memory 中的代码，避免 LLM 基于过时代码修改

## 风险与回退

- 如果 LLM 不按 Patch 格式输出 → 回退到完整重写（已有兜底逻辑）
- 如果 Patch 应用失败 → 回退到完整重写（已有兜底逻辑）
- 如果当前 HTML 为空/无效 → 正常从头生成
