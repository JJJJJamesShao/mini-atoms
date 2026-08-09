-- mini-atoms RBAC + 限流基建
-- 在 Supabase Dashboard → SQL Editor 执行本文件
-- 内容：profiles（角色）+ 新用户自动 free 触发器 + usage（用量记录）+ RLS

-- 1. profiles 表：账号角色（free / paid）
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'free' check (role in ('free', 'paid')),
  created_at timestamptz not null default now()
);

-- 2. 新注册用户自动创建 free 角色记录
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, role) values (new.id, 'free');
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 3. 触发器只对之后注册的用户生效，为存量用户补建 free 记录
insert into public.profiles (id, role)
select id, 'free' from auth.users
on conflict (id) do nothing;

-- 4. usage 表：LLM 生成用量记录（限流与审计依据）
create table if not exists public.usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  action text not null,
  created_at timestamptz not null default now()
);

create index if not exists usage_user_time_idx on public.usage (user_id, created_at);

-- 5. RLS：用户只能读自己的记录；写操作只走服务端 service role（绕过 RLS）
alter table public.profiles enable row level security;
alter table public.usage enable row level security;

drop policy if exists "用户可读自己的 profile" on public.profiles;
create policy "用户可读自己的 profile" on public.profiles
  for select using (auth.uid() = id);

drop policy if exists "用户可读自己的用量" on public.usage;
create policy "用户可读自己的用量" on public.usage
  for select using (auth.uid() = user_id);
