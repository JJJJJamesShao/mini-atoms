import { describe, expect, it, vi } from "vitest";
import { runSOP } from "../src/lib/agent/engine";
import { selectSOP, selectSOPId } from "../src/lib/agent/router";
import { ROLES } from "../src/lib/agent/role";
import {
  DEFAULT_SOP,
  FULLSTACK_SOP,
  GAME_SOP,
  SOP_REGISTRY,
} from "../src/lib/agent/sop";
import type { Executors } from "../src/lib/agent";
import type {
  ClarifyOutput,
  GenerateOutput,
  SpecOutput,
  VerifyResult,
} from "../src/lib/schemas";

const READY_CLARIFY: ClarifyOutput = {
  status: "ready",
  questions: [],
  summary: "需求已明确",
};

const NEED_CLARIFY: ClarifyOutput = {
  status: "need_clarification",
  questions: [{ id: "q1", question: "要什么风格？", options: ["简约"] }],
  summary: "信息不足",
};

const SPEC: SpecOutput = {
  requirements: ["r1"],
  constraints: ["c1"],
  userStories: ["u1"],
};

const GENERATED: GenerateOutput = {
  files: [{ path: "index.html", content: "<!DOCTYPE html><html></html>" }],
  notes: "mock 生成",
};

const VERIFY_OK: VerifyResult = { pass: true, stage: "structure", errors: [] };
const VERIFY_FAIL: VerifyResult = {
  pass: false,
  stage: "syntax",
  errors: [{ rule: "syntax", message: "mock 语法错误" }],
};

/** 可编排行为的 mock 执行器，记录调用顺序 */
function makeExecutors(overrides?: {
  clarify?: Executors["clarify"];
  verifyResults?: VerifyResult[];
}) {
  const calls: string[] = [];
  const verifyQueue = [...(overrides?.verifyResults ?? [VERIFY_OK])];
  const executors: Executors = {
    clarify:
      overrides?.clarify ??
      (async () => {
        calls.push("clarify");
        return READY_CLARIFY;
      }),
    spec: async () => {
      calls.push("spec");
      return SPEC;
    },
    generate: async () => {
      calls.push("generate");
      return GENERATED;
    },
    verify: async () => {
      calls.push("verify");
      return verifyQueue.length > 1 ? verifyQueue.shift()! : verifyQueue[0];
    },
  };
  return { executors, calls };
}

describe("selectSOP 路由", () => {
  it("游戏类输入 → game SOP", () => {
    expect(selectSOPId("做一个数独游戏")).toBe("game");
    expect(selectSOPId("做一个贪吃蛇")).toBe("game");
    expect(selectSOPId("make a snake game")).toBe("game");
  });

  it("工具类输入 → tool SOP", () => {
    expect(selectSOPId("做一个计时器")).toBe("tool");
    expect(selectSOPId("做一个待办清单")).toBe("tool");
    expect(selectSOPId("做一个计算器")).toBe("tool");
  });

  it("复杂任务 → fullstack-app 多阶段流程", () => {
    expect(selectSOPId("做一个博客")).toBe("fullstack-app");
    expect(selectSOPId("带登录的管理系统")).toBe("fullstack-app");
    expect(selectSOPId("做一个 CRUD 后台")).toBe("fullstack-app");
  });

  it("其他输入 → web-app 默认流程", () => {
    expect(selectSOPId("做一个电商网站")).toBe("web-app");
  });

  it("tool 复用 web-app 完整流程；game 为精简流程（无 approve）", () => {
    expect(SOP_REGISTRY.get("tool")).toBe(DEFAULT_SOP);
    expect(selectSOP("做一个数独游戏")).toBe(GAME_SOP);
    expect(GAME_SOP.steps.some((s) => s.action === "approve")).toBe(false);
    expect(DEFAULT_SOP.steps.some((s) => s.action === "approve")).toBe(true);
  });
});

describe("SOP 配置完整性", () => {
  it("所有步骤的跳转目标都存在，角色引用合法", () => {
    for (const sop of [DEFAULT_SOP, GAME_SOP, FULLSTACK_SOP]) {
      const names = new Set(sop.steps.map((s) => s.name));
      for (const step of sop.steps) {
        const targets =
          typeof step.next === "string"
            ? [step.next]
            : [
                step.next.default,
                ...(step.next.conditions ?? []).map((c) => c.then),
              ];
        for (const target of targets) {
          if (target === "") continue;
          expect(names.has(target), `${sop.id}.${step.name} → ${target}`).toBe(
            true,
          );
        }
        if (step.role !== "system") {
          expect(ROLES[step.role], `${sop.id}.${step.name} role`).toBeDefined();
        }
      }
    }
  });
});

