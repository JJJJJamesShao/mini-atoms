/**
 * SOP 执行引擎 — 读取 SOP 配置，按步骤顺序执行，条件分支跳转。
 *
 * 替换 runPipeline 的硬编码单流程：
 * - 节点动作（clarify/spec/generate/verify）委托给注入的 Executors，
 *   节点级进度事件由执行器自行 emit（见 llm-executors）；
 * - 引擎只负责流转控制，并为 approve/fix 这类无执行器的步骤 emit 事件；
 * - approve 步骤挂起等待注入的 Approver 决策（无 approve 步骤的 SOP 不会调用）。
 */

import type { File } from "../schemas";
import type { Executors, Approver } from "./index";
import type { AgentEventBus } from "./bus";
import { createRoles, ROLES, type Role, type RoleId } from "./role";
import { MessageTopic } from "./message";
import type { SOPCondition, SOPConfig, SOPStep } from "./sop";
import type {
  ClarifyOutput,
  GenerateOutput,
  SpecOutput,
  VerifyResult,
} from "../schemas";

/** verify 失败后允许的最大修复次数（含多轮 Patch），用尽则 fail */
const MAX_FIX_ATTEMPTS = 5;
/** 步数上限，防止 SOP 配置错误导致死循环 */
const MAX_STEPS = 50;

export interface SOPRunResult {
  sop: SOPConfig;
  finalState: "done" | "fail";
  /** 失败原因：need_clarification / spec_rejected / verify_failed */
  reason: string | null;
  /** finalState 为 done 时的生成产物 */
  result?: GenerateOutput;
}

/** 跨步骤共享的执行上下文 */
interface ExecutionContext {
  input: string;
  clarify: ClarifyOutput | null;
  spec: SpecOutput | null;
  generated: GenerateOutput | null;
  lastErrors: VerifyResult["errors"] | undefined;
  fixAttempts: number;
  /** 对话迭代时传入的初始代码 */
  initialFiles?: File[];
}

/**
 * @param roles 本次运行使用的角色实例（持有各自 Memory）；
 *   不传则内部创建——调用方需要共享 Memory 给执行器时应显式传入
 */
export async function runSOP(
  input: string,
  sop: SOPConfig,
  executors: Executors,
  approver?: Approver,
  bus?: AgentEventBus,
  roles?: Record<RoleId, Role>,
  initialFiles?: File[],
): Promise<SOPRunResult> {
  const runRoles = roles ?? createRoles();
  /** 本次流水线会话 id：Topic 消息按会话隔离历史 */
  const sessionId = crypto.randomUUID();

  const ctx: ExecutionContext = {
    input,
    clarify: null,
    spec: null,
    generated: null,
    lastErrors: undefined,
    fixAttempts: 0,
    initialFiles,
  };

  let current: string | undefined = sop.steps[0]?.name;
  let stepsTaken = 0;

  while (current) {
    if (++stepsTaken > MAX_STEPS) {
      throw new Error(`SOP ${sop.id} 执行超过 ${MAX_STEPS} 步，疑似死循环`);
    }
    const step = sop.steps.find((s) => s.name === current);
    if (!step) {
      throw new Error(`SOP ${sop.id} 中不存在步骤: ${current}`);
    }

    if (step.action === "done") {
      return {
        sop,
        finalState: "done",
        reason: null,
        result: ctx.generated ?? undefined,
      };
    }
    if (step.action === "fail") {
      return { sop, finalState: "fail", reason: "unknown" };
    }

    const role = step.role === "system" ? null : runRoles[step.role];

    // Agent 间通信消费端：执行前从 Bus 拉取订阅 Topic 的历史消息写入 Memory
    if (role && bus) role.prepareContext(bus, sessionId);

    const output = await executeStep(step, ctx, executors, approver, bus);

    // Agent 间通信生产端：步骤产物按 Topic 发布（PRD/ARCH_SPEC/CODE/REVIEW）
    if (bus) {
      bus.publish(stepToTopic(step), {
        from: role?.config.name ?? "系统",
        payload: output,
        sessionId,
      });
    }

    const next = resolveNext(step, output);

    if (next === "fail") {
      return { sop, finalState: "fail", reason: deriveFailReason(step) };
    }
    current = next || undefined;
  }

  // next 为空串收尾但未经过 done 步骤：SOP 配置不完整
  return { sop, finalState: "fail", reason: "sop_terminated" };
}

