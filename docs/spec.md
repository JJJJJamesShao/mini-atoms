# Spec — 产品规格说明书

> 本文档面向评审者：看完应能理解产品全貌、技术选型理由、以及当前实现边界。

---

## 1. 产品定位

**一句话**：一个 AI Native 的单页应用生成器，用户说需求，系统出应用。

**差异化**：不是「代码编辑器」，而是「对话式产品工厂」——用户全程用自然语言交互，不接触代码。支持从任意版本分叉修改，增量编辑比完整重写更快更准。

---

## 2. 用户故事（P0 — 必须完成）

| #    | 用户故事                                                           | 验收标准                                                          |
| ---- | ------------------------------------------------------------------ | ----------------------------------------------------------------- |
| US-1 | 作为用户，我可以用自然语言描述需求，让系统理解我的意图             | 输入"做一个待办清单"，系统进入 clarify 阶段                       |
| US-2 | 作为用户，我可以在规格确认阶段看到需求的三段式拆解，并决定是否继续 | 看到 Requirements/Constraints/User Stories 卡片，可点击确认或修改 |
| US-3 | 作为用户，我可以在确认后看到 AI 生成应用的全过程                   | 实时展示里程碑阶段卡片，有进度感                                  |
| US-4 | 作为用户，我可以在沙箱中预览和交互生成的应用                       | iframe 内应用可点击、可输入、有响应                               |
| US-5 | 作为用户，我可以注册账号并保存我的项目                             | Supabase Auth 邮箱注册，刷新后项目不丢失                          |
| US-6 | 作为用户，我可以用对话方式迭代修改已有应用                         | 输入"改成深色模式"，生成新版本并自动存档                          |
| US-7 | 作为用户，我可以查看和回退到历史版本                               | 版本列表可点击，回退后预览同步更新                                |
| US-8 | 作为用户，我可以从任意历史版本分叉创建新修改                       | 选中 v1 后输入修改 → 生成 v3（基于 v1）                           |
| US-9 | 作为用户，我可以看到增量修改的详细过程                             | locate→patch→apply→verify 各阶段有独立卡片和日志                  |

---

## 3. 用户故事（P1 — 时间允许）

| #     | 用户故事                                   | 验收标准                                |
| ----- | ------------------------------------------ | --------------------------------------- |
| US-10 | 模板库：从预设模板快速启动                 | 首页展示模板卡片，点击后预填需求        |
| US-11 | 极速/精细档切换：快速预览 vs 高质量生成    | 生成前可选择档位，影响模型和 token 预算 |
| US-12 | 导出代码：下载完整项目 ZIP                 | 一键下载包含所有文件的 ZIP              |
| US-13 | 版本 Diff 可视化                           | 选择两个版本，显示并排 Diff             |
| US-14 | **用户打断机制**：生成过程中可中断当前任务 | 生成阶段显示"中断"按钮                  |

---

## 4. 核心流程

### 4.1 首次生成流程

```
用户输入需求
    ↓
[clarify] AI 澄清需求（可选提问）
    ↓
[spec] 输出规格（Req/Constraints/US）
    ↓
[approve] 用户确认门 ← 阻断点
    ├─ 确认 → 继续
    └─ 修改 → 回 clarify
    ↓
[generate] AI 生成代码（File[]）
    ↓
[verify] 确定性校验（syntax + security + structure）
    ├─ 通过 → [done]
    └─ 失败 → [fix] → 重新 generate（最多 5 次）
    ↓
[done] 自动保存版本 + 预览
```

### 4.2 增量修改流程（Modify SOP）

```
用户输入修改需求（已有代码）
    ↓
[locate] 快模型定位改动范围（"第 45 行的 CSS 块"）
    ↓
[patch] 强模型生成 SEARCH/REPLACE 指令
    ↓
[apply] 三级模糊匹配应用补丁
    ├─ 失败 → [fix-patch] 带反馈重试（最多 5 次）
    ↓
[verify] 校验修改后的代码
    ├─ 失败 → [fix-patch] 重写补丁（最多 5 次）
    ↓
[done] 保存新版本
```

**设计要点**：

- locate 把"在哪里改"从 patch 里拆出来，降低 SEARCH 块不匹配率
- apply 失败（块不匹配/多候选/无实际改动）→ fix-patch 带反馈回 patch 重试
- 每次重试都基于**原始代码**重新生成补丁（不在半成品上叠加）
- 无 approve 门：修改是对既有规格的增量，不需要重新确认
- 次数用尽 → fail 保留旧版本（不自动回退完整重写）

### 4.3 SOP 路由策略

系统按输入特征自动选择 SOP：

| SOP           | 触发条件                             | 特点                                   |
| ------------- | ------------------------------------ | -------------------------------------- |
| game          | 输入含"游戏"相关关键词               | 跳过 approve，直接生成                 |
| fullstack-app | 输入含"数据库/登录/多页面"等复杂需求 | 分阶段生成（schema→shell→pages→merge） |
| modify        | 有现有代码 + 用户输入修改意图        | locate→patch→apply→verify 小循环       |
| web-app/tool  | 默认                                 | 完整流程含 approve 确认门              |

---

## 5. 技术架构

### 5.1 分层

