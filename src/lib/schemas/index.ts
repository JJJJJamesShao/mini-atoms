import { z } from "zod";

/** 需求澄清节点输出 */
export const ClarifyOutputSchema = z.object({
  status: z.enum(["need_clarification", "ready"]),
  /** 深度调优版 prompt 改由 openQuestions 承担待澄清问题，此字段保留兼容旧输出 */
  questions: z
    .array(
      z.object({
        id: z.string(),
        question: z.string(),
        options: z.array(z.string()),
      }),
    )
    .optional(),
  summary: z.string(),
  /** 深度调优版 prompt 的结构化扩展字段（可选，向后兼容） */
  requirements: z.array(z.string()).optional(),
  constraints: z.array(z.string()).optional(),
  assumptions: z.array(z.string()).optional(),
  openQuestions: z.array(z.string()).optional(),
});
export type ClarifyOutput = z.infer<typeof ClarifyOutputSchema>;

/** 规格确认节点输出 */
export const SpecOutputSchema = z.object({
  requirements: z.array(z.string()),
  constraints: z.array(z.string()),
  userStories: z.array(z.string()),
});
export type SpecOutput = z.infer<typeof SpecOutputSchema>;

/** 文件节点 */
export const FileSchema = z.object({
  path: z.string(),
  content: z.string(),
});
export type File = z.infer<typeof FileSchema>;

/** 代码生成节点输出（files 为项目文件列表，当前阶段通常为单文件 index.html） */
export const GenerateOutputSchema = z.object({
  files: z.array(FileSchema),
  notes: z.string(),
});
export type GenerateOutput = z.infer<typeof GenerateOutputSchema>;

/** 校验错误（精确定位） */
export const VerifyErrorSchema = z.object({
  rule: z.string(),
  message: z.string(),
  /** 错误所在行号（1-based） */
  line: z.number().optional(),
  /** 错误所在列号（1-based） */
  column: z.number().optional(),
  /** 出错代码片段（含上下文） */
  snippet: z.string().optional(),
  /** 修复建议 */
  suggestion: z.string().optional(),
});
export type VerifyError = z.infer<typeof VerifyErrorSchema>;

/** 校验节点输出 */
export const VerifyResultSchema = z.object({
  pass: z.boolean(),
  stage: z.enum(["syntax", "security", "structure"]),
  errors: z.array(VerifyErrorSchema),
});
export type VerifyResult = z.infer<typeof VerifyResultSchema>;

/**
 * 改动定位节点输出（modify SOP 的 locate 步骤）。
 * 把"在哪里改"从补丁生成里拆出来：快模型读现有代码 + 修改意图，
 * 输出改动点锚点，patch 步骤据此聚焦生成 SEARCH/REPLACE 块。
 */
export const LocateOutputSchema = z.object({
  /** 修改意图的一句话概括 */
  intent: z.string(),
  /** 改动点锚点列表 */
  anchors: z.array(
    z.object({
      id: z.string(),
      /** 改动点描述（如"导航栏主题色 CSS 变量"） */
      description: z.string(),
      /** 定位提示：改动点附近可精确搜索的代码片段 */
      searchHint: z.string(),
    }),
  ),
});
export type LocateOutput = z.infer<typeof LocateOutputSchema>;
