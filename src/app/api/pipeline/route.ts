import { NextRequest } from "next/server";
import { runPipeline } from "@/lib/agent";
import { createLLMExecutors } from "@/lib/agent/llm-executors";
import { createProject } from "@/lib/db/projects";
import { createVersion } from "@/lib/db/versions";
import { createMessage } from "@/lib/db/messages";
import { createAuthClient } from "@/lib/supabase/auth-server";

/**
 * POST /api/pipeline
 * 服务端 Agent 流水线入口
 *
 * 流程：
 * 1. 解析请求体（用户输入）
 * 2. 创建 LLM 执行器（服务端安全调用百炼 API）
 * 3. 运行流水线
 * 4. SSE 流式返回阶段事件
 *
 * TODO: 接入 Supabase Auth + 限流
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body?.input || typeof body.input !== "string") {
    return new Response(JSON.stringify({ error: "缺少 input 字段" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { input } = body;

  // TODO: 接入真实鉴权后启用
  // const user = await verifyUser(req);
  // if (!user) return new Response("Unauthorized", { status: 401 });
  // if (await isRateLimited(user.id)) return new Response("Too Many", { status: 429 });

  // 创建 SSE 流
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      try {
        const executors = createLLMExecutors();

        // approve 确认门：在当前实现中自动通过
        // TODO: 接入前端确认门后，改为等待用户确认
        const approver = async () => {
          send({ type: "approve_needed", spec: null });
          // 当前 demo 阶段自动通过，后续接入前端确认
          return true;
        };

        send({ type: "start", input });

        const { events, finalState, result } = await runPipeline(
          input,
          executors,
          approver,
        );

        // 推送所有事件
        for (const event of events) {
          send({ type: "stage", ...event });
        }

        // 流水线成功后持久化：项目 + 版本 + 消息（任务 3）
        // 已登录用户关联 user_id；匿名调用仍可生成但不归属任何用户（demo 阶段）
        // TODO: 接入限流后改为强制登录
        let projectId: string | null = null;
        if (finalState === "done" && result) {
          try {
            const auth = await createAuthClient();
            const {
              data: { user },
            } = await auth.auth.getUser();
            const project = await createProject(input, user?.id);
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
