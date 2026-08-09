# Kimi Code 任务：MetaGPT 简化版角色+SOP 系统（4h）

> 目标：构建最小可行的 MetaGPT 架构，支持多角色、可配置 SOP、动态路由
> 分支：从 feat/agent-bus 继续开发
> 提交：每步 `--no-verify`，完成后统一 verify

---

## 现有基础

- `src/lib/agent/index.ts` — 硬编码单 SOP（clarify→spec→approve→generate→verify→fix→done）
- `src/lib/agent/bus.ts` — Agent EventBus（已就绪）
- `src/lib/agent/llm-executors.ts` — 执行器（clarify/spec/generate/verify）
- `src/lib/llm/prompts.ts` — prompt 模板（按角色分）

---

## 任务拆解

### 任务 1：Role 角色基类（30min）

**目标**：定义可复用的 Agent 角色，每个角色有 name、goal、constraints。

**新增文件**：`src/lib/agent/role.ts`

```typescript
export interface RoleConfig {
  name: string; // "产品经理"
  goal: string; // "理解用户需求，产出清晰的产品规格"
  constraints: string[]; // ["不超过3个澄清问题", "简单需求直接通过"]
  model: string; // "qwen3.6-flash"
  maxTokens?: number;
}

export class Role {
  constructor(public config: RoleConfig) {}

  systemPrompt(): string {
    return `你是${this.config.name}。${this.config.goal}
约束：${this.config.constraints.join("\n")}`;
  }
}

// 预设角色
export const ROLES = {
  pm: new Role({
    name: "产品经理",
    goal: "理解用户需求，判断是否需要澄清",
    constraints: ["简单需求直接通过", "最多提3个问题"],
    model: "qwen3.6-flash",
    maxTokens: 65536,
  }),
  architect: new Role({
    name: "架构师",
    goal: "将需求拆解为技术规格",
    constraints: ["严格JSON输出", "包含约束条件"],
    model: "qwen3.8-max",
    maxTokens: 131072,
  }),
  engineer: new Role({
    name: "前端工程师",
    goal: "生成完整可运行的单文件HTML",
    constraints: ["无外部依赖", "原生JS", "内联样式"],
    model: "glm-5.2",
    maxTokens: 131072,
  }),
  reviewer: new Role({
    name: "代码审查员",
    goal: "检查代码语法和结构",
    constraints: ["确定性检查", "零模型调用"],
    model: "none", // 零模型
  }),
};
```

---

### 任务 2：SOP 配置 DSL（1h）

**目标**：定义可配置的流程模板，支持顺序执行、条件分支。

**新增文件**：`src/lib/agent/sop.ts`

```typescript
export interface SOPStep {
  name: string; // "clarify"
  role: string; // "pm"
  action: string; // "clarify"
  next:
    | string
    | {
        // 简单分支
        default: string;
        conditions?: Array<{
          field: string; // "status"
          operator: "eq" | "ne";
          value: string;
          then: string;
        }>;
      };
  timeout?: number; // 秒，默认 60
}

export interface SOPConfig {
  id: string; // "web-app"
  name: string; // "网页应用生成"
  description: string;
  steps: SOPStep[];
}

// 预设 SOP
export const DEFAULT_SOP: SOPConfig = {
  id: "web-app",
  name: "网页应用",
  description: "通用单文件 HTML 应用生成",
  steps: [
    {
      name: "clarify",
      role: "pm",
      action: "clarify",
      next: {
        default: "spec",
        conditions: [
          {
            field: "status",
            operator: "eq",
            value: "need_clarification",
            then: "fail",
          },
        ],
      },
    },
    { name: "spec", role: "architect", action: "spec", next: "approve" },
    {
      name: "approve",
      role: "pm",
      action: "approve",
      next: {
        default: "generate",
        conditions: [
          { field: "approved", operator: "eq", value: "false", then: "fail" },
        ],
      },
    },
    { name: "generate", role: "engineer", action: "generate", next: "verify" },
    {
      name: "verify",
      role: "reviewer",
      action: "verify",
      next: {
        default: "done",
        conditions: [
          { field: "pass", operator: "eq", value: "false", then: "fix" },
        ],
      },
    },
    { name: "fix", role: "engineer", action: "fix", next: "generate" },
    { name: "done", role: "system", action: "done", next: "" },
    { name: "fail", role: "system", action: "fail", next: "" },
  ],
};

// 游戏类 SOP（更精简）
export const GAME_SOP: SOPConfig = {
  id: "game",
  name: "小游戏",
  description: "单文件 HTML5 游戏",
  steps: [
    { name: "clarify", role: "pm", action: "clarify", next: "spec" },
    { name: "spec", role: "architect", action: "spec", next: "generate" },
    { name: "generate", role: "engineer", action: "generate", next: "verify" },
    {
      name: "verify",
      role: "reviewer",
      action: "verify",
      next: {
        default: "done",
        conditions: [
          { field: "pass", operator: "eq", value: "false", then: "fix" },
        ],
      },
    },
    { name: "fix", role: "engineer", action: "fix", next: "generate" },
    { name: "done", role: "system", action: "done", next: "" },
  ],
};

export const SOP_REGISTRY = new Map<string, SOPConfig>([
  ["web-app", DEFAULT_SOP],
  ["game", GAME_SOP],
  ["tool", DEFAULT_SOP], // 工具类复用 web-app
]);
```

