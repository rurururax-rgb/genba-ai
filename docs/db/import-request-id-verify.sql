-- 見積書 OCR 取り込みの登録 ID 適用後の確認（読み取り専用）

-- ① 列（uuid・NULL 許容）と制約
SELECT column_name, data_type, is_nullable FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'estimate_items' AND column_name = 'import_request_id';
SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
 WHERE conrelid = 'public.estimate_items'::regclass AND conname = 'estimate_items_company_import_request_key';
-- 期待: UNIQUE (company_id, import_request_id)

-- ② 既存行は変わっていない（行数は適用前と同じ・すべて NULL）
SELECT count(*) AS rows, count(import_request_id) AS with_request_id FROM public.estimate_items;

-- ③ RLS・ポリシー・トリガーが適用前と同じ（precheck の ④⑤ と見比べる）
SELECT relrowsecurity FROM pg_class WHERE oid = 'public.estimate_items'::regclass;
SELECT policyname, cmd, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = 'estimate_items';
SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.estimate_items'::regclass AND NOT tgisinternal ORDER BY tgname;

-- ④ アプリ配信後: 同じ会社で同じ登録 ID が 2 行以上ないこと（制約があるので 0 行のはず）
SELECT company_id, import_request_id, count(*) FROM public.estimate_items
 WHERE import_request_id IS NOT NULL GROUP BY 1, 2 HAVING count(*) > 1;
