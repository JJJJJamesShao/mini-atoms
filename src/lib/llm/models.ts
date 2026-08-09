/** LLM 模型路由配置 — 按节点分配模型 */

export interface ModelConfig {
  model: string;
  desc: string;
  maxTokens?: number;
  temperature?: number;
}

/** 节点级模型路由：不同节点用不同模型平衡成本与质量 */
export const MODEL_ROUTING = {
  /** 需求澄清：快模型，成本低，只需理解意图 */
  clarify: {
    model: "qwen3.6-flash",
    desc: "快模型，成本低",
    maxTokens: 2048,
    temperature: 0.7,
  } as ModelConfig,

  /** 规格生成：快模型，结构化输出 */
  spec: {
    model: "qwen3.6-flash",
    desc: "快模型，结构化输出",
    maxTokens: 4096,
    temperature: 0.3,
  } as ModelConfig,

  /** 代码生成：强模型，代码质量关键 */
  generate: {
    model: "qwen3.8-max",
    desc: "强模型，代码质量",
    maxTokens: 8192,
    temperature: 0.2,
  } as ModelConfig,

  /** 修复：强模型，基于错误信息推理 */
  fix: {
    model: "qwen3.8-max",
    desc: "强模型，修复错误",
    maxTokens: 8192,
    temperature: 0.2,
  } as ModelConfig,

  /** 意图分类（打断机制预留）：快模型 */
  classify: {
    model: "qwen3.6-flash",
    desc: "快模型，意图分类",
    maxTokens: 512,
    temperature: 0.1,
  } as ModelConfig,

  /** 备选强模型 */
  deepseek: {
    model: "deepseek-v4-pro",
    desc: "备选强模型",
    maxTokens: 8192,
    temperature: 0.2,
  } as ModelConfig,
} as const;

export type NodeType = keyof typeof MODEL_ROUTING;
