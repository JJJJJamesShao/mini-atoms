# Kimi Code 长任务包：核心闭环冲刺（T5 持久化 + T6 账号体系）

> 目标：2-3 小时内完成数据持久化 + 账号体系 + 端到端测试
> 要求：每完成一步必须 `./verify.sh` 全绿 → commit → 再下一步
> 当前分支：从 main 切出 `feat/persistence`

---

## ⚠️ 执行纪律（违反则任务失败）

1. **每完成一个任务编号，必须执行 `./verify.sh`**
2. **verify.sh 全绿后才能 `git add -A && git commit`**
3. **commit message 必须包含当前任务编号**
4. **严禁在未测试通过时 commit**
5. **严禁修改 `src/lib/` 下的核心逻辑（agent/verify/schemas），只读**
6. **测试代码必须覆盖新增功能的核心路径**

---

## 前置：确认当前代码状态

在开始之前，先确认：

```bash
git checkout main && git pull origin main
git checkout -b feat/persistence
./verify.sh  # 必须全绿，否则先修
```

---

## 任务 1：Clarify Prompt 修复（15min）

### 问题

当前 clarify prompt 太严格，"做一个待办清单"这种简单需求被判定为 need_clarification，导致流水线直接 fail。

### 目标

让简单需求直接通过 clarify，只有真正模糊的需求才问问题。

### 改动文件

- `src/lib/llm/prompts.ts` — 修改 `buildClarifyPrompt`

### Prompt 修改

将 system prompt 改为：

```
你是一位资深产品经理。判断用户需求是否足够清晰以直接进入规格生成。

判断标准：
- 如果需求明确（如"做一个待办清单"、"贪吃蛇游戏"、"计时器"），直接返回 ready
- 只有当需求明显缺失关键信息（如没有说明用途、没有说明目标用户）时才返回 need_clarification
- 不要过度追问，简单需求应该直接通过
```

### 测试要求

在 `src/scripts/test_llm.ts` 中添加测试用例：

```typescript
// 测试：简单需求应直接通过
const simpleInputs = ["做一个待办清单", "贪吃蛇游戏", "计时器"];
for (const input of simpleInputs) {
  const resp = await client.chat.completions.create({...});
  const parsed = extractJson(resp.choices[0].message.content);
  console.assert(parsed.status === "ready", `${input} 应直接通过`);
}
```

### 验收

- [ ] `./verify.sh` 全绿
- [ ] `npx tsx src/scripts/test_llm.ts` 中新增测试通过
- [ ] curl 测试：`curl -s -X POST http://localhost:3000/api/pipeline -H "Content-Type: application/json" -d '{"input":"做一个待办清单"}'` 返回的 events 中包含 `done` 而非 `fail`

### Commit

```bash
git add -A
git commit -m "fix(prompt): 放宽 clarify 门槛，简单需求直接通过

- 修改 buildClarifyPrompt，减少对简单需求的过度追问
- 测试：待办清单/贪吃蛇/计时器直接通过 ready 状态
- verify.sh 全绿"
```

---

## 任务 2：Supabase 持久化层封装（30min）

### 目标

创建服务端 Supabase 客户端封装，提供项目/版本/消息的 CRUD 操作。

### 新增文件

**`src/lib/supabase/server.ts`**

```typescript
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SECRET_KEY!;

export const supabase = createClient(supabaseUrl, supabaseKey);
```

**`src/lib/db/projects.ts`**

```typescript
import { supabase } from "../supabase/server";

export async function createProject(title: string, userId?: string) {
  const { data, error } = await supabase
    .from("projects")
    .insert({ title, user_id: userId })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function getProjects(userId?: string) {
  let query = supabase
    .from("projects")
    .select("*")
    .order("created_at", { ascending: false });
  if (userId) query = query.eq("user_id", userId);
  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

export async function getProject(id: string) {
  const { data, error } = await supabase
    .from("projects")
    .select("*")
    .eq("id", id)
    .single();
  if (error) throw error;
  return data;
}
```

**`src/lib/db/versions.ts`**

```typescript
import { supabase } from "../supabase/server";

export async function createVersion(
  projectId: string,
  files: any[],
  versionNo: number,
  notes?: string,
) {
  const { data, error } = await supabase
    .from("versions")
    .insert({ project_id: projectId, files, version_no: versionNo, notes })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function getVersions(projectId: string) {
  const { data, error } = await supabase
    .from("versions")
    .select("*")
    .eq("project_id", projectId)
    .order("version_no", { ascending: true });
  if (error) throw error;
  return data ?? [];
}
```

**`src/lib/db/messages.ts`**

```typescript
import { supabase } from "../supabase/server";

export async function createMessage(
  projectId: string,
  role: string,
  content: string,
) {
  const { data, error } = await supabase
    .from("messages")
    .insert({ project_id: projectId, role, content })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function getMessages(projectId: string) {
  const { data, error } = await supabase
    .from("messages")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data ?? [];
}
```

