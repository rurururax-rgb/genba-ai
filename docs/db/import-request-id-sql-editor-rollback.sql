-- 見積書 OCR 取り込みの登録 ID のロールバック（制約 → 列の順に削除する）
-- 明細の行は消さない（import_request_id の値だけが無くなる）。
-- アプリは列が無くても登録できる（登録 ID なしの従来の登録になる）ので、アプリを戻さずに実行してよい。
-- ただし列を消すと、再送による二重登録の防止は効かなくなる（画面側の照合だけになる）。
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE estimate_items DROP CONSTRAINT IF EXISTS estimate_items_company_import_request_key;
ALTER TABLE estimate_items DROP COLUMN IF EXISTS import_request_id;
COMMIT;
