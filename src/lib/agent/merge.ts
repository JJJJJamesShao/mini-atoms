/**
 * 多阶段确定性合并（零 LLM）— fullstack-app SOP 的 merge 步骤。
 *
 * 输入契约（由 prompts.ts 的阶段 prompt 强制）：
 * - shellHtml 含 <!-- PAGE_CONTENT:name --> 占位符（正则解析，有什么填什么）
 * - pagesText 按 `// === PAGE: name ===` 分隔符组织
 * - schemaJs 内联进 <script> 前转义 </script>（字符串字面量会撑破页面）
 */

/** 转义内联 JS 中的 </script>（防止字符串字面量提前闭合 script 标签） */
function escapeInlineJs(code: string): string {
  return code.replace(/<\/script/gi, "<\\/script");
}

/** 按分隔符切分 pages 输出：`// === PAGE: name ===` → 页面名到代码块的映射 */
export function splitPages(pagesText: string): Map<string, string> {
  const pages = new Map<string, string>();
  const pattern = /\/\/\s*===\s*PAGE:\s*([\w-]+)\s*===/g;
  const matches = [...pagesText.matchAll(pattern)];
  for (let i = 0; i < matches.length; i++) {
    const name = matches[i][1];
    const start = (matches[i].index ?? 0) + matches[i][0].length;
    const end =
      i + 1 < matches.length
        ? (matches[i + 1].index ?? pagesText.length)
        : pagesText.length;
    pages.set(name, pagesText.slice(start, end).trim());
  }
  return pages;
}

/** 从 shell 中解析页面占位符名（不硬编码页面清单；容忍冒号两侧空格） */
export function findPagePlaceholders(shellHtml: string): string[] {
  const pattern = /<!--\s*PAGE_CONTENT:\s*([\w-]+)\s*-->/g;
  return [...shellHtml.matchAll(pattern)].map((m) => m[1]);
}

/** 缺页检测：shell 占位符在 pages 输出中无对应 PAGE 块（引擎据此进 fix-pages 重修） */
export function findMissingPages(
  shellHtml: string,
  pagesText: string,
): string[] {
  const pages = splitPages(pagesText);
  return findPagePlaceholders(shellHtml).filter((name) => !pages.has(name));
}

/**
 * 合并三阶段产物为单文件 HTML：
 * 1. shell 占位符 ← pages 对应代码块（缺失则留注释标记，由最终 verify 兜住）
 * 2. schema 注入 </head> 前（先于 body 内页面脚本执行）
 */
export function mergeFullstack(
  schemaJs: string,
  shellHtml: string,
  pagesText: string,
): string {
  const pages = splitPages(pagesText);
  let merged = shellHtml;

  for (const name of findPagePlaceholders(shellHtml)) {
    const placeholder = new RegExp(`<!--\\s*PAGE_CONTENT:\\s*${name}\\s*-->`);
    // 缺页留注释标记（引擎 merge 步骤会检出并转 fix-pages 重修，此为兜底痕迹）
    const pageCode = pages.get(name) ?? `<!-- 页面 ${name} 的实现缺失 -->`;
    // 函数式替换：避免替换串中的 $& / $$ / $' 等模式被 String.replace 解释
    //（LLM 产物含 `$${price}` 这类文本时会被静默改写）
    merged = merged.replace(placeholder, () => pageCode);
  }

  const schemaScript = `<script>\n${escapeInlineJs(schemaJs)}\n</script>`;
  if (merged.includes("</head>")) {
    merged = merged.replace("</head>", () => `${schemaScript}\n</head>`);
  } else {
    // shell 无 </head>（异常产物）：把 schema 放最前，由最终 verify 判结构
    merged = `${schemaScript}\n${merged}`;
  }
  return merged;
}
