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
  // 1. 尝试直接解析（纯 JSON）
  try {
    const result = CodeArtifactSchema.safeParse(JSON.parse(text));
    if (result.success) return result.data;
  } catch {
    // 不是纯 JSON，继续
  }

  // 2. 找最外层 markdown 代码块（第一个 ``` 到最后一个 ```）
  // LLM 可能在 JSON 的 content 字段内部也包裹了 ```html ... ```，
  // 所以不能用简单的非贪婪匹配，必须从外层提取
  const firstBlockMatch = text.match(/```(?:json)?\s*/);
  if (firstBlockMatch && firstBlockMatch.index !== undefined) {
    const lastBackticks = text.lastIndexOf("```");
    if (lastBackticks > firstBlockMatch.index) {
      const block = text
        .slice(firstBlockMatch.index + firstBlockMatch[0].length, lastBackticks)
        .trim();
      try {
        const result = CodeArtifactSchema.safeParse(JSON.parse(block));
        if (result.success) return result.data;
      } catch {
        // 继续兜底
      }
    }
  }

  // 3. 兜底：提取所有代码块，按长度排序（优先尝试最长的）
  const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)```/g;
  let match;
  const blocks: string[] = [];
  while ((match = codeBlockRegex.exec(text)) !== null) {
    blocks.push(match[1].trim());
  }
  for (const block of blocks.sort((a, b) => b.length - a.length)) {
    try {
      const result = CodeArtifactSchema.safeParse(JSON.parse(block));
      if (result.success) return result.data;
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * 清理 content 中可能包裹的 markdown 代码块标记。
 * LLM 经常在 JSON 的字符串值中包裹 ```html ... ```，即使 prompt 要求不要。
 */
function cleanContent(content: string): string {
  const match = content.match(
    /^```(?:html|css|js|javascript|typescript)?\s*\n?([\s\S]*?)```\s*$/,
  );
  if (match) return match[1].trim();
  return content.trim();
}

/**
 * 将多文件 CodeArtifact 合并为单文件 HTML。
 *
 * 处理逻辑：
 * 1. 找到 index.html（或第一个 html 文件）作为入口
 * 2. 将外部 CSS 文件内联为 <style> 标签（替换 <link rel="stylesheet">）
 * 3. 将外部 JS 文件内联为 <script> 标签（替换 <script src="...">）
 * 4. 其余文件按 type 插入到合适位置（css → head, js → body 末尾）
 * 5. 所有 content 经过 cleanContent 去除可能的 markdown 代码块标记
 *
 * 这解决了 iframe srcDoc 模式下无法加载相对路径资源的问题。
 */
export function mergeToSingleHtml(artifact: CodeArtifact): string {
  // 先清理所有文件的 content
  const cleanedFiles = artifact.files.map((f) => ({
    ...f,
    content: cleanContent(f.content),
  }));
  const fileMap = new Map(cleanedFiles.map((f) => [f.path, f.content]));

  // 找到入口 HTML 文件
  const entryFile =
    cleanedFiles.find((f) => f.path === "index.html") ??
    cleanedFiles.find((f) => f.type === "html");

  if (!entryFile) {
    // 没有 HTML 文件，无法渲染；返回第一个文件的内容作为降级
    return cleanedFiles[0]?.content ?? "<!-- 无内容 -->";
  }

  let html = entryFile.content;

  // 1. 替换 <link rel="stylesheet" href="xxx.css"> 为内联 <style>
  html = html.replace(
    /<link[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>/gi,
    (_match, href: string) => {
      const cssContent = fileMap.get(href);
      if (cssContent) {
        return `<style>\n/* ${href} */\n${cssContent}\n</style>`;
      }
      return `<!-- 未找到样式: ${href} -->`;
    },
  );

  // 2. 替换 <script src="xxx.js"></script> 为内联 <script>
  html = html.replace(
    /<script[^>]*src=["']([^"']+)["'][^>]*>\s*<\/script>/gi,
    (_match, src: string) => {
      const jsContent = fileMap.get(src);
      if (jsContent) {
        return `<script>\n/* ${src} */\n${jsContent}\n</script>`;
      }
      return `<!-- 未找到脚本: ${src} -->`;
    },
  );

  // 3. 处理未被显式引用的文件：CSS 插入 </head> 前，JS 插入 </body> 前
  const remainingFiles = cleanedFiles.filter(
    (f) => f.path !== entryFile.path && !html.includes(f.path),
  );

  const remainingCss = remainingFiles.filter((f) => f.type === "css");
  const remainingJs = remainingFiles.filter((f) => f.type === "js");

  if (remainingCss.length > 0) {
    const inlineCss = remainingCss
      .map((f) => `/* ${f.path} */\n${f.content}`)
      .join("\n\n");
    const styleTag = `<style>\n${inlineCss}\n</style>`;
    if (html.includes("</head>")) {
      html = html.replace("</head>", `${styleTag}\n</head>`);
    } else if (html.includes("<body>")) {
      html = html.replace("<body>", `<body>\n${styleTag}`);
    } else {
      html = `${styleTag}\n${html}`;
    }
  }

  if (remainingJs.length > 0) {
    const inlineJs = remainingJs
      .map((f) => `/* ${f.path} */\n${f.content}`)
      .join("\n\n");
    const scriptTag = `<script>\n${inlineJs}\n</script>`;
    if (html.includes("</body>")) {
      html = html.replace("</body>", `${scriptTag}\n</body>`);
    } else {
      html = `${html}\n${scriptTag}`;
    }
  }

  return html;
}

/** 降级：把纯 HTML 或 JSON 包装成单文件 CodeArtifact */
export function wrapHtmlAsArtifact(text: string): CodeArtifact {
  // 先尝试从 JSON 中提取 HTML（LLM 可能输出了 JSON 但解析失败）
  try {
    const json = JSON.parse(text);
    if (json.files && Array.isArray(json.files) && json.files[0]?.content) {
      return {
        files: json.files.map(
          (f: { path: string; type: string; content: string }) => ({
            path: f.path ?? "index.html",
            type: (f.type as "html" | "css" | "js") ?? "html",
            content: cleanContent(f.content), // ← 清理 markdown 代码块
            dependencies: [],
          }),
        ),
        metadata: { framework: null, externalDeps: [] },
        notes: json.notes,
      };
    }
  } catch {
    // 不是 JSON，继续降级
  }

  // 提取 HTML（去除 markdown 代码块）
  const html = extractHtml(text);
  return {
    files: [
      { path: "index.html", type: "html", content: html, dependencies: [] },
    ],
    metadata: { framework: null, externalDeps: [] },
  };
}

function extractHtml(text: string): string {
  const match = text.match(/```(?:html|css|js|javascript)?\s*([\s\S]*?)```/);
  if (match) return match[1].trim();
  return text.trim();
}
