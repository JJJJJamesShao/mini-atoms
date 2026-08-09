import * as acorn from "acorn";
import { parse } from "node-html-parser";
import type { File, VerifyResult } from "../schemas";

interface VerifyError {
  rule: string;
  message: string;
}

const MAX_SIZE_BYTES = 200 * 1024;

/** 提取 HTML 中所有 <script> 块的内联代码（不含带 src 的外部脚本） */
function extractInlineScripts(html: string): string[] {
  const root = parse(html);
  return root
    .querySelectorAll("script")
    .filter((s) => !s.getAttribute("src"))
    .map((s) => s.textContent);
}

/** 语法校验：acorn 解析每个 <script> 块，收集语法错误（含行号） */
export function validateSyntax(html: string): VerifyError[] {
  const scripts = extractInlineScripts(html);
  const errors: VerifyError[] = [];
  scripts.forEach((code, i) => {
    try {
      acorn.parse(code, { ecmaVersion: 2022 });
    } catch (e) {
      const err = e as SyntaxError & { loc?: { line: number; column: number } };
      const where = err.loc ? `行 ${err.loc.line}:${err.loc.column} ` : "";
      const label = scripts.length > 1 ? `script#${i + 1} ` : "";
      errors.push({
        rule: "syntax",
        message: `${label}${where}${err.message}`,
      });
    }
  });
  return errors;
}

/** 结构校验：DOCTYPE、禁止外部 script/stylesheet、大小 <200KB */
export function validateStructure(html: string): VerifyError[] {
  const errors: VerifyError[] = [];
  const root = parse(html);

  if (!/^\s*<!DOCTYPE html>/i.test(html)) {
    errors.push({ rule: "doctype", message: "缺少 <!DOCTYPE html> 声明" });
  }

  root.querySelectorAll("script[src]").forEach((s) => {
    errors.push({
      rule: "external-script",
      message: `禁止外部脚本: ${s.getAttribute("src")}`,
    });
  });

  root.querySelectorAll('link[rel="stylesheet"]').forEach((l) => {
    errors.push({
      rule: "external-stylesheet",
      message: `禁止外部样式表: ${l.getAttribute("href")}`,
    });
  });

  const size = Buffer.byteLength(html, "utf8");
  if (size >= MAX_SIZE_BYTES) {
    errors.push({
      rule: "size-limit",
      message: `大小 ${size} 字节，超过 200KB 限制`,
    });
  }

  return errors;
}

/** 统一入口：先 syntax 后 structure，stage 标记失败发生在哪层 */
export function verifyHtml(code: string): VerifyResult {
  const syntaxErrors = validateSyntax(code);
  if (syntaxErrors.length > 0) {
    return { pass: false, stage: "syntax", errors: syntaxErrors };
  }
  const structureErrors = validateStructure(code);
  if (structureErrors.length > 0) {
    return { pass: false, stage: "structure", errors: structureErrors };
  }
  return { pass: true, stage: "structure", errors: [] };
}

/** 项目级校验：从文件列表中提取 index.html 进行校验（当前阶段只校验主入口） */
export function verifyProject(files: File[]): VerifyResult {
  const entry = files.find((f) => f.path === "index.html");
  if (!entry) {
    return {
      pass: false,
      stage: "structure",
      errors: [{ rule: "missing-entry", message: "缺少 index.html 入口文件" }],
    };
  }
  return verifyHtml(entry.content);
}