### 测试要求

新增 `tests/db.test.ts`：

```typescript
import { describe, it, expect } from "vitest";
import { createProject, getProjects } from "../src/lib/db/projects";
import { createVersion, getVersions } from "../src/lib/db/versions";

describe("数据库操作", () => {
  it("创建并查询项目", async () => {
    const project = await createProject("测试项目");
    expect(project).toHaveProperty("id");
    expect(project.title).toBe("测试项目");

    const projects = await getProjects();
    expect(projects.some((p) => p.id === project.id)).toBe(true);

    // 清理
    const { supabase } = await import("../src/lib/supabase/server");
    await supabase.from("projects").delete().eq("id", project.id);
  });

  it("创建并查询版本", async () => {
    const project = await createProject("版本测试");
    const version = await createVersion(
      project.id,
      [{ path: "index.html", content: "<h1>Test</h1>" }],
      1,
    );
    expect(version).toHaveProperty("id");

    const versions = await getVersions(project.id);
    expect(versions).toHaveLength(1);

    // 清理
    const { supabase } = await import("../src/lib/supabase/server");
    await supabase.from("versions").delete().eq("id", version.id);
    await supabase.from("projects").delete().eq("id", project.id);
  });
});
```

### 验收

- [ ] `./verify.sh` 全绿（包括新增 db 测试）
- [ ] TypeScript 编译通过
- [ ] 测试能在本地连接真实 Supabase 跑通

### Commit

```bash
git add -A
git commit -m "feat(db): Supabase 持久化层封装（projects/versions/messages）

- src/lib/supabase/server.ts — 服务端 Supabase 客户端
- src/lib/db/projects.ts — 项目 CRUD
- src/lib/db/versions.ts — 版本 CRUD
- src/lib/db/messages.ts — 消息 CRUD
- tests/db.test.ts — 数据库操作测试
- verify.sh 全绿"
```

---

## 任务 3：流水线接入持久化（45min）

### 目标

API Route 在流水线完成后自动保存项目、版本、消息到 Supabase。

### 改动文件

**`app/api/pipeline/route.ts`**

在流水线完成后添加保存逻辑：

```typescript
import { createProject } from "@/lib/db/projects";
import { createVersion } from "@/lib/db/versions";
import { createMessage } from "@/lib/db/messages";

// ... 在 runPipeline 完成后 ...

if (finalState === "done" && result) {
  // 1. 创建项目
  const project = await createProject(input);

  // 2. 保存版本
  await createVersion(project.id, result.files, 1, result.notes);

  // 3. 保存消息记录
  await createMessage(project.id, "user", input);
  await createMessage(project.id, "assistant", "生成完成");

  send({ type: "project_created", projectId: project.id });
}
```

### 测试要求

新增 `tests/api-pipeline.test.ts`（或使用 test_llm.ts 扩展）：

```typescript
// 端到端测试：调用 API → 检查 Supabase 是否有数据
const resp = await fetch("http://localhost:3000/api/pipeline", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ input: "做一个计时器" }),
});

// 解析 SSE，获取 projectId
// 查询 Supabase 确认项目存在
```

或者更简单：直接在 test_llm.ts 中添加验证：

```typescript
// 在 SSE 流结束后，查询 Supabase
const { supabase } = await import("../src/lib/supabase/server");
const { data: projects } = await supabase
  .from("projects")
  .select("*")
  .order("created_at", { ascending: false })
  .limit(1);
console.log("最新项目:", projects?.[0]);
```

### 验收

- [ ] `./verify.sh` 全绿
- [ ] `npm run dev` 后 curl 调用 `/api/pipeline` → Supabase 中能看到新项目
- [ ] 项目包含正确的 title、versions、messages

### Commit

```bash
git add -A
git commit -m "feat(api): 流水线完成后自动持久化到 Supabase

- /api/pipeline 在 done 后保存 project + version + message
- 新增 project_created SSE 事件通知前端
- verify.sh 全绿"
```

---

## 任务 4：项目列表页（30min）

### 目标

创建 `/projects` 页面，展示用户所有项目，点击可进入继续编辑。

### 新增文件

**`app/projects/page.tsx`**

```typescript
import { createClient } from "@supabase/supabase-js";

export default async function ProjectsPage() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  const { data: projects } = await supabase.from("projects").select("*, versions(*)").order("created_at", { ascending: false });

  return (
    <main className="p-8">
      <h1 className="text-2xl font-bold mb-6">我的项目</h1>
      <div className="grid gap-4">
        {projects?.map((p) => (
          <a key={p.id} href={`/projects/${p.id}`} className="block p-4 border rounded-lg hover:shadow-md transition">
            <h2 className="font-medium">{p.title}</h2>
            <p className="text-sm text-neutral-500">{p.versions?.length ?? 0} 个版本</p>
          </a>
        )) ?? <p>暂无项目</p>}
      </div>
    </main>
  );
}
```

