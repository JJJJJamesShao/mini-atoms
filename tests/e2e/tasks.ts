/**
 * E2E 任务集 — 模拟面试官/日常使用者的完整操作路径。
 *
 * 任务线性串联（后续任务依赖前序产物，禁止并行）：
 * 1. 新建网页应用：web-app 全流程（clarify→spec→approve 确认门→generate→verify→done）
 * 2. 对话迭代修改：基于任务 1 的项目发起 modify SOP，校验版本链（v2 基于 v1）
 * 3. 新建小游戏：game SOP 无确认门，直通 done
 * 4. 模糊需求：软着陆（need_clarification + 问题清单）或规格拒绝，
 *    模型行为非确定，路径分支记 soft 警告，"流程有明确终态"是硬断言
 *
 * 两次线上返工（projectId 闭环断裂、spec 坏 JSON 死流程）都在这些路径上。
 */

import { getSupabase } from "../../src/lib/supabase/server";
import { verifyProject } from "../../src/lib/verify";
import type { File } from "../../src/lib/schemas";
import { SSESession, type SSEEvent } from "./client";

export interface E2EContext {
  baseUrl: string;
  cookie: string;
  userId: string;
  /** 运行期间创建的项目 id（收尾清理用） */
  createdProjectIds: string[];
  /** 任务间传递：任务 1 的项目 id 与产物 */
  webApp?: { projectId: string; html: string };
}

export interface E2ETask {
  name: string;
  /** hard：失败中断后续任务（线性依赖链）；soft：只记警告 */
  severity: "hard" | "soft";
  run: (ctx: E2EContext) => Promise<void>;
}

/** 等待确认门出现的上限：clarify + spec 各 ~2min + JSON 重试余量 */
const WAIT_APPROVE_MS = 6 * 60 * 1000;
/** 确认后等到 done 的上限：generate 长生成 + 至多 5 轮 fix 的极端路径 */
const WAIT_DONE_MS = 15 * 60 * 1000;

export class AssertError extends Error {}

export function assert(cond: boolean, message: string): void {
  if (!cond) throw new AssertError(message);
}

/** 实时打印阶段时间线（对应用户盯着页面看的感知） */
function printEvent(e: SSEEvent): void {
  const at = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  if (e.type === "start") {
    const sop = e.sop as { id?: string; name?: string } | undefined;
    console.log(
      `  [${at}] ▶ 流程启动：${sop?.name ?? "?"}（${sop?.id ?? "?"}）`,
    );
    return;
  }
  if (e.type === "agent_event") {
    const p = e.payload as
      | { type?: string; agent?: string; role?: string; message?: string }
      | undefined;
    if (p?.type === "agent:start") {
      console.log(`  [${at}] ▶ ${p.agent}（${p.role}）开始`);
    } else if (p?.type === "agent:complete") {
      console.log(`  [${at}] ✓ ${p.agent}：${p.message ?? "完成"}`);
    } else if (p?.type === "agent:error") {
      console.log(`  [${at}] ✗ ${p.agent} 出错：${p.message}`);
    }
    return;
  }
  if (e.type === "approve_needed") {
    console.log(`  [${at}] ⏸ 等待规格确认`);
  } else if (e.type === "done") {
    console.log(
      `  [${at}] ■ 终态：${e.finalState}${e.reason ? `（${e.reason}）` : ""}`,
    );
  } else if (e.type === "error" || e.type === "persist_error") {
    console.log(`  [${at}] ✗ ${e.type}：${e.message}`);
  }
}

function newSession(ctx: E2EContext): SSESession {
  return new SSESession(ctx.baseUrl, ctx.cookie, printEvent);
}

/** 从 done/project_created 事件收集项目 id（登记清理） */
function trackProject(ctx: E2EContext, session: SSESession): string {
  const created = session.lastOfType("project_created");
  const done = session.lastOfType("done");
  const projectId =
    (created?.projectId as string | undefined) ??
    (done?.projectId as string | undefined);
  assert(Boolean(projectId), "未收到 projectId（持久化失败？）");
  ctx.createdProjectIds.push(projectId!);
  return projectId!;
}

