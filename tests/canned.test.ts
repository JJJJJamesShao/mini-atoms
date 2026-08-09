import { describe, expect, it } from "vitest";
import { cannedScenarios } from "../src/lib/mock/canned";
import {
  ClarifyOutputSchema,
  GenerateOutputSchema,
  SpecOutputSchema,
} from "../src/lib/schemas";

describe("罐头数据契约校验", () => {
  it("包含 3 个罐头场景", () => {
    expect(cannedScenarios).toHaveLength(3);
  });

  it.each(cannedScenarios.map((s) => [s.title, s] as const))(
    "%s：clarify/spec/generate 均通过 zod 校验",
    (_title, scenario) => {
      expect(ClarifyOutputSchema.parse(scenario.clarify)).toBeTruthy();
      expect(SpecOutputSchema.parse(scenario.spec)).toBeTruthy();
      expect(GenerateOutputSchema.parse(scenario.generate)).toBeTruthy();
    },
  );

  it.each(cannedScenarios.map((s) => [s.title, s] as const))(
    "%s：generate.code 是完整单文件 HTML 且 <8KB",
    (_title, scenario) => {
      const code = scenario.generate.code;
      expect(code).toMatch(/^<!DOCTYPE html>/i);
      expect(code).toContain("<style>");
      expect(code).toContain("<script>");
      expect(code).toContain("</html>");
      expect(Buffer.byteLength(code, "utf8")).toBeLessThan(8 * 1024);
    },
  );
});
