# mini-atoms 开发迭代日志

> 本次迭代聚焦于 Agent 流水线的健壮性、渲染稳定性与用户体验优化。
> 时间范围：2026-08-09 ~ 2026-08-10

---

## 一、Agent 流水线核心增强

### 1.1 GLM-5.2 流式生成 + 双 Provider 降级

**问题**：百炼 Qwen 在长内容生成时容易超时（>30s），且非流式响应对用户体验差。

**方案**：

- 引入 **GLM-5.2** 作为主要生成模型，支持 128K 上下文 + 流式输出
- 保留 **百炼 Qwen** 作为降级路径（GLM 失败时自动切换）
- `collectStreamWithProgress` 统一收集流式输出，每 200 字符 emit 进度事件

**关键修复**：

- 只收集 `content` 字段，**忽略 `reasoning_content`**（思考过程混入输出导致解析失败）
- `extractHtml` 和 `parseCodeArtifact` 改用贪婪匹配，处理嵌套 markdown 代码块

### 1.2 多轮 Patch 修复（Search/Replace）

**问题**：校验失败后 LLM 完整重写代码，token 浪费且容易引入新问题。

**方案**：引入 **Aider 风格的 Search/Replace Patch 工具**。

```
generate → verify(fail) → patch(精确编辑几百字符) → verify
                        ↓ patch 失败
                     generate(完整重写，兜底)
```

- `parsePatch` / `applyPatch`：解析并应用 Search/Replace 指令
- 最多 **5 轮修复循环**（`MAX_FIX_ATTEMPTS = 5`）
- 失败时自动回退完整重写

### 1.3 结构化输出（CodeArtifact）

游戏 SOP 强制 LLM 输出 JSON 格式：

```json
{
  "files": [{ "path": "index.html", "type": "html", "content": "..." }],
  "metadata": { "framework": null, "externalDeps": [] },
  "notes": "游戏核心机制说明"
}
```

- `parseCodeArtifact`：提取最外层 markdown 代码块中的 JSON
- `mergeToSingleHtml`：多文件合并为单文件（CSS/JS 内联），解决 iframe srcDoc 限制
- `cleanContent`：自动去除 content 中的 ```html/css/js 标记

### 1.4 精确错误定位（Verify 增强）

每个校验错误携带完整上下文：

```typescript
interface VerifyError {
  rule: string; // "syntax" | "security" | "structure"
  message: string; // 人类可读描述
  line?: number; // 全局行号
  column?: number; // 列号
  snippet?: string; // 出错代码片段（含上下文）
  suggestion?: string; // 修复建议
}
```

校验层级：syntax → security → structure，优先级逐级降低。

新增安全校验：

- `<iframe>` / `<object>` / `<embed>` 禁止
- `javascript:` 协议链接禁止
- `onclick` 等内联事件处理器禁止
- `<form action>` 禁止（防止数据外发）

---

## 二、UI/UX 优化

### 2.1 侧栏重构

- **删除 `/projects` 路由**：所有项目通过侧栏"最近项目"展示
- **新增 API**：`GET /api/projects`（列表）、`GET /api/projects/:id`（详情）、`DELETE /api/projects/:id`（删除）、`PATCH /api/projects/:id/pin`（置顶）
- **项目操作菜单**：每个项目右侧 ⋮ 按钮，支持置顶/删除
  - 菜单使用 **fixed 定位**，脱离 overflow 容器限制
  - 置顶项目显示 📌 标记并排在最前

### 2.2 PreviewFrame 加载缓冲

- iframe 加载时显示旋转动画 + "正在加载…"
- `onLoad` 事件自动清除 loading 状态
- 诊断面板：iframe body 为空时显示红色浮动提示

### 2.3 注册限制

- 注册页面显示当前人数：`12 / 20`
- 满员时禁用注册：`名额已满`
- 每日生成额度统一为 **10 次**（不分付费/免费）
- 移除付费账号体系，所有用户统一额度

---

## 三、Bug 修复

### 3.1 渲染失败（73KB → 309 字符）

**根因**：

1. `reasoning_content` 混入 `content` 字段
2. `parseCodeArtifact` 正则非贪婪匹配，遇到内部 ` ``` ` 提前终止

**修复**：

- 流式收集只取 `delta.content`
- 正则改为从第一个 ` ``` ` 到最后一个 ` ``` ` 的贪婪匹配

