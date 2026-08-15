/**
 * 输入内容审核：Pipeline 入口层的横切检查，不侵入 Agent 内部逻辑。
 *
 * 当前为本地关键词过滤（零成本、零延迟），满足法规底线；
 * 生产环境如需更精细的审核，可在 checkInput 内接入阿里云内容安全（绿网）
 * 文本反垃圾接口，按返回 labels/rate 判定——不阻塞当前实现。
 */

const BLOCKED_PATTERNS = [
  /暴力|恐怖|爆炸|炸弹|制毒|贩毒|枪支/i,
  /色情|淫秽|性交易|招嫖/i,
  /赌博|博彩|赌球|六合彩/i,
  /翻墙|VPN|代理.*访问/i,
  // 根据实际法规需求扩展
];

export interface ModerationResult {
  blocked: boolean;
  message?: string;
}

/** 检查用户输入是否命中拦截规则 */
export function checkInput(input: string): ModerationResult {
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(input)) {
      return {
        blocked: true,
        message: "输入内容包含不合规信息，请修改后重试。",
      };
    }
  }
  return { blocked: false };
}
