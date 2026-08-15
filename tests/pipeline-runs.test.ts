/**
 * Pipeline 运行注册表测试：注册/查询/注销语义与同用户顶号取消。
 */

import { describe, expect, it } from "vitest";
import {
  getRun,
  registerRun,
  unregisterRun,
} from "../src/app/api/pipeline/runs";

describe("pipeline runs 注册表", () => {
  it("注册后可查询，注销后不可查询", () => {
    const controller = registerRun("user-a");
    expect(getRun("user-a")).toBe(controller);
    expect(controller.signal.aborted).toBe(false);

    unregisterRun("user-a", controller);
    expect(getRun("user-a")).toBeUndefined();
  });

  it("同用户重复注册：旧运行被取消并顶替", () => {
    const first = registerRun("user-b");
    const second = registerRun("user-b");

    expect(first.signal.aborted).toBe(true);
    expect(getRun("user-b")).toBe(second);
    expect(second.signal.aborted).toBe(false);

    unregisterRun("user-b", second);
  });

  it("注销携带过期 controller 时不会误删新运行", () => {
    const stale = registerRun("user-c");
    const fresh = registerRun("user-c"); // 顶替 stale
    unregisterRun("user-c", stale); // 过期 controller，应被忽略

    expect(getRun("user-c")).toBe(fresh);
    unregisterRun("user-c", fresh);
  });

  it("不同用户的运行互不影响", () => {
    const a = registerRun("user-d1");
    const b = registerRun("user-d2");
    a.abort();

    expect(getRun("user-d2")?.signal.aborted).toBe(false);

    unregisterRun("user-d1", a);
    unregisterRun("user-d2", b);
  });
});
