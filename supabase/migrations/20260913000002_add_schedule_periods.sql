-- 20260913000002_add_schedule_periods.sql
--
-- 工程表 Phase 1.5: AM/PM 時間帯カラムの追加
--
-- 既存行は start_period='am', end_period='pm' をデフォルトとして使用
--
-- 注意: ADD CONSTRAINT IF NOT EXISTS は PostgreSQL 非対応のため
--       DO $$ ブロックで pg_constraint を事前チェックして安全に追加する

-- カラム追加（ADD COLUMN IF NOT EXISTS は PostgreSQL 9.6+ で有効）
ALTER TABLE schedule_items
  ADD COLUMN IF NOT EXISTS start_period TEXT NOT NULL DEFAULT 'am',
  ADD COLUMN IF NOT EXISTS end_period   TEXT NOT NULL DEFAULT 'pm';

-- CHECK 制約を安全に追加（pg_constraint で存在確認してから追加）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'schedule_items_start_period_check'
      AND conrelid = 'schedule_items'::regclass
  ) THEN
    ALTER TABLE schedule_items
      ADD CONSTRAINT schedule_items_start_period_check
      CHECK (start_period IN ('am', 'pm'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'schedule_items_end_period_check'
      AND conrelid = 'schedule_items'::regclass
  ) THEN
    ALTER TABLE schedule_items
      ADD CONSTRAINT schedule_items_end_period_check
      CHECK (end_period IN ('am', 'pm'));
  END IF;
END $$;
