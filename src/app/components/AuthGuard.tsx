"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { getSupabaseBrowser } from "@/lib/supabase/client";

/**
 * 客户端路由保护：未登录重定向到 /auth/login。
 * TODO: supabase-js 的 session 存 localStorage，middleware 无法读取；
 * 后续接入 @supabase/ssr 后将保护下沉到 middleware。
 */
export default function AuthGuard({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [authed, setAuthed] = useState(false);

  useEffect(() => {
    getSupabaseBrowser()
      .auth.getSession()
      .then(({ data }) => {
        if (data.session) setAuthed(true);
        else router.replace("/auth/login");
      })
      .catch(() => router.replace("/auth/login"));
  }, [router]);

  if (!authed) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-[#a3a3a3]">
        正在验证登录状态…
      </div>
    );
  }
  return <>{children}</>;
}