### 3.2 iframe 不刷新

**根因**：`key` 只依赖 `title`，html 变化不触发重新加载。

**修复**：`useEffect` 监听 `preview?.html` 变化时自动 increment `reloadKey`。

### 3.3 菜单被截断

**根因**：`overflow-y-auto` 容器裁剪了 `absolute` 定位的子元素。

**修复**：菜单状态提升到 `Sidebar` 组件，用 `position: fixed` + `z-index: 9999` 渲染在侧栏 DOM 末尾。

---

## 四、架构决策与取舍

### 4.1 单文件 HTML 是物理极限

在没有云端沙箱之前，单文件内联 HTML 就是当前架构的极限：

- `iframe srcDoc` 无 base URL → 无法加载相对路径资源
- `sandbox="allow-scripts"` 已经是最大权限
- ESM 模块、`import/export` 需要基础 URL 或 blob URL

**未来突破方案**：

- WebContainers（StackBlitz）— 浏览器端运行 Node.js
- Sandpack（CodeSandbox）— 浏览器端 bundler
- 云端构建 + CDN 分发

### 4.2 不做多阶段分层生成

对于复杂项目（如坦克大战），考虑过按层次分阶段生成：

1. 底层工具/物理引擎
2. 实体层（Tank、Bullet）
3. 关卡/渲染/UI

**结论：笔试阶段不做。**

- 需要改 SOP 引擎（阶段间产物传递）+ generate executor（增量构建）+ verify（模块级校验）
- 时间风险高（4-6 小时），可能做不完
- LLM 单文件上限约 5000-8000 行，拆分收益不确定

**替代方案**：Prompt 要求 LLM 按代码层次组织（工具 → 物理 → 实体 → 渲染），多轮 Patch 修复。

### 4.3 移除付费体系

原设计：免费 0 次 + 付费无限
新设计：所有用户统一 10 次/天

**理由**：

- 笔试场景不需要付费闭环
- 减少复杂度（Stripe 集成、付费页面、价格策略）
- 注册限制（20 人上限）已足够控制成本

---

## 五、未来可改善方向

### 5.1 向 atoms 产品形态靠拢

| 方向           | 说明                               | 优先级 |
| -------------- | ---------------------------------- | ------ |
| 多文件项目支持 | 真正的多文件编辑器（文件树 + tab） | 高     |
| 云端沙箱       | WebContainers 或 Sandpack 集成     | 高     |
| 版本对比       | 代码 diff 可视化                   | 中     |
| 实时协作       | 多人同时编辑同一代码               | 低     |
| 部署导出       | 一键导出为独立 HTML/zip            | 中     |

### 5.2 自发性改进

| 方向            | 说明                                | 优先级 |
| --------------- | ----------------------------------- | ------ |
| Patch 多轮循环  | 当前最多 5 轮，可增加自适应终止条件 | 中     |
| 专用 Apply 模型 | 像 Cursor 那样用专门模型做变更应用  | 低     |
| 更智能的匹配    | Levenshtein 距离做模糊匹配          | 中     |
| 代码覆盖率测试  | verify 阶段注入测试用例并运行       | 中     |
| 用户反馈循环    | 用户点击"这个不对"自动触发修复      | 高     |

### 5.3 已知技术债务

- `profiles` 表仍有 `role` 字段（值为 `free`），未来可清理
- `sidebar` 中示例项目硬编码（todo/snake/timer），未来应从数据库加载
- `PreviewFrame` 诊断日志（`console.log`）生产环境应移除
- `createPortal` 方案在 SSR 下可能有 hydration 问题（当前未使用）

---

## 六、测试覆盖

当前测试：67 个全部通过

| 测试文件                     | 覆盖内容                                          |
| ---------------------------- | ------------------------------------------------- |
| `tests/sop.test.ts`          | SOP 引擎核心流程（正常/失败/重试/确认门）         |
| `tests/architecture.test.ts` | 角色 Memory 隔离、CodeArtifact 解析、Topic 消息池 |
| `tests/verify.test.ts`       | 语法/安全/结构校验、错误定位                      |
| `tests/db.test.ts`           | Supabase 真实数据库操作（项目/版本/消息/用户）    |

---

_上次更新：2026-08-10 06:15_
