/**
 * 阶段级校验（fullstack-app SOP 中间产物专用）。
 *
 * 与 verifyProject（最终单文件 HTML 完整校验）分工：
 * - schema / pages：纯 JS 产物，只验 acorn 语法
 * - shell：HTML 骨架，验基本结构 + 至少一个 PAGE_CONTENT 占位符
 * - 最终合并产物仍走 verifyProject（本模块不覆盖）
 */

import * as acorn from "acorn";
import { parse } from "node-html-parser";
import type { VerifyResult } from "../schemas";

/** 纯 JS 语法校验（schema/pages 阶段） */
function verifyJsSyntax(code: string, stage: string): VerifyResult {
  const errors: VerifyResult["errors"] = [];

  if (!code.trim()) {
    errors.push({ rule: "stage-empty", message: `${stage} 阶段产物为空` });
    return { pass: false, stage: "syntax", errors };
  }
  if (/<\s*html|<\s*!DOCTYPE/i.test(code)) {
    errors.push({
      rule: "stage-constraint",
      message: `${stage} 阶段禁止生成 HTML 文档结构`,
    });
  }

  try {
    acorn.parse(code, { ecmaVersion: 2022, allowReturnOutsideFunction: true });
  } catch (err) {
    const e = err as {
      message?: string;
      loc?: { line: number; column: number };
    };
    errors.push({
      rule: "syntax",
      message: `JS 语法错误：${e.message ?? String(err)}${e.loc ? `（第 ${e.loc.line} 行）` : ""}`,
    });
  }

  return { pass: errors.length === 0, stage: "syntax", errors };
}

/** shell 骨架校验：HTML 基本结构 + 页面占位符存在 */
function verifyShell(html: string): VerifyResult {
  const errors: VerifyResult["errors"] = [];

  if (!/<\s*!DOCTYPE\s+html/i.test(html)) {
    errors.push({
      rule: "structure",
      message: "shell 缺少 <!DOCTYPE html> 声明",
    });
  }
  const root = parse(html);
  if (!root.querySelector("body")) {
    errors.push({ rule: "structure", message: "shell 缺少 <body>" });
  }
  if (
    /<script\s+[^>]*src\s*=|<link\s+[^>]*rel\s*=\s*["']?stylesheet/i.test(html)
  ) {
    errors.push({
      rule: "structure",
      message: "shell 禁止外部脚本/样式（产物必须自包含）",
    });
  }
  if (!/<!--\s*PAGE_CONTENT:\s*[\w-]+\s*-->/.test(html)) {
    errors.push({
      rule: "stage-constraint",
      message: "shell 缺少 <!-- PAGE_CONTENT:name --> 页面占位符",
    });
  }

  return { pass: errors.length === 0, stage: "structure", errors };
}

/** 阶段产物统一校验入口（stage: schema / shell / pages） */
export function verifyStageCode(code: string, stage: string): VerifyResult {
  if (stage === "shell") return verifyShell(code);
  return verifyJsSyntax(code, stage);
}
