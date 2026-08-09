/**
 * 结构化代码产物 Schema — Engineer Agent 的结构化输出契约。
 *
 * 游戏 SOP 强制 LLM 按此 JSON 结构输出（支持真正的多文件）；
 * 其他 SOP 解析失败时降级为单文件 HTML 包装（见 parseCodeArtifact）。
 */

import { z } from "zod";

export const ArtifactFileSchema = z.object({
  path: z.string(),
  type: z.enum(["html", "css", "js", "json", "svg"]),
  content: z.string(),
  /** 依赖的其他文件路径 */
  dependencies: z.array(z.string()).default([]),
});
export type ArtifactFile = z.infer<typeof ArtifactFileSchema>;

export const CodeArtifactSchema = z.object({
  files: z.array(ArtifactFileSchema).min(1),
  metadata: z
    .object({
      framework: z.string().nullable().default(null),
      externalDeps: z.array(z.string()).default([]),
      bundleSize: z.number().optional(),
    })
    .default({ framework: null, externalDeps: [] }),
  notes: z.string().optional(),
});
export type CodeArtifact = z.infer<typeof CodeArtifactSchema>;

/** 从文本（可能带 markdown 代码块包裹）解析结构化产物；失败返回 null */
export function parseCodeArtifact(text: string): CodeArtifact | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (!match) return null;
    try {
      raw = JSON.parse(match[1].trim());
    } catch {
      return null;
    }
  }
  const result = CodeArtifactSchema.safeParse(raw);
  return result.success ? result.data : null;
}

/** 降级：把纯 HTML 包装成单文件 CodeArtifact */
export function wrapHtmlAsArtifact(html: string): CodeArtifact {
  return {
    files: [{ path: "index.html", type: "html", content: html, dependencies: [] }],
    metadata: { framework: null, externalDeps: [] },
  };
}
