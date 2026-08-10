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
import { mergeFullstack } from "./merge";
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
  /** reason 为 need_clarification 时，模型希望用户补充的问题清单（软着陆引导用） */
  questions?: string[];
  /** finalState 为 done 时的生成产物 */
  result?: GenerateOutput;
  /** 多阶段 SOP 的中间产物（schema/shell/pages 原始代码，落库供排查与回放） */
  stageOutputs?: Record<string, GenerateOutput>;
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
  /** 多阶段 SOP：各阶段产物（generate-X 步骤名 → 输出） */
  stageOutputs: Record<string, GenerateOutput>;
}

/**
 * 从步骤名解析多阶段标识：generate-schema → "schema"、verify-pages → "pages"；
 * 无后缀的单阶段步骤（generate/verify）返回 undefined
 */
function stageOfStep(stepName: string): string | undefined {
  const match = stepName.match(/^(?:generate|verify)-(.+)$/);
  return match ? match[1] : undefined;
}

/** 多阶段 SOP：当前阶段生成时作为输入的前置产物 */
function stageInputFiles(
  ctx: ExecutionContext,
  stage: string | undefined,
): File[] | undefined {
  switch (stage) {
    case "schema":
      return ctx.initialFiles;
    case "shell":
      return ctx.stageOutputs["schema"]?.files;
    case "pages":
      return [
        ...(ctx.stageOutputs["schema"]?.files ?? []),
        ...(ctx.stageOutputs["shell"]?.files ?? []),
      ];
    default:
      return ctx.initialFiles ?? ctx.generated?.files;
  }
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
    stageOutputs: {},
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
        stageOutputs:
          Object.keys(ctx.stageOutputs).length > 0
            ? ctx.stageOutputs
            : undefined,
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
      const reason = deriveFailReason(step);
      const runResult: SOPRunResult = {
        sop,
        finalState: "fail",
        reason,
        // 多阶段失败时中间产物一并带出（落库供排查）
        stageOutputs:
          Object.keys(ctx.stageOutputs).length > 0
            ? ctx.stageOutputs
            : undefined,
      };
      // 软着陆：澄清不足不掐死任务，把模型想确认的问题透传给前端引导用户补充
      if (reason === "need_clarification") {
        const clarifyOut = output as ClarifyOutput | null;
        const questions = clarifyOut?.openQuestions?.length
          ? clarifyOut.openQuestions
          : clarifyOut?.questions?.map((q) => q.question);
        if (questions?.length) runResult.questions = questions;
      }
      return runResult;
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
    case "merge":
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
      const stage = stageOfStep(step.name);
      // fix 模式（有校验错误）：重修当前阶段产物（ctx.generated 即该阶段上次输出）；
      // 否则传入前置阶段产物（shell 引用 schema、pages 引用 schema+shell）
      const currentFiles = ctx.lastErrors?.length
        ? (ctx.generated?.files ?? stageInputFiles(ctx, stage))
        : stageInputFiles(ctx, stage);
      const out = await executors.generate(
        ctx.spec,
        ctx.lastErrors,
        currentFiles,
        ctx.fixAttempts,
        stage,
      );
      ctx.generated = out;
      if (stage) ctx.stageOutputs[stage] = out;
      return out;
    }
    case "verify": {
      if (!ctx.generated) throw new Error("verify 步骤缺少 generate 产物");
      const stage = stageOfStep(step.name);
      const out = await executors.verify(ctx.generated.files, stage);
      // 多阶段 SOP 必须清理：上一阶段的错误不能污染下一阶段（否则误判为 fix 模式）
      ctx.lastErrors = out.pass ? undefined : out.errors;
      return out;
    }
    case "merge": {
      // 确定性合并（零 LLM）：schema + shell + pages → index.html
      const schema = ctx.stageOutputs["schema"];
      const shell = ctx.stageOutputs["shell"];
      const pages = ctx.stageOutputs["pages"];
      if (!schema || !shell || !pages) {
        throw new Error("merge 步骤缺少阶段产物（schema/shell/pages）");
      }
      bus?.emit({
        type: "agent:start",
        agent: step.name,
        role: roleName,
        message: "合并各阶段产物",
      });
      const merged = mergeFullstack(
        schema.files[0]?.content ?? "",
        shell.files[0]?.content ?? "",
        pages.files[0]?.content ?? "",
      );
      const out: GenerateOutput = {
        files: [{ path: "index.html", content: merged }],
        notes: `多阶段合并完成：schema ${schema.files[0]?.content.length ?? 0} 字符 + shell ${shell.files[0]?.content.length ?? 0} 字符 + pages ${pages.files[0]?.content.length ?? 0} 字符 → ${merged.length} 字符`,
      };
      ctx.generated = out;
      bus?.emit({
        type: "agent:complete",
        agent: step.name,
        role: roleName,
        output: out,
        message: out.notes,
      });
      return out;
    }
    case "fix": {
      // fix 不调用执行器：记录次数并回退到 generate 重新生成。
      // 事件挂到对应的 generate 阶段卡片上（fix-schema → generate-schema），
      // fix 是内部步骤，不在前端阶段列表中展示
      ctx.fixAttempts += 1;
      const exhausted = ctx.fixAttempts >= MAX_FIX_ATTEMPTS;
      bus?.emit({
        type: "agent:thinking",
        agent: step.name.replace(/^fix($|-)/, "generate$1"),
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
