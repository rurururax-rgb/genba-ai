-- ============================================================
-- 20260912000003_add_printed_at_to_invoice_documents.sql
--
-- 目的: invoice_documents.printed_at は API コードで参照されているが、
--       初期 Migration（20260827000002）に含まれていなかった。
--       リコンシリエーションとして ADD COLUMN IF NOT EXISTS で補完する。
--
-- 安全方針: ADD COLUMN IF NOT EXISTS のみ。破壊的変更なし。
-- ============================================================

ALTER TABLE invoice_documents
  ADD COLUMN IF NOT EXISTS printed_at TIMESTAMPTZ;
