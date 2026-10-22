-- =====================================================================
-- KI-002 PR-4b: 適用前の読み取り専用確認 SQL（Supabase SQL Editor で 1 つずつ実行する）
--
-- ・SELECT・カタログ参照・SHOW だけ。書き込み・DDL・関数の作成は一切しない。
--   念のため ⓪ の BEGIN READ ONLY の中で実行してもよい（最後に ROLLBACK）。
-- ・行の中身（名前・金額・メモ）は出さない。件数と定義だけを出す。
-- ・本番への接続・実行は、人間が別途承認してから人間が行う。
-- ・期待値は docs/db/ki-002-pr4b-ledger-estimate-item-match.md の「適用前の確認」を参照。
-- =====================================================================

-- ⓪（任意）読み取り専用トランザクションで囲む。①〜⑧ を流した後に ROLLBACK; を実行する
-- BEGIN READ ONLY;

-- ① PostgreSQL のバージョン（ON DELETE SET NULL (列) は 15 以上が必要）
SHOW server_version;

-- ② migration 履歴（20261014000001 = 記録あり、20261016000001 = 記録なし であること。20261015000001 は PR-4a で、どちらでもよい）
SELECT v.version,
       EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations m WHERE m.version = v.version) AS recorded
FROM (VALUES ('20261013000002'), ('20261014000001'), ('20261015000001'), ('20261016000001')) AS v(version)
ORDER BY v.version;

-- ③ 列の型・NULL 可否（参照元の project_id は NOT NULL であること）
SELECT c.table_name, c.column_name, c.data_type, c.is_nullable = 'YES' AS nullable
FROM information_schema.columns c
WHERE c.table_schema = 'public'
  AND (c.table_name, c.column_name) IN (
    ('estimate_items', 'id'), ('estimate_items', 'project_id'), ('estimate_items', 'company_id'),
    ('cost_ledger_items', 'estimate_item_id'), ('cost_ledger_items', 'project_id'), ('cost_ledger_items', 'company_id'))
ORDER BY 1, 2;

-- ④ 既存の外部キー（cost_ledger_items → estimate_items）・estimate_items の一意制約と、PR-4b の制約名が未使用であること
SELECT c.conrelid::regclass::text AS tbl, c.conname, c.contype, c.convalidated, pg_get_constraintdef(c.oid) AS definition
FROM pg_constraint c
WHERE c.connamespace = 'public'::regnamespace
  AND ((c.contype = 'f' AND c.conrelid = to_regclass('public.cost_ledger_items') AND c.confrelid = to_regclass('public.estimate_items'))
       OR (c.contype IN ('p', 'u') AND c.conrelid = to_regclass('public.estimate_items'))
       OR c.conname IN ('estimate_items_id_project_id_key', 'cost_ledger_items_estimate_item_project_fkey'))
ORDER BY 1, 2;

-- ⑤ データの食い違い（blocking_* がすべて 0 であること。論理削除済みの台帳行・見積行も数える）
SELECT 'R3 cost_ledger_items.estimate_item_id' AS ref,
  count(*) AS with_ref,
  count(*) FILTER (WHERE e.id IS NULL) AS blocking_orphan,
  count(*) FILTER (WHERE e.id IS NOT NULL AND e.project_id IS NULL) AS blocking_target_null,
  count(*) FILTER (WHERE e.project_id <> x.project_id) AS blocking_mismatch,
  count(*) FILTER (WHERE x.deleted_at IS NULL AND e.deleted_at IS NOT NULL) AS info_live_to_deleted_item,
  count(*) FILTER (WHERE x.deleted_at IS NOT NULL) AS info_deleted_ledger_rows
FROM public.cost_ledger_items x LEFT JOIN public.estimate_items e ON e.id = x.estimate_item_id
WHERE x.estimate_item_id IS NOT NULL;

-- ⑥ 行数（ロック時間の目安。estimate_items の一意制約の作成中は estimate_items の読み書きが止まる）
SELECT
  (SELECT count(*) FROM public.estimate_items) AS estimate_items_total,
  (SELECT count(*) FROM public.cost_ledger_items) AS cost_ledger_items_total,
  (SELECT count(*) FROM public.cost_ledger_items WHERE estimate_item_id IS NULL) AS ledger_without_estimate_item,
  pg_size_pretty(pg_total_relation_size('public.estimate_items')) AS estimate_items_size;

-- ⑦ RLS ポリシー・トリガー（2 テーブル）。適用後にもう一度実行し、結果が同じであることを確かめる
SELECT 'policy' AS kind, tablename AS tbl, policyname AS name, cmd || ' ' || roles::text AS detail, qual, with_check
FROM pg_policies
WHERE schemaname = 'public' AND tablename IN ('cost_ledger_items', 'estimate_items')
UNION ALL
SELECT 'trigger', tgrelid::regclass::text, tgname, 'enabled=' || tgenabled::text, NULL, NULL
FROM pg_trigger
WHERE NOT tgisinternal AND tgrelid IN (to_regclass('public.cost_ledger_items'), to_regclass('public.estimate_items'))
ORDER BY 1, 2, 3;

-- ⑧ 適用の直前: 長く開いたままのトランザクション（あればロック待ちになりやすい。終わるまで適用を待つ）
SELECT pid, usename, application_name, state, now() - xact_start AS xact_age, left(query, 80) AS query
FROM pg_stat_activity
WHERE datname = current_database() AND xact_start IS NOT NULL AND pid <> pg_backend_pid()
  AND now() - xact_start > interval '30 seconds'
ORDER BY xact_start;

-- ROLLBACK;  -- ⓪ で BEGIN READ ONLY; を実行した場合
