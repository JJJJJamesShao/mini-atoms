# mini-atoms 开发迭代日志

> 本次迭代聚焦于 Agent 流水线的健壮性、渲染稳定性、用户体验优化与增量修改能力。
> 时间范围：2026-08-09 ~ 2026-08-12

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

### 1.2 LLM 调用全流式化（PR #33）

**问题**：clarify/spec 等非流式调用同样会被代理静默挂起，且前端无进度反馈。

**方案**：

- 所有 LLM 调用统一走流式路径（`streamChat` / `streamGLM`）
- 提取公共模块：`collectStreamText` + `throttleByChars` + 超时档位配置
- 超时档位：
  - GENERATE：idle 60s / total 600s（大文件生成正常时长）
  - FAST_JSON：idle 60s / total 120s（KB 级 JSON）
  - SUMMARY：idle 30s / total 60s（一句话摘要）

**关键修复**：

- 此前 follow-up 回退完整重写被 300s 超时误杀，放宽到 600s 后问题解决
- 流式公共模块消除 stage/follow-up/patch 三处重复代码

### 1.3 多轮 Patch 修复（Search/Replace）

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

### 1.4 增量修改小循环（Modify SOP，PR #34）

**问题**：用户说"把背景改成蓝色"时，传统方案要么完整重写（慢+贵），要么直接 Patch（锚点匹配率低、常失败）。

**方案**：引入 **Locate→Patch→Apply→Verify 小循环**：

```
Locate（快模型）: "用户要改背景色，目标在第 45 行的 CSS 块"
     ↓
Patch（强模型）: "生成精确的 SEARCH/REPLACE 指令"
     ↓
Apply（零 LLM）: "三级模糊匹配（精确→行尾归一化→忽略缩进）"
     ↓
Verify（零 LLM）: "语法/安全/结构校验"
     ↓
done / fix-patch（最多 5 轮）
```

**设计要点**：

- locate 把"在哪里改"从 patch 里拆出来，降低 SEARCH 块不匹配率
- apply 三级匹配：精确 → 行尾空白归一化 → 忽略缩进逐行对齐
- 失败原因带近似位置提示，回传 patch 模型重试
- 每次重试基于**原始代码**重新生成补丁（不在半成品上叠加）
- 无 approve 门：修改是对既有规格的增量，不需要重新确认
- 次数用尽 → fail 保留旧版本（v1 砍掉自动回退完整重写——最贵且曾引发 300s 超时误杀的路径）

**收益**：

- 修改只需几百字符的 Patch，而非完整重写
- Apply 三级匹配降低锚点漂移导致的失败率
- 用户始终有旧版本可回退

### 1.5 多阶段 SOP 编排（fullstack-app，PR #32）

**问题**：复杂项目（带数据库/登录/多页面）单文件生成易超出 LLM 上下文或质量下降。

**方案**：分阶段分层生成：

```
clarify → spec → approve
  → generate-schema → verify-schema
  → generate-shell → verify-shell
  → generate-pages → verify-pages
  → merge（零 LLM 字符串组装）
  → verify → done
```

- 每个阶段产物存入 `stage_outputs`，供后续阶段引用
- 缺页检测：merge 时检查 pages 与 shell 占位符匹配，不匹配则回 fix-pages 重修
- 确定性 merge：零 LLM 字符串组装，schema + shell + pages → index.html

### 1.6 结构化输出（CodeArtifact）

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

### 1.7 精确错误定位（Verify 增强）

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

## 二、稳定性与持久化

### 2.1 SSE 心跳保活 + 断流兜底（PR #29）

**问题**：复杂任务生成时间超过 30-60s，中间代理（Cloudflare/Vercel/Nginx）按"无数据传输"断开 SSE 连接，前端感知"页面卡住"。

**方案**：

- 服务端每 15s 发送 `heartbeat` 事件（静默期才发，避免冗余流量）
- 前端 45s 无数据判定断流，自动终态化并提示"连接已断开，请重试"
- 取值依据：最坏数据间隙 ≈ 30s+定时器滞后，45s（3× 间隔）留出足够容差

### 2.2 流水线过程数据持久化（PR #27）

**问题**：刷新页面后丢失进行中的生成状态，无法恢复。

**方案**：

