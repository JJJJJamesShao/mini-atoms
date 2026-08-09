import { z } from "zod";

/** 需求澄清节点输出 */
export const ClarifyOutputSchema = z.object({
  status: z.enum(["need_clarification", "ready"]),
  questions: z.array(
    z.object({
      id: z.string(),
      question: z.string(),
      options: z.array(z.string()),
    }),
  ),
  summary: z.string(),
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
