/** LLM 模型路由配置 — 按节点分配模型（支持环境变量覆盖） */

export interface ModelConfig {
  model: string;
  desc: string;
  maxTokens?: number;
  temperature?: number;
}

/** 从环境变量读取模型名，提供默认值 */
function env(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

/** 节点级模型路由：不同节点分配不同模型平衡成本与质量 */
export const MODEL_ROUTING = {
  /** 需求澄清：快模型，成本低，只需理解意图 */
  clarify: {
    model: env("QWEN_3_6_FLASH", "qwen3.6-flash"),
    desc: "快模型，成本低",
    maxTokens: 2048,
    temperature: 0.7,
  } as ModelConfig,

  /** 规格生成：快模型，结构化输出 */
  spec: {
    model: env("QWEN_3_6_FLASH", "qwen3.6-flash"),
    desc: "快模型，结构化输出",
    maxTokens: 4096,
    temperature: 0.3,
  } as ModelConfig,

  /** 代码生成：强模型，代码质量关键 */
  generate: {
    model: env("QWEN_3_8", "qwen3.8-max"),
    desc: "强模型，代码质量",
    maxTokens: 8192,
    temperature: 0.2,
  } as ModelConfig,

  /** 修复：强模型，基于错误信息推理 */
  fix: {
    model: env("QWEN_3_8", "qwen3.8-max"),
    desc: "强模型，修复错误",
    maxTokens: 8192,
    temperature: 0.2,
  } as ModelConfig,

  /** 意图分类（打断机制预留）：快模型 */
  classify: {
    model: env("QWEN_3_6_FLASH", "qwen3.6-flash"),
    desc: "快模型，意图分类",
    maxTokens: 512,
    temperature: 0.1,
  } as ModelConfig,

  /** 备选强模型 */
  deepseek: {
    model: env("DEEPSEEK_V4_PRO", "deepseek-v4-flash-0731"),
    desc: "备选强模型",
    maxTokens: 8192,
    temperature: 0.2,
  } as ModelConfig,

  /** GLM 主力生成模型 */
  glm: {
    model: env("GLM_5_2", "glm-5.2"),
    desc: "GLM 主力生成",
    maxTokens: 131072,
    temperature: 0.2,
  } as ModelConfig,
} as const;

export type NodeType = keyof typeof MODEL_ROUTING;
