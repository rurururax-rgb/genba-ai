-- 見積サマリーに諸経費・端数値引を追加
-- misc_expense_override : NULL = 小計×8%の自動計算、数値 = 手動上書き値
-- rounding_discount     : 端数値引（常に手動入力、小計から差し引く）

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS misc_expense_override NUMERIC,
  ADD COLUMN IF NOT EXISTS rounding_discount     NUMERIC NOT NULL DEFAULT 0;

COMMENT ON COLUMN projects.misc_expense_override IS '諸経費（NULL=小計×8%自動計算、数値=手動上書き）';
COMMENT ON COLUMN projects.rounding_discount     IS '端数値引（小計から差し引く値、デフォルト0）';
