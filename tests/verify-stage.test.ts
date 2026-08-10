/**
 * verifyStageCode 阶段级校验回归测试 — fullstack-app SOP 中间产物：
 * schema/pages 只验 JS 语法（acorn），shell 验骨架结构 + 占位符。
 */

import { describe, expect, it } from "vitest";
import { verifyStageCode } from "../src/lib/verify/stage";

describe("verifyStageCode", () => {
  it("schema：合法 JS 通过", () => {
    const r = verifyStageCode(
      "const db = {};\nfunction list() { return []; }",
      "schema",
    );
    expect(r.pass).toBe(true);
  });

  it("schema：JS 语法错误报行号", () => {
    const r = verifyStageCode("const a = 1;\nvar b = ;", "schema");
    expect(r.pass).toBe(false);
    expect(r.errors[0].rule).toBe("syntax");
    expect(r.errors[0].message).toContain("第 2 行");
  });

  it("schema：混入 HTML 文档结构被拒绝", () => {
    const r = verifyStageCode("<!DOCTYPE html><html></html>", "schema");
    expect(r.pass).toBe(false);
    expect(r.errors.some((e) => e.rule === "stage-constraint")).toBe(true);
  });

  it("schema/pages：空产物被拒绝", () => {
    expect(verifyStageCode("   ", "schema").pass).toBe(false);
    expect(verifyStageCode("", "pages").pass).toBe(false);
  });

  it("shell：合法骨架（含占位符）通过", () => {
    const shell =
      "<!DOCTYPE html><html><head></head><body><!-- PAGE_CONTENT:home --></body></html>";
    expect(verifyStageCode(shell, "shell").pass).toBe(true);
  });

  it("shell：缺占位符 / 缺 DOCTYPE / 外部脚本分别被拒绝", () => {
    expect(
      verifyStageCode(
        "<!DOCTYPE html><html><head></head><body>无占位符</body></html>",
        "shell",
      ).pass,
    ).toBe(false);
    expect(
      verifyStageCode(
        "<html><body><!-- PAGE_CONTENT:home --></body></html>",
        "shell",
      ).errors.some((e) => e.message.includes("DOCTYPE")),
    ).toBe(true);
    expect(
      verifyStageCode(
        '<!DOCTYPE html><html><head><script src="https://x.com/a.js"></script></head><body><!-- PAGE_CONTENT:home --></body></html>',
        "shell",
      ).pass,
    ).toBe(false);
  });

  it("pages：合法 JS 块通过，HTML 文档结构被拒绝", () => {
    expect(
      verifyStageCode("// === PAGE: home ===\nconst x = 1;", "pages").pass,
    ).toBe(true);
    expect(
      verifyStageCode("<html><body>越权输出</body></html>", "pages").pass,
    ).toBe(false);
  });

  it("pages：HTML 片段（含内联 script）是合法产物（契约对齐回归）", () => {
    const fragment = `// === PAGE: home ===
<div class="home"><h1>首页</h1></div>
<script>
  document.getElementById('btn').addEventListener('click', () => {});
</script>`;
    expect(verifyStageCode(fragment, "pages").pass).toBe(true);
  });

  it("pages：内联 script 的 JS 语法错误被逐块检出", () => {
    const fragment = `// === PAGE: home ===
<div>ok</div>
<script>
var b = ;
</script>`;
    const r = verifyStageCode(fragment, "pages");
    expect(r.pass).toBe(false);
    expect(r.errors[0].message).toContain("home");
  });

  it("pages：缺少 PAGE 分隔符块被拒绝", () => {
    const r = verifyStageCode("<div>没有分隔符的片段</div>", "pages");
    expect(r.pass).toBe(false);
    expect(r.errors.some((e) => e.message.includes("PAGE"))).toBe(true);
  });
});
