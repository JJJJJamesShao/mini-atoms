import { cannedScenarios } from "../mock/canned";
import type { Executors } from "./index";
import { verifyProject } from "../verify";

/**
 * 罐头执行器：默认实现，使用 T1 罐头数据。
 * 【替换点】接入真实 LLM 后，将这些实现替换为模型调用（如 clarify 调澄清模型、
 * generate 调代码生成模型），runPipeline 主循环无需改动。
 */
export function createCannedExecutors(scenarioId = "todo"): Executors {
  const scenario = cannedScenarios.find((s) => s.id === scenarioId);
  if (!scenario) throw new Error(`未知罐头场景: ${scenarioId}`);

  return {
    clarify: async () => scenario.clarify,
    spec: async () => scenario.spec,
    generate: async () => scenario.generate,
    verify: async (files) => verifyProject(files),
    // modify SOP 罐头实现：定位返回固定锚点，补丁返回空补丁文本
    // （罐头场景不演练修改回路，仅满足接口；修改回路由 sop 测试的 mock 覆盖）
    locate: async (input) => ({
      intent: input,
      anchors: [
        {
          id: "anchor-1",
          description: "罐头定位锚点",
          searchHint: "<body>",
        },
      ],
    }),
    patch: async (locate) => ({
      patchText: "",
      notes: `罐头补丁：${locate.intent}`,
    }),
  };
}
