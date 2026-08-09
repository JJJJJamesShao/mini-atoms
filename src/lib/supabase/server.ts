import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;

/** 懒加载服务端 Supabase 客户端 — 构建时不检查环境变量，只在运行时检查（service role，仅服务端使用） */
export function getSupabase(): SupabaseClient {
  if (cached) return cached;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    throw new Error(
      "Missing SUPABASE_URL or SUPABASE_SECRET_KEY in environment",
    );
  }
  cached = createClient(url, key);
  return cached;
}
