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

/** 代码生成节点输出（code 为完整单文件 HTML） */
export const GenerateOutputSchema = z.object({
  code: z.string(),
  notes: z.string(),
});
export type GenerateOutput = z.infer<typeof GenerateOutputSchema>;

/** 校验节点输出 */
export const VerifyResultSchema = z.object({
  pass: z.boolean(),
  stage: z.enum(["syntax", "structure"]),
  errors: z.array(
    z.object({
      rule: z.string(),
      message: z.string(),
    }),
  ),
});
export type VerifyResult = z.infer<typeof VerifyResultSchema>;
