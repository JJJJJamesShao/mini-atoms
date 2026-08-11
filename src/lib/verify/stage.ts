/**
 * 阶段级校验（fullstack-app SOP 中间产物专用）。
 *
 * 与 verifyProject（最终单文件 HTML 完整校验）分工：
 * - schema：纯 JS 产物，只验 acorn 语法
 * - pages：HTML 片段（含内联 <script>），按 PAGE 分隔符切分后逐块验脚本语法
 * - shell：HTML 骨架，验基本结构 + 至少一个 PAGE_CONTENT 占位符
 * - 最终合并产物仍走 verifyProject（本模块不覆盖）
 */

import * as acorn from "acorn";
import { parse } from "node-html-parser";
import { splitPages } from "../agent/merge";
import type { VerifyResult } from "../schemas";

/** 纯 JS 语法校验（schema 阶段） */
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

/**
 * pages 阶段校验：产物是 HTML 片段（非纯 JS）——按 PAGE 分隔符切分，
 * 逐块提取内联 <script> 做语法校验，块外 HTML 片段不参与 JS 解析
 */
function verifyPages(text: string): VerifyResult {
  const errors: VerifyResult["errors"] = [];

  if (!text.trim()) {
    errors.push({ rule: "stage-empty", message: "pages 阶段产物为空" });
    return { pass: false, stage: "syntax", errors };
  }
  if (/<\s*html|<\s*!DOCTYPE/i.test(text)) {
    errors.push({
      rule: "stage-constraint",
      message: "pages 阶段禁止输出 <!DOCTYPE>/<html> 文档结构",
    });
  }

  const pages = splitPages(text);
  if (pages.size === 0) {
    errors.push({
      rule: "stage-constraint",
      message: "pages 缺少 // === PAGE: name === 分隔符块",
    });
    return { pass: false, stage: "syntax", errors };
  }

  for (const [name, block] of pages) {
    const scripts = [...block.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)];
    for (const m of scripts) {
      const js = m[1];
      if (!js.trim()) continue;
      try {
        acorn.parse(js, { ecmaVersion: 2022 });
      } catch (err) {
        const e = err as {
          message?: string;
          loc?: { line: number; column: number };
        };
        errors.push({
          rule: "syntax",
          message: `页面 ${name} 的脚本语法错误：${e.message ?? String(err)}${e.loc ? `（块内第 ${e.loc.line} 行）` : ""}`,
        });
      }
    }
  }

  return { pass: errors.length === 0, stage: "syntax", errors };
}

/** 阶段产物统一校验入口（stage: schema / shell / pages） */
export function verifyStageCode(code: string, stage: string): VerifyResult {
  if (stage === "shell") return verifyShell(code);
  if (stage === "pages") return verifyPages(code);
  return verifyJsSyntax(code, stage);
}
