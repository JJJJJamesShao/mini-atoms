/**
 * 两阶段生成的「阶段 1：架构规划」prompt 与输出解析。
 *
 * 背景：GLM-5.2 的 max_tokens 对思考与正文合并计费（实测 512 上限会被
 * 思考全部吃光）。思考期与出码期拆分后，出码期关闭深度思考，
 * 全部输出预算留给代码本身，等效突破单次 128K 的内容上限。
 */

import type { SpecOutput, VerifyResult } from "@/lib/schemas";

/** 阶段 1 输出预算：思考 + 方案文本，32K 充足 */
export const PLAN_MAX_TOKENS = 32_768;

/**
 * 阶段 2 出码预算：100K——不顶满 128K，给模型留输出余量
 * （顶满时末尾 chunk 易被平台/网关截断）
 */
export const GENERATE_MAX_TOKENS = 102_400;

/** 单次出码的预估安全线：阶段 1 自估超过该值则提示可能截断 */
export const SINGLE_SHOT_TOKEN_BUDGET = 90_000;

const SYSTEM_PLAN = `你是一位资深前端架构师。你的任务是为一个「单文件 HTML 应用」制定完整、可直接照做的实现方案，下游工程师将严格按你的方案编码，不再自行设计。

要求：
1. 完整覆盖：页面结构（区块划分）、UI 组件清单、状态设计（变量与数据结构）、核心算法思路、交互细节、边界情况处理。
2. 不写实际代码，必要时可用少量伪代码表达关键逻辑。
3. 方案必须具体到「照做即可」的程度，避免泛泛而谈。
4. 中文输出。
5. 输出末尾必须单独一行给出你对最终实现代码量的估计，格式严格为：
估算token：N
（N 为整数，估算最终单文件 HTML 的 token 数，1 个中文字符约 0.75 token，1 个 ASCII 字符约 0.3 token）`;

/** 阶段 1 规划 prompt：输入规格（修复场景含错误清单），输出实现方案 */
export function buildPlanPrompt(
  spec: SpecOutput,
  errors?: VerifyResult["errors"],
): Array<{ role: "system" | "user"; content: string }> {
  let userContent =
    "规格：\n- " +
    spec.requirements.join("\n- ") +
    "\n\n约束：\n- " +
    spec.constraints.join("\n- ");

  if (spec.userStories && spec.userStories.length > 0) {
    userContent += "\n\n用户故事：\n- " + spec.userStories.join("\n- ");
  }

  if (errors && errors.length > 0) {
    userContent +=
      "\n\n注意：上一版代码在校验阶段发现以下错误（共 " +
      errors.length +
      " 处），方案中必须针对性规避：\n- " +
      errors.map((e) => `${e.rule}: ${e.message}`).join("\n- ");
  }

  return [
    { role: "system" as const, content: SYSTEM_PLAN },
    { role: "user" as const, content: userContent },
  ];
}

/**
 * 从阶段 1 方案文本中解析模型自估的实现 token 数。
 * 匹配「估算token：N」标记（容忍空格/冒号变体/千分位/"约"前缀），
 * 未匹配返回 null（按"无法估计"处理，照常单阶段出码）。
 */
export function parseEstimatedTokens(planText: string): number | null {
  const match = planText.match(/估算\s*token\s*[：:]\s*约?\s*([\d][\d,]*)/i);
  if (!match) return null;
  const n = Number.parseInt(match[1].replace(/,/g, ""), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}
