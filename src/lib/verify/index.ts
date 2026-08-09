import * as acorn from "acorn";
import { parse } from "node-html-parser";
import type { File, VerifyError, VerifyResult } from "../schemas";

const MAX_SIZE_BYTES = 200 * 1024;

/** 提取 HTML 中所有 <script> 块的内联代码（不含带 src 的外部脚本） */
function extractInlineScripts(
  html: string,
): Array<{ index: number; code: string; startPos: number }> {
  const root = parse(html);
  return root
    .querySelectorAll("script")
    .filter((s) => !s.getAttribute("src"))
    .map((s, index) => {
      // 计算 script 在原始 HTML 中的大致位置
      const text = s.textContent;
      const startPos = html.indexOf(text);
      return { index, code: text, startPos };
    });
}

/** 将 HTML 中的绝对字符位置转换为行号/列号 */
function posToLineCol(
  html: string,
  pos: number,
): { line: number; column: number } {
  const lines = html.slice(0, pos).split("\n");
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

/** 提取代码片段（含上下文） */
function extractSnippet(html: string, pos: number, contextLines = 2): string {
  const lines = html.split("\n");
  const { line } = posToLineCol(html, pos);
  const start = Math.max(0, line - contextLines - 1);
  const end = Math.min(lines.length, line + contextLines);
  return lines
    .slice(start, end)
    .map((l, i) => `${start + i + 1}: ${l}`)
    .join("\n");
}

/** 语法校验：acorn 解析每个 <script> 块，收集语法错误（含行号+代码片段） */
export function validateSyntax(html: string): VerifyError[] {
  const scripts = extractInlineScripts(html);
  const errors: VerifyError[] = [];

  scripts.forEach(({ index, code, startPos }) => {
    try {
      acorn.parse(code, { ecmaVersion: 2022 });
    } catch (e) {
      const err = e as SyntaxError & {
        loc?: { line: number; column: number };
        pos?: number;
      };
      // acorn 的错误位置是相对于 script 块的，需要转换为 HTML 全局位置
      const scriptStart = posToLineCol(html, startPos);
      const globalLine = scriptStart.line + (err.loc?.line ?? 1) - 1;
      const globalColumn =
        err.loc?.line === 1
          ? scriptStart.column + (err.loc?.column ?? 0)
          : (err.loc?.column ?? 0);
      const label = scripts.length > 1 ? `script#${index + 1} ` : "";

      // 计算出错位置在 HTML 中的绝对字符位置
      const scriptLines = code.split("\n");
      const errLineInScript = (err.loc?.line ?? 1) - 1;
      const charOffset =
        scriptLines.slice(0, errLineInScript).join("\n").length +
        (errLineInScript > 0 ? 1 : 0) +
        (err.loc?.column ?? 0);
      const absPos = startPos + charOffset;

      errors.push({
        rule: "syntax",
        message: `${label}第 ${globalLine} 行，第 ${globalColumn + 1} 列：${err.message}`,
        line: globalLine,
        column: globalColumn + 1,
        snippet: extractSnippet(html, absPos, 2),
        suggestion: "检查 JavaScript 语法，确保变量声明、括号匹配正确",
      });
    }
  });

  return errors;
}

/** 危险标签与 XSS 向量校验（含定位） */
export function validateSecurity(html: string): VerifyError[] {
  const errors: VerifyError[] = [];
  const root = parse(html);

  root.querySelectorAll("iframe").forEach((el) => {
    const outer = el.outerHTML;
    const pos = html.indexOf(outer);
    const { line, column } = posToLineCol(html, pos);
    errors.push({
      rule: "dangerous-tag",
      message: `第 ${line} 行：禁止包含 <iframe> 标签（安全风险）`,
      line,
      column,
      snippet: extractSnippet(html, pos, 1),
      suggestion: "移除 <iframe>，如果需要嵌入内容请使用其他方案",
    });
  });

  root.querySelectorAll("object, embed").forEach((el) => {
    const outer = el.outerHTML;
    const pos = html.indexOf(outer);
    const { line, column } = posToLineCol(html, pos);
    errors.push({
      rule: "dangerous-tag",
      message: `第 ${line} 行：禁止包含 <${el.tagName.toLowerCase()}> 标签`,
      line,
      column,
      snippet: extractSnippet(html, pos, 1),
      suggestion: `移除 <${el.tagName.toLowerCase()}> 标签，使用原生 HTML/JS 替代`,
    });
  });

  root
    .querySelectorAll("a[href^='javascript:'], a[href^='JAVASCRIPT:']")
    .forEach((el) => {
      const outer = el.outerHTML;
      const pos = html.indexOf(outer);
      const { line, column } = posToLineCol(html, pos);
      const href = el.getAttribute("href") ?? "";
      errors.push({
        rule: "xss-vector",
        message: `第 ${line} 行：禁止 javascript: 协议链接：${href.slice(0, 50)}`,
        line,
        column,
        snippet: extractSnippet(html, pos, 1),
        suggestion: "移除 javascript: 协议，改用 addEventListener 绑定事件",
      });
    });

  root.querySelectorAll("*").forEach((el) => {
    const attrs = el.attributes;
    for (const key of Object.keys(attrs)) {
      const lower = key.toLowerCase();
      if (lower.startsWith("on")) {
        const outer = el.outerHTML;
        const pos = html.indexOf(outer);
        const { line, column } = posToLineCol(html, pos);
        errors.push({
          rule: "xss-vector",
          message: `第 ${line} 行：禁止内联事件处理器 ${key}="${attrs[key].slice(0, 50)}"`,
          line,
          column,
          snippet: extractSnippet(html, pos, 1),
          suggestion: `移除 ${key} 属性，改用 element.addEventListener() 在 <script> 中绑定事件`,
        });
      }
    }
  });

  root.querySelectorAll("form[action]").forEach((el) => {
    const outer = el.outerHTML;
    const pos = html.indexOf(outer);
    const { line, column } = posToLineCol(html, pos);
    errors.push({
      rule: "external-communication",
      message: `第 ${line} 行：禁止 <form action>（防止数据外发）`,
      line,
      column,
      snippet: extractSnippet(html, pos, 1),
      suggestion:
        "移除 form 的 action 属性，所有交互应在页面内用 JavaScript 处理",
    });
  });

  return errors;
}

/** 结构校验：DOCTYPE、基本标签、禁止外部资源、大小 <200KB */
export function validateStructure(html: string): VerifyError[] {
  const errors: VerifyError[] = [];

  if (!/^\s*<!DOCTYPE html>/i.test(html)) {
    errors.push({
      rule: "doctype",
      message: "缺少 <!DOCTYPE html> 声明",
      suggestion: "在文件最开头添加 <!DOCTYPE html>",
    });
  }

  const root = parse(html);

  if (!root.querySelector("html")) {
    errors.push({
      rule: "html-tag",
      message: "缺少 <html> 根标签",
      suggestion: "确保整个文档包裹在 <html>...</html> 中",
    });
  }

  if (!root.querySelector("body")) {
    errors.push({
      rule: "body-tag",
      message: "缺少 <body> 标签（内容可能无法渲染）",
      suggestion: "确保可见内容放在 <body>...</body> 中",
    });
  }

  root.querySelectorAll("script[src]").forEach((s) => {
    const src = s.getAttribute("src") ?? "";
    const outer = s.outerHTML;
    const pos = html.indexOf(outer);
    const { line, column } = posToLineCol(html, pos);
    errors.push({
      rule: "external-script",
      message: `第 ${line} 行：禁止外部脚本：${src}`,
      line,
      column,
      snippet: extractSnippet(html, pos, 1),
      suggestion: "将外部脚本内容内联到 <script>...</script> 中，或移除该引用",
    });
  });

  root.querySelectorAll('link[rel="stylesheet"]').forEach((l) => {
    const href = l.getAttribute("href") ?? "";
    const outer = l.outerHTML;
    const pos = html.indexOf(outer);
    const { line, column } = posToLineCol(html, pos);
    errors.push({
      rule: "external-stylesheet",
      message: `第 ${line} 行：禁止外部样式表：${href}`,
      line,
      column,
      snippet: extractSnippet(html, pos, 1),
      suggestion: "将外部 CSS 内容内联为 <style>...</style>，或移除该引用",
    });
  });

  const size = Buffer.byteLength(html, "utf8");
  if (size >= MAX_SIZE_BYTES) {
    errors.push({
      rule: "size-limit",
      message: `大小 ${size} 字节，超过 200KB 限制`,
      suggestion: "精简代码：移除未使用的 CSS、压缩变量名、减少冗余注释",
    });
  }

  return errors;
}

/** 统一入口：syntax → security → structure，stage 标记失败发生在哪层 */
export function verifyHtml(code: string): VerifyResult {
  const syntaxErrors = validateSyntax(code);
  if (syntaxErrors.length > 0) {
    return { pass: false, stage: "syntax", errors: syntaxErrors };
  }
  const securityErrors = validateSecurity(code);
  if (securityErrors.length > 0) {
    return { pass: false, stage: "security", errors: securityErrors };
  }
  const structureErrors = validateStructure(code);
  if (structureErrors.length > 0) {
    return { pass: false, stage: "structure", errors: structureErrors };
  }
  return { pass: true, stage: "structure", errors: [] };
}

/** 项目级校验：从文件列表中提取 index.html 进行校验 */
export function verifyProject(files: File[]): VerifyResult {
  const entry = files.find((f) => f.path === "index.html");
  if (!entry) {
    return {
      pass: false,
      stage: "structure",
      errors: [
        {
          rule: "missing-entry",
          message: "缺少 index.html 入口文件",
          suggestion: "确保生成结果包含 path 为 'index.html' 的文件",
        },
      ],
    };
  }
  return verifyHtml(entry.content);
}
