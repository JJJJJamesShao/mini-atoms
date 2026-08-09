import { config } from "dotenv";
config({ path: ".env.local" });

import { describe, expect, it } from "vitest";
import { createProject, getProjects } from "../src/lib/db/projects";
import { createVersion, getVersions } from "../src/lib/db/versions";
import { createMessage, getMessages } from "../src/lib/db/messages";
import { getSupabase } from "../src/lib/supabase/server";

// 连接真实 Supabase 的集成测试：本地跑 verify.sh 需 .env.local 配好；
// CI 无密钥时自动跳过，保证流水线绿。
const hasEnv = Boolean(
  process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY,
);

describe.skipIf(!hasEnv)("数据库操作（真实 Supabase）", () => {
  it("创建并查询项目", async () => {
    const project = await createProject("测试项目");
    expect(project).toHaveProperty("id");
    expect(project.title).toBe("测试项目");

    const projects = await getProjects();
    expect(projects.some((p) => p.id === project.id)).toBe(true);

    await getSupabase().from("projects").delete().eq("id", project.id);
  });

  it("创建并查询版本", async () => {
    const project = await createProject("版本测试");
    const version = await createVersion(
      project.id,
      [{ path: "index.html", content: "<h1>Test</h1>" }],
      1,
    );
    expect(version).toHaveProperty("id");

    const versions = await getVersions(project.id);
    expect(versions).toHaveLength(1);

    await getSupabase().from("versions").delete().eq("id", version.id);
    await getSupabase().from("projects").delete().eq("id", project.id);
  });

  it("创建并查询消息", async () => {
    const project = await createProject("消息测试");
    const message = await createMessage(project.id, "user", "做一个计时器");
    expect(message).toHaveProperty("id");

    const messages = await getMessages(project.id);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("做一个计时器");

    await getSupabase().from("messages").delete().eq("id", message.id);
    await getSupabase().from("projects").delete().eq("id", project.id);
  });
});
