/**
 * E2E 串行 runner — 黑箱流程测试入口。
 *
 * 用法：
 *   1. .env.local 配置 E2E_TEST_EMAIL / E2E_TEST_PASSWORD（测试账号凭证，
 *      账号由 runner 自动幂等 provision 为 paid）
 *   2. npm run test:e2e
 *      - 默认自起 `next dev`（端口 E2E_PORT，默认 3123），跑完自动关停；
 *      - 已有运行中的服务时：E2E_BASE_URL=http://localhost:3000 npm run test:e2e
 *
 * 注意：本套件调用真实 LLM（每次运行约 3 次完整生成，数分钟 + 真实费用）
 * 与真实 Supabase（创建的测试项目跑完自动清理）。它是合入前的手动闸门，
 * 不进 verify.sh / CI。
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getSupabase } from "../../src/lib/supabase/server";
import { provisionTestAuth } from "./auth";
import { AssertError, TASKS, type E2EContext } from "./tasks";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const BASE_URL =
  process.env.E2E_BASE_URL ??
  `http://localhost:${process.env.E2E_PORT ?? 3123}`;
const SERVER_READY_TIMEOUT_MS = 120_000;

/** 等待被测服务就绪（任何 HTTP 响应即视为就绪，编译预热由首个请求承担） */
async function waitForServer(url: string): Promise<void> {
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  for (;;) {
    try {
      await fetch(`${url}/auth/login`, { redirect: "manual" });
      return;
    } catch {
      if (Date.now() > deadline) {
        throw new Error(
          `被测服务 ${url} 在 ${SERVER_READY_TIMEOUT_MS / 1000}s 内未就绪`,
        );
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

function spawnDevServer(): ChildProcess {
  const port = new URL(BASE_URL).port || "3123";
  console.log(`启动被测服务：next dev -p ${port}（日志静默，失败时回显）`);
  const child = spawn("npx", ["next", "dev", "-p", port], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logBuf = "";
  child.stdout?.on("data", (d) => (logBuf += String(d)));
  child.stderr?.on("data", (d) => (logBuf += String(d)));
  child.on("exit", (code) => {
    if (code !== null && code !== 0 && code !== 143) {
      console.error(
        `被测服务异常退出（code ${code}），最近日志：\n${logBuf.slice(-2000)}`,
      );
    }
  });
  return child;
}

/** 清理运行期间创建的测试项目（versions/messages/gates 级联删除） */
async function cleanupProjects(projectIds: string[]): Promise<void> {
  if (projectIds.length === 0) return;
  const { error } = await getSupabase()
    .from("projects")
    .delete()
    .in("id", projectIds);
  if (error) {
    console.warn(`⚠ 测试项目清理失败（需手动删除）：${error.message}`);
    console.warn(`  项目 id：${projectIds.join(", ")}`);
    return;
  }
  console.log(`已清理 ${projectIds.length} 个测试项目`);
}

interface TaskOutcome {
  name: string;
  result: "pass" | "fail" | "skip";
  detail?: string;
  durationMs: number;
}

async function main(): Promise<void> {
  console.log("=== mini-atoms E2E 黑箱流程测试 ===");
  console.log(`目标服务：${BASE_URL}`);
  console.log("任务串行执行（依赖链：后续任务复用前序产物）\n");

  // 1. 测试账号（幂等 provision paid）
  const auth = await provisionTestAuth();
  console.log(`测试账号就绪：${auth.email}`);

  // 2. 被测服务
  let server: ChildProcess | null = null;
  if (!process.env.E2E_BASE_URL) {
    server = spawnDevServer();
  }
  const stopServer = () => {
    if (server && !server.killed) server.kill("SIGTERM");
  };
  process.on("exit", stopServer);
  process.on("SIGINT", () => {
    stopServer();
    process.exit(130);
  });

  const ctx: E2EContext = {
    baseUrl: BASE_URL,
    cookie: auth.cookieHeader,
    userId: auth.userId,
    createdProjectIds: [],
  };
  const outcomes: TaskOutcome[] = [];

  try {
    await waitForServer(BASE_URL);
    console.log("服务就绪，开始执行任务\n");

    // 3. 串行执行任务（hard 失败中断依赖链，后续记 skip）
    let chainBroken = false;
    for (const task of TASKS) {
      if (chainBroken) {
        outcomes.push({ name: task.name, result: "skip", durationMs: 0 });
        console.log(`○ ${task.name} —— 跳过（前置任务失败）`);
        continue;
      }
      console.log(`● ${task.name}`);
      const startedAt = Date.now();
      try {
        await task.run(ctx);
        const durationMs = Date.now() - startedAt;
        outcomes.push({ name: task.name, result: "pass", durationMs });
        console.log(`✔ 通过（${Math.round(durationMs / 1000)}s）\n`);
      } catch (err) {
        const durationMs = Date.now() - startedAt;
        const message = err instanceof Error ? err.message : String(err);
        if (task.severity === "soft") {
          outcomes.push({
            name: task.name,
            result: "pass",
            detail: `soft 警告：${message}`,
            durationMs,
          });
          console.log(`⚠ soft 警告（不判负）：${message}\n`);
        } else {
          outcomes.push({
            name: task.name,
            result: "fail",
            detail: message,
            durationMs,
          });
          console.log(`✘ 失败：${message}\n`);
          chainBroken = true;
        }
      }
    }
  } finally {
    // 4. 清理测试数据 + 关停服务
    await cleanupProjects(ctx.createdProjectIds).catch((e) =>
      console.warn("清理异常：", e),
    );
    stopServer();
  }

  // 5. 汇总
  console.log("=== 汇总 ===");
  for (const o of outcomes) {
    const icon = o.result === "pass" ? "✔" : o.result === "fail" ? "✘" : "○";
    const secs = o.durationMs ? `（${Math.round(o.durationMs / 1000)}s）` : "";
    console.log(
      `${icon} ${o.name} ${secs}${o.detail ? ` —— ${o.detail}` : ""}`,
    );
  }
  const failed = outcomes.filter((o) => o.result === "fail");
  if (failed.length > 0) {
    console.error(`\n${failed.length} 个任务失败`);
    process.exit(1);
  }
  console.log("\n全部通过");
  process.exit(0);
}

main().catch((err) => {
  if (err instanceof AssertError) {
    console.error("断言失败：", err.message);
  } else {
    console.error("E2E runner 异常：", err);
  }
  process.exit(1);
});
