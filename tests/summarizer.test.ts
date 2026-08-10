import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeSummarizer } from "../src/lib/agent/llm-executors";

/** 生成指定长度的假代码内容 */
const code = (len: number) => "x".repeat(len);

describe("CodeSummarizer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("满足条件时调用摘要并回调（首次：≥3000 字符）", async () => {
    const fn = vi.fn<(snippet: string) => Promise<string>>(
      async () => "正在构建 HTML 骨架",
    );
    const onSummary = vi.fn();
    const s = new CodeSummarizer(fn);

    await s.maybeSummarize(code(3500), onSummary);

    expect(fn).toHaveBeenCalledTimes(1);
    // 只发送末尾 2000 字符
    expect(fn.mock.calls[0][0]).toHaveLength(2000);
    expect(onSummary).toHaveBeenCalledWith("正在构建 HTML 骨架");
  });

  it("节流：10s 间隔内不重复触发", async () => {
    const fn = vi.fn(async () => "摘要");
    const s = new CodeSummarizer(fn);

    await s.maybeSummarize(code(3500), vi.fn());
    // 立即再来 3000+ 新字符，但间隔不足 10s
    await s.maybeSummarize(code(7000), vi.fn());

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("节流：间隔够但新增字符不足 3000 不触发", async () => {
    vi.useFakeTimers();
    const fn = vi.fn(async () => "摘要");
    const s = new CodeSummarizer(fn);

    await s.maybeSummarize(code(3500), vi.fn());
    vi.setSystemTime(Date.now() + 11000);
    await s.maybeSummarize(code(3500 + 100), vi.fn());

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("间隔与字符都满足后再次触发", async () => {
    vi.useFakeTimers();
    const fn = vi.fn(async () => "摘要2");
    const onSummary = vi.fn();
    const s = new CodeSummarizer(fn);

    await s.maybeSummarize(code(3500), vi.fn());
    vi.setSystemTime(Date.now() + 11000);
    await s.maybeSummarize(code(6500), onSummary);

    expect(fn).toHaveBeenCalledTimes(2);
    expect(onSummary).toHaveBeenCalledWith("摘要2");
  });

  it("并发守卫：上一次摘要未完成时不重复触发", async () => {
    let resolveFirst: ((v: string) => void) | undefined;
    const fn = vi.fn(() => new Promise<string>((r) => (resolveFirst = r)));
    const s = new CodeSummarizer(fn);

    const first = s.maybeSummarize(code(3500), vi.fn());
    // 不 await 第一次，直接触发第二次（时间/字符条件都伪造成满足也没用——守卫先拦）
    const second = s.maybeSummarize(code(8000), vi.fn());
    resolveFirst?.("摘要");
    await Promise.all([first, second]);

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("摘要失败静默处理：不抛出、不影响后续触发", async () => {
    vi.useFakeTimers();
    const fn = vi
      .fn<(snippet: string) => Promise<string>>()
      .mockRejectedValueOnce(new Error("LLM 挂了"))
      .mockResolvedValue("恢复后的摘要");
    const onSummary = vi.fn();
    const s = new CodeSummarizer(fn);

    // 失败不抛出
    await expect(
      s.maybeSummarize(code(3500), onSummary),
    ).resolves.toBeUndefined();
    expect(onSummary).not.toHaveBeenCalled();

    // 后续仍可正常触发
    vi.setSystemTime(Date.now() + 11000);
    await s.maybeSummarize(code(7000), onSummary);
    expect(onSummary).toHaveBeenCalledWith("恢复后的摘要");
  });
});
