# 过程复盘：mini-atoms 开发记录

> 这是一个 AI Agent 驱动的应用生成系统，用户用自然语言描述需求，系统自动完成需求澄清 → 架构规格 → 代码生成 → 语法校验 → 沙箱预览，支持对话式迭代与版本管理。

---

## 一、任务简报

### 1.1 任务概述

**任务来源**：DeepWisdom 笔试题目
**任务要求**：基于 Next.js + TypeScript 构建一个 AI 驱动的应用生成系统，用户通过自然语言描述需求，系统自动生成可运行的 Web 应用。

**核心约束**：

- 前端框架：Next.js + TypeScript + Tailwind CSS
- 数据库：Supabase（PostgreSQL）
- AI 模型：自由选择（最终选用 GLM-5.2 + 百炼 Qwen）
- 部署平台：Vercel
- 笔试时间：约 12 小时（2026-08-09 20:00 ~ 2026-08-10 08:00）

### 1.2 最终成果

**已上线**：https://mini-atoms.vercel.app
**GitHub**：https://github.com/JJJJJamesShao/mini-atoms
**核心功能**：

- 自然语言生成 Web 应用（数独、2048、计时器等）
- 多阶段 Agent 流水线（PM → Architect → Engineer → Reviewer）
- Search/Replace Patch 修复（校验失败后精准编辑，非完整重写）
- 对话式迭代（基于现有代码增量修改）
- 版本管理 + 项目置顶/删除
- 一键导出 HTML

---

## 二、开发过程记录

### 2.1 准备阶段（08-09 20:00 ~ 21:00）

**决策：技术栈选型**

- **前端框架**：Next.js 15（App Router）+ React 19 + TypeScript + Tailwind CSS
- **数据库**：Supabase（PostgreSQL + Auth + RLS）
- **AI 模型**：
  - 主力：GLM-5.2（128K 上下文 + 流式输出）
  - 降级：百炼 Qwen（OpenAI 兼容接口）
- **部署**：Vercel（原生支持 Next.js）

**初始架构设计**：

确定了"多角色 Agent 流水线"的核心架构：

- PM Agent：需求澄清
- Architect Agent：规格生成
- Engineer Agent：代码生成
- Reviewer Agent：自动校验

每个角色有独立的 Memory 池，通过 Topic-based 消息系统共享上下文。

---

### 2.2 核心开发阶段（08-09 21:00 ~ 08-10 04:00）

#### 坑 1：LLM 输出不稳定，长内容生成超时

**问题**：百炼 Qwen 在生成 5000+ 字符的 HTML 时经常超时（>30s），且非流式响应用户体验差。

**解决过程**：

1. 首先尝试增加 timeout，但 30s 是 Vercel Hobby 层的上限，无法突破
2. 尝试换用 GLM-5.2，发现支持 128K 上下文 + 流式输出
3. 实现 `collectStreamWithProgress` 统一收集流式输出，每 200 字符 emit 进度事件到前端
4. 设计降级机制：GLM 失败时自动切换到百炼 Qwen

**关键代码**：`src/lib/llm/client.ts` 中的 `streamGLM` + `streamChat` 双 Provider 设计

#### 坑 2：渲染失败 —— 73KB 流输出只剩 309 字符

**问题**：生成完成后 iframe 显示空白，后端日志显示 "最终 HTML 长度: 309"，但流输出总长度是 73699 字符。

**根因分析**：

