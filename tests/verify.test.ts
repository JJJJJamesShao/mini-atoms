import { describe, expect, it } from "vitest";
import { verifyHtml, verifyProject } from "../src/lib/verify";
import { cannedScenarios } from "../src/lib/mock/canned";

const VALID_HTML = `<!DOCTYPE html>
<html><head><style>body{color:#000}</style></head>
<body><script>var x = 1; console.log(x);</script></body></html>`;

describe("verifyHtml", () => {
  it("合法应用通过（罐头数据全部通过）", () => {
    for (const s of cannedScenarios) {
      const r = verifyProject(s.generate.files);
      expect(r.pass, `${s.title} 应通过`).toBe(true);
      expect(r.errors).toHaveLength(0);
    }
  });

  it("JS 语法错误：失败并报行号", () => {
    const html = `<!DOCTYPE html>
<html><body>
<script>
var a = 1;
var b = ;
</script>
</body></html>`;
    const r = verifyHtml(html);
    expect(r.pass).toBe(false);
    expect(r.stage).toBe("syntax");
    expect(r.errors[0].rule).toBe("syntax");
    expect(r.errors[0].message).toMatch(/行 3:/);
  });

  it("缺 DOCTYPE：structure 阶段失败", () => {
    const html = `<html><body><script>var x=1;</script></body></html>`;
    const r = verifyHtml(html);
    expect(r.pass).toBe(false);
    expect(r.stage).toBe("structure");
    expect(r.errors.some((e) => e.rule === "doctype")).toBe(true);
  });

  it("含外部 script src：拒绝", () => {
    const html = `<!DOCTYPE html>
<html><body><script src="https://cdn.example.com/lib.js"></script></body></html>`;
    const r = verifyHtml(html);
    expect(r.pass).toBe(false);
    expect(r.errors.some((e) => e.rule === "external-script")).toBe(true);
  });

  it("含外部 stylesheet：拒绝", () => {
    const html = `<!DOCTYPE html>
<html><head><link rel="stylesheet" href="https://cdn.example.com/a.css"></head>
<body></body></html>`;
    const r = verifyHtml(html);
    expect(r.pass).toBe(false);
    expect(r.errors.some((e) => e.rule === "external-stylesheet")).toBe(true);
  });

  it("超过 200KB 大小限制：拒绝", () => {
    const big = "x".repeat(200 * 1024);
    const html = `<!DOCTYPE html>\n<html><body><!-- ${big} --><script>var x=1;</script></body></html>`;
    const r = verifyHtml(html);
    expect(r.pass).toBe(false);
    expect(r.errors.some((e) => e.rule === "size-limit")).toBe(true);
  });

  it("多 script 块：全部解析，任一块报错即失败并定位块编号", () => {
    const html = `<!DOCTYPE html>
<html><body>
<script>var ok = 1;</script>
<script>var bad = ;</script>
</body></html>`;
    const r = verifyHtml(html);
    expect(r.pass).toBe(false);
    expect(r.stage).toBe("syntax");
    expect(r.errors[0].message).toContain("script#2");
  });

  it("空输入：失败（缺 DOCTYPE）", () => {
    const r = verifyHtml("");
    expect(r.pass).toBe(false);
    expect(r.stage).toBe("structure");
    expect(r.errors.some((e) => e.rule === "doctype")).toBe(true);
  });

  it("语法错误优先于结构错误（先 syntax 后 structure）", () => {
    // 既缺 DOCTYPE 又有语法错误：应报 syntax 阶段
    const html = `<html><body><script>var x = ;</script></body></html>`;
    const r = verifyHtml(html);
    expect(r.pass).toBe(false);
    expect(r.stage).toBe("syntax");
  });
});

describe("verifyProject", () => {
  it("正常文件列表通过", () => {
    const r = verifyProject([{ path: "index.html", content: VALID_HTML }]);
    expect(r.pass).toBe(true);
  });

  it("缺少 index.html：失败", () => {
    const r = verifyProject([{ path: "app.js", content: "console.log(1);" }]);
    expect(r.pass).toBe(false);
    expect(r.errors[0].rule).toBe("missing-entry");
  });

  it("index.html 语法错误：失败", () => {
    const r = verifyProject([
      {
        path: "index.html",
        content: "<html><script>var x = ;</script></html>",
      },
    ]);
    expect(r.pass).toBe(false);
    expect(r.stage).toBe("syntax");
  });
});
