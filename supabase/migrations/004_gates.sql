-- mini-atoms 挂起门持久化（feat/gate-persistence）
-- 在 Supabase Dashboard → SQL Editor 执行；幂等可重复执行
-- 背景：approve 确认门此前只存在于单进程内存 Map，页面刷新/服务重启即丢。
-- 本迁移新建 gates 表：挂起时双写（DB + 内存），刷新后从 DB 重建"等待确认"UI。

create table if not exists public.gates (
  id uuid primary key default gen_random_uuid(),
  session_id text not null unique,
  project_id uuid references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id),
  type text not null check (type in ('approve', 'need_input')),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'expired')),
  payload jsonb,  -- { spec, input, baseVersionNo }：恢复 UI 所需的全部上下文
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  expires_at timestamptz not null default (now() + interval '30 minutes')
);

create index if not exists gates_session_idx on public.gates (session_id);
create index if not exists gates_user_idx on public.gates (user_id, status);
