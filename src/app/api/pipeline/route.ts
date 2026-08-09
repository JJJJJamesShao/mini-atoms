import { NextRequest } from "next/server";
import { createLLMExecutors } from "@/lib/agent/llm-executors";
import { AgentEventBus } from "@/lib/agent/bus";
import { runSOP } from "@/lib/agent/engine";
import { selectSOP } from "@/lib/agent/router";
import { createRoles } from "@/lib/agent/role";
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
 * 3. SOP 路由（selectSOP）+ runSOP 引擎执行，SSE 实时推送 Agent 事件
 * 4. approve 阶段挂起（仅含确认门的 SOP），等待 /api/pipeline/confirm 注入决策
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

  // 2. 角色与额度
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

  // 3. 记用量
  await logUsage(user.id, "generate");

  // 创建 SSE 流 + Agent EventBus
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      // 创建独立的 Agent 事件总线
      const bus = new AgentEventBus();

      // 全局订阅：所有 Agent 事件实时推送到前端
      bus.subscribeAll((event) => {
        send({ type: "agent_event", payload: event });
      });

      try {
        // SOP 路由：按输入关键词选择流程（game 精简流程跳过 approve）
        const sop = selectSOP(input);

        // 本次运行的角色实例（记忆隔离）+ 共享 Memory 的 LLM 执行器；
        // 游戏 SOP 强制结构化 JSON 输出（CodeArtifact）
        const roles = createRoles();
        const executors = createLLMExecutors(bus, {
          structured: sop.id === "game",
          memories: {
            clarify: roles.pm.memory,
            spec: roles.architect.memory,
            generate: roles.engineer.memory,
            verify: roles.reviewer.memory,
          },
        });

        // approve 确认门：推送规格后挂起，等待 /api/pipeline/confirm
        //（仅含 approve 步骤的 SOP 会调用；game SOP 自动跳过）
        const sessionId = crypto.randomUUID();
        const approver = async (spec: SpecOutput) => {
          send({ type: "approve_needed", sessionId, spec });
          return waitForApproval(sessionId, user.id);
        };

        // 前端按 sop.steps 动态生成阶段卡片（fix 为内部步骤，不下发）
        const displaySteps = sop.steps
          .map((s) => s.name)
          .filter((n) =>
            ["clarify", "spec", "approve", "generate", "verify", "done"].includes(n),
          );
        send({
          type: "start",
          input,
          sop: { id: sop.id, name: sop.name, steps: displaySteps },
        });

        const { finalState, reason, result } = await runSOP(
          input,
          sop,
          executors,
          approver,
          bus,
          roles,
        );

        // 流水线成功后持久化
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

        send({
          type: "done",
          finalState,
          reason,
          projectId,
          result: result
            ? {
                files: result.files,
                notes: result.notes,
              }
            : null,
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error("[Pipeline Error]", errorMsg, err);
        send({
          type: "error",
          message: errorMsg,
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
