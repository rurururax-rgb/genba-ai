-- ============================================================
-- cost_ledger_invoices 二重登録防止の識別情報（P1-1 / DB 土台のみ）
--
-- 目的:
--   業者請求書の OCR 登録で、同じ請求書の二重登録により実績原価（actual_cost）が
--   二重計上されるのを DB の一意制約で防ぐ。アプリ側の対応は後続 PR で行う。
--
-- 追加する列（すべて NULL 許容・既存行は NULL のまま。backfill しない）:
--   source           … 'ocr' | 'manual' | NULL（NULL = この migration 以前の既存行）
--   vendor_name      … OCR で読み取った業者名（比較表示用。一意性には使わない）
--   invoice_number   … OCR で読み取った請求書番号（疑い判定用。業者ごとに重なりうるため一意にしない）
--   document_sha256  … 請求書画像の SHA-256（小文字16進64文字）。OCR 登録のみ
--   idempotency_key  … 1回の登録操作ごとのキー（同一送信の再試行では同じ値を使う）
--
-- 一意制約:
--   ① 同じ案件に同じ画像の OCR 登録は1件まで（同じ案件の別の台帳項目への登録も拒否）。
--      別案件への同じ画像は許可。按分（1枚の請求書を複数項目へ）は OCR では扱わない。
--   ② idempotency_key は全体で一意（同一送信の再送・連打・同時送信を1行にする）。
--
-- 限界（この制約だけでは防げないもの）:
--   ・再スキャン・撮り直し・形式変換など、画像のバイト列が違えば別ハッシュになる
--   ・手動登録（source = 'manual'）・既存行（source IS NULL）は ① の対象外
--   ・別案件に誤って登録した同じ請求書
--   ・project_id と親 cost_ledger_items.project_id の一致は CHECK では保証できない
--     （CHECK は他テーブルを参照できない）。後続 API が親台帳項目から project_id を取得して保存する
--
-- RLS: 既存ポリシー（親 cost_ledger_items と company_members による会社所属確認）は変更しない。
-- 既存データ: DELETE / UPDATE / TRUNCATE なし。既存行は新しい列が NULL のため、
--   CHECK はすべて満たし、部分一意インデックスの対象にもならない。
-- ============================================================

ALTER TABLE cost_ledger_invoices
  ADD COLUMN IF NOT EXISTS source          TEXT,
  ADD COLUMN IF NOT EXISTS vendor_name     TEXT,
  ADD COLUMN IF NOT EXISTS invoice_number  TEXT,
  ADD COLUMN IF NOT EXISTS document_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS idempotency_key UUID;

-- source は既知の値か NULL（既存行）のみ
ALTER TABLE cost_ledger_invoices
  ADD CONSTRAINT cost_ledger_invoices_source_check
  CHECK (source IS NULL OR source IN ('ocr', 'manual'));

-- OCR 登録は一意制約に必要な値をすべて持つ（欠落で ① をすり抜けさせない）
ALTER TABLE cost_ledger_invoices
  ADD CONSTRAINT cost_ledger_invoices_ocr_keys_check
  CHECK (
    source IS DISTINCT FROM 'ocr'
    OR (project_id IS NOT NULL AND document_sha256 IS NOT NULL AND idempotency_key IS NOT NULL)
  );

-- 画像ハッシュは OCR 登録だけが持つ（source を変えて ① をすり抜けさせない）。
-- source = 'ocr' だと source IS NULL のとき NULL（= CHECK 通過）になるため IS NOT DISTINCT FROM を使う
ALTER TABLE cost_ledger_invoices
  ADD CONSTRAINT cost_ledger_invoices_sha256_source_check
  CHECK (document_sha256 IS NULL OR source IS NOT DISTINCT FROM 'ocr');

-- 大文字・空白などの表記違いで ① をすり抜けさせない
ALTER TABLE cost_ledger_invoices
  ADD CONSTRAINT cost_ledger_invoices_sha256_format_check
  CHECK (document_sha256 IS NULL OR document_sha256 ~ '^[0-9a-f]{64}$');

-- ① 同じ案件に同じ画像の OCR 登録は1件まで
CREATE UNIQUE INDEX IF NOT EXISTS cost_ledger_invoices_project_sha256_ocr_uq
  ON cost_ledger_invoices (project_id, document_sha256)
  WHERE source = 'ocr' AND project_id IS NOT NULL AND document_sha256 IS NOT NULL;

-- ② 同一送信の再送は1行まで
CREATE UNIQUE INDEX IF NOT EXISTS cost_ledger_invoices_idempotency_key_uq
  ON cost_ledger_invoices (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

COMMENT ON COLUMN cost_ledger_invoices.source IS
  '登録元: ocr | manual。NULL はこの列の追加前に登録された行（登録元不明）';
COMMENT ON COLUMN cost_ledger_invoices.vendor_name IS
  'OCR で読み取った業者名（重複候補の比較表示用。一意性には使わない）';
COMMENT ON COLUMN cost_ledger_invoices.invoice_number IS
  'OCR で読み取った請求書番号（重複の疑い判定用。業者ごとに重なりうるため一意にしない）';
COMMENT ON COLUMN cost_ledger_invoices.document_sha256 IS
  '請求書画像の SHA-256（小文字16進64文字）。OCR 登録のみ。同じ案件では一意';
COMMENT ON COLUMN cost_ledger_invoices.idempotency_key IS
  '登録操作ごとのキー。同一送信の再試行では同じ値を使う。全体で一意';
