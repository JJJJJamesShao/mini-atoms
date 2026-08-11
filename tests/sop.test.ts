import { describe, expect, it, vi } from "vitest";
import { runSOP } from "../src/lib/agent/engine";
import { selectSOP, selectSOPId } from "../src/lib/agent/router";
import { ROLES } from "../src/lib/agent/role";
import {
  DEFAULT_SOP,
  FULLSTACK_SOP,
  GAME_SOP,
  MODIFY_SOP,
  SOP_REGISTRY,
} from "../src/lib/agent/sop";
import type { Executors } from "../src/lib/agent";
import type {
  ClarifyOutput,
  File,
  GenerateOutput,
  LocateOutput,
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
    locate: async (input) => ({ intent: input, anchors: [] }),
    patch: async (locate) => ({ patchText: "", notes: locate.intent }),
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

  it("有现有代码（对话迭代）→ modify 增量修改小循环，优先级高于关键词", () => {
    expect(selectSOPId("把标题改成蓝色", { hasCurrentCode: true })).toBe(
      "modify",
    );
    expect(selectSOPId("做一个数独游戏", { hasCurrentCode: true })).toBe(
      "modify",
    );
    expect(selectSOPId("做一个数独游戏", { hasCurrentCode: false })).toBe(
      "game",
    );
    expect(selectSOP("把标题改成蓝色", { hasCurrentCode: true })).toBe(
      MODIFY_SOP,
    );
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
    for (const sop of [DEFAULT_SOP, GAME_SOP, FULLSTACK_SOP, MODIFY_SOP]) {
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
      locate: async (input) => ({ intent: input, anchors: [] }),
      patch: async (locate) => ({ patchText: "", notes: locate.intent }),
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
      locate: async (input) => ({ intent: input, anchors: [] }),
      patch: async (locate) => ({ patchText: "", notes: locate.intent }),
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

  it("fullstack-app：merge 检出缺页 → fix-pages 重修 → 补齐后 done", async () => {
    const SHELL_TWO_PAGES =
      "<!DOCTYPE html><html><head></head><body><!-- PAGE_CONTENT:home --><!-- PAGE_CONTENT:login --></body></html>";
    let pagesCalls = 0;
    const pagesErrorsSeen: boolean[] = [];
    const executors: Executors = {
      clarify: async () => READY_CLARIFY,
      spec: async () => SPEC,
      generate: async (_spec, errors, _files, _attempt, stage) => {
        if (stage === "pages") {
          pagesCalls++;
          pagesErrorsSeen.push(Boolean(errors?.length));
          // 第一次缺 login 块（触发 merge 缺页检测），第二次补齐
          const content =
            pagesCalls === 1
              ? "// === PAGE: home ===\n<div>首页</div>"
              : "// === PAGE: home ===\n<div>首页</div>\n// === PAGE: login ===\n<form>登录</form>";
          return { files: [{ path: "pages.js", content }], notes: "ok" };
        }
        const content = stage === "schema" ? "const db = {};" : SHELL_TWO_PAGES;
        return { files: [{ path: `${stage}.out`, content }], notes: "ok" };
      },
      verify: async () => VERIFY_OK,
      locate: async (input) => ({ intent: input, anchors: [] }),
      patch: async (locate) => ({ patchText: "", notes: locate.intent }),
    };
    const out = await runSOP(
      "做一个带登录的博客",
      FULLSTACK_SOP,
      executors,
      async () => true,
    );

    expect(out.finalState).toBe("done");
    expect(pagesCalls).toBe(2);
    // 第二次重修带着 merge-missing-page 错误信息
    expect(pagesErrorsSeen).toEqual([false, true]);
    const html = out.result?.files[0].content ?? "";
    expect(html).toContain("<form>登录</form>");
    expect(html).not.toContain("的实现缺失");
  });
});

describe("modify SOP 增量修改小循环", () => {
  const BASE_HTML = "<!DOCTYPE html><html><body><h1>旧标题</h1></body></html>";
  const BASE_FILES: File[] = [{ path: "index.html", content: BASE_HTML }];
  const LOCATE: LocateOutput = {
    intent: "把标题改成新标题",
    anchors: [
      { id: "a1", description: "主标题", searchHint: "<h1>旧标题</h1>" },
    ],
  };
  const GOOD_PATCH = [
    "<<<<<<< SEARCH",
    "<h1>旧标题</h1>",
    "=======",
    "<h1>新标题</h1>",
    ">>>>>>> REPLACE",
  ].join("\n");
  const BAD_PATCH = [
    "<<<<<<< SEARCH",
    "<h1>不存在的标题</h1>",
    "=======",
    "<h1>新标题</h1>",
    ">>>>>>> REPLACE",
  ].join("\n");

  /** modify SOP 专用 mock：patch 队列 + 反馈捕获 */
  function makeModifyExecutors(overrides?: {
    patchTexts?: string[];
    verifyResults?: VerifyResult[];
  }) {
    const calls: string[] = [];
    const feedbacks: Array<string | undefined> = [];
    const patchQueue = [...(overrides?.patchTexts ?? [GOOD_PATCH])];
    const verifyQueue = [...(overrides?.verifyResults ?? [VERIFY_OK])];
    const executors: Executors = {
      clarify: async () => READY_CLARIFY,
      spec: async () => SPEC,
      generate: async () => GENERATED,
      verify: async () => {
        calls.push("verify");
        return verifyQueue.length > 1 ? verifyQueue.shift()! : verifyQueue[0];
      },
      locate: async (input) => {
        calls.push("locate");
        return { ...LOCATE, intent: input };
      },
      patch: async (_locate, _files, feedback) => {
        calls.push("patch");
        feedbacks.push(feedback);
        const patchText =
          patchQueue.length > 1 ? patchQueue.shift()! : patchQueue[0];
        return { patchText, notes: "mock 补丁" };
      },
    };
    return { executors, calls, feedbacks };
  }

  it("happy path：locate→patch→apply→verify→done，产物已打补丁且 locate 落 stageOutputs", async () => {
    const { executors, calls } = makeModifyExecutors();
    const out = await runSOP(
      "把标题改成新标题",
      MODIFY_SOP,
      executors,
      undefined,
      undefined,
      undefined,
      BASE_FILES,
    );

    expect(out.finalState).toBe("done");
    expect(calls).toEqual(["locate", "patch", "verify"]);
    expect(out.result?.files[0].content).toContain("<h1>新标题</h1>");
    expect(out.result?.files[0].content).not.toContain("旧标题");
    // locate 产物随 stageOutputs 带出（落库供排查）
    expect(out.stageOutputs?.locate).toBeDefined();
  });

  it("apply 失败（SEARCH 块未命中）→ 带反馈回 patch 重试 → 成功", async () => {
    const { executors, calls, feedbacks } = makeModifyExecutors({
      patchTexts: [BAD_PATCH, GOOD_PATCH],
    });
    const out = await runSOP(
      "把标题改成新标题",
      MODIFY_SOP,
      executors,
      undefined,
      undefined,
      undefined,
      BASE_FILES,
    );

    expect(out.finalState).toBe("done");
    expect(calls).toEqual(["locate", "patch", "patch", "verify"]);
    // 第二次 patch 收到 apply 失败反馈（三级匹配均未命中）
    expect(feedbacks[0]).toBeUndefined();
    expect(feedbacks[1]).toContain("未找到匹配");
    expect(out.result?.files[0].content).toContain("<h1>新标题</h1>");
  });

  it("verify 失败 → 回 patch 重写补丁（反馈含校验错误）", async () => {
    const { executors, calls, feedbacks } = makeModifyExecutors({
      verifyResults: [VERIFY_FAIL, VERIFY_OK],
    });
    const out = await runSOP(
      "把标题改成新标题",
      MODIFY_SOP,
      executors,
      undefined,
      undefined,
      undefined,
      BASE_FILES,
    );

    expect(out.finalState).toBe("done");
    expect(calls).toEqual(["locate", "patch", "verify", "patch", "verify"]);
    expect(feedbacks[1]).toContain("mock 语法错误");
  });

  it("no-op 补丁（内容未变）→ 视为失败重试，反馈指明无实际修改", async () => {
    const NOOP_PATCH = [
      "<<<<<<< SEARCH",
      "<h1>旧标题</h1>",
      "=======",
      "<h1>旧标题</h1>",
      ">>>>>>> REPLACE",
    ].join("\n");
    const { executors, feedbacks } = makeModifyExecutors({
      patchTexts: [NOOP_PATCH, GOOD_PATCH],
    });
    const out = await runSOP(
      "把标题改成新标题",
      MODIFY_SOP,
      executors,
      undefined,
      undefined,
      undefined,
      BASE_FILES,
    );

    expect(out.finalState).toBe("done");
    expect(feedbacks[1]).toContain("未产生任何实际修改");
  });

  it("重试次数用尽 → fail 且无新产物（旧版本保留由路由层兜底）", async () => {
    const { executors, calls } = makeModifyExecutors({
      patchTexts: [BAD_PATCH],
    });
    const out = await runSOP(
      "把标题改成新标题",
      MODIFY_SOP,
      executors,
      undefined,
      undefined,
      undefined,
      BASE_FILES,
    );

    expect(out.finalState).toBe("fail");
    expect(out.reason).toBe("verify_failed");
    // 首次 patch + 4 次重试（MAX_FIX_ATTEMPTS=5，第 5 次 fix 判定用尽）
    expect(calls.filter((c) => c === "patch")).toHaveLength(5);
    expect(out.result).toBeUndefined();
  });

  it("modify SOP 无 approve/clarify/spec 步骤（修改不重新确认规格）", () => {
    const actions = MODIFY_SOP.steps.map((s) => s.action);
    expect(actions).not.toContain("approve");
    expect(actions).not.toContain("clarify");
    expect(actions).not.toContain("spec");
  });
});
