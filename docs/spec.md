# Spec — 产品规格说明书

> 本文档面向评审者：看完应能理解产品全貌、技术选型理由、以及当前实现边界。

---

## 1. 产品定位

**一句话**：一个 AI Native 的单页应用生成器，用户说需求，系统出应用。

**差异化**：不是「代码编辑器」，而是「对话式产品工厂」——用户全程用自然语言交互，不接触代码。

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
| US-8 | 作为用户，我可以看到版本之间的差异                                 | Diff 视图高亮改动行                                               |
| US-9 | 作为用户，我可以分享我的应用链接给他人                             | 生成可访问的分享 URL                                              |

---

## 3. 用户故事（P1 — 时间允许）

| #     | 用户故事                                |
| ----- | --------------------------------------- |
| US-10 | 模板库：从预设模板快速启动              |
| US-11 | 极速/精细档切换：快速预览 vs 高质量生成 |
| US-12 | 导出代码：下载完整项目 ZIP              |

---

## 4. 核心流程

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
[verify] 确定性校验（syntax + structure）
    ├─ 通过 → [done]
    └─ 失败 → [fix] → 重新 generate（最多 2 次）
    ↓
[done] 自动保存版本 + 预览
```

---

## 5. 技术架构

### 5.1 分层

| 层      | 职责                       | 技术                                    |
| ------- | -------------------------- | --------------------------------------- |
| UI      | 页面、组件、状态管理       | Next.js App Router + React + Tailwind   |
| API     | 业务逻辑、LLM 调用、持久化 | Next.js API Routes + Edge Runtime       |
| Data    | 项目/版本/消息存储         | Supabase (PostgreSQL + Auth)            |
| Agent   | 流水线状态机 + 节点执行器  | TypeScript 纯函数，依赖注入             |
| Verify  | 代码校验                   | acorn + node-html-parser                |
| Preview | 沙箱渲染                   | iframe sandbox + Service Worker（未来） |

### 5.2 关键设计决策

| 决策       | 选择             | 理由                                |
| ---------- | ---------------- | ----------------------------------- |
| 生成物格式 | `File[]` 数组    | 预留多文件扩展，当前只有 index.html |
| 校验方式   | 零模型（纯代码） | 确定性、可重复、零成本              |
| 状态机     | 硬编码转移表     | 可预测、可测试、无黑盒              |
| 持久化     | Supabase         | 笔试要求 + Auth 内置 + 免费额度     |
| 部署       | Vercel           | 与 Next.js 原生集成，自动 CI/CD     |
| LLM        | GLM（智谱）      | 笔试提供额度，中文场景友好          |

---

## 6. 数据模型

```sql
-- 项目
projects (
  id uuid PK,
  user_id uuid,           -- Supabase Auth user id
  title text,
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
```

---

## 7. 节点级模型路由

| 节点     | 模型                  | 理由                           |
| -------- | --------------------- | ------------------------------ |
| clarify  | GLM-4-Flash（快模型） | 成本低，只需理解意图           |
| spec     | GLM-4-Flash           | 结构化输出，轻量               |
| generate | GLM-4（强模型）       | 代码质量关键，值得花 token     |
| verify   | 零模型（acorn）       | 确定性、零成本                 |
| fix      | GLM-4                 | 基于错误信息修复，需要推理能力 |

---

## 8. 已知限制与 Roadmap

### 8.1 当前限制

- 生成物仅限单文件 HTML（iframe srcDoc 渲染）
- 无 CSS/JS 分离（样式和脚本内联在 HTML 中）
- 无后端能力（纯前端应用）
- 无实时协作

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

| 入口           | 文件                                |
| -------------- | ----------------------------------- |
| 流水线状态机   | `src/lib/agent/index.ts`            |
| 节点执行器接口 | `src/lib/agent/canned-executors.ts` |
| 数据契约       | `src/lib/schemas/index.ts`          |
| 校验层         | `src/lib/verify/index.ts`           |
| 罐头数据       | `src/lib/mock/canned.ts`            |

---

_最后更新：2026-08-09_