**`app/projects/[id]/page.tsx`**（简化版，只展示最新版本）

```typescript
export default async function ProjectPage({
  params,
}: {
  params: { id: string };
}) {
  // 从 Supabase 读取项目 + 最新版本
  // 渲染 ProjectWorkspace 组件（复用现有的）
}
```

### 测试要求

- 访问 `/projects` 能看到项目列表
- 点击项目能进入详情页
- verify.sh 全绿

### Commit

```bash
git add -A
git commit -m "feat(ui): 项目列表页 + 项目详情页

- /projects — 展示所有项目卡片
- /projects/[id] — 展示项目详情和最新版本
- Server Component 直接从 Supabase 读取数据
- verify.sh 全绿"
```

---

## 任务 5：Supabase Auth 基础（45min）

### 目标

接入 Supabase Auth，实现登录/注册，项目与用户关联。

### 新增文件

**`app/auth/login/page.tsx`** — 登录页（邮箱+密码）
**`app/auth/register/page.tsx`** — 注册页
**`src/lib/supabase/client.ts`** — 浏览器端 Supabase 客户端
**`src/middleware.ts`** — 保护路由，未登录重定向

### 简化实现

由于时间紧，可以先只做：

1. 注册页：邮箱 + 密码 → 调用 `supabase.auth.signUp`
2. 登录页：邮箱 + 密码 → 调用 `supabase.auth.signInWithPassword`
3. middleware：检查 session，未登录重定向到 `/auth/login`
4. 项目创建时关联 `user_id`

### 测试要求

- 注册新用户 → 能登录 → 能访问 `/projects`
- 未登录访问 `/projects` → 重定向到登录页
- verify.sh 全绿

### Commit

```bash
git add -A
git commit -m "feat(auth): Supabase Auth 登录/注册 + 路由保护

- /auth/login — 登录页
- /auth/register — 注册页
- src/middleware.ts — 未登录重定向
- 项目创建关联当前用户 user_id
- verify.sh 全绿"
```

---

## 任务 6：端到端测试 + 文档（30min）

### 目标

确保整个闭环可演示：注册 → 登录 → 创建项目 → LLM 生成 → 持久化 → 刷新还在。

### 测试清单

```bash
# 1. 启动服务
npm run dev

# 2. 测试注册
curl -s -X POST http://localhost:3000/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"test123"}'

# 3. 测试登录（获取 token）
# 4. 测试创建项目（携带 token）
# 5. 验证 Supabase 数据
# 6. 刷新页面，确认项目还在
```

### 更新 README

在 README 中添加：

```markdown
## 快速开始

### 环境变量
```

NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SECRET_KEY=
ANTHROPIC_AUTH_TOKEN=
ANTHROPIC_BASE_URL=https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1

````

### 本地运行
```bash
npm install
npm run dev
````

### 测试

```bash
./verify.sh        # 单元测试 + 构建
npx tsx src/scripts/test_llm.ts  # LLM 链路测试
```

````

### Commit
```bash
git add -A
git commit -m "docs: README 更新 + 端到端测试验证

- 添加环境变量说明
- 添加本地运行指南
- 验证完整闭环：注册→登录→生成→持久化
- verify.sh 全绿"
````

---

## 时间预算

| 任务                     | 预估  | 累计  |
| ------------------------ | ----- | ----- |
| 任务 1: Clarify 修复     | 15min | 15min |
| 任务 2: 持久化层         | 30min | 45min |
| 任务 3: 流水线接入持久化 | 45min | 1.5h  |
| 任务 4: 项目列表页       | 30min | 2h    |
| 任务 5: Auth             | 45min | 2.75h |
| 任务 6: 测试 + 文档      | 30min | 3h    |

**总计：约 3h**

---

## 降级预案

如果时间不够，按序砍：

1. **任务 4 简化** — 只做项目列表，不做详情页（详情页复用首页 workspace）
2. **任务 5 简化** — 只做注册/登录页面，不做 middleware 保护（后续加）
3. **任务 6 简化** — 只更新 README，不写端到端 curl 测试

**绝对不可砍**：任务 1（否则 LLM 跑不通）、任务 2+3（否则没有持久化）

---

## 提交前最终检查清单

```bash
./verify.sh          # 必须全绿
git status           # 确认无未跟踪文件
git log --oneline    # 确认每个任务都有 commit
npm run build        # 生产构建成功
```

完成后创建 PR：

```bash
git push origin feat/persistence
# 在 GitHub 创建 PR，合入 main
```