- 每次 Agent 事件（start/complete/thinking/progress/error）聚合为过程数据
- 随版本行落库：`stages`（阶段终态）+ `logs`（执行日志）+ `spec` + `notes`
- 刷新后从数据库完整重建工作区：版本列表、阶段卡片、执行日志

### 2.3 Approve 挂起门持久化（PR #31）

**问题**：用户在 approve 阶段刷新页面，确认门丢失，无法继续。

**方案**：

- **双写设计**：内存 resolver（同进程唤醒）+ DB gates 表（刷新恢复）
- 挂起时写入 gates 表：session_id / project_id / user_id / payload / expires_at
- 刷新后前端调 `/api/gates/pending` 重建"等待确认"UI
- 决策结果：
  - `live`：原流水线存活，直接唤醒续跑
  - `recorded`：仅 DB 记录决策，提示"原生成已终止，请重新发起"
  - `expired`：30 分钟超时，提示"确认门已过期"

### 2.4 异常路径落库（PR #30）

**问题**：生成失败或异常时，过程数据丢失，用户看不到"为什么会失败"。

**方案**：

- done / fail / error 三路径统一落库
- 失败运行同样写版本行（失败过程对客户有信任价值）
- 幂等防护：`persistAttempted` 标志防止同一运行二次落库
- 阶段终态：出错节点标 failed，未触达的保持 pending

---

## 三、UI/UX 优化

### 3.1 侧栏重构

- **删除 `/projects` 路由**：所有项目通过侧栏"最近项目"展示
- **新增 API**：`GET /api/projects`（列表）、`GET /api/projects/:id`（详情）、`DELETE /api/projects/:id`（删除）、`PATCH /api/projects/:id/pin`（置顶）
- **项目操作菜单**：每个项目右侧 ⋮ 按钮，支持置顶/删除
  - 菜单使用 **fixed 定位**，脱离 overflow 容器限制
  - 置顶项目显示 📌 标记并排在最前

### 3.2 PreviewFrame 加载缓冲

- iframe 加载时显示旋转动画 + "正在加载…"
- `onLoad` 事件自动清除 loading 状态
- 诊断面板：iframe body 为空时显示红色浮动提示

### 3.3 Modify SOP 阶段卡片（PR #34）

新增增量修改专属阶段卡片：

| 阶段      | 显示名   | 说明                         |
| --------- | -------- | ---------------------------- |
| locate    | 改动定位 | 快模型识别需要修改的代码区域 |
| patch     | 补丁生成 | 强模型输出 SEARCH/REPLACE 块 |
| apply     | 补丁应用 | 三级模糊匹配应用补丁         |
| verify    | 收尾验证 | 语法/安全/结构校验           |
| fix-patch | 补丁修复 | 应用失败时带反馈重试         |

### 3.4 注册限制

- 注册页面显示当前人数：`12 / 20`
- 满员时禁用注册：`名额已满`
- 每日生成额度统一为 **10 次**（不分付费/免费）
- 移除付费账号体系，所有用户统一额度

---

## 四、Bug 修复

### 4.1 渲染失败（73KB → 309 字符）

**根因**：

