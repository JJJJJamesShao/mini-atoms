import { config } from "dotenv";
config({ path: ".env.local" });

import { createLLMExecutors } from "../lib/agent/llm-executors";
import { runPipeline } from "../lib/agent";
import type { SpecOutput } from "../lib/schemas";
import * as fs from "fs";

/** 流水线事件 payload 的可能形状（按 state 不同取不同子集） */
interface EventPayload {
  summary?: string;
  spec?: SpecOutput;
  isRetry?: boolean;
  pass?: boolean;
  reason?: string;
  questions?: { question: string }[];
}

/**
 * 直接测试 LLM 生成质量（绕过 HTTP/Auth，纯测执行器）
 * 用法: npx tsx src/scripts/test_generate_direct.ts [需求描述]
 */

const input = process.argv[2] || "做一个待办清单";

async function main() {
  console.log(`=== 需求: ${input} ===\n`);

  const executors = createLLMExecutors();

  // approve 自动通过（模拟用户点了确认）
  const approver = async () => true;

  console.time("总耗时");
  const { events, finalState, result } = await runPipeline(
    input,
    executors,
    approver,
  );
  console.timeEnd("总耗时");

  // 打印阶段事件
  console.log("\n=== 流水线阶段 ===");
  for (const e of events) {
    const time = new Date(e.timestamp).toLocaleTimeString();
    const payload = e.payload as EventPayload;
    console.log(`  [${time}] ${e.state}`);
    if (e.state === "clarify" && payload?.summary) {
      console.log(`    → 摘要: ${payload.summary}`);
    }
    if (e.state === "spec") {
      const spec = payload?.spec;
      if (spec) {
        console.log(`    → 需求: ${spec.requirements?.length} 条`);
        console.log(`    → 约束: ${spec.constraints?.length} 条`);
      }
    }
    if (e.state === "generate") {
      if (payload?.isRetry) console.log(`    → 修复后重试`);
    }
    if (e.state === "verify") {
      console.log(`    → ${payload?.pass ? "通过" : "失败"}`);
    }
    if (e.state === "fail") {
      console.log(`    → 原因: ${payload?.reason}`);
      if (payload?.questions) {
        console.log(`    → 澄清问题:`);
        for (const q of payload.questions) {
          console.log(`      - ${q.question}`);
        }
      }
    }
  }

  console.log(`\n=== 最终状态: ${finalState} ===`);

  if (finalState === "done" && result) {
    const html = result.files[0].content;
    console.log(`HTML 长度: ${html.length} 字符`);
    console.log(`文件: ${result.files[0].path}`);
    console.log(`备注: ${result.notes}`);

    // 语法检查
    const hasDoctype = /^\s*<!DOCTYPE html>/i.test(html);
    const hasHtml = /<html/i.test(html);
    const hasScript = /<script>/i.test(html);
    const hasStyle = /<style>/i.test(html);

    console.log(`\n=== HTML 结构检查 ===`);
    console.log(`  DOCTYPE: ${hasDoctype ? "✅" : "❌"}`);
    console.log(`  <html>: ${hasHtml ? "✅" : "❌"}`);
    console.log(`  <script>: ${hasScript ? "✅" : "❌"}`);
    console.log(`  <style>: ${hasStyle ? "✅" : "❌"}`);

    // 保存到文件
    const filename = `/tmp/generated_${Date.now()}.html`;
    fs.writeFileSync(filename, html);
    console.log(`\n✅ 已保存: ${filename}`);
    console.log("请在浏览器打开验证交互功能");
  } else {
    console.log("\n❌ 生成未完成");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("❌ 错误:", err);
  process.exit(1);
});