1. GLM-5.2 同时输出 `content`（最终代码）和 `reasoning_content`（思考过程）
2. 流式收集代码把两者都拼进去了：`const text = delta || reasoning || ""`
3. `parseCodeArtifact` 用非贪婪正则 `[�-￿]*?` 匹配，遇到内部的 ` ``` ` 就提前终止

**解决**：

1. 只收集 `delta.content`，忽略 `reasoning_content`
2. 正则改为从第一个 ` ``` ` 到最后一个 ` ``` ` 的贪婪匹配
3. 增加 `cleanContent` 函数去除 JSON content 中的 markdown 代码块标记

**教训**：LLM 的输出格式不可信任，必须有严格的解析和清理层。

#### 坑 3：校验失败后完整重写，token 浪费严重

**问题**：verify 发现语法错误后，LLM 收到"有个语法错误"的提示，但它看不到具体哪行错了，只能完整重写代码。导致：

- 每次修复消耗 ~8万 token
- 经常引入新问题
- 修复轮次多（平均 2-3 轮）

**解决过程**：

1. 调研 OpenAI Codex、Aider、RooCode 等工具的实现
2. 发现核心模式：**LLM 输出编辑指令（SEARCH/REPLACE），后端执行替换**
3. 实现 `parsePatch` + `applyPatch` 工具
4. 优化 verify 错误信息，增加行号、列号、代码片段、修复建议
5. 设计多轮 Patch 修复循环（最多 5 轮），失败回退完整重写

**效果**：修复轮次从 2-3 轮降至 1-2 轮，token 消耗降低 90%+。

**关键代码**：`src/lib/agent/patch.ts`

#### 坑 4：iframe 不刷新

**问题**：Patch 修复后的新 HTML 到达前端，但 iframe 仍然显示旧内容。

**根因**：iframe 的 `key` 只依赖 `preview.title`，html 内容变化不会触发重新加载。

**解决**：`useEffect` 监听 `preview?.html` 变化时自动 increment `reloadKey`。

**教训**：React 的 key 机制对 iframe `srcDoc` 不敏感，需要手动触发重新加载。

#### 坑 5：对话式迭代是断的

**问题**：follow-up 时 LLM 看不到之前的代码，只能从头生成。

**根因**：`sendFollowUp` 只传了 `input` 字符串，没有传当前版本的 HTML。

**解决**：

1. `POST /api/pipeline` 接收 `currentFiles` 参数
2. `useWorkspace.sendFollowUp` 获取当前版本 HTML 传给后端
3. generate 阶段检测到 `currentFiles` + 无 `errors` → 走 Follow-up 模式
4. 新增 `buildFollowUpPrompt`，让 LLM 基于现有代码做增量 Patch 修改

**关键决策**：追加版本到现有项目，不创建新项目。这样用户能看到版本演进历史。

---

### 2.3 UI 优化阶段（08-10 04:00 ~ 06:00）

#### 坑 6：侧栏菜单被截断

**问题**：项目右侧的 `⋮` 按钮弹出的菜单，在"最近项目"和"示例"的分界线处被截断，无法点击"删除"。

**根因**：`overflow-y-auto` 容器裁剪了 `absolute` 定位的子元素。

**解决尝试**：

1. 增加菜单宽度 `min-w-[120px]` → `w-[140px]` → 无效
2. 改用 `position: fixed` + `getBoundingClientRect()` 计算坐标 → 菜单不显示
3. 尝试 `createPortal` 渲染到 `document.body` → 和 Next.js hydration 冲突
4. **最终方案**：把菜单状态提升到 `Sidebar` 组件本身，用 `position: fixed` + `z-index: 9999` 渲染在侧栏 DOM 末尾

**教训**：React 中 `overflow` 裁剪问题，`fixed` 定位比 `absolute` 更可靠，但要注意事件委托和关闭逻辑。

#### 坑 7：Vercel 部署 500 错误

**问题**：本地运行正常，部署到 Vercel 后访问 `/api/projects` 返回 500。

**排查过程**：

1. 检查环境变量：发现 SUPABASE_SECRET_KEY 未配置（只配了 NEXT_PUBLIC_SUPABASE_ANON_KEY）
2. 但即使配了 key，仍然 500
3. 检查 Vercel 日志，发现是 Edge Runtime 不支持 `Buffer` API
4. 所有 API 路由添加 `export const runtime = "nodejs"`
5. 新增 `vercel.json` 配置 pipeline 超时 300s

**教训**：Next.js 默认在 Vercel 上可能用 Edge Runtime，需要显式声明 `runtime = "nodejs"`。

---

### 2.4 最终完善阶段（08-10 06:00 ~ 08:00）

#### 代码质量评分

在版本卡片上显示"质量 100"标签，基于 verify 结果计算分数。让系统自检能力可视化。

#### 一键导出 HTML

PreviewFrame 加"下载"按钮，把当前 HTML 保存为 `.html` 文件。用户能下载、本地打开、直接部署。

#### README 重构

从模板级别的 README 重写为展示工程深度的文档：

- Mermaid 架构图
- 4 个核心设计决策详解
- 30 秒速览流程
- 完整技术栈 + 快速开始

#### Demo GIF + 录屏

录制 15 秒动图（输入"做一个数独"→生成→"把背景改成深蓝色"→增量修改）+ 完整录屏，放在 README 顶部。

---

## 三、结果呈现

### 3.1 最终交付物

| 交付物      | 链接                                        | 说明           |
| ----------- | ------------------------------------------- | -------------- |
| 在线应用    | https://mini-atoms.vercel.app               | 已部署，可访问 |
| GitHub 仓库 | https://github.com/JJJJJamesShao/mini-atoms | 完整源码       |
| PR #20      | 对话式迭代 + 环境变量化                     | 已合并         |
| PR #21      | Node.js runtime + Vercel 配置               | 已合并         |
| PR #22      | README 重构 + Demo GIF                      | 已合并         |

### 3.2 功能清单

**✅ 已完成**：

- 自然语言生成 Web 应用
- 多阶段 Agent 流水线（4 角色协作）
- Search/Replace Patch 修复
- 对话式迭代（基于现有代码增量修改）
- 三级自动校验（语法/安全/结构）
- 版本管理 + 项目置顶/删除
- 沙箱预览 + 一键导出
- 代码质量评分
- 用户系统（注册/登录/角色权限）
- 67 个测试全部通过

**⚠️ 已知限制**：

- 单文件架构（复杂项目可能超出承载能力）
- 代码上限约 5000-8000 行有效代码

### 3.3 架构图

```
用户输入 → [PM]澄清 → [Architect]规格 → 确认门
                              ↓
         [Reviewer]校验 ← [Engineer]生成 ← 规格
                ↓ 错误
              修复(Patch) → 再次生成
                ↓ 通过
            沙箱预览 → 持久化 → 版本管理
