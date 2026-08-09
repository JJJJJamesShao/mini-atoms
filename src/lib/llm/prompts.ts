/** LLM Prompt 模板 — 按流水线节点定义 */

import type { SpecOutput, VerifyResult } from "../schemas";

const SYSTEM_CLARIFY = `你是一位资深产品经理。判断用户需求是否足够清晰以直接进入规格生成。

判断标准：
- 如果需求明确（如"做一个待办清单"、"贪吃蛇游戏"、"计时器"），直接返回 ready
- 只有当需求明显缺失关键信息（如没有说明用途、没有说明目标用户）时才返回 need_clarification
- 不要过度追问，简单需求应该直接通过`;

const SYSTEM_SPEC = `你是一位技术架构师，擅长将需求拆解为可执行的技术规格。
你必须严格按照 JSON 格式输出，不要包含任何额外文字。`;

const SYSTEM_GENERATE = `你是一位全栈前端工程师，精通 HTML/CSS/JavaScript。
你的任务是根据规格生成完整的、可独立运行的单文件 HTML 应用。

**输出要求**：
1. 必须是完整的单文件 HTML（包含 <!DOCTYPE html>）
2. 所有样式内联在 <style> 标签中
3. 所有脚本内联在 <script> 标签中
4. 不允许引用任何外部资源（CDN、图片外链等）
5. 不允许使用框架（React/Vue 等），只能用原生 JS
6. 代码必须语法正确，可直接运行
7. 应用必须美观、交互流畅
8. 文件大小不超过 200KB

**输出格式**：
直接输出 HTML 代码，不要包裹在 markdown 代码块中，不要添加任何解释文字。`;

const SYSTEM_FIX = `你是一位前端工程师，之前生成的代码在校验阶段发现了错误。
请根据错误信息修复代码，重新输出完整的 HTML 文件。

**修复原则**：
1. 只修复报错的语法/结构问题
2. 保持原有功能和样式不变
3. 输出完整的修复后代码，不要只输出修改的部分`;

// --- clarify 节点 ---

export function buildClarifyPrompt(userInput: string) {
  return [
    { role: "system" as const, content: SYSTEM_CLARIFY },
    {
      role: "user" as const,
      content: `用户需求：${userInput}

请判断这个需求是否足够清晰以直接进入规格生成。如果不够清晰，请提出最多 3 个澄清问题（每个问题附带选项）。

请严格按照以下 JSON 格式输出：
{
  "status": "ready" | "need_clarification",
  "questions": [
    { "id": "q1", "question": "...", "options": ["选项A", "选项B"] }
  ],
  "summary": "用一句话总结用户需求的要点"
}`,
    },
  ];
}

// --- spec 节点 ---

export function buildSpecPrompt(clarifySummary: string) {
  return [
    { role: "system" as const, content: SYSTEM_SPEC },
    {
      role: "user" as const,
      content: `需求总结：${clarifySummary}

请将其拆解为技术规格。严格按照以下 JSON 格式输出：
{
  "requirements": ["功能需求1", "功能需求2", ...],
  "constraints": ["约束1", "约束2", ...],
  "userStories": ["作为...我可以...以便..."]
}

注意：
- requirements 不超过 8 条
- constraints 必须包含"单文件 HTML"、"无外部依赖"
- userStories 至少 1 条`,
    },
  ];
}

// --- generate 节点 ---

export function buildGeneratePrompt(
  spec: SpecOutput,
  errors?: VerifyResult["errors"],
) {
  const constraints = spec.constraints.join("\n- ");
  const requirements = spec.requirements.join("\n- ");

  let userContent = `需求：
- ${requirements}

约束：
- ${constraints}

请生成完整的单文件 HTML 应用。`;

  if (errors && errors.length > 0) {
    userContent =
      SYSTEM_FIX +
      "\n\n之前的代码在校验阶段发现以下错误：\n" +
      errors.map((e) => `- [${e.rule}] ${e.message}`).join("\n") +
      "\n\n原始规格：\n- " +
      requirements +
      "\n\n约束：\n- " +
      constraints +
      "\n\n请修复后输出完整代码。";
  }

  return [
    { role: "system" as const, content: SYSTEM_GENERATE },
    { role: "user" as const, content: userContent },
  ];
}

// --- classify 节点（打断机制预留）---

export function buildClassifyPrompt(currentTask: string, newMessage: string) {
  return [
    {
      role: "system" as const,
      content: "你是一位意图分类助手。判断用户新消息与当前任务的关系。",
    },
    {
      role: "user" as const,
      content: `当前任务：${currentTask}
用户新消息：${newMessage}

请判断意图类型（amend/switch/unrelated），只输出一个单词：`,
    },
  ];
}
