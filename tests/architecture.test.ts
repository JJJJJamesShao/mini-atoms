import { describe, expect, it } from "vitest";
import { AgentEventBus } from "../src/lib/agent/bus";
import { AgentMemory } from "../src/lib/agent/memory";
import { MessageTopic, type TypedMessage } from "../src/lib/agent/message";
import { createRoles, Role, ROLES } from "../src/lib/agent/role";
import { runSOP } from "../src/lib/agent/engine";
import { DEFAULT_SOP, GAME_SOP } from "../src/lib/agent/sop";
import type { Executors } from "../src/lib/agent";
import type {
  ClarifyOutput,
  GenerateOutput,
  SpecOutput,
  VerifyResult,
} from "../src/lib/schemas";
import {
  CodeArtifactSchema,
  parseCodeArtifact,
  wrapHtmlAsArtifact,
} from "../src/lib/schemas/code-artifact";

// ---------- 公共 mock ----------

const READY_CLARIFY: ClarifyOutput = {
  status: "ready",
  questions: [],
  summary: "需求已明确",
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

function makeExecutors(): Executors {
  return {
    clarify: async () => READY_CLARIFY,
    spec: async () => SPEC,
    generate: async () => GENERATED,
    verify: async () => VERIFY_OK,
  };
}

// ---------- Topic-based EventBus ----------

describe("TypedEventBus Topic 路由", () => {
  it("按 Topic 订阅：PRD 只送达 PRD 订阅者", () => {
    const bus = new AgentEventBus();
    const prdReceived: TypedMessage[] = [];
    const codeReceived: TypedMessage[] = [];
    bus.subscribeTopic(MessageTopic.PRD, (m) => prdReceived.push(m));
    bus.subscribeTopic(MessageTopic.CODE, (m) => codeReceived.push(m));

    bus.publish(MessageTopic.PRD, {
      from: "产品经理",
      payload: { summary: "做一个待办" },
      sessionId: "s1",
    });

    expect(prdReceived).toHaveLength(1);
    expect(prdReceived[0].topic).toBe(MessageTopic.PRD);
    expect(codeReceived).toHaveLength(0);
  });

  it("旧 emit() 兼容：进度事件映射进 SYSTEM Topic 历史", () => {
    const bus = new AgentEventBus();
    bus.emit({ type: "agent:start", agent: "clarify", role: "产品经理" });

    const systemMsgs = bus.queryHistory(MessageTopic.SYSTEM, "__system__");
    expect(systemMsgs).toHaveLength(1);
    expect(systemMsgs[0].from).toBe("产品经理");
  });

  it("queryHistory 按 sessionId 隔离", () => {
    const bus = new AgentEventBus();
    bus.publish(MessageTopic.PRD, { from: "pm", payload: "a", sessionId: "s1" });
    bus.publish(MessageTopic.PRD, { from: "pm", payload: "b", sessionId: "s2" });

    expect(bus.queryHistory(MessageTopic.PRD, "s1")).toHaveLength(1);
    expect(bus.queryHistory(MessageTopic.PRD, "s2")).toHaveLength(1);
    expect(bus.queryHistory(MessageTopic.ARCH_SPEC, "s1")).toHaveLength(0);
  });

  it("历史上限 100 条，防内存泄漏", () => {
    const bus = new AgentEventBus();
    for (let i = 0; i < 150; i++) {
      bus.publish(MessageTopic.SYSTEM, {
        from: "test",
        payload: i,
        sessionId: "s1",
      });
    }
    expect(bus.stats().historySize).toBe(100);
    // 保留最新 100 条
    const msgs = bus.queryHistory(MessageTopic.SYSTEM, "s1");
    expect(msgs[msgs.length - 1].payload).toBe(149);
    expect(msgs[0].payload).toBe(50);
  });
});

// ---------- Agent Memory ----------

describe("AgentMemory", () => {
  it("add/query/clear 基本行为", () => {
    const mem = new AgentMemory();
    mem.add({ topic: MessageTopic.PRD, content: "需求A" });
    mem.add({ topic: MessageTopic.CODE, content: "代码B" });
    mem.add({ topic: MessageTopic.PRD, content: "需求C" });

    expect(mem.query(MessageTopic.PRD).map((e) => e.content)).toEqual([
      "需求A",
      "需求C",
    ]);
    expect(mem.query(MessageTopic.PRD, 1)[0].content).toBe("需求C");
    expect(mem.size).toBe(3);
    mem.clear();
    expect(mem.size).toBe(0);
  });

  it("容量裁剪：超出 maxEntries 丢弃最旧条目", () => {
    const mem = new AgentMemory({ maxEntries: 3 });
    for (let i = 0; i < 5; i++) {
      mem.add({ topic: MessageTopic.SYSTEM, content: `m${i}` });
    }
    expect(mem.size).toBe(3);
    expect(mem.all().map((e) => e.content)).toEqual(["m2", "m3", "m4"]);
  });

  it("buildContext：system prompt + 记忆条目", () => {
    const mem = new AgentMemory();
    mem.add({ topic: MessageTopic.PRD, content: "需求" });
    const ctx = mem.buildContext("你是架构师");
    expect(ctx[0]).toEqual({ role: "system", content: "你是架构师" });
    expect(ctx[1].content).toBe("[PRD] 需求");
  });
});

// ---------- Role 记忆隔离与消息消费 ----------

describe("Role Memory 隔离", () => {
  it("createRoles 每次返回全新实例，记忆互不影响", () => {
    const a = createRoles();
    const b = createRoles();
    a.pm.memory.add({ topic: MessageTopic.SYSTEM, content: "x" });
    expect(b.pm.memory.size).toBe(0);
    expect(a.pm.memory).not.toBe(b.pm.memory);
  });

  it("prepareContext：架构师只消费 PRD，拿不到 CODE", () => {
    const bus = new AgentEventBus();
    bus.publish(MessageTopic.PRD, { from: "产品经理", payload: { s: 1 }, sessionId: "s1" });
    bus.publish(MessageTopic.CODE, { from: "前端工程师", payload: { c: 1 }, sessionId: "s1" });

    const architect = new Role(ROLES.architect.config);
    architect.prepareContext(bus, "s1");

    expect(architect.memory.query(MessageTopic.PRD)).toHaveLength(1);
    expect(architect.memory.query(MessageTopic.CODE)).toHaveLength(0);
    expect(architect.memory.all()[0].metadata?.from).toBe("产品经理");
  });
});

// ---------- 引擎 × 消息池集成 ----------

describe("runSOP × Topic 消息池", () => {
  it("步骤产物按 Topic 发布：clarify→PRD、spec→ARCH_SPEC、generate→CODE、verify→REVIEW", async () => {
    const bus = new AgentEventBus();
    const published: TypedMessage[] = [];
    for (const topic of [MessageTopic.PRD, MessageTopic.ARCH_SPEC, MessageTopic.CODE, MessageTopic.REVIEW]) {
      bus.subscribeTopic(topic, (m) => published.push(m));
    }

    const out = await runSOP("做一个电商网站", DEFAULT_SOP, makeExecutors(), async () => true, bus);

    expect(out.finalState).toBe("done");
    const topics = published.map((m) => m.topic);
    expect(topics).toEqual([
      MessageTopic.PRD,
      MessageTopic.ARCH_SPEC,
      MessageTopic.CODE,
      MessageTopic.REVIEW,
    ]);
    expect(published[0].from).toBe("产品经理");
    expect(published[0].payload).toEqual(READY_CLARIFY);
    expect(published[1].payload).toEqual(SPEC);
    // 同一会话 id 贯穿
    expect(new Set(published.map((m) => m.sessionId)).size).toBe(1);
  });

  it("记忆链路：架构师执行后其 Memory 中含 PRD 历史", async () => {
    const bus = new AgentEventBus();
    const roles = createRoles();
    await runSOP("做一个数独游戏", GAME_SOP, makeExecutors(), undefined, bus, roles);

    // 架构师在 spec 步骤前 prepareContext，消费了 PM 发布的 PRD
    expect(roles.architect.memory.query(MessageTopic.PRD).length).toBeGreaterThan(0);
  });
});

// ---------- 结构化输出 ----------

describe("CodeArtifact 结构化输出", () => {
  const validJson = JSON.stringify({
    files: [
      { path: "index.html", type: "html", content: "<!DOCTYPE html><html></html>", dependencies: [] },
      { path: "game.js", type: "js", content: "console.log(1)", dependencies: [] },
    ],
    metadata: { framework: null, externalDeps: [] },
    notes: "游戏说明",
  });

  it("合法 JSON 解析成功（含多文件）", () => {
    const artifact = parseCodeArtifact(validJson);
    expect(artifact).not.toBeNull();
    expect(artifact?.files).toHaveLength(2);
    expect(artifact?.files[1].path).toBe("game.js");
    expect(artifact?.notes).toBe("游戏说明");
  });

  it("markdown 代码块包裹也能解析", () => {
    const artifact = parseCodeArtifact("```json\n" + validJson + "\n```");
    expect(artifact?.files).toHaveLength(2);
  });

  it("非法结构返回 null（缺 files / type 枚举外）", () => {
    expect(parseCodeArtifact("{}")).toBeNull();
    expect(parseCodeArtifact('{"files":[]}')).toBeNull();
    expect(
      parseCodeArtifact(
        JSON.stringify({ files: [{ path: "a.py", type: "python", content: "" }] }),
      ),
    ).toBeNull();
  });

  it("纯 HTML 无法解析 → wrapHtmlAsArtifact 降级为单文件", () => {
    expect(parseCodeArtifact("<!DOCTYPE html><html></html>")).toBeNull();
    const fallback = wrapHtmlAsArtifact("<!DOCTYPE html><html></html>");
    expect(fallback.files).toHaveLength(1);
    expect(fallback.files[0].type).toBe("html");
    // 降级产物自身也过 schema
    expect(CodeArtifactSchema.safeParse(fallback).success).toBe(true);
  });
});
