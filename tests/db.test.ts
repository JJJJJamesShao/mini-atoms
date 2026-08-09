import { config } from "dotenv";
config({ path: ".env.local" });

import { describe, expect, it } from "vitest";
import { createProject, getProjects } from "../src/lib/db/projects";
import { createVersion, getVersions } from "../src/lib/db/versions";
import { createMessage, getMessages } from "../src/lib/db/messages";
import { getUserRole, setUserRole } from "../src/lib/db/profiles";
import { countUsageToday, logUsage } from "../src/lib/db/usage";
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

describe.skipIf(!hasEnv)("RBAC 与限流（真实 Supabase）", () => {
  it("新用户默认 free / 用量记录 / 角色切换", async () => {
    const supabase = getSupabase();
    const email = `rbac-test-${Date.now()}@example.com`;
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password: "test-pass-123456",
      email_confirm: true,
    });
    if (error) throw error;
    const uid = data.user.id;

    try {
      // 触发器自动建 free profile（允许毫秒级延迟，轮询等待）
      let role: string | null = null;
      for (let i = 0; i < 10; i++) {
        role = await getUserRole(uid).catch(() => null);
        if (role) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      expect(role).toBe("free");

      // 免费额度 0：0 >= 0 即超限，应被门禁拒绝
      expect(await countUsageToday(uid, "generate")).toBe(0);

      // 用量记录真实写库
      await logUsage(uid, "generate");
      expect(await countUsageToday(uid, "generate")).toBe(1);

      // 角色可切换为 paid
      await setUserRole(uid, "paid");
      expect(await getUserRole(uid)).toBe("paid");
    } finally {
      await supabase.auth.admin.deleteUser(uid);
    }
  });
});
