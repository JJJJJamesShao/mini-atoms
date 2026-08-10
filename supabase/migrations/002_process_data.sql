-- mini-atoms 过程数据持久化（feat/process-persistence）
-- 在 Supabase Dashboard → SQL Editor 执行；幂等可重复执行
-- 背景：流水线过程数据（阶段状态、执行日志、spec、SOP、分叉基准）此前只存在于
-- SSE 流与前端内存，刷新即丢。本迁移给 versions 表补齐 7 列，使每次运行
-- （含失败运行）的过程可完整回放。

alter table if exists public.versions
  add column if not exists request text,           -- 触发本版本的用户输入
  add column if not exists notes text,             -- 结果说明（成功产物 notes / 失败原因文案）
  add column if not exists spec jsonb,             -- approve 阶段确认的规格（SpecOutput）
  add column if not exists sop_id text,            -- 本次运行的 SOP 流程 id
  add column if not exists stages jsonb,           -- 阶段卡片终态 [{stage,status,detail}]
  add column if not exists logs jsonb,             -- 执行日志 [{seq,stage,phase,detail,timestamp}]
  add column if not exists parent_version_no int;  -- 分叉基准：本版本基于哪个 version_no 修改（首版为 null）