/** 断言产物 HTML 通过确定性校验层 */
function assertHtmlPass(files: File[], label: string): string {
  const html =
    files.find((f) => f.path === "index.html")?.content ?? files[0]?.content;
  assert(Boolean(html), `${label}：产物缺少 HTML 文件`);
  const result = verifyProject(files);
  assert(
    result.pass,
    `${label}：产物未通过校验层——${result.errors.map((e) => e.message).join("；")}`,
  );
  return html!;
}

interface VersionRow {
  version_no: number;
  sop_id: string | null;
  parent_version_no: number | null;
  stages: { stage: string; status: string }[] | null;
}

async function loadVersions(projectId: string): Promise<VersionRow[]> {
  const { data, error } = await getSupabase()
    .from("versions")
    .select("version_no, sop_id, parent_version_no, stages")
    .eq("project_id", projectId)
    .order("version_no");
  if (error) throw new Error(`DB 版本查询失败：${error.message}`);
  return (data ?? []) as VersionRow[];
}

/** 任务 1：新建网页应用全流程（含规格确认门） */
async function taskCreateWebApp(ctx: E2EContext): Promise<void> {
  const session = newSession(ctx);
  await session.start({
    input: "做一个待办清单应用，支持添加任务、勾选完成和删除任务",
  });

  const start = await session.waitFor(
    (e) => e.type === "start",
    60_000,
    "流程启动事件",
  );
  const sop = start.sop as { id?: string } | undefined;
  assert(sop?.id === "web-app", `SOP 路由错误：期望 web-app，实际 ${sop?.id}`);

  const approveNeeded = await session.waitFor(
    (e) => e.type === "approve_needed",
    WAIT_APPROVE_MS,
    "规格确认门（approve_needed）",
  );
  const spec = approveNeeded.spec as
    { requirements?: string[]; constraints?: string[] } | undefined;
  assert(Boolean(spec?.requirements?.length), "确认门规格缺少 requirements");

  const { live } = await session.confirm(
    approveNeeded.sessionId as string,
    true,
  );
  assert(live, "确认门未唤醒存活流水线（live=false）");

  const done = await session.waitFor(
    (e) => e.type === "done",
    WAIT_DONE_MS,
    "终态事件（done）",
  );
  assert(
    done.finalState === "done",
    `终态非 done：${done.finalState}（${done.reason ?? "无原因"}）`,
  );

  const result = done.result as { files?: File[] } | null;
  assert(Boolean(result?.files?.length), "done 事件缺少产物 files");
  const html = assertHtmlPass(result!.files!, "任务 1 产物");

  const projectId = trackProject(ctx, session);
  // DB 核验：版本 1 落库、SOP 正确、阶段全 done、消息成对
  const versions = await loadVersions(projectId);
  assert(
    versions.length === 1,
    `DB 版本数错误：期望 1，实际 ${versions.length}`,
  );
  const v1 = versions[0];
  assert(v1.sop_id === "web-app", `DB 版本 SOP 错误：${v1.sop_id}`);
  assert(
    Boolean(v1.stages?.length) && v1.stages!.every((s) => s.status === "done"),
    `DB 阶段未全部 done：${JSON.stringify(v1.stages)}`,
  );
  const { count } = await getSupabase()
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId);
  assert((count ?? 0) >= 2, `DB 消息未成对落库：${count} 条`);

  ctx.webApp = { projectId, html };
  console.log("  ✔ DB 核验通过：版本 1 / 阶段全 done / 消息成对");
}

/** 任务 2：对话迭代修改（modify SOP，版本链 v2 基于 v1） */
async function taskFollowUpModify(ctx: E2EContext): Promise<void> {
  assert(Boolean(ctx.webApp), "任务 2 依赖任务 1 的项目产物");
  const { projectId, html } = ctx.webApp!;
  const session = newSession(ctx);
  await session.start({
    input: "把页面改成深色模式",
    projectId,
    currentFiles: [{ path: "index.html", content: html }],
    baseVersionNo: 1,
  });

  const start = await session.waitFor(
    (e) => e.type === "start",
    60_000,
    "流程启动事件",
  );
  const sop = start.sop as { id?: string } | undefined;
  assert(sop?.id === "modify", `SOP 路由错误：期望 modify，实际 ${sop?.id}`);

  const done = await session.waitFor(
    (e) => e.type === "done",
    WAIT_DONE_MS,
    "终态事件（done）",
  );
  assert(
    done.finalState === "done",
    `终态非 done：${done.finalState}（${done.reason ?? "无原因"}）`,
  );
  // modify SOP 无确认门
  assert(
    !session.events.some((e) => e.type === "approve_needed"),
    "modify SOP 不应出现确认门",
  );

  const result = done.result as { files?: File[] } | null;
  assert(Boolean(result?.files?.length), "done 事件缺少产物 files");
  const newHtml = assertHtmlPass(result!.files!, "任务 2 产物");
  assert(newHtml !== html, "修改后产物与原代码完全一致（修改未生效？）");

  trackProject(ctx, session);
  const versions = await loadVersions(projectId);
  assert(
    versions.length === 2,
    `DB 版本数错误：期望 2，实际 ${versions.length}`,
  );
  const v2 = versions[1];
  assert(v2.sop_id === "modify", `DB 版本 SOP 错误：${v2.sop_id}`);
  assert(
    v2.parent_version_no === 1,
    `版本链断裂：v2.parent_version_no 期望 1，实际 ${v2.parent_version_no}`,
  );
  console.log("  ✔ DB 核验通过：v2 基于 v1 / modify SOP / 产物已变化");
}

