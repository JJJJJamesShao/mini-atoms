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

**结构标记（必须在对应位置插入）**：
在生成过程中，按以下顺序输出，并在每个部分前插入标记注释：

<!-- SECTION: HEAD -->
<!DOCTYPE html><html><head>...</head>

<!-- SECTION: CSS -->
<style>...</style>

<!-- SECTION: BODY -->
<body>...</body>

<!-- SECTION: JS -->
<script>...</script></html>

这些标记用于系统跟踪生成进度，请不要省略。

**输出格式**：
直接输出 HTML 代码，不要包裹在 markdown 代码块中，不要添加任何解释文字。`;

const SYSTEM_FIX = `你是一位前端工程师，之前生成的代码在校验阶段发现了错误。
请根据错误信息修复代码，重新输出完整的 HTML 文件。

**修复原则**（极其重要）：
1. 只修复报错的语法/结构问题，不要改动正确部分
2. 保持原有功能和样式完全不变
3. 修复后确保所有校验都能通过
4. 输出完整的修复后代码，不要只输出修改的部分`;

/** 格式化校验错误为 LLM 可读的详细报告 */
function formatErrorsForLLM(errors: VerifyResult["errors"]): string {
  return errors
    .map((e, i) => {
      const parts = [`[错误 ${i + 1}] ${e.rule}`];
      if (e.line)
        parts.push(
          `位置：第 ${e.line} 行${e.column ? `，第 ${e.column} 列` : ""}`,
        );
      parts.push(`问题：${e.message}`);
      if (e.snippet) parts.push(`相关代码：\n${e.snippet}`);
      if (e.suggestion) parts.push(`修复建议：${e.suggestion}`);
      return parts.join("\n");
    })
    .join("\n\n---\n\n");
}

/** 游戏专用：结构化输出（CodeArtifact JSON，支持多文件） */
const SYSTEM_GENERATE_GAME = `你是一位 HTML5 游戏开发专家。

## 输出格式（严格 JSON）
你必须输出合法的 JSON，格式如下：
{
  "files": [
    {
      "path": "index.html",
      "type": "html",
      "content": "<!DOCTYPE html>...<script>所有JS代码内联在这里</script>...</html>",
      "dependencies": []
    }
  ],
  "metadata": {
    "framework": null,
    "externalDeps": []
  },
  "notes": "游戏核心机制说明..."
}

## 关键约束（必须严格遵守）
- **单文件 HTML**：所有 CSS 和 JS 必须内联在 index.html 中，不要拆分成多个文件
- **无外部依赖**：原生 JS + Canvas，不使用任何 CDN 或外部库
- **包含完整的游戏循环、碰撞检测、得分系统**
- **支持键盘和触摸控制**
- **直接输出 JSON，不要包裹 markdown 代码块，不要添加解释文字`;

// --- patch 模式（精确编辑，避免完整重写） ---

const SYSTEM_PATCH = `你是一位前端工程师，擅长精确代码编辑。
你收到了一份带有校验错误的 HTML 代码，以及详细的错误定位信息。

**你的任务**：使用 Search/Replace 格式输出精确的编辑指令，修复所有错误。

## 输出格式（严格 Search/Replace）

每个修改使用如下格式：

<<<<<<< SEARCH
[要替换的原始代码，必须精确匹配文件中的内容]
=======
[修复后的新代码]
>>>>>>> REPLACE

**重要规则**：
1. SEARCH 块必须精确匹配原始代码（包括空格、缩进、换行）
2. 可以有多个 SEARCH/REPLACE 块，按顺序应用
3. 只修改报错的代码，不要改动正确部分
4. 不要输出任何解释文字，只输出 SEARCH/REPLACE 块
5. 确保所有错误都被修复

## 示例

<<<<<<< SEARCH
var b = ;
=======
var b = 0;
>>>>>>> REPLACE

<<<<<<< SEARCH
<script src="https://cdn.example.com/lib.js"></script>
=======
<!-- 外部脚本已移除 -->
>>>>>>> REPLACE`;

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
      "\n\n之前的代码在校验阶段发现以下错误（共 " +
      errors.length +
      " 处）：\n\n" +
      formatErrorsForLLM(errors) +
      "\n\n---\n\n原始规格：\n- " +
      requirements +
      "\n\n约束：\n- " +
      constraints +
      "\n\n请根据错误详情精确定位并修复问题，输出完整修复后的代码。特别注意：只修改报错的部分，保持其他代码不变。";
  }

  return [
    { role: "system" as const, content: SYSTEM_GENERATE },
    { role: "user" as const, content: userContent },
  ];
}

// --- generate 节点（游戏专用：结构化输出） ---

export function buildGameGeneratePrompt(
  spec: SpecOutput,
  errors?: VerifyResult["errors"],
) {
  const constraints = spec.constraints.join("\n- ");
  const requirements = spec.requirements.join("\n- ");

  let userContent = `游戏需求：
- ${requirements}

约束：
- ${constraints}

请按 CodeArtifact JSON 格式输出完整游戏代码。`;

  if (errors && errors.length > 0) {
    userContent +=
      "\n\n之前的代码在校验阶段发现以下错误（共 " +
      errors.length +
      " 处），请修复后重新输出完整 JSON：\n\n" +
      formatErrorsForLLM(errors) +
      "\n\n---\n\n请根据错误详情精确定位并修复问题。特别注意：只修改报错的部分，保持其他代码不变。";
  }

  return [
    { role: "system" as const, content: SYSTEM_GENERATE_GAME },
    { role: "user" as const, content: userContent },
  ];
}

// --- patch 模式（精确编辑） ---

export function buildPatchPrompt(
  currentHtml: string,
  errors: VerifyResult["errors"],
): Array<{ role: "system" | "user"; content: string }> {
  return [
    { role: "system" as const, content: SYSTEM_PATCH },
    {
      role: "user" as const,
      content: `当前 HTML 代码（${currentHtml.length} 字符）：

${currentHtml}

---

校验发现以下错误（共 ${errors.length} 处）：

${formatErrorsForLLM(errors)}

---

请使用 Search/Replace 格式输出编辑指令，修复所有错误。不要输出任何解释文字。`,
    },
  ];
}
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
