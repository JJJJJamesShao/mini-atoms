/**
 * Prompt 契约回归测试 — L2 评审发现的运行时契约破坏（mock/类型系统捕获不到）：
 * 1. SYSTEM_CLARIFY 曾丢失 status/summary → spec 阶段拿到空需求
 * 2. SYSTEM_SPEC 曾丢失 userStories → SpecCard spec[key].map() 崩溃
 * 3. SYSTEM_FIX（Search/Replace 语义）曾混入完整重写修复路径 → 产出 Patch 文本而非 HTML
 * 这些测试锁住 prompt 与下游代码之间的输出契约。
 */

import { describe, expect, it } from "vitest";
import {
  buildClarifyPrompt,
  buildGameGeneratePrompt,
  buildGeneratePrompt,
  buildLocatePrompt,
  buildModifyPatchPrompt,
  buildSpecPrompt,
} from "../src/lib/llm/prompts";
import type {
  ClarifyOutput,
  LocateOutput,
  SpecOutput,
} from "../src/lib/schemas";

const SPEC: SpecOutput = {
  requirements: ["r1"],
  constraints: ["c1"],
  userStories: ["u1"],
};

const ERRORS = [{ rule: "syntax", message: "mock 语法错误" }];

describe("prompt 输出契约", () => {
  it("SYSTEM_CLARIFY 必须要求 status 与 summary 字段（下游引擎/执行器依赖）", () => {
    const system = buildClarifyPrompt("做一个计算器")[0].content;
    expect(system).toContain('"status"');
    expect(system).toContain('"summary"');
    expect(system).toContain("need_clarification");
  });

  it("SYSTEM_SPEC 必须要求 userStories 字段（SpecCard 三段式 UI 依赖）", () => {
    const system = buildSpecPrompt({ requirements: ["r1"] })[0].content;
    expect(system).toContain('"userStories"');
    expect(system).toContain('"requirements"');
    expect(system).toContain('"constraints"');
  });

  it("clarify→spec 交接：新版结构化输出的 requirements 直接进入 spec prompt", () => {
    const clarify = {
      status: "ready",
      questions: [],
      summary: "总结",
      requirements: ["需求A", "需求B"],
    } as ClarifyOutput;
    // 与 llm-executors spec 节点相同的取值逻辑
    const messages = buildSpecPrompt({
      requirements: clarify.requirements ?? [clarify.summary],
    });
    expect(messages[1].content).toContain("需求A");
    expect(messages[1].content).toContain("需求B");
  });

  it("clarify→spec 交接：旧版输出（无 requirements）回退 summary，不为空", () => {
    const clarify = {
      status: "ready",
      questions: [],
      summary: "单文件计算器",
    } as ClarifyOutput;
    const messages = buildSpecPrompt({
      requirements: clarify.requirements ?? [clarify.summary],
    });
    expect(messages[1].content).toContain("单文件计算器");
  });

  it("clarify→spec 交接：constraints 与 assumptions 透传进 spec prompt", () => {
    const messages = buildSpecPrompt({
      requirements: ["需求A"],
      constraints: ["单文件 HTML"],
      assumptions: ["默认深色主题"],
    });
    expect(messages[1].content).toContain("单文件 HTML");
    expect(messages[1].content).toContain("默认深色主题");
  });

  it("SYSTEM_SPEC 必须强制单文件/无外部依赖约束（verify 层硬性检查，防白烧 fix 轮次）", () => {
    const system = buildSpecPrompt({ requirements: ["r1"] })[0].content;
    expect(system).toContain("单文件 HTML");
    expect(system).toContain("无外部依赖");
  });

  it("SYSTEM_GENERATE 必须包含 4 个 SECTION 分段标记（流式子步骤进度解析依赖）", () => {
    const system = buildGeneratePrompt(SPEC)[0].content;
    for (const marker of [
      "SECTION: HEAD",
      "SECTION: CSS",
      "SECTION: BODY",
      "SECTION: JS",
    ]) {
      expect(system).toContain(`<!-- ${marker} -->`);
    }
  });

  it("完整重写修复路径：不得混入 Search/Replace 格式，要求输出完整 HTML", () => {
    const messages = buildGeneratePrompt(SPEC, ERRORS);
    const all = messages.map((m) => m.content).join("\n");
    expect(all).not.toContain("<<<<<<< SEARCH");
    expect(all).not.toContain(">>>>>>> REPLACE");
    expect(all).toContain("完整的");
  });

  it("游戏结构化修复路径：要求重新输出完整 JSON", () => {
    const messages = buildGameGeneratePrompt(SPEC, ERRORS);
    const all = messages.map((m) => m.content).join("\n");
    expect(all).toContain("JSON");
    expect(all).not.toContain("<<<<<<< SEARCH");
  });
});

describe("modify SOP prompt 输出契约", () => {
  const LOCATE: LocateOutput = {
    intent: "把主题色改为暗色",
    anchors: [
      {
        id: "anchor-1",
        description: "主题色 CSS 变量",
        searchHint: "--primary: #3b82f6",
      },
    ],
  };

  it("SYSTEM_LOCATE 必须要求 intent/anchors/searchHint 字段（LocateOutput schema 依赖）", () => {
    const system = buildLocatePrompt("<html></html>", "改主题色")[0].content;
    expect(system).toContain('"intent"');
    expect(system).toContain('"anchors"');
    expect(system).toContain('"searchHint"');
    expect(system).toContain('"description"');
  });

  it("SYSTEM_LOCATE 必须强调 searchHint 逐字取自现有代码（applyPatch 精确匹配依赖）", () => {
    const system = buildLocatePrompt("<html></html>", "改主题色")[0].content;
    expect(system).toContain("逐字");
  });

  it("buildLocatePrompt user 消息必须携带现有代码与修改需求", () => {
    const messages = buildLocatePrompt(
      "<body>旧代码</body>",
      "把主题色改成暗色",
    );
    expect(messages[1].content).toContain("旧代码");
    expect(messages[1].content).toContain("把主题色改成暗色");
  });

  it("SYSTEM_MODIFY_PATCH 必须使用 Search/Replace 格式且禁止解释文字", () => {
    const system = buildModifyPatchPrompt("<html></html>", LOCATE)[0].content;
    expect(system).toContain("<<<<<<< SEARCH");
    expect(system).toContain(">>>>>>> REPLACE");
    expect(system).toContain("不要输出任何解释文字");
  });

  it("buildModifyPatchPrompt user 消息必须携带意图与锚点", () => {
    const messages = buildModifyPatchPrompt("<html></html>", LOCATE);
    expect(messages[1].content).toContain("把主题色改为暗色");
    expect(messages[1].content).toContain("anchor-1");
    expect(messages[1].content).toContain("--primary: #3b82f6");
  });

  it("buildModifyPatchPrompt 携带反馈时必须包含反馈内容（重试回路依赖）", () => {
    const messages = buildModifyPatchPrompt(
      "<html></html>",
      LOCATE,
      "块 #1 失败：SEARCH 块未找到匹配",
    );
    expect(messages[1].content).toContain("上一轮补丁应用/校验反馈");
    expect(messages[1].content).toContain("块 #1 失败");
  });
});