describe("runSOP 执行引擎", () => {
  it("web-app happy path：approve 通过 → done，顺序执行", async () => {
    const { executors, calls } = makeExecutors();
    const approver = vi.fn(async () => true);
    const out = await runSOP(
      "做一个电商网站",
      DEFAULT_SOP,
      executors,
      approver,
    );

    expect(out.finalState).toBe("done");
    expect(out.result?.files).toEqual(GENERATED.files);
    expect(approver).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["clarify", "spec", "generate", "verify"]);
  });

  it("web-app approve 拒绝 → fail(spec_rejected)，不进入 generate", async () => {
    const { executors, calls } = makeExecutors();
    const out = await runSOP(
      "做一个电商网站",
      DEFAULT_SOP,
      executors,
      async () => false,
    );

    expect(out.finalState).toBe("fail");
    expect(out.reason).toBe("spec_rejected");
    expect(calls).toEqual(["clarify", "spec"]);
  });

  it("game SOP 跳过 approve：approver 不被调用", async () => {
    const { executors, calls } = makeExecutors();
    const approver = vi.fn(async () => {
      throw new Error("game SOP 不应调用 approver");
    });
    const out = await runSOP("做一个数独游戏", GAME_SOP, executors, approver);

    expect(out.finalState).toBe("done");
    expect(approver).not.toHaveBeenCalled();
    expect(calls).toEqual(["clarify", "spec", "generate", "verify"]);
  });

  it("clarify 需要澄清 → fail(need_clarification)", async () => {
    const { executors } = makeExecutors({ clarify: async () => NEED_CLARIFY });
    const out = await runSOP(
      "随便做点什么",
      DEFAULT_SOP,
      executors,
      async () => true,
    );

    expect(out.finalState).toBe("fail");
    expect(out.reason).toBe("need_clarification");
  });

  it("verify 首次失败 → fix → 重新生成 → done", async () => {
    const { executors, calls } = makeExecutors({
      verifyResults: [VERIFY_FAIL, VERIFY_OK],
    });
    const out = await runSOP("做一个数独游戏", GAME_SOP, executors);

    expect(out.finalState).toBe("done");
    expect(calls).toEqual([
      "clarify",
      "spec",
      "generate",
      "verify",
      "generate",
      "verify",
    ]);
  });

  it("verify 连续失败 → 修复次数用尽 → fail(verify_failed)", async () => {
    const { executors, calls } = makeExecutors({
      verifyResults: [VERIFY_FAIL],
    });
    const out = await runSOP("做一个数独游戏", GAME_SOP, executors);

    expect(out.finalState).toBe("fail");
    expect(out.reason).toBe("verify_failed");
    // 1 次首次生成 + 4 次修复重试（MAX_FIX_ATTEMPTS=5，第 5 次 fix 判定用尽）
    expect(calls.filter((c) => c === "generate")).toHaveLength(5);
  });

  it("fullstack-app：四阶段产物传递 + 确定性 merge → done", async () => {
    const calls: string[] = [];
    const stageInputs: Record<string, string[] | undefined> = {};
    const executors: Executors = {
      clarify: async () => READY_CLARIFY,
      spec: async () => SPEC,
      generate: async (_spec, _errors, currentFiles, _attempt, stage) => {
        calls.push(`generate:${stage ?? "plain"}`);
        stageInputs[stage ?? "plain"] = currentFiles?.map((f) => f.path);
        const content =
          stage === "schema"
            ? "const db = {};"
            : stage === "shell"
              ? "<!DOCTYPE html><html><head></head><body><!-- PAGE_CONTENT:home --></body></html>"
              : "// === PAGE: home ===\n<div>首页</div>";
        return { files: [{ path: `${stage}.out`, content }], notes: "ok" };
      },
      verify: async () => VERIFY_OK,
    };
    const out = await runSOP(
      "做一个带登录的博客",
      FULLSTACK_SOP,
      executors,
      async () => true,
    );

    expect(out.finalState).toBe("done");
    expect(calls).toEqual([
      "generate:schema",
      "generate:shell",
      "generate:pages",
    ]);
    // 阶段产物传递：shell 引用 schema，pages 引用 schema+shell
    expect(stageInputs["shell"]).toEqual(["schema.out"]);
    expect(stageInputs["pages"]).toEqual(["schema.out", "shell.out"]);
    // 确定性 merge：占位符被页面代码替换，schema 被注入
    const html = out.result?.files[0].content ?? "";
    expect(html).toContain("<div>首页</div>");
    expect(html).toContain("const db = {};");
    expect(html).not.toContain("PAGE_CONTENT");
    // 中间产物随结果带出（落库供排查）
    expect(out.stageOutputs?.schema).toBeDefined();
    expect(out.stageOutputs?.shell).toBeDefined();
    expect(out.stageOutputs?.pages).toBeDefined();
  });

  it("fullstack-app：阶段校验失败只重修该阶段（lastErrors 不跨阶段污染）", async () => {
    const verifyQueue = [
      VERIFY_FAIL, // verify-schema 第一次失败
      VERIFY_OK, // verify-schema 重修后通过
      VERIFY_OK, // verify-shell
      VERIFY_OK, // verify-pages
      VERIFY_OK, // 最终 verify
    ];
    const genCalls: { stage?: string; hasErrors: boolean }[] = [];
    const executors: Executors = {
      clarify: async () => READY_CLARIFY,
      spec: async () => SPEC,
      generate: async (_spec, errors, _files, _attempt, stage) => {
        genCalls.push({ stage, hasErrors: Boolean(errors?.length) });
        const content =
          stage === "schema"
            ? "const db = {};"
            : stage === "shell"
              ? "<!DOCTYPE html><html><head></head><body><!-- PAGE_CONTENT:home --></body></html>"
              : "// === PAGE: home ===\n<div>首页</div>";
        return { files: [{ path: `${stage}.out`, content }], notes: "ok" };
      },
      verify: async () =>
        verifyQueue.length > 1 ? verifyQueue.shift()! : verifyQueue[0],
    };
    const out = await runSOP(
      "做一个带登录的博客",
      FULLSTACK_SOP,
      executors,
      async () => true,
    );

    expect(out.finalState).toBe("done");
    // schema 生成两次（第二次带错误信息重修），shell/pages 各一次且无错误污染
    expect(genCalls).toEqual([
      { stage: "schema", hasErrors: false },
      { stage: "schema", hasErrors: true },
      { stage: "shell", hasErrors: false },
      { stage: "pages", hasErrors: false },
    ]);
  });
});
