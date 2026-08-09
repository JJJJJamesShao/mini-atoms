import { config } from "dotenv";
config({ path: ".env.local" });
import { getSupabase } from "../lib/supabase/server";
import { getUserRole, setUserRole } from "../lib/db/profiles";

/**
 * 预创建 paid 账号（如面试官账号）。
 * 用法：INTERVIEWER_EMAIL=xxx INTERVIEWER_PASSWORD=xxx npx tsx src/scripts/create_paid_account.ts
 * 注意：密码只通过环境变量传入，不要写进代码或提交。
 */
async function main() {
  const email = process.env.INTERVIEWER_EMAIL;
  const password = process.env.INTERVIEWER_PASSWORD;
  if (!email || !password) {
    throw new Error("需要 INTERVIEWER_EMAIL 与 INTERVIEWER_PASSWORD 环境变量");
  }

  const supabase = getSupabase();
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  let userId: string;
  if (error) {
    // GoTrue 已注册错误：code = "email_exists"（message 措辞随版本变化，不依赖）
    if ((error as { code?: string }).code !== "email_exists") throw error;
    // 账号已存在（如先经 /auth/register 注册）：查到 user id 后继续提权
    console.log("账号已存在，直接设置 paid 角色");
    const { data: list, error: listError } =
      await supabase.auth.admin.listUsers({ perPage: 1000 });
    if (listError) throw listError;
    const existing = list.users.find((u) => u.email === email);
    if (!existing) throw new Error(`已注册但按邮箱未找到用户: ${email}`);
    userId = existing.id;
  } else {
    userId = data.user.id;
  }

  await setUserRole(userId, "paid");
  const role = await getUserRole(userId);
  if (role !== "paid") throw new Error(`角色校验失败: ${role}`);
  console.log(`paid 账号就绪: ${email}（角色已验证为 paid）`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