---

### 任务 3：SOP 执行引擎（1h）

**目标**：替换硬编码 `runPipeline`，用 SOP 配置驱动执行。

**修改文件**：`src/lib/agent/engine.ts`（新增）

```typescript
import type { SOPConfig, SOPStep } from "./sop";
import type { Executors } from "./index";
import type { AgentEventBus } from "./bus";

export interface ExecutionContext {
  input: string;
  sop: SOPConfig;
  stepResults: Map<string, unknown>;
  currentStep: number;
}

export async function runSOP(
  input: string,
  sop: SOPConfig,
  executors: Executors,
  bus: AgentEventBus,
  approver?: (stepName: string, context: unknown) => Promise<boolean>,
) {
  const context: ExecutionContext = {
    input,
    sop,
    stepResults: new Map(),
    currentStep: 0,
  };

  let currentStepName = sop.steps[0].name;

  while (currentStepName) {
    const step = sop.steps.find((s) => s.name === currentStepName);
    if (!step) break;

    context.currentStep = sop.steps.indexOf(step);

    // emit start
    bus.emit({
      type: "agent:start",
      agent: step.name,
      role: step.role,
      message: `执行 ${step.name}（${step.role}）`,
    });

    // 执行 action
    let result: unknown;
    try {
      result = await executeStep(step, context, executors, approver);
      context.stepResults.set(step.name, result);
    } catch (err) {
      bus.emit({
        type: "agent:error",
        agent: step.name,
        role: step.role,
        message: err instanceof Error ? err.message : String(err),
      });
      break;
    }

    // emit complete
    bus.emit({
      type: "agent:complete",
      agent: step.name,
      role: step.role,
      output: result,
      message: `${step.name} 完成`,
    });

    // 计算下一步
    const nextStepName = resolveNext(step, result);
    if (!nextStepName || nextStepName === "done" || nextStepName === "fail") {
      break;
    }
    currentStepName = nextStepName;
  }

  return context;
}

function resolveNext(step: SOPStep, result: unknown): string {
  if (typeof step.next === "string") return step.next;

  // 条件分支
  const resultObj = result as Record<string, unknown>;
  for (const condition of step.next.conditions ?? []) {
    const field = resultObj?.[condition.field];
    const match =
      condition.operator === "eq"
        ? String(field) === condition.value
        : String(field) !== condition.value;
    if (match) return condition.then;
  }
  return step.next.default;
}

async function executeStep(
  step: SOPStep,
  context: ExecutionContext,
  executors: Executors,
  approver?: (stepName: string, context: unknown) => Promise<boolean>,
): Promise<unknown> {
  // 根据 action 调用对应执行器
  // ...（映射到现有 executors）
}
```

---

### 任务 4：SOP 路由（30min）

**目标**：根据用户输入自动选择 SOP。

**新增文件**：`src/lib/agent/router.ts`

```typescript
import { SOP_REGISTRY } from "./sop";

export function selectSOP(input: string): string {
  const lower = input.toLowerCase();

  // 关键词匹配
  if (/游戏|game|贪吃蛇|数独|坦克/.test(lower)) return "game";
  if (/工具|计算器|计时器|todo|待办/.test(lower)) return "tool";

  // 默认网页应用
  return "web-app";
}
```

---

### 任务 5：API Route 接入新引擎（30min）

**修改**：`src/app/api/pipeline/route.ts`

- 用 `selectSOP(input)` 选流程
- 用 `runSOP()` 替换 `runPipeline()`
- 保持 SSE 输出格式不变（前端兼容）

---

### 任务 6：前端适配（30min）

**修改**：`src/app/hooks/useWorkspace.ts`

- `STAGE_ORDER` 不再硬编码，从 SOP 配置读取
- VersionCard 显示当前使用的 SOP 名称

---

## 时间账

| 任务            | 时间  | 累计  |
| --------------- | ----- | ----- |
| Role 基类       | 30min | 30min |
| SOP DSL + 预设  | 1h    | 1.5h  |
| 执行引擎        | 1h    | 2.5h  |
| SOP 路由        | 30min | 3h    |
| API 接入        | 30min | 3.5h  |
| 前端适配 + 测试 | 30min | 4h    |

---

## 验收标准

- [ ] 输入"做一个数独游戏" → 自动选 GAME_SOP（跳过 approve）
- [ ] 输入"做一个待办清单" → 自动选 DEFAULT_SOP（完整流程）
- [ ] Agent 执行日志显示角色名（产品经理/架构师/前端工程师）
- [ ] `./verify.sh` 全绿
- [ ] `npm run build` 成功

---

## 禁止

- ❌ 不要改 `src/lib/schemas/` 数据契约
- ❌ 不要改 `src/lib/verify/` 校验层
- ❌ 不要改 `src/lib/llm/` prompt 模板
- ❌ 不要并行执行（只做顺序）

---

## 降级预案

如果时间不够：

1. 只做任务 1+2（Role + SOP 配置），不接入执行引擎
2. 执行引擎复用现有 `runPipeline`，只加 SOP 选择逻辑
3. 前端只做 SOP 名称显示

---

_任务包版本：v1.0 — 2026-08-10 01:05_
