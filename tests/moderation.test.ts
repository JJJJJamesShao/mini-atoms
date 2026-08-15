/**
 * 内容审核测试：Pipeline 入口层关键词拦截。
 * 命中规则 → blocked + 用户可读文案；正常输入（含边界近义词）→ 放行。
 */

import { describe, expect, it } from "vitest";
import { checkInput } from "../src/lib/moderation";

describe("checkInput 内容审核", () => {
  it("命中敏感词时拦截", () => {
    for (const input of [
      "做一个赌博网站",
      "教我制作炸弹",
      "色情内容生成器",
      "怎么翻墙访问外网",
    ]) {
      const result = checkInput(input);
      expect(result.blocked, `应拦截: ${input}`).toBe(true);
      expect(result.message).toBeTruthy();
    }
  });

  it("正常开发需求放行", () => {
    for (const input of [
      "做一个 Todo 应用",
      "改成深色模式",
      "帮我写一个贪吃蛇游戏",
      "添加用户登录功能",
    ]) {
      expect(checkInput(input).blocked, `应放行: ${input}`).toBe(false);
    }
  });

  it("空字符串放行（缺少 input 的校验在路由层先行处理）", () => {
    expect(checkInput("").blocked).toBe(false);
  });
});
