-- 案件基本情報フィールド追加（御見積書の表紙項目）
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS person_in_charge      TEXT,
  ADD COLUMN IF NOT EXISTS construction_period   TEXT,
  ADD COLUMN IF NOT EXISTS payment_terms         TEXT,
  ADD COLUMN IF NOT EXISTS estimate_valid_from   DATE,
  ADD COLUMN IF NOT EXISTS estimate_valid_months INT  DEFAULT 1,
  ADD COLUMN IF NOT EXISTS construction_overview TEXT,
  ADD COLUMN IF NOT EXISTS project_memo          TEXT,
  ADD COLUMN IF NOT EXISTS payment_contract_pct  INT  DEFAULT 20,
  ADD COLUMN IF NOT EXISTS payment_start_pct     INT  DEFAULT 50,
  ADD COLUMN IF NOT EXISTS payment_completion_pct INT DEFAULT 30;
