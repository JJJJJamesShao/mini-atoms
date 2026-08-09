import { NextRequest } from "next/server";
import { runPipeline, type Executors } from "@/lib/agent";
import { createLLMExecutors } from "@/lib/agent/llm-executors";
import type { SpecOutput } from "@/lib/schemas";
import { createProject } from "@/lib/db/projects";
import { createVersion } from "@/lib/db/versions";
import { createMessage } from "@/lib/db/messages";
import { getUserRole, type UserRole } from "@/lib/db/profiles";
import { countUsageToday, logUsage } from "@/lib/db/usage";
import { createAuthClient } from "@/lib/supabase/auth-server";
import { waitForApproval } from "./gate";

/** 各角色每日 LLM 生成额度：free=0（仅罐头演示），paid 暂不限量 */
const DAILY_QUOTA: Record<UserRole, number> = {
  free: 0,
  paid: Number.POSITIVE_INFINITY,
};

const jsonError = (status: number, payload: Record<string, unknown>) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/**
 * POST /api/pipeline
 * 服务端 Agent 流水线入口（LLM 生成，强制登录 + 角色额度检查）
 *
 * 流程：
 * 1. 鉴权：未登录 401
 * 2. RBAC：角色从 profiles 表读取，免费账号额度 0 → 403；超限 → 429
 * 3. 运行流水线，SSE 实时推送各节点开始/结束事件
 * 4. approve 阶段挂起，等待前端经 /api/pipeline/confirm 注入用户决策
 * 5. 成功后持久化项目/版本/消息并关联 user_id
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body?.input || typeof body.input !== "string") {
    return jsonError(400, { error: "缺少 input 字段" });
  }

  const { input } = body;

  // 1. 强制登录
  const auth = await createAuthClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) {
    return jsonError(401, {
      error: "unauthorized",
      message: "请先登录后再使用 LLM 生成",
    });
  }

  // 2. 角色与额度（账号状态以数据库 profiles 表为准）
  const role = await getUserRole(user.id);
  const used = await countUsageToday(user.id, "generate");
  const quota = DAILY_QUOTA[role];
  if (used >= quota) {
    return jsonError(role === "free" ? 403 : 429, {
      error: "quota_exceeded",
      role,
      used,
      quota: quota === Number.POSITIVE_INFINITY ? null : quota,
      message:
        role === "free"
          ? "免费账号仅支持罐头演示（零成本），LLM 生成需付费账号"
          : "今日生成额度已用完",
    });
  }

  // 3. 记用量（生成前记录，防止失败重试绕过限流）
  await logUsage(user.id, "generate");

  // 创建 SSE 流
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      try {
        // 包装 LLM 执行器：节点开始/结束时实时推送阶段事件，
        // 否则事件要等 runPipeline 返回后才有，approve 确认门会死锁
        const base = createLLMExecutors();
        const executors: Executors = {
          clarify: async (inp) => {
            send({ type: "stage", state: "clarify", phase: "start" });
            const out = await base.clarify(inp);
            send({
              type: "stage",
              state: "clarify",
              phase: "end",
              summary: out.summary,
              needClarification: out.status === "need_clarification",
            });
            return out;
          },
          spec: async (c) => {
            send({ type: "stage", state: "spec", phase: "start" });
            const out = await base.spec(c);
            send({ type: "stage", state: "spec", phase: "end", spec: out });
            return out;
          },
          generate: async (s, errors) => {
            send({
              type: "stage",
              state: "generate",
              phase: "start",
              isRetry: Boolean(errors?.length),
            });
            const out = await base.generate(s, errors);
            send({
              type: "stage",
              state: "generate",
              phase: "end",
              notes: out.notes,
            });
            return out;
          },
          verify: async (files) => {
            send({ type: "stage", state: "verify", phase: "start" });
            const out = await base.verify(files);
            send({
              type: "stage",
              state: "verify",
              phase: "end",
              pass: out.pass,
              errors: out.errors,
            });
            return out;
          },
        };

        // approve 确认门：推送规格后挂起，等待 /api/pipeline/confirm 注入用户决策
        const sessionId = crypto.randomUUID();
        const approver = async (spec: SpecOutput) => {
          send({ type: "approve_needed", sessionId, spec });
          return waitForApproval(sessionId, user.id);
        };

        send({ type: "start", input });

        const { events, finalState, result } = await runPipeline(
          input,
          executors,
          approver,
        );

        // 流水线成功后持久化：项目 + 版本 + 消息，关联当前登录用户
        let projectId: string | null = null;
        if (finalState === "done" && result) {
          try {
            const project = await createProject(input, user.id);
            await createVersion(project.id, result.files, 1);
            await createMessage(project.id, "user", input);
            await createMessage(
              project.id,
              "assistant",
              result.notes || "生成完成",
            );
            projectId = project.id;
            send({ type: "project_created", projectId });
          } catch (dbErr) {
            send({
              type: "persist_error",
              message:
                dbErr instanceof Error ? dbErr.message : JSON.stringify(dbErr),
            });
          }
        }

        const failEvent = [...events].reverse().find((e) => e.state === "fail");
        const reason = (failEvent?.payload as { reason?: string } | undefined)
          ?.reason;

        send({
          type: "done",
          finalState,
          reason: reason ?? null,
          projectId,
          result: result
            ? {
                files: result.files,
                notes: result.notes,
              }
            : null,
        });
      } catch (err) {
        send({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
