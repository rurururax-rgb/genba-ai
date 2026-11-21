-- ============================================================
-- estimate_items 見積書 OCR 取り込みの二重登録防止（登録 ID）
--
-- 目的:
--   見積書 OCR の明細を見積へ登録するとき、通信が途切れて応答だけが届かず、再送で二重に登録されるのを
--   DB の一意制約で防ぐ。取り込み候補 1 行ごとに画面が登録 ID（UUID）を作り、再送では同じ ID を送る。
--   登録 API（/api/estimate-items/import）は、同じ ID が登録済みならその明細を返し、もう一度は入れない。
--
-- 追加する列（NULL 許容・既存行は NULL のまま。backfill しない）:
--   import_request_id … 取り込み候補 1 行の登録 ID。手入力・過去見積から追加・LINE などは NULL
--
-- 一意制約:
--   UNIQUE (company_id, import_request_id)
--   ・PostgreSQL の UNIQUE は NULL を互いに別の値として扱う（NULLS DISTINCT）ため、
--     既存行・NULL の行どうしは衝突しない
--   ・会社ごとの一意。他社の行とは衝突せず、他社に同じ ID があるかは分からない（RLS で他社の行は見えない）
--   ・同じ ID の同時登録は、後から来た INSERT が先の INSERT の確定を待ってから 23505（unique_violation）で失敗する
--
-- RLS: estimate_items の既存ポリシー（自社データのみ）がそのまま適用される。ポリシー・関数は追加しない。
-- 既存データ: DELETE / UPDATE / TRUNCATE なし。
-- ロック: ADD COLUMN（既定値なし）は表の書き換えなし。ADD CONSTRAINT UNIQUE は一意インデックスを作る間、
--   estimate_items への書き込みを止める（行数に比例。適用前の確認 SQL で行数を確かめる）。
-- ロールバック: docs/db/import-request-id-sql-editor-rollback.sql（制約 → 列の順に削除）
-- ============================================================

ALTER TABLE estimate_items
  ADD COLUMN IF NOT EXISTS import_request_id UUID;

ALTER TABLE estimate_items
  ADD CONSTRAINT estimate_items_company_import_request_key
  UNIQUE (company_id, import_request_id);

COMMENT ON COLUMN estimate_items.import_request_id IS
  '見積書 OCR 取り込み候補 1 行の登録 ID。再送で同じ ID を送り、同じ会社で 1 行だけにする（UNIQUE (company_id, import_request_id)）。取り込み以外は NULL';
