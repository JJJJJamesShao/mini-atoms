"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { getSupabaseBrowser } from "@/lib/supabase/client";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { error } = await getSupabaseBrowser().auth.signInWithPassword({
      email,
      password,
    });
    setLoading(false);
    if (error) {
      setError(error.message);
    } else {
      router.push("/projects");
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <form
        onSubmit={submit}
        className="flex w-full max-w-sm flex-col gap-4 rounded-xl border border-[#e5e5e5] bg-white p-6 shadow-sm dark:border-neutral-700 dark:bg-neutral-900"
      >
        <h1 className="text-xl font-bold">登录 mini-atoms</h1>
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="邮箱"
          className="rounded-lg border border-[#e5e5e5] bg-transparent px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-neutral-200 dark:border-neutral-700"
        />
        <input
          type="password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="密码"
          className="rounded-lg border border-[#e5e5e5] bg-transparent px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-neutral-200 dark:border-neutral-700"
        />
        {error && <p className="text-xs text-red-600">{error}</p>}
        <button
          type="submit"
          disabled={loading}
          className="rounded-lg bg-neutral-900 px-4 py-2 text-sm text-white transition-colors hover:bg-neutral-700 disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900"
        >
          {loading ? "登录中…" : "登录"}
        </button>
        <p className="text-center text-xs text-[#a3a3a3]">
          还没有账号？
          <Link href="/auth/register" className="text-blue-600 underline">
            去注册
          </Link>
        </p>
      </form>
    </main>
  );
}
