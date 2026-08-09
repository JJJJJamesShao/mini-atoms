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

export interface ApplyResult {
  success: boolean;
  newContent: string;
  applied: number;
  failed: number;
  details: Array<{
    index: number;
    status: "applied" | "failed";
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

/**
 * 应用 patch 块到原始内容。
 *
 * 策略：
 * 1. 精确字符串匹配（含空白）
 * 2. 失败时尝试模糊匹配（去除首尾空白后匹配）
 * 3. 每次替换后立即更新内容，后续块在新内容上继续匹配
 */
export function applyPatch(content: string, blocks: PatchBlock[]): ApplyResult {
  let current = content;
  const details: ApplyResult["details"] = [];
  let applied = 0;
  let failed = 0;

  for (let i = 0; i < blocks.length; i++) {
    const { search, replace } = blocks[i];
    const index = current.indexOf(search);

    if (index !== -1) {
      current =
        current.slice(0, index) +
        replace +
        current.slice(index + search.length);
      applied++;
      details.push({ index: i, status: "applied" });
      continue;
    }

    // 模糊匹配：去除首尾空白
    const fuzzySearch = search.trim();
    const fuzzyIndex = current.indexOf(fuzzySearch);
    if (fuzzySearch !== search && fuzzyIndex !== -1) {
      current =
        current.slice(0, fuzzyIndex) +
        replace +
        current.slice(fuzzyIndex + fuzzySearch.length);
      applied++;
      details.push({ index: i, status: "applied" });
      continue;
    }

    failed++;
    details.push({
      index: i,
      status: "failed",
      reason: `SEARCH 块未找到匹配（长度 ${search.length} 字符）。请确保搜索代码与文件内容完全一致。`,
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
