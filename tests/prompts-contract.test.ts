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
  buildSpecPrompt,
} from "../src/lib/llm/prompts";
import type { ClarifyOutput, SpecOutput } from "../src/lib/schemas";

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