1. `reasoning_content` 混入 `content` 字段
2. `parseCodeArtifact` 正则非贪婪匹配，遇到内部 ` ``` ` 提前终止

**修复**：

- 流式收集只取 `delta.content`
- 正则改为从第一个 ` ``` ` 到最后一个 ` ``` ` 的贪婪匹配

### 4.2 iframe 不刷新

**根因**：`key` 只依赖 `title`，html 变化不触发重新加载。

**修复**：`useEffect` 监听 `preview?.html` 变化时自动 increment `reloadKey`。

### 4.3 菜单被截断

**根因**：`overflow-y-auto` 容器裁剪了 `absolute` 定位的子元素。

**修复**：菜单状态提升到 `Sidebar` 组件，用 `position: fixed` + `z-index: 9999` 渲染在侧栏 DOM 末尾。

### 4.4 对话迭代创建独立项目（PR #25）

**根因**：`sendFollowUp` 未传递 `projectId`，后端每次都创建新项目。

**修复**：

- `runVersion` 接收 `projectId` 参数
- 有 `projectId` 时追加版本，无则创建新项目
- 增加写型 IDOR 防护：校验项目归属，防止携带他人 projectId 写入

### 4.5 多阶段 SOP 修复（PR #32）

**L2 评审发现的问题**：

- merge 缺页检测未转入 fix-pages 重修循环 → 以缺页状态进入 verify 会误判通过
- verify-X 阶段失败未正确标记 stage 状态 → 前端阶段卡片显示错误
- 落库聚合的 verify 失败判定未覆盖 verify-X 阶段 → 失败运行被误标为成功

**修复**：

- merge 后加缺页检测，missingPages 非空 → 设置 lastErrors → SOP 条件分支回 fix-pages
- verify-X 的 `pass: false` 在 bus 订阅器中正确标为 failed
- persistRun 的 stages 聚合从 `stageStates` Map 取值，覆盖所有 verify-X 子阶段

---

## 五、架构决策与取舍

### 5.1 单文件 HTML 是物理极限

在没有云端沙箱之前，单文件内联 HTML 就是当前架构的极限：

- `iframe srcDoc` 无 base URL → 无法加载相对路径资源
- `sandbox="allow-scripts"` 已经是最大权限
- ESM 模块、`import/export` 需要基础 URL 或 blob URL

**未来突破方案**：

- WebContainers（StackBlitz）— 浏览器端运行 Node.js
- Sandpack（CodeSandbox）— 浏览器端 bundler
- 云端构建 + CDN 分发

### 5.2 Modify SOP 的兜底策略

**曾考虑的方案**：

- A. Patch 失败自动回退完整重写（原有逻辑）→ 300s 超时误杀，违背增量初衷
- B. Patch 失败提示用户手动选择"完整重写" → 增加交互复杂度
- C. **当前方案**：Patch 用尽次数后 fail，保留旧版本，用户可重新发起 → 最可控

### 5.3 移除付费体系

原设计：免费 0 次 + 付费无限
新设计：所有用户统一 10 次/天

**理由**：

- 笔试场景不需要付费闭环
- 减少复杂度（Stripe 集成、付费页面、价格策略）
- 注册限制（20 人上限）已足够控制成本

---

## 六、未来可改善方向

### 6.1 向 atoms 产品形态靠拢

| 方向           | 说明                               | 优先级 |
| -------------- | ---------------------------------- | ------ |
| 多文件项目支持 | 真正的多文件编辑器（文件树 + tab） | 高     |
| 云端沙箱       | WebContainers 或 Sandpack 集成     | 高     |
| 版本对比       | 代码 diff 可视化                   | 中     |
| 实时协作       | 多人同时编辑同一代码               | 低     |
| 部署导出       | 一键导出为独立 HTML/zip            | 中     |

### 6.2 自发性改进

| 方向            | 说明                                       | 优先级 |
| --------------- | ------------------------------------------ | ------ |
| 专用 Apply 模型 | 像 Cursor 那样训练专门做代码变更应用的模型 | 低     |
| 更智能的匹配    | Levenshtein 距离做模糊匹配                 | 中     |
| 代码覆盖率测试  | verify 阶段注入测试用例并运行              | 中     |
| 用户反馈循环    | 用户点击"这个不对"自动触发修复             | 高     |

### 6.3 已知技术债务

- `profiles` 表仍有 `role` 字段（值为 `free`），未来可清理
- `sidebar` 中示例项目硬编码（todo/snake/timer），未来应从数据库加载
- `PreviewFrame` 诊断日志（`console.log`）生产环境应移除
- `createPortal` 方案在 SSR 下可能有 hydration 问题（当前未使用）

---

## 七、测试覆盖

当前测试：67 个全部通过

| 测试文件                     | 覆盖内容                                             |
| ---------------------------- | ---------------------------------------------------- |
| `tests/sop.test.ts`          | SOP 引擎核心流程（正常/失败/重试/确认门/Modify SOP） |
| `tests/architecture.test.ts` | 角色 Memory 隔离、CodeArtifact 解析、Topic 消息池    |
| `tests/verify.test.ts`       | 语法/安全/结构校验、错误定位                         |
| `tests/db.test.ts`           | Supabase 真实数据库操作（项目/版本/消息/用户）       |

---

_上次更新：2026-08-12 01:00_
