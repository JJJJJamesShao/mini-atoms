import { NextRequest } from "next/server";
import { createLLMExecutors } from "@/lib/agent/llm-executors";
import { AgentEventBus } from "@/lib/agent/bus";
import { runSOP } from "@/lib/agent/engine";
import { selectSOP } from "@/lib/agent/router";
import { createRoles } from "@/lib/agent/role";
import type { File, SpecOutput } from "@/lib/schemas";

/** 强制 Node.js runtime：Edge Runtime 不支持 Buffer 和完整 Supabase 客户端 */
export const runtime = "nodejs";
import { createProject, getProject } from "@/lib/db/projects";
import { createVersion, getVersions } from "@/lib/db/versions";
import type { ProcessData, ProcessLog, StageState } from "@/lib/db/versions";
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

/** 失败原因 → 用户可读文案（与前端 useWorkspace.failReasonText 保持一致） */
function failReasonText(reason: string | null): string {
  switch (reason) {
    case "spec_rejected":
      return "规格被拒绝，请重新描述需求。";
    case "need_clarification":
      return "还需要你补充几点信息，流程已暂停等待你（见问题清单）。";
    default:
      return "生成校验多次未通过，请换个描述重试。";
  }
}

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

  const { input, projectId, currentFiles, baseVersionNo } = body as {
    input: string;
    projectId?: string;
    currentFiles?: File[];
    /** 分叉基准：本次基于哪个 version_no 的代码修改（首版缺省） */
    baseVersionNo?: number;
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

  // 2. 迭代模式：校验项目归属，防止携带他人 projectId 写入（写型 IDOR）
  //    user_id 为 null 的是历史演示数据，沿用 projects API 的既有约定放行
  if (projectId) {
    let owner: string | null;
    try {
      const project = await getProject(projectId);
      owner = project.user_id;
    } catch {
      return jsonError(404, {
        error: "project_not_found",
        message: "项目不存在",
      });
    }
    if (owner && owner !== user.id) {
      return jsonError(403, {
        error: "forbidden",
        message: "无权修改该项目",
      });
    }
  }

  // 3. 角色与额度
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

  // 4. 记用量
  await logUsage(user.id, "generate");

  // 创建 SSE 流 + Agent EventBus
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      // 最近一次发送真实数据的时间（心跳以此为基准，只在静默期发）
      let lastActivity = Date.now();
      const send = (data: unknown) => {
        lastActivity = Date.now();
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      // SSE 心跳：Cloudflare(100s)/Nginx(60s)/Vercel Edge(30s) 等中间代理按
      // "无数据传输"断开长连接，LLM 思考期（clarify/spec 非流式调用、approve 挂起）
      // 必须主动保活。15s 一跳，仅在静默期发送，避免冗余流量。
      const HEARTBEAT_INTERVAL = 15000;
      const heartbeatTimer = setInterval(() => {
        if (Date.now() - lastActivity >= HEARTBEAT_INTERVAL) {
          try {
            send({ type: "heartbeat", timestamp: Date.now() });
          } catch {
            // 流已关闭，定时器随即在 finally 清理
          }
        }
      }, HEARTBEAT_INTERVAL);

      // 创建独立的 Agent 事件总线
      const bus = new AgentEventBus();

      // 过程数据收集器：从 bus 事件聚合阶段终态与执行日志，随版本行落库，
      // 使刷新后可完整回放 workflow（客户在意开发过程的细节执行）
      const processLogs: ProcessLog[] = [];
      const stageStates = new Map<string, StageState>();
      let capturedSpec: SpecOutput | null = null;
      let logSeq = 0;
      const pushProcessLog = (
        stage: string,
        phase: ProcessLog["phase"],
        detail?: string,
      ) => {
        processLogs.push({
          seq: ++logSeq,
          stage,
          phase,
          detail,
          timestamp: Date.now(),
        });
      };

      // 全局订阅：所有 Agent 事件实时推送到前端 + 聚合为过程数据。
      // send 必须包 try/catch：页面刷新后 SSE 流已取消，裸 send 抛错会被 bus
      // 捕获并跳过本处理器后续的聚合逻辑，导致续跑运行的过程数据全部丢失。
      bus.subscribeAll((event) => {
        try {
          send({ type: "agent_event", payload: event });
        } catch {
          // 断流：推送丢失可接受，聚合必须继续
        }

        const stage = event.agent;
        switch (event.type) {
          case "agent:start":
            stageStates.set(stage, {
              stage,
              status: "active",
              detail: event.role,
            });
            pushProcessLog(stage, "start", event.role);
            break;
          case "agent:complete": {
            // verify 未通过时阶段记为 failed（与前端 useWorkspace 的判定一致）
            const out = event.output as { pass?: boolean } | undefined;
            const status =
              stage === "verify" && out?.pass === false ? "failed" : "done";
            stageStates.set(stage, {
              stage,
              status,
              detail: event.message,
            });
            pushProcessLog(stage, "end", event.message);
            break;
          }
          case "agent:thinking":
          case "agent:progress":
          case "agent:summary":
            pushProcessLog(
              stage,
              "progress",
              event.message ??
                (event.percent ? `进度 ${event.percent}%` : undefined),
            );
            break;
          case "agent:error":
            stageStates.set(stage, {
              stage,
              status: "failed",
              detail: event.error ?? event.message,
            });
            pushProcessLog(stage, "progress", event.error ?? event.message);
            break;
          case "file:generated": {
            const f = event.output as
              { path?: string; size?: number } | undefined;
            pushProcessLog(
              stage,
              "progress",
              `📄 ${f?.path ?? "文件"}（${f?.size ?? 0} 字符）`,
            );
            break;
          }
        }
      });

      // 供 catch（异常路径）落库使用的提升声明：正常路径在 try 内赋值
      let sopId = "unknown";
      let displaySteps: string[] = [];
      // 落库幂等防护：persistRun 之后的 send 在断流时抛错会落入外层 catch，
      // 若无防护会对同一运行二次落库（重复项目/版本/消息）
      let persistAttempted = false;

      /**
       * 落库一次运行（done/fail/error 三路径共用）。成功与失败都写版本行——
       * 失败过程对客户同样有信任价值。返回最终项目 id（落库失败时由调用方捕获）。
       * 内部的 send 仅作通知，断流不影响落库结果，一律 try/catch 吞掉。
       */
      const persistRun = async (opts: {
        stages: StageState[];
        notes: string | null;
        questions: string[] | null;
        files: File[];
        assistantText: string;
      }): Promise<string | null> => {
        persistAttempted = true;
        const notify = (data: unknown) => {
          try {
            send(data);
          } catch {
            // 流已关闭：通知丢失可接受，落库已完成
          }
        };
        const process: ProcessData = {
          request: input,
          notes: opts.notes,
          spec: capturedSpec,
          sopId,
          stages: opts.stages,
          logs: processLogs,
          parentVersionNo: null, // 下方按项目实际情况填充
          questions: opts.questions,
        };
        if (projectId) {
          // 对话迭代：追加版本到现有项目
          const versions = await getVersions(projectId);
          const nextVersionNo = versions.length + 1;
          process.parentVersionNo =
            baseVersionNo ?? versions[versions.length - 1]?.version_no ?? null;
          await createVersion(projectId, opts.files, nextVersionNo, process);
          await createMessage(projectId, "user", input);
          await createMessage(projectId, "assistant", opts.assistantText);
          notify({
            type: "project_updated",
            projectId,
            versionNo: nextVersionNo,
          });
          return projectId;
        }
        // 首次生成：创建新项目
        const project = await createProject(input, user.id);
        await createVersion(project.id, opts.files, 1, process);
        await createMessage(project.id, "user", input);
        await createMessage(project.id, "assistant", opts.assistantText);
        notify({
          type: "project_created",
          projectId: project.id,
          versionNo: 1,
        });
        return project.id;
      };

      try {
        // SOP 路由：按输入关键词选择流程（game 精简流程跳过 approve）
        const sop = selectSOP(input);
        sopId = sop.id;

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
        // 双写 gates 表：刷新后前端可从 /api/gates/pending 重建等待确认 UI
        const sessionId = crypto.randomUUID();
        const approver = async (spec: SpecOutput) => {
          capturedSpec = spec; // 落库用：记录用户确认的规格
          send({ type: "approve_needed", sessionId, spec });
          return waitForApproval(sessionId, user.id, {
            projectId: projectId ?? null,
            payload: { spec, input, baseVersionNo: baseVersionNo ?? null },
          });
        };

        // 前端按 sop.steps 动态生成阶段卡片（fix 为内部步骤，不下发）
        displaySteps = sop.steps
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

        const { finalState, reason, result, questions } = await runSOP(
          input,
          sop,
          executors,
          approver,
          bus,
          roles,
          initialFiles,
        );

        // 流水线结束后持久化：成功与失败运行都落库（失败过程对客户同样有信任价值）
        let finalProjectId: string | null = null;
        if (finalState === "done" || finalState === "fail") {
          try {
            // 软着陆：澄清不足（need_clarification）不是失败——未执行的阶段保持
            // pending，只停在已执行的位置，等用户补充信息后继续（认知严重度一致）
            const isNeedInput =
              finalState === "fail" && reason === "need_clarification";
            // 阶段卡片终态：未触达/未收尾的阶段跟随流水线终态（与前端 finalizeStages 一致）
            const finalStageStatus =
              finalState === "done" ? ("done" as const) : ("failed" as const);
            const stages: StageState[] = displaySteps.map((name) => {
              const s = stageStates.get(name);
              if (isNeedInput) {
                return s ?? { stage: name, status: "pending" };
              }
              if (!s || s.status === "active" || s.status === "pending") {
                return {
                  stage: name,
                  status: finalStageStatus,
                  detail: s?.detail,
                };
              }
              return s;
            });
            const notes =
              result?.notes ?? (reason ? failReasonText(reason) : null);
            // 失败运行没有新产物：保留所基于的代码（首轮失败则为空文件列表）
            const files = result?.files ?? currentFiles ?? [];
            finalProjectId = await persistRun({
              stages,
              notes,
              questions: questions ?? null,
              files,
              assistantText:
                notes ?? (finalState === "done" ? "生成完成" : "生成失败"),
            });
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
          questions: questions ?? null,
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
        // 异常终止同样落库（与 done/fail 路径对齐）：出错节点标 failed，
        // 未触达的保持 pending，过程日志完整保留，刷新后可回放事故现场。
        // 幂等防护：正常路径已尝试落库（persistAttempted）时跳过，防止
        // persistRun 之后的 send 抛错导致同一运行二次落库。
        if (!persistAttempted) {
          try {
            const stages: StageState[] = displaySteps.map((name) => {
              const s = stageStates.get(name);
              if (!s) return { stage: name, status: "pending" };
              if (s.status === "active" || s.status === "pending") {
                return { ...s, status: "failed" };
              }
              return s;
            });
            await persistRun({
              stages,
              notes: `执行出错：${errorMsg}`,
              questions: null,
              // 异常中断没有新产物：保留所基于的代码
              files: currentFiles ?? [],
              assistantText: `执行出错：${errorMsg}`,
            });
          } catch (persistErr) {
            console.error("[Pipeline] 异常路径落库失败:", persistErr);
          }
        }
        try {
          send({
            type: "error",
            message: errorMsg,
          });
        } catch {
          // 流已断开：错误通知丢失可接受，落库已在上面完成
        }
      } finally {
        clearInterval(heartbeatTimer);
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
