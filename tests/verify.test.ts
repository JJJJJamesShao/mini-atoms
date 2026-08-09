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

  it("JS 语法错误：失败并报全局行号", () => {
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
    // 全局行号：<!DOCTYPE html>(1) + <html><body>(2) + <script>(3) + var a(4) + var b(5)
    expect(r.errors[0].message).toMatch(/第 5 行/);
    expect(r.errors[0].line).toBe(5);
    expect(r.errors[0].snippet).toBeDefined();
    expect(r.errors[0].suggestion).toBeDefined();
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

  it("含 <iframe>：security 阶段失败", () => {
    const html = `<!DOCTYPE html>
<html><body><iframe src="https://evil.com"></iframe></body></html>`;
    const r = verifyHtml(html);
    expect(r.pass).toBe(false);
    expect(r.stage).toBe("security");
    expect(r.errors.some((e) => e.rule === "dangerous-tag")).toBe(true);
  });

  it("含 javascript: 协议链接：security 阶段失败", () => {
    const html = `<!DOCTYPE html>
<html><body><a href="javascript:alert(1)">点击</a></body></html>`;
    const r = verifyHtml(html);
    expect(r.pass).toBe(false);
    expect(r.stage).toBe("security");
    expect(r.errors.some((e) => e.rule === "xss-vector")).toBe(true);
  });

  it("含 onclick 内联处理器：security 阶段失败", () => {
    const html = `<!DOCTYPE html>
<html><body><button onclick="alert(1)">点击</button></body></html>`;
    const r = verifyHtml(html);
    expect(r.pass).toBe(false);
    expect(r.stage).toBe("security");
    expect(r.errors.some((e) => e.rule === "xss-vector")).toBe(true);
  });

  it("含 <form action>：security 阶段失败", () => {
    const html = `<!DOCTYPE html>
<html><body><form action="https://evil.com/submit"><input></form></body></html>`;
    const r = verifyHtml(html);
    expect(r.pass).toBe(false);
    expect(r.stage).toBe("security");
    expect(r.errors.some((e) => e.rule === "external-communication")).toBe(
      true,
    );
  });

  it("缺 <body>：structure 阶段警告", () => {
    const html = `<!DOCTYPE html>
<html><script>var x=1;</script></html>`;
    const r = verifyHtml(html);
    expect(r.pass).toBe(false);
    expect(r.errors.some((e) => e.rule === "body-tag")).toBe(true);
  });

  it("语法错误优先于安全错误（先 syntax 后 security）", () => {
    const html = `<!DOCTYPE html>
<html><body>
<script>var x = ;</script>
<iframe src="evil.com"></iframe>
</body></html>`;
    const r = verifyHtml(html);
    expect(r.pass).toBe(false);
    expect(r.stage).toBe("syntax");
  });

  it("安全错误优先于结构错误（先 security 后 structure）", () => {
    const html = `<html><body>
<a href="javascript:alert(1)">click</a>
</body></html>`;
    const r = verifyHtml(html);
    expect(r.pass).toBe(false);
    expect(r.stage).toBe("security");
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
