-- mini-atoms 核心持久化三表（docs/spec.md §6 数据模型）
-- 在 Supabase Dashboard → SQL Editor 执行，先于 001_rbac.sql
-- 注意：现有库的三表为手动创建，本文件用于 fresh 环境复现；幂等可重复执行

-- 1. 项目
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id),
  title text not null,
  created_at timestamptz not null default now()
);

-- 2. 版本（files 为 jsonb 文件列表：[{path, content}, ...]）
create table if not exists public.versions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  files jsonb not null,
  version_no int not null,
  is_snapshot boolean not null default false,
  snapshot_name text,
  created_at timestamptz not null default now()
);

create index if not exists versions_project_idx on public.versions (project_id, version_no);

-- 3. 对话消息
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null,
  created_at timestamptz not null default now()
);

create index if not exists messages_project_idx on public.messages (project_id, created_at);

-- 4. RLS：读操作只走服务端 service role（绕过 RLS），默认拒绝客户端直读
alter table public.projects enable row level security;
alter table public.versions enable row level security;
alter table public.messages enable row level security;
