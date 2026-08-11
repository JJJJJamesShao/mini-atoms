/**
 * applyPatch 三级模糊匹配测试 — 修改 Agent 的确定性护栏：
 * exact（精确）→ rstrip（行尾空白归一化）→ indent（忽略行首缩进），
 * 每级要求唯一命中，多候选直接失败并给出可操作的反馈。
 */

import { describe, expect, it } from "vitest";
import {
  applyPatch,
  parsePatch,
  summarizeAppliedPatch,
} from "../src/lib/agent/patch";

const DOC = [
  "<!DOCTYPE html>",
  "<html>",
  "<body>",
  "  <script>",
  "    let count = 0;",
  "    function inc() {",
  "      count += 1;",
  "    }",
  "  </script>",
  "</body>",
  "</html>",
].join("\n");

describe("applyPatch 三级匹配", () => {
  it("exact：精确匹配直接应用", () => {
    const result = applyPatch(DOC, [
      { search: "    let count = 0;", replace: "    let count = 10;" },
    ]);
    expect(result.success).toBe(true);
    expect(result.details[0].matchLevel).toBe("exact");
    expect(result.newContent).toContain("let count = 10;");
  });

  it("rstrip：search 行尾空格漂移仍命中", () => {
    const result = applyPatch(DOC, [
      { search: "    let count = 0;   ", replace: "    let count = 10;" },
    ]);
    expect(result.success).toBe(true);
    expect(result.details[0].matchLevel).toBe("rstrip");
    expect(result.newContent).toContain("let count = 10;");
  });

  it("rstrip：content 行尾有空格、search 没有时仍命中（多行块）", () => {
    const dirty = DOC.replace(
      "    let count = 0;\n    function inc() {",
      "    let count = 0;  \n    function inc() {",
    );
    const result = applyPatch(dirty, [
      {
        search: "    let count = 0;\n    function inc() {",
        replace: "    let count = 10;\n    function inc() {",
      },
    ]);
    expect(result.success).toBe(true);
    expect(result.details[0].matchLevel).toBe("rstrip");
    expect(result.newContent).toContain("let count = 10;");
  });

  it("indent：缩进层级漂移时忽略缩进逐行对齐", () => {
    const result = applyPatch(DOC, [
      {
        search: "function inc() {\n  count += 1;\n}",
        replace: "function inc() {\n  count += 2;\n}",
      },
    ]);
    expect(result.success).toBe(true);
    expect(result.details[0].matchLevel).toBe("indent");
    expect(result.newContent).toContain("count += 2;");
  });

  it("大小写敏感：大小写不同任何级别都不应命中", () => {
    const result = applyPatch(DOC, [
      { search: "    LET COUNT = 0;", replace: "x" },
    ]);
    expect(result.success).toBe(false);
    expect(result.applied).toBe(0);
    expect(result.newContent).toBe(DOC);
  });

  it("多候选：唯一性不满足时失败并要求补充上下文", () => {
    const dup = DOC + "\n" + "    let count = 0;";
    const result = applyPatch(dup, [
      { search: "    let count = 0;", replace: "    let count = 10;" },
    ]);
    expect(result.success).toBe(false);
    expect(result.applied).toBe(0);
    expect(result.details[0].reason).toContain("候选位置");
    expect(result.newContent).toBe(dup); // 未做任何替换
  });

  it("多块顺序应用：后续块在前块替换后的新内容上匹配", () => {
    const result = applyPatch(DOC, [
      { search: "    let count = 0;", replace: "    let total = 0;" },
      { search: "      count += 1;", replace: "      total += 1;" },
    ]);
    expect(result.success).toBe(true);
    expect(result.applied).toBe(2);
    expect(result.newContent).toContain("let total = 0;");
    expect(result.newContent).toContain("total += 1;");
  });

  it("部分失败：成功块生效，失败块给出近似位置提示", () => {
    const result = applyPatch(DOC, [
      { search: "    let count = 0;", replace: "    let count = 10;" },
      {
        search: "      count += 99; // 不存在的行",
        replace: "      count += 2;",
      },
    ]);
    expect(result.success).toBe(false);
    expect(result.applied).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.details[1].reason).toContain("未找到匹配");
    expect(result.newContent).toContain("let count = 10;"); // 成功块保留
  });

  it("失败提示：search 首行能定位时给出疑似行号", () => {
    const result = applyPatch(DOC, [
      { search: "    let count = 0;\n      完全不存在的第二行", replace: "x" },
    ]);
    expect(result.success).toBe(false);
    expect(result.details[0].reason).toContain("第 5 行");
  });

  it("空 SEARCH 块直接失败，不误伤内容", () => {
    const result = applyPatch(DOC, [{ search: "", replace: "x" }]);
    expect(result.success).toBe(false);
    expect(result.newContent).toBe(DOC);
  });
});

describe("parsePatch", () => {
  it("解析多个 SEARCH/REPLACE 块", () => {
    const text = [
      "<<<<<<< SEARCH",
      "a = 1;",
      "=======",
      "a = 2;",
      ">>>>>>> REPLACE",
      "一些间隔文字",
      "<<<<<<< SEARCH",
      "b = 3;",
      "=======",
      "b = 4;",
      ">>>>>>> REPLACE",
    ].join("\n");
    const blocks = parsePatch(text);
    expect(blocks).toEqual([
      { search: "a = 1;", replace: "a = 2;" },
      { search: "b = 3;", replace: "b = 4;" },
    ]);
  });

  it("无块时返回空数组", () => {
    expect(parsePatch("没有补丁的普通文本")).toEqual([]);
  });
});

describe("summarizeAppliedPatch 改动摘要", () => {
  const ANCHORS = [
    { description: "主题色 CSS 变量", searchHint: "--primary" },
    { description: "按钮点击事件", searchHint: "addEventListener" },
  ];

  it("块按 searchHint 映射回锚点，聚合字符数", () => {
    const blocks = [
      { search: ":root { --primary: blue; }", replace: "x" },
      { search: 'btn.addEventListener("click", a)', replace: "y" },
      { search: 'btn.addEventListener("click", b)', replace: "z" },
    ];
    const details = blocks.map((_, index) => ({
      index,
      status: "applied" as const,
    }));
    const summary = summarizeAppliedPatch(blocks, details, ANCHORS);
    expect(summary).toBe(
      "修改 3 处：主题色 CSS 变量（~26 字符）、按钮点击事件（~64 字符）",
    );
  });

  it("未匹配锚点的块归入「其他改动」", () => {
    const blocks = [{ search: "<footer>old</footer>", replace: "x" }];
    const details = [{ index: 0, status: "applied" as const }];
    expect(summarizeAppliedPatch(blocks, details, ANCHORS)).toBe(
      "修改 1 处：其他改动（~20 字符）",
    );
  });

  it("无锚点（非 modify 流程）时全部归入「其他改动」", () => {
    const blocks = [{ search: "a", replace: "b" }];
    const details = [{ index: 0, status: "applied" as const }];
    expect(summarizeAppliedPatch(blocks, details)).toBe(
      "修改 1 处：其他改动（~1 字符）",
    );
  });

  it("失败块不计入；全部失败时返回无有效修改", () => {
    const blocks = [{ search: "--primary: blue", replace: "x" }];
    const details = [{ index: 0, status: "failed" as const }];
    expect(summarizeAppliedPatch(blocks, details, ANCHORS)).toBe("无有效修改");
  });
});
