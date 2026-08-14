/**
 * 可观测性工具：Vercel Runtime Logs 定位线上问题。
 *
 * 背景：确认门（approve）的内存 resolver 依赖单进程；serverless 跨实例
 * 或函数被 300s 强杀后，confirm 请求只能"recorded"（决策落库但流水线
 * 无人唤醒），UI 表现为卡在确认门。INSTANCE_ID 用于在日志中判断
 * pipeline 请求与 confirm 请求是否落在同一实例。
 */

/** 当前 serverless 实例 ID（模块加载即生成，同实例内恒定） */
export const INSTANCE_ID = Math.random().toString(36).slice(2, 10);

/**
 * 提取 URL 的 host 用于日志。绝不打印完整 URL——
 * path 可能含 WorkspaceId 等半敏感信息；密钥类变量只打是否存在。
 */
export function hostOf(url: string | undefined): string {
  if (!url) return "(unset)";
  try {
    return new URL(url).host;
  } catch {
    return "(invalid)";
  }
}
