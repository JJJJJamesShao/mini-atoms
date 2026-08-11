/**
 * mergeFullstack 确定性合并回归测试 — fullstack-app SOP 的零 LLM 合并：
 * 占位符解析、pages 分隔符切分、</script> 转义、缺失页面兜底。
 */

import { describe, expect, it } from "vitest";
import {
  findPagePlaceholders,
  mergeFullstack,
  splitPages,
} from "../src/lib/agent/merge";

const SHELL = `<!DOCTYPE html>
<html><head><title>t</title></head>
<body>
<nav>导航</nav>
<section id="page-home"><!-- PAGE_CONTENT:home --></section>
<section id="page-login"><!-- PAGE_CONTENT: login --></section>
</body></html>`;

const PAGES = `// === PAGE: home ===
<div>首页内容</div>

// === PAGE: login ===
<form>登录表单</form>`;

describe("splitPages", () => {
  it("按分隔符切分页面块", () => {
    const pages = splitPages(PAGES);
    expect(pages.get("home")).toBe("<div>首页内容</div>");
    expect(pages.get("login")).toBe("<form>登录表单</form>");
  });

  it("无分隔符时返回空表", () => {
    expect(splitPages("没有标记的文本").size).toBe(0);
  });
});

describe("findPagePlaceholders", () => {
  it("解析 shell 中的全部占位符（含空格变体）", () => {
    expect(findPagePlaceholders(SHELL)).toEqual(["home", "login"]);
  });
});

describe("mergeFullstack", () => {
  it("占位符被页面代码替换，schema 注入 </head> 前", () => {
    const merged = mergeFullstack("const db = {};", SHELL, PAGES);
    expect(merged).toContain("<div>首页内容</div>");
    expect(merged).toContain("<form>登录表单</form>");
    expect(merged).not.toContain("PAGE_CONTENT");
    const headEnd = merged.indexOf("</head>");
    const schemaPos = merged.indexOf("const db = {};");
    expect(schemaPos).toBeGreaterThan(-1);
    expect(schemaPos).toBeLessThan(headEnd);
  });

  it("缺失的页面留注释标记（由最终 verify 兜住）", () => {
    const merged = mergeFullstack(
      "const db = {};",
      SHELL,
      "// === PAGE: home ===\n<div>只有首页</div>",
    );
    expect(merged).toContain("<!-- 页面 login 的实现缺失 -->");
  });

  it("schema 中的 </script> 字符串被转义", () => {
    const merged = mergeFullstack('const s = "</script>";', SHELL, PAGES);
    expect(merged).toContain('"<\\/script>"');
    expect(merged).not.toContain('"</script>"');
  });

  it("shell 缺少 </head> 时 schema 前置兜底", () => {
    const merged = mergeFullstack(
      "const db = {};",
      "<html><body><!-- PAGE_CONTENT:home --></body></html>",
      "// === PAGE: home ===\n<div>x</div>",
    );
    expect(merged.indexOf("const db = {};")).toBeLessThan(
      merged.indexOf("<html>"),
    );
  });

  it("替换串中的 $ 模式不被解释（$& / $$ / $' / 美元模板）", () => {
    const pages = `// === PAGE: home ===
<div>价格: $& 和 $$ 以及 $' 还有 \`$\${price}\`</div>

// === PAGE: login ===
<form>登录</form>`;
    const merged = mergeFullstack("const db = {};", SHELL, pages);
    expect(merged).toContain("价格: $& 和 $$ 以及 $' 还有 `$${price}`");
  });
});
