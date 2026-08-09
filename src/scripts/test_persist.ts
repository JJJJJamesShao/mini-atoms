import { config } from "dotenv";
config({ path: ".env.local" });
import { createProject } from "../lib/db/projects";
import { createVersion } from "../lib/db/versions";
import { createMessage } from "../lib/db/messages";
import { getSupabase } from "../lib/supabase/server";

/** 任务 3 调试用：模拟 route.ts 的持久化调用序列 */
async function main() {
  const html =
    "<!DOCTYPE html><html><body><h1>t</h1><script>console.log(1)</script></body></html>";

  const project = await createProject("做一个待办清单");
  console.log("project ok:", project.id);
  try {
    const v = await createVersion(
      project.id,
      [{ path: "index.html", content: html }],
      1,
    );
    console.log("version ok:", v.id);
  } catch (e) {
    console.log("version FAIL:", JSON.stringify(e));
  }
  try {
    const m1 = await createMessage(project.id, "user", "做一个待办清单");
    console.log("message user ok:", m1.id);
  } catch (e) {
    console.log("message user FAIL:", JSON.stringify(e));
  }
  try {
    const m2 = await createMessage(project.id, "assistant", "生成完成");
    console.log("message assistant ok:", m2.id);
  } catch (e) {
    console.log("message assistant FAIL:", JSON.stringify(e));
  }
  await getSupabase().from("projects").delete().eq("id", project.id);
  console.log("cleaned up");
}

main().catch((e) => {
  console.error("project FAIL:", JSON.stringify(e));
  process.exit(1);
});
