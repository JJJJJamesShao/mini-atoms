/**
 * Search/Replace Patch 工具 — 受 Aider / RooCode 启发
 *
 * 让 LLM 输出精确的编辑指令，后端执行字符串替换，避免完整重写。
 * 格式：
 *
 * ```
 * <<<<<<< SEARCH
 * [要被替换的原始代码，必须精确匹配]
 * =======
 * [替换后的新代码]
 * >>>>>>> REPLACE
 * ```
 */

export interface PatchBlock {
  search: string;
  replace: string;
}

/** 匹配级别：exact 精确 / rstrip 行尾空白归一化 / indent 忽略行首缩进 */
export type MatchLevel = "exact" | "rstrip" | "indent";

export interface ApplyResult {
  success: boolean;
  newContent: string;
  applied: number;
  failed: number;
  details: Array<{
    index: number;
    status: "applied" | "failed";
    /** 命中级别（仅 applied 时有值）：fuzzy 级别越低可信度越高 */
    matchLevel?: MatchLevel;
    reason?: string;
  }>;
}

const PATCH_DELIMITER =
  /^<<<<<<< SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> REPLACE$/gm;

/** 从 LLM 输出中解析 patch 块 */
export function parsePatch(text: string): PatchBlock[] {
  const blocks: PatchBlock[] = [];
  let match;
  while ((match = PATCH_DELIMITER.exec(text)) !== null) {
    blocks.push({ search: match[1], replace: match[2] });
  }
  return blocks;
}

/** 将文本切分为行并记录每行的起始字符偏移 */
function splitWithOffsets(
  text: string,
): Array<{ line: string; start: number }> {
  const lines: Array<{ line: string; start: number }> = [];
  let start = 0;
  for (const line of text.split("\n")) {
    lines.push({ line, start });
    start += line.length + 1;
  }
  return lines;
}

interface LineMatch {
  start: number;
  end: number;
}

/**
 * 行级模糊查找：eq 判定两行等价，要求 search 的连续行序列在 content 中出现。
 * 返回所有命中区间——模糊级别必须唯一命中才可应用（多候选 = 误改风险）。
 */
function findLineMatches(
  content: string,
  search: string,
  eq: (contentLine: string, searchLine: string) => boolean,
): LineMatch[] {
  const contentLines = splitWithOffsets(content);
  const searchLines = search.split("\n");
  if (searchLines.length > contentLines.length) return [];

  const matches: LineMatch[] = [];
  for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
    let ok = true;
    for (let j = 0; j < searchLines.length; j++) {
      if (!eq(contentLines[i + j].line, searchLines[j])) {
        ok = false;
        break;
      }
    }
    if (ok) {
      const last = contentLines[i + searchLines.length - 1];
      matches.push({
        start: contentLines[i].start,
        end: last.start + last.line.length,
      });
    }
  }
  return matches;
}

const rstrip = (s: string) => s.replace(/\s+$/, "");

/** 三级匹配策略：逐级放宽，只在上一级未命中时降级 */
const MATCH_STRATEGIES: Array<{
  level: MatchLevel;
  find: (content: string, search: string) => LineMatch[];
}> = [
  {
    level: "exact",
    find: (content, search) => {
      const matches: LineMatch[] = [];
      let from = 0;
      for (;;) {
        const idx = content.indexOf(search, from);
        if (idx === -1) break;
        matches.push({ start: idx, end: idx + search.length });
        from = idx + 1;
      }
      return matches;
    },
  },
  {
    level: "rstrip",
    find: (content, search) =>
      findLineMatches(content, search, (a, b) => rstrip(a) === rstrip(b)),
  },
  {
    level: "indent",
    find: (content, search) =>
      findLineMatches(content, rstrip(search), (a, b) => a.trim() === b.trim()),
  },
];

/**
 * 失败时给出近似位置提示：找首个非空 search 行（trim 后）在 content 中
 * trim 相等的行号，作为 LLM 修正 SEARCH 块的参照。
 */
function findHintLine(content: string, search: string): number | null {
  const probe = search
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!probe) return null;
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === probe) return i + 1;
  }
  return null;
}

/**
 * 应用 patch 块到原始内容。
 *
 * 三级匹配策略（逐级放宽，每级要求唯一命中）：
 * 1. exact：精确字符串匹配（含空白）
 * 2. rstrip：行尾空白归一化的逐行匹配（容忍 LLM 输出的行尾空格漂移）
 * 3. indent：忽略行首缩进的逐行对齐（容忍缩进层级误判；
 *    JS/CSS/HTML 对缩进不敏感，替换文本采用模型给出的缩进）
 * 每次替换后立即更新内容，后续块在新内容上继续匹配。
 */
export function applyPatch(content: string, blocks: PatchBlock[]): ApplyResult {
  let current = content;
  const details: ApplyResult["details"] = [];
  let applied = 0;
  let failed = 0;

  for (let i = 0; i < blocks.length; i++) {
    const { search, replace } = blocks[i];

    if (!search) {
      failed++;
      details.push({
        index: i,
        status: "failed",
        reason: "SEARCH 块为空，无法定位。",
      });
      continue;
    }

    let appliedBlock = false;
    for (const strategy of MATCH_STRATEGIES) {
      const matches = strategy.find(current, search);
      if (matches.length === 1) {
        const { start, end } = matches[0];
        current = current.slice(0, start) + replace + current.slice(end);
        applied++;
        details.push({
          index: i,
          status: "applied",
          matchLevel: strategy.level,
        });
        appliedBlock = true;
        break;
      }
      if (matches.length > 1) {
        failed++;
        details.push({
          index: i,
          status: "failed",
          reason: `SEARCH 块在 ${strategy.level} 级别命中 ${matches.length} 个候选位置，无法确定唯一改动点。请补充更多上下文使 SEARCH 块唯一。`,
        });
        appliedBlock = true; // 已有定论（失败），不再降级
        break;
      }
    }
    if (appliedBlock) continue;

    failed++;
    const hint = findHintLine(current, search);
    details.push({
      index: i,
      status: "failed",
      reason:
        `SEARCH 块未找到匹配（长度 ${search.length} 字符）。请确保搜索代码与文件内容完全一致。` +
        (hint ? `疑似目标位置：第 ${hint} 行附近。` : ""),
    });
  }

  return {
    success: failed === 0,
    newContent: current,
    applied,
    failed,
    details,
  };
}

/**
 * 将 patch 结果格式化为 LLM 可读的反馈
 */
export function formatPatchFeedback(result: ApplyResult): string {
  if (result.success) {
    return `✅ 全部 ${result.applied} 个 patch 块应用成功。`;
  }
  const lines: string[] = [];
  lines.push(
    `⚠️ Patch 应用结果：${result.applied} 成功，${result.failed} 失败`,
  );
  for (const d of result.details) {
    if (d.status === "failed") {
      lines.push(`  - 块 #${d.index + 1} 失败：${d.reason}`);
    }
  }
  lines.push("请修正失败的 SEARCH 块后重试。");
  return lines.join("\n");
}
