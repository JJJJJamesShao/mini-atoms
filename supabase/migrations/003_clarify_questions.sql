-- mini-atoms 澄清问题清单（feat/clarify-guidance）
-- 在 Supabase Dashboard → SQL Editor 执行；幂等可重复执行
-- 背景：need_clarification 软着陆——模型想确认的问题随版本落库（string[]），
-- 刷新后引导卡片仍可完整回放。

alter table if exists public.versions
  add column if not exists questions jsonb;  -- 待用户补充的澄清问题清单（string[]，need_input 版本专有）
