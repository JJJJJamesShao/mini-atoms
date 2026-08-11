-- mini-atoms 多阶段 SOP 中间产物（feat/multistage-sop）
-- 在 Supabase Dashboard → SQL Editor 执行；幂等可重复执行
-- 背景：fullstack-app SOP 分阶段生成（schema/shell/pages），中间产物随版本
-- 落库用于排查 merge 问题与过程回放。nullable 冗余列，不影响存量行。

alter table if exists public.versions
  add column if not exists stage_outputs jsonb;  -- { "schema": "...", "shell": "...", "pages": "..." }
