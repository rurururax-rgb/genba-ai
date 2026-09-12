-- 20260913000001_extend_schedule_items.sql
--
-- 工程表 Phase 1: schedule_items テーブルの拡張
--
-- 既存カラム（変更なし）:
--   id, project_id, company_id, name, start_date, end_date,
--   assignee, memo, sort_order, source, created_at, updated_at, deleted_at
--
-- 追加カラム:
--   category         TEXT  : 工種（大工/電気/設備/クロス等）
--   vendor_name      TEXT  : 業者名
--   status           TEXT  : 工程状態（planned/confirmed/in_progress/done/delayed）
--   estimate_group_id UUID : 見積グループとの紐付け（Phase 2 AI工程案生成に備えた構造）

ALTER TABLE schedule_items
  ADD COLUMN IF NOT EXISTS category          TEXT,
  ADD COLUMN IF NOT EXISTS vendor_name       TEXT,
  ADD COLUMN IF NOT EXISTS status            TEXT NOT NULL DEFAULT 'planned',
  ADD COLUMN IF NOT EXISTS estimate_group_id UUID REFERENCES estimate_groups(id) ON DELETE SET NULL;

-- インデックス（工程一覧取得高速化）
CREATE INDEX IF NOT EXISTS idx_schedule_items_project
  ON schedule_items (project_id, sort_order)
  WHERE deleted_at IS NULL;
