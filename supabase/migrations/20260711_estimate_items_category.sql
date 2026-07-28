-- estimate_items に category（工種）カラムを追加
-- CLAUDE.md: カラム追加はOK・削除禁止
ALTER TABLE estimate_items
  ADD COLUMN IF NOT EXISTS category TEXT;
