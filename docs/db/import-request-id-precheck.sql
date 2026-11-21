-- 見積書 OCR 取り込みの登録 ID（estimate_items.import_request_id）適用前の確認（読み取り専用）
-- SQL Editor で実行する。何も書き込まない。

-- ① 列・制約がまだ無いこと（あれば適用済み。もう一度は適用しない）
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'estimate_items' AND column_name = 'import_request_id';
SELECT conname, pg_get_constraintdef(oid) AS def
  FROM pg_constraint
 WHERE conrelid = 'public.estimate_items'::regclass AND conname = 'estimate_items_company_import_request_key';

-- ② 行数と表の大きさ（UNIQUE の一意インデックスを作る間、estimate_items への書き込みが止まる時間の目安）
SELECT count(*) AS rows, pg_size_pretty(pg_total_relation_size('public.estimate_items')) AS total_size FROM public.estimate_items;

-- ③ company_id が NULL の行（UNIQUE (company_id, import_request_id) は NULL を別の値として扱うので衝突しないが、件数を控える）
SELECT count(*) AS company_id_null FROM public.estimate_items WHERE company_id IS NULL;

-- ④ estimate_items の RLS とポリシー（変更しない。適用後も同じであること）
SELECT relrowsecurity FROM pg_class WHERE oid = 'public.estimate_items'::regclass;
SELECT policyname, cmd, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = 'estimate_items';

-- ⑤ estimate_items のトリガー（変更しない。適用後も同じであること）
SELECT tgname, pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid = 'public.estimate_items'::regclass AND NOT tgisinternal ORDER BY tgname;

-- ⑥ 長く続いているトランザクション（あれば適用を待つ。ロック待ちで画面の保存が止まらないように）
SELECT pid, state, now() - xact_start AS xact_age, left(query, 80) AS query
  FROM pg_stat_activity WHERE xact_start IS NOT NULL AND now() - xact_start > interval '30 seconds' ORDER BY xact_start;
