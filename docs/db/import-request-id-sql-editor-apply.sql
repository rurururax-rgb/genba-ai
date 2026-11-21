-- 見積書 OCR 取り込みの登録 ID（supabase/migrations/20261122000001_add_import_request_id_to_estimate_items.sql と同じ内容）
-- 人間の承認後に SQL Editor で実行する。先に import-request-id-precheck.sql を実行して確かめること。
-- 一意インデックスを作る間に長く待たないよう、ロック待ちは 5 秒で諦める（失敗したら何も変わらない。時間をおいてやり直す）
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE estimate_items
  ADD COLUMN IF NOT EXISTS import_request_id UUID;

ALTER TABLE estimate_items
  ADD CONSTRAINT estimate_items_company_import_request_key
  UNIQUE (company_id, import_request_id);

COMMENT ON COLUMN estimate_items.import_request_id IS
  '見積書 OCR 取り込み候補 1 行の登録 ID。再送で同じ ID を送り、同じ会社で 1 行だけにする（UNIQUE (company_id, import_request_id)）。取り込み以外は NULL';

COMMIT;