/** 任务 3：新建小游戏（game SOP 无确认门直通） */
async function taskCreateGame(ctx: E2EContext): Promise<void> {
  const session = newSession(ctx);
  await session.start({ input: "做一个贪吃蛇游戏，用方向键控制移动" });

  const start = await session.waitFor(
    (e) => e.type === "start",
    60_000,
    "流程启动事件",
  );
  const sop = start.sop as { id?: string } | undefined;
  assert(sop?.id === "game", `SOP 路由错误：期望 game，实际 ${sop?.id}`);

  const done = await session.waitFor(
    (e) => e.type === "done",
    WAIT_DONE_MS,
    "终态事件（done）",
  );
  assert(
    done.finalState === "done",
    `终态非 done：${done.finalState}（${done.reason ?? "无原因"}）`,
  );
  assert(
    !session.events.some((e) => e.type === "approve_needed"),
    "game SOP 不应出现确认门",
  );

  const result = done.result as { files?: File[] } | null;
  assert(Boolean(result?.files?.length), "done 事件缺少产物 files");
  assertHtmlPass(result!.files!, "任务 3 产物");
  trackProject(ctx, session);
  console.log("  ✔ game SOP 直通验证通过");
}

/** 任务 4（soft）：模糊需求——软着陆或规格拒绝，流程必须有明确终态 */
async function taskVagueInput(ctx: E2EContext): Promise<void> {
  const session = newSession(ctx);
  await session.start({ input: "帮我做个好玩的东西" });

  const first = await session.waitFor(
    (e) => e.type === "approve_needed" || e.type === "done",
    WAIT_APPROVE_MS,
    "确认门或终态",
  );

  if (first.type === "approve_needed") {
    // 模型认为信息足够（非确定性分支）——走规格拒绝路径，同样验证流程闭环
    console.log("  ⚠ 模型未要求澄清（非确定性行为，记警告不判负）");
    await session.confirm(first.sessionId as string, false);
    const done = await session.waitFor(
      (e) => e.type === "done",
      120_000,
      "拒绝后的终态事件",
    );
    assert(
      done.finalState === "fail" && done.reason === "spec_rejected",
      `规格拒绝路径终态错误：${done.finalState}（${done.reason ?? "无"}）`,
    );
  } else {
    assert(
      first.finalState === "fail" && first.reason === "need_clarification",
      `软着陆终态错误：${first.finalState}（${first.reason ?? "无"}）`,
    );
    const questions = first.questions as string[] | null;
    assert(Boolean(questions?.length), "need_clarification 终态缺少问题清单");
    console.log(`  ✔ 软着陆验证通过：${questions!.length} 个引导问题`);
  }
  trackProject(ctx, session);
}

/** 任务列表（顺序即依赖链，禁止重排） */
export const TASKS: E2ETask[] = [
  {
    name: "新建网页应用全流程（含规格确认门）",
    severity: "hard",
    run: taskCreateWebApp,
  },
  {
    name: "对话迭代修改（modify SOP 版本链）",
    severity: "hard",
    run: taskFollowUpModify,
  },
  {
    name: "新建小游戏（game SOP 跳过确认门）",
    severity: "hard",
    run: taskCreateGame,
  },
  { name: "模糊需求软着陆", severity: "soft", run: taskVagueInput },
];
