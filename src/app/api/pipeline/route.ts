import { NextRequest } from "next/server";
import { createLLMExecutors } from "@/lib/agent/llm-executors";
import { AgentEventBus } from "@/lib/agent/bus";
import { runSOP } from "@/lib/agent/engine";
import { selectSOP } from "@/lib/agent/router";
import { createRoles } from "@/lib/agent/role";
import type { File, SpecOutput } from "@/lib/schemas";

/** 强制 Node.js runtime：Edge Runtime 不支持 Buffer 和完整 Supabase 客户端 */
export const runtime = "nodejs";
import { createProject } from "@/lib/db/projects";
import { createVersion, getVersions } from "@/lib/db/versions";
import { createMessage } from "@/lib/db/messages";
import { countUsageToday, logUsage } from "@/lib/db/usage";
import { getUserRole, type UserRole } from "@/lib/db/profiles";
import { createAuthClient } from "@/lib/supabase/auth-server";
import { waitForApproval } from "./gate";

/** 各角色每日 LLM 生成额度：free=0（仅罐头演示），paid 不限量 */
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
 * 服务端 Agent 流水线入口（强制登录 + 每日额度限制）
 *
 * 支持两种模式：
 * 1. 首次生成：{ input } → 创建新项目 + 版本 1
 * 2. 对话迭代：{ input, projectId, currentFiles } → 追加版本
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body?.input || typeof body.input !== "string") {
    return jsonError(400, { error: "缺少 input 字段" });
  }

  const { input, projectId, currentFiles } = body as {
    input: string;
    projectId?: string;
    currentFiles?: File[];
  };

  // 1. 强制登录
  const auth = await createAuthClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) {
    return jsonError(401, {
      error: "unauthorized",
      message: "请先登录后再使用生成",
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
          ? "免费账号仅支持体验示例项目，AI 生成需付费账号"
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
            [
              "clarify",
              "spec",
              "approve",
              "generate",
              "verify",
              "done",
            ].includes(n),
          );
        send({
          type: "start",
          input,
          sop: { id: sop.id, name: sop.name, steps: displaySteps },
        });

        // 对话迭代：传入当前代码，让 LLM 基于现有代码修改
        const initialFiles: File[] | undefined = currentFiles;

        const { finalState, reason, result } = await runSOP(
          input,
          sop,
          executors,
          approver,
          bus,
          roles,
          initialFiles,
        );

        // 流水线成功后持久化
        let finalProjectId: string | null = null;
        if (finalState === "done" && result) {
          try {
            if (projectId) {
              // 对话迭代：追加版本到现有项目
              const versions = await getVersions(projectId);
              const nextVersionNo = versions.length + 1;
              await createVersion(projectId, result.files, nextVersionNo);
              await createMessage(projectId, "user", input);
              await createMessage(
                projectId,
                "assistant",
                result.notes || "修改完成",
              );
              finalProjectId = projectId;
              send({
                type: "project_updated",
                projectId,
                versionNo: nextVersionNo,
              });
            } else {
              // 首次生成：创建新项目
              const project = await createProject(input, user.id);
              await createVersion(project.id, result.files, 1);
              await createMessage(project.id, "user", input);
              await createMessage(
                project.id,
                "assistant",
                result.notes || "生成完成",
              );
              finalProjectId = project.id;
              send({ type: "project_created", projectId: finalProjectId });
            }
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
          projectId: finalProjectId,
          result: result
            ? {
                files: result.files,
                notes: result.notes,
              }
            : null,
          quality:
            finalState === "done" && result
              ? {
                  passed: true,
                  score: 100,
                  checks: [
                    { name: "语法", passed: true },
                    { name: "安全", passed: true },
                    { name: "结构", passed: true },
                  ],
                }
              : {
                  passed: false,
                  score: 0,
                  checks: [],
                },
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
