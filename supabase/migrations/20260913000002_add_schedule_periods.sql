-- 20260913000002_add_schedule_periods.sql
--
-- 工程表 Phase 1.5: AM/PM 時間帯カラムの追加
--
-- 既存行は start_period='am', end_period='pm' をデフォルトとして使用

ALTER TABLE schedule_items
  ADD COLUMN IF NOT EXISTS start_period TEXT NOT NULL DEFAULT 'am',
  ADD COLUMN IF NOT EXISTS end_period   TEXT NOT NULL DEFAULT 'pm';

-- 入力値制約（am / pm のみ許可）
ALTER TABLE schedule_items
  ADD CONSTRAINT IF NOT EXISTS schedule_items_start_period_check CHECK (start_period IN ('am', 'pm')),
  ADD CONSTRAINT IF NOT EXISTS schedule_items_end_period_check   CHECK (end_period   IN ('am', 'pm'));
