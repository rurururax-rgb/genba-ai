-- 資材マスター画面のために spec・url 列を追加
-- spec: 仕様・型番等の補足テキスト
-- url : 製品情報ページ URL（カタラボ等）

ALTER TABLE company_estimate_items
  ADD COLUMN IF NOT EXISTS spec TEXT,
  ADD COLUMN IF NOT EXISTS url  TEXT;

COMMENT ON COLUMN company_estimate_items.spec IS '仕様・型番など補足情報';
COMMENT ON COLUMN company_estimate_items.url  IS '製品情報ページURL（カタラボ等）';