| 层      | 职责                       | 技术                                  |
| ------- | -------------------------- | ------------------------------------- |
| UI      | 页面、组件、状态管理       | Next.js App Router + React + Tailwind |
| API     | 业务逻辑、LLM 调用、持久化 | Next.js API Routes + Node.js Runtime  |
| Data    | 项目/版本/消息/确认门存储  | Supabase (PostgreSQL + Auth)          |
| Agent   | 流水线状态机 + 节点执行器  | TypeScript 纯函数，依赖注入           |
| Verify  | 代码校验                   | acorn + node-html-parser              |
| Preview | 沙箱渲染                   | iframe sandbox                        |

### 5.2 关键设计决策

| 决策       | 选择             | 理由                                |
| ---------- | ---------------- | ----------------------------------- |
| 生成物格式 | `File[]` 数组    | 预留多文件扩展，当前只有 index.html |
| 校验方式   | 零模型（纯代码） | 确定性、可重复、零成本              |
| 状态机     | 配置化 SOP       | 4 套 SOP 按需路由，可扩展           |
| 持久化     | Supabase         | Auth 内置 + Row Level Security      |
| 部署       | Vercel           | 与 Next.js 原生集成，自动 CI/CD     |
| LLM        | GLM + 百炼 Qwen  | 双 Provider 降级，中文场景友好      |

---

## 6. 数据模型

```sql
-- 项目
projects (
  id uuid PK,
  user_id uuid,           -- Supabase Auth user id
  title text,
  pinned bool,
  created_at timestamptz
);

-- 版本（关键：files 是 jsonb 数组）
versions (
  id uuid PK,
  project_id uuid FK,
  files jsonb,            -- [{path, content}, ...]
  version_no int,
  is_snapshot bool,       -- 用户主动命名的快照
  snapshot_name text null,
  -- 过程数据（供刷新回放）
  request text,
  notes text,
  spec jsonb,
  sop_id text,
  stages jsonb,           -- [{stage, status, detail}]
  logs jsonb,             -- [{seq, stage, phase, detail, timestamp}]
  parent_version_no int,  -- 分叉基准
  questions jsonb,        -- need_clarification 软着陆问题清单
  stage_outputs jsonb,    -- 多阶段中间产物
  created_at timestamptz
);

-- 对话消息
messages (
  id uuid PK,
  project_id uuid FK,
  role text,              -- user | assistant | system
  content text,
  created_at timestamptz
);

-- 确认门（刷新恢复用）
gates (
  id uuid PK,
  session_id text,
  project_id uuid FK null,
  user_id uuid,
  type text,              -- approve
  status text,            -- pending | approved | rejected | expired
  payload jsonb,          -- {spec, input, baseVersionNo}
  expires_at timestamptz,
  created_at timestamptz
);
```

---

## 7. 节点级模型路由

| 节点     | 模型                     | 理由                           |
| -------- | ------------------------ | ------------------------------ |
| clarify  | Qwen 3.6 Flash（快模型） | 成本低，只需理解意图           |
| spec     | Qwen 3.6 Flash           | 结构化输出，轻量               |
| generate | GLM-5.2（强模型）        | 代码质量关键，128K 上下文      |
| locate   | Qwen 3.6 Flash           | 定位改动范围，轻量             |
| patch    | Qwen 3.8 Max / GLM-5.2   | 精确 Patch 生成，需要推理能力  |
| verify   | 零模型（acorn）          | 确定性、零成本                 |
| fix      | GLM-5.2                  | 基于错误信息修复，需要推理能力 |

---

## 8. 已知限制与 Roadmap

### 8.1 当前限制

- 生成物仅限单文件 HTML（iframe srcDoc 渲染）
- 无 CSS/JS 分离（样式和脚本内联在 HTML 中）
- 无后端能力（纯前端应用）
- 无实时协作
- fix 次数用尽后 fail，不自动回退完整重写（v1 取舍）

### 8.2 扩展路径

| 阶段 | 能力                      | 改动点                           |
| ---- | ------------------------- | -------------------------------- |
| 近期 | 多文件生成（CSS/JS 分离） | 生成器 prompt + verify 层        |
| 近期 | 文件树预览                | PreviewFrame 改用 Service Worker |
| 中期 | 组件化生成                | 引入组件库概念                   |
| 中期 | 后端能力                  | Cloud Functions 或自建 API       |
| 远期 | 实时协作                  | WebSocket + OT 算法              |

---

## 9. 评审指引

### 如何运行

```bash
# 1. 克隆
git clone https://github.com/JJJJJamesShao/mini-atoms.git
cd mini-atoms

# 2. 安装依赖
npm install

# 3. 配置环境变量（.env.local）
# NEXT_PUBLIC_SUPABASE_URL=...
# NEXT_PUBLIC_SUPABASE_ANON_KEY=...
# GLM_API_KEY=...

# 4. 本地验证
./verify.sh

# 5. 启动开发
npm run dev
```

### 关键入口

| 入口         | 文件                             |
| ------------ | -------------------------------- |
| 流水线状态机 | `src/lib/agent/engine.ts`        |
| SOP 配置     | `src/lib/agent/sop.ts`           |
| 节点执行器   | `src/lib/agent/llm-executors.ts` |
| 增量修改     | `src/lib/agent/patch.ts`         |
| 数据契约     | `src/lib/schemas/index.ts`       |
| 校验层       | `src/lib/verify/index.ts`        |
| 罐头数据     | `src/lib/mock/canned.ts`         |

---

_最后更新：2026-08-12_
