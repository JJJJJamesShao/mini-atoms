import type {
  ClarifyOutput,
  File,
  GenerateOutput,
  SpecOutput,
  VerifyResult,
} from "../schemas";

/** 流水线状态 */
export type PipelineState =
  | "idle"
  | "clarify"
  | "spec"
  | "approve"
  | "generate"
  | "verify"
  | "fix"
  | "done"
  | "fail";

/** 流水线事件（供 SSE/进度展示） */
export interface PipelineEvent {
  state: PipelineState;
  payload: unknown;
  timestamp: number;
}

/** 可注入的节点执行器——默认实现使用罐头数据，替换为真实 LLM 调用时只需提供新实现 */
export interface Executors {
  clarify: (input: string) => Promise<ClarifyOutput>;
  spec: (clarify: ClarifyOutput) => Promise<SpecOutput>;
  /**
   * 生成代码。
   * @param spec - 规格
   * @param errors - 校验错误（非空表示 fix 模式）
   * @param currentFiles - 当前代码文件（fix 模式时传入，用于 patch 编辑；
   *   多阶段 SOP 时为前置阶段产物）
   * @param attempt - 当前 fix 轮次（0 表示首次生成，1+ 表示修复重试）
   * @param stage - 多阶段 SOP 的阶段标识（schema/shell/pages），缺省为单阶段生成
   */
  generate: (
    spec: SpecOutput,
    errors?: VerifyResult["errors"],
    currentFiles?: File[],
    attempt?: number,
    stage?: string,
  ) => Promise<GenerateOutput>;
  /**
   * 校验产物。
   * @param stage - 多阶段 SOP 的阶段标识（schema/shell 走阶段级校验），
   *   缺省为完整单文件 HTML 校验
   */
  verify: (files: File[], stage?: string) => Promise<VerifyResult>;
}

/** approve 节点决策（骨架阶段由调用方注入，默认自动通过） */
export type Approver = (spec: SpecOutput) => Promise<boolean>;

const MAX_FIX_ATTEMPTS = 2;

/** 状态转移表：描述每个状态的合法后继 */
export const TRANSITIONS: Record<PipelineState, PipelineState[]> = {
  idle: ["clarify"],
  clarify: ["spec", "fail"],
  spec: ["approve"],
  approve: ["generate", "clarify"], // 被拒 → 回 clarify
  generate: ["verify"],
  verify: ["fix", "done", "fail"],
  fix: ["generate"],
  done: [],
  fail: [],
};

/**
 * 运行流水线主循环。
 * 返回产生的事件数组与最终状态；终态为 done 时 result 含生成的代码。
 */
export async function runPipeline(
  input: string,
  executors: Executors,
  approve: Approver = async () => true,
): Promise<{
  events: PipelineEvent[];
  finalState: PipelineState;
  result?: GenerateOutput;
}> {
  const events: PipelineEvent[] = [];
  let state: PipelineState = "idle";
  let fixAttempts = 0;

  const enter = (next: PipelineState, payload: unknown) => {
    if (!TRANSITIONS[state].includes(next)) {
      throw new Error(`非法状态转移: ${state} -> ${next}`);
    }
    state = next;
    events.push({ state, payload, timestamp: Date.now() });
  };

  enter("clarify", { input });
  const clarifyOut = await executors.clarify(input);
  if (clarifyOut.status === "need_clarification") {
    // 骨架阶段：澄清问题返回给调用方，待真实 LLM 接入后做交互式澄清
    enter("fail", {
      reason: "need_clarification",
      questions: clarifyOut.questions,
    });
    return { events, finalState: state };
  }

  enter("spec", { summary: clarifyOut.summary });
  const specOut = await executors.spec(clarifyOut);

  enter("approve", { spec: specOut });
  const approved = await approve(specOut);
  if (!approved) {
    // 规格被拒：回 clarify 重新澄清（骨架阶段仅记录一次转移后终止，避免无限循环）
    enter("clarify", { reason: "spec_rejected" });
    enter("fail", { reason: "spec_rejected" });
    return { events, finalState: state };
  }

  let lastErrors: VerifyResult["errors"] | undefined;
  let generated: GenerateOutput | undefined;

  for (;;) {
    enter("generate", { isRetry: fixAttempts > 0 });
    generated = await executors.generate(specOut, lastErrors);

    enter("verify", { notes: generated.notes });
    const verifyOut = await executors.verify(generated.files);

    if (verifyOut.pass) {
      enter("done", { files: generated.files });
      return { events, finalState: state, result: generated };
    }

    fixAttempts += 1;
    if (fixAttempts >= MAX_FIX_ATTEMPTS) {
      enter("fail", { reason: "verify_failed", errors: verifyOut.errors });
      return { events, finalState: state };
    }
    lastErrors = verifyOut.errors;
    enter("fix", { errors: verifyOut.errors, attempt: fixAttempts });
  }
}
