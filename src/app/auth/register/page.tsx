"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { getSupabaseBrowser } from "@/lib/supabase/client";

const MAX_USERS = 20;

export default function RegisterPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [userCount, setUserCount] = useState<number | null>(null);

  useEffect(() => {
    fetch("/api/users/count")
      .then((r) => r.json())
      .then((d) => setUserCount(d.count ?? 0))
      .catch(() => setUserCount(0));
  }, []);

  const isFull = userCount !== null && userCount >= MAX_USERS;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isFull) {
      setError("注册名额已满，请稍后重试。");
      return;
    }
    setLoading(true);
    setError(null);
    setNotice(null);
    const { data, error } = await getSupabaseBrowser().auth.signUp({
      email,
      password,
    });
    setLoading(false);
    if (error) {
      setError(error.message);
    } else if (data.session) {
      router.push("/");
    } else {
      setNotice("注册成功，请先到邮箱完成验证后再登录。");
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <form
        onSubmit={submit}
        className="flex w-full max-w-sm flex-col gap-4 rounded-xl border border-[#e5e5e5] bg-white p-6 shadow-sm dark:border-neutral-700 dark:bg-neutral-900"
      >
        <h1 className="text-xl font-bold">注册 mini-atoms</h1>

        {userCount !== null && (
          <div className="rounded-lg bg-neutral-100 px-3 py-2 text-xs text-[#525252] dark:bg-neutral-800">
            当前注册人数：{userCount} / {MAX_USERS}
            {isFull && (
              <span className="ml-1 font-semibold text-red-600">（已满）</span>
            )}
          </div>
        )}

        <input
          type="email"
          required
          disabled={isFull}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="邮箱"
          className="rounded-lg border border-[#e5e5e5] bg-transparent px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-neutral-200 disabled:opacity-40 dark:border-neutral-700"
        />
        <input
          type="password"
          required
          disabled={isFull}
          minLength={6}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="密码（至少 6 位）"
          className="rounded-lg border border-[#e5e5e5] bg-transparent px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-neutral-200 disabled:opacity-40 dark:border-neutral-700"
        />
        {error && <p className="text-xs text-red-600">{error}</p>}
        {notice && <p className="text-xs text-green-600">{notice}</p>}
        <button
          type="submit"
          disabled={loading || isFull}
          className="rounded-lg bg-neutral-900 px-4 py-2 text-sm text-white transition-colors hover:bg-neutral-700 disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900"
        >
          {loading ? "注册中…" : isFull ? "名额已满" : "注册"}
        </button>
        <p className="text-center text-xs text-[#a3a3a3]">
          已有账号？
          <Link href="/auth/login" className="text-blue-600 underline">
            去登录
          </Link>
        </p>
      </form>
    </main>
  );
}
