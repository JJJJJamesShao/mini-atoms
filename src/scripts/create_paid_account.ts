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

  if (error) {
    if (error.message.includes("User already registered")) {
      console.log("账号已存在，跳过创建");
      return;
    }
    throw error;
  }

  await setUserRole(data.user.id, "paid");
  const role = await getUserRole(data.user.id);
  if (role !== "paid") throw new Error(`角色校验失败: ${role}`);
  console.log(`paid 账号创建成功: ${email}（角色已验证为 paid）`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