/** 计算下一步：先匹配条件分支，未命中走 default */
function resolveNext(step: SOPStep, output: unknown): string {
  if (typeof step.next === "string") return step.next;

  const resultObj = output as Record<string, unknown> | null;
  for (const condition of step.next.conditions ?? []) {
    if (matchCondition(condition, resultObj?.[condition.field])) {
      return condition.then;
    }
  }
  return step.next.default;
}

function matchCondition(condition: SOPCondition, fieldValue: unknown): boolean {
  const actual = String(fieldValue);
  return condition.operator === "eq"
    ? actual === condition.value
    : actual !== condition.value;
}

/** 步骤产物 → 消息 Topic（Agent 间通信路由表） */
function stepToTopic(step: SOPStep): MessageTopic {
  switch (step.action) {
    case "clarify":
      return MessageTopic.PRD;
    case "spec":
      return MessageTopic.ARCH_SPEC;
    case "generate":
      return MessageTopic.CODE;
    case "verify":
      return MessageTopic.REVIEW;
    default:
      // approve/fix 等系统流转事件
      return MessageTopic.SYSTEM;
  }
}

/** 跳转 fail 时按步骤类型给出原因（与前端文案映射保持一致） */
function deriveFailReason(step: SOPStep): string {
  switch (step.action) {
    case "clarify":
      return "need_clarification";
    case "approve":
      return "spec_rejected";
    case "fix":
      return "verify_failed";
    default:
      return "unknown";
  }
}

async function executeStep(
  step: SOPStep,
  ctx: ExecutionContext,
  executors: Executors,
  approver: Approver | undefined,
  bus: AgentEventBus | undefined,
): Promise<unknown> {
  const roleName =
    step.role === "system" ? "系统" : ROLES[step.role].config.name;

  switch (step.action) {
    case "clarify": {
      const out = await executors.clarify(ctx.input);
      ctx.clarify = out;
      return out;
    }
    case "spec": {
      if (!ctx.clarify) throw new Error("spec 步骤缺少 clarify 产物");
      const out = await executors.spec(ctx.clarify);
      ctx.spec = out;
      return out;
    }
    case "approve": {
      if (!ctx.spec) throw new Error("approve 步骤缺少 spec 产物");
      bus?.emit({
        type: "agent:start",
        agent: "approve",
        role: roleName,
        message: "等待用户确认规格",
      });
      const approved = approver ? await approver(ctx.spec) : true;
      bus?.emit({
        type: "agent:complete",
        agent: "approve",
        role: roleName,
        output: { approved },
        message: approved ? "用户已确认规格" : "用户拒绝规格",
      });
      return { approved };
    }
    case "generate": {
      if (!ctx.spec) throw new Error("generate 步骤缺少 spec 产物");
      // 对话迭代：传入初始代码（如果有），否则用当前生成产物（fix 模式）
      const currentFiles = ctx.initialFiles ?? ctx.generated?.files;
      // fix 模式：传入当前代码和 fix 轮次，让 generate 走 patch 编辑而非完整重写
      const out = await executors.generate(
        ctx.spec,
        ctx.lastErrors,
        currentFiles,
        ctx.fixAttempts,
      );
      ctx.generated = out;
      return out;
    }
    case "verify": {
      if (!ctx.generated) throw new Error("verify 步骤缺少 generate 产物");
      const out = await executors.verify(ctx.generated.files);
      if (!out.pass) ctx.lastErrors = out.errors;
      return out;
    }
    case "fix": {
      // fix 不调用执行器：记录次数并回退到 generate 重新生成
      ctx.fixAttempts += 1;
      const exhausted = ctx.fixAttempts >= MAX_FIX_ATTEMPTS;
      bus?.emit({
        type: "agent:thinking",
        agent: "generate",
        role: ROLES.engineer.config.name,
        message: exhausted
          ? "修复次数用尽"
          : `校验未通过，自动修复重试（第 ${ctx.fixAttempts} 次）`,
      });
      return { attempt: ctx.fixAttempts, exhausted };
    }
    default:
      throw new Error(`未知 action: ${step.action}`);
  }
}
