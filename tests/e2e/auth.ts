/**
 * E2E 测试账号与会话铸造。
 *
 * 流程：
 * 1. provision：service role 幂等创建 paid 测试账号（免费账号配额为 0，跑不了生成）
 * 2. 登录：anon key + 密码换取 session
 * 3. 铸造 cookie：按 @supabase/ssr 0.12 的存储格式手工编码——
 *    key = sb-<project-ref>-auth-token，value = "base64-" + base64url(JSON)，
 *    超过 3180 字符按 key.0 / key.1 分块（与 applyServerStorage 一致）。
 *    服务端 createAuthClient 只读 cookie，这是 Node 端黑箱过鉴权的唯一通道。
 *
 * 安全约束：账号邮箱/密码只从环境变量读取（E2E_TEST_EMAIL / E2E_TEST_PASSWORD），
 * 不得写死进代码——paid 角色不限量，泄露等于放开生成额度。
 */

import { createClient } from "@supabase/supabase-js";
import { getSupabase } from "../../src/lib/supabase/server";
import { setUserRole } from "../../src/lib/db/profiles";

/** 与 @supabase/ssr utils/chunker 的 MAX_CHUNK_SIZE 保持一致 */
const MAX_CHUNK_SIZE = 3180;
const BASE64_PREFIX = "base64-";

export interface E2EAuth {
  userId: string;
  email: string;
  /** 可直接拼进 Cookie 请求头的完整值 */
  cookieHeader: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `缺少环境变量 ${name}（E2E 测试账号凭证，写在 .env.local 即可）`,
    );
  }
  return value;
}

function base64UrlEncode(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64url");
}

/** 从 NEXT_PUBLIC_SUPABASE_URL 提取项目 ref：https://<ref>.supabase.co */
function projectRef(url: string): string {
  const host = new URL(url).hostname;
  const ref = host.split(".")[0];
  if (!ref) throw new Error(`无法从 SUPABASE_URL 解析项目 ref: ${url}`);
  return ref;
}

/** 按 @supabase/ssr 格式铸造会话 cookie（含分块） */
export function mintSessionCookie(
  supabaseUrl: string,
  session: unknown,
): string {
  const key = `sb-${projectRef(supabaseUrl)}-auth-token`;
  const encoded = BASE64_PREFIX + base64UrlEncode(JSON.stringify(session));
  const pairs: string[] = [];
  for (let i = 0; i * MAX_CHUNK_SIZE < encoded.length; i++) {
    const value = encoded.slice(i * MAX_CHUNK_SIZE, (i + 1) * MAX_CHUNK_SIZE);
    // 与 createChunks 一致：单块不分名，多块追加 .index
    const name = encoded.length > MAX_CHUNK_SIZE ? `${key}.${i}` : key;
    pairs.push(`${name}=${value}`);
  }
  return pairs.join("; ");
}

/** 幂等 provision paid 测试账号并登录，返回可用 Cookie 头 */
export async function provisionTestAuth(): Promise<E2EAuth> {
  const email = requireEnv("E2E_TEST_EMAIL");
  const password = requireEnv("E2E_TEST_PASSWORD");
  const anonUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");

  // 1. provision（幂等）：创建 + 提权 paid
  const admin = getSupabase();
  let userId: string;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) {
    if ((error as { code?: string }).code !== "email_exists") throw error;
    const { data: list, error: listError } = await admin.auth.admin.listUsers({
      perPage: 1000,
    });
    if (listError) throw listError;
    const existing = list.users.find((u) => u.email === email);
    if (!existing) throw new Error(`已注册但按邮箱未找到用户: ${email}`);
    userId = existing.id;
  } else {
    userId = data.user.id;
  }
  await setUserRole(userId, "paid");

  // 2. 密码登录换 session
  const anon = createClient(anonUrl, anonKey);
  const { data: signIn, error: signInError } =
    await anon.auth.signInWithPassword({ email, password });
  if (signInError) {
    throw new Error(`测试账号登录失败: ${signInError.message}`);
  }

  return {
    userId,
    email,
    cookieHeader: mintSessionCookie(anonUrl, signIn.session),
  };
}