```

---

## 四、经验总结

### 4.1 技术经验

**LLM 输出不可信任，必须有多层校验**

- 第一层：JSON 结构校验（CodeArtifact Schema）
- 第二层：内容清理（去除 markdown 代码块标记）
- 第三层：语法校验（acorn 解析 JS）
- 第四层：安全校验（禁止 iframe、XSS 向量）
- 第五层：结构校验（DOCTYPE、外部资源、大小限制）

**Prompt 工程比模型选择更重要**

同样的 GLM-5.2，好的 Prompt（精确错误定位 + 代码片段）能让修复成功率显著提升。关键不是用多强的模型，而是给模型足够精确的上下文。

**流式输出是必选项**

非流式响应在生成长内容时用户体验极差（白屏 30 秒）。流式输出 + 实时进度推送是必须的。

### 4.2 工程经验

**先跑通端到端，再优化细节**

第一轮只实现了 clarlify → spec → generate → verify 的基础流程，没有 Memory 隔离、没有 Patch 修复。先让整个流程能跑通，生成一个能玩的数独，然后再逐步优化每个环节。

**调试信息要充足**

在 pipeline API 中加了很多 `console.log`（HTML 长度、是否含 DOCTYPE、iframe body 内容等），这些在排查渲染问题时起了关键作用。

**测试不能省**

67 个测试覆盖了 SOP 引擎、架构隔离、代码校验、数据库操作。每次重构后跑一遍测试，能快速发现回归问题。

### 4.3 AI 工具使用经验

**主力 vs 辅助的分工**

- **Kimi Code（主力，~80%）**：承担架构设计、核心模块实现、Bug 修复。K3 模型在代码生成和上下文理解上表现稳定。
- **Cloud Code + DeepSeek V4 Flash（辅助）**：配合处理部分模块，但因订阅稳定性问题未作为主力。
- **Claude Code（Review）**：用于代码审查和架构合理性验证，发现潜在问题（如 Memory 隔离边界、错误处理路径）。

**AI 适合生成框架，边界情况需人工处理**

Patch 工具的核心逻辑由 AI 设计，但边界情况（如嵌套 markdown 代码块的解析、Patch 匹配失败时的回退逻辑）需要人工补充。

---

## 五、参考资料

- [项目 GitHub 仓库](https://github.com/JJJJJamesShao/mini-atoms)
- [在线体验](https://mini-atoms.vercel.app)
- [CHANGELOG.md](CHANGELOG.md) — 完整迭代日志
- [docs/spec.md](docs/spec.md) — 系统规格文档
- [docs/task-conversational-iteration.md](docs/task-conversational-iteration.md) — 对话式迭代设计
