-- =====================================================================
-- KI-002 PR-4a: 適用前の読み取り専用確認 SQL（Supabase SQL Editor で 1 つずつ実行する）
--
-- ・SELECT・カタログ参照・SHOW だけ。書き込み・DDL・関数の作成は一切しない。
--   念のため ⓪ の BEGIN READ ONLY の中で実行してもよい（最後に ROLLBACK）。
-- ・行の中身（名前・金額・メモ）は出さない。件数と定義だけを出す。
-- ・本番への接続・実行は、人間が別途承認してから人間が行う。
-- ・期待値は docs/db/ki-002-pr4a-group-project-match.md の「適用前の確認」を参照。
-- =====================================================================

-- ⓪（任意）読み取り専用トランザクションで囲む。①〜⑧ を流した後に ROLLBACK; を実行する
-- BEGIN READ ONLY;

-- ① PostgreSQL のバージョン（ON DELETE SET NULL (列) は 15 以上が必要）
SHOW server_version;

-- ② migration 履歴（20261014000001 = 記録あり、20261015000001 = 記録なし であること）
SELECT v.version,
       EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations m WHERE m.version = v.version) AS recorded
FROM (VALUES ('20261013000002'), ('20261014000001'), ('20261015000001')) AS v(version)
ORDER BY v.version;

-- ③ 列の型・NULL 可否（参照元の project_id は NOT NULL であること）
SELECT c.table_name, c.column_name, c.data_type, c.is_nullable = 'YES' AS nullable
FROM information_schema.columns c
WHERE c.table_schema = 'public'
  AND (c.table_name, c.column_name) IN (
    ('estimate_groups', 'id'), ('estimate_groups', 'project_id'), ('estimate_groups', 'company_id'),
    ('estimate_items', 'group_id'), ('estimate_items', 'project_id'),
    ('schedule_items', 'estimate_group_id'), ('schedule_items', 'project_id'))
ORDER BY 1, 2;

-- ④ 既存の外部キー（工種の列 → estimate_groups）と、PR-4a の制約名が未使用であること
SELECT c.conrelid::regclass::text AS tbl, c.conname, c.contype, c.convalidated, pg_get_constraintdef(c.oid) AS definition
FROM pg_constraint c
WHERE c.connamespace = 'public'::regnamespace
  AND ((c.contype = 'f' AND c.confrelid = to_regclass('public.estimate_groups'))
       OR c.conname IN ('estimate_groups_id_project_id_key', 'estimate_items_group_project_fkey',
                        'schedule_items_estimate_group_project_fkey'))
ORDER BY 1, 2;

-- ⑤ データの食い違い（参照ごとに 1 行。blocking_* がすべて 0 であること。論理削除済みの行も数える）
SELECT 'R1 estimate_items.group_id' AS ref,
  count(*) AS with_ref,
  count(*) FILTER (WHERE g.id IS NULL) AS blocking_orphan,
  count(*) FILTER (WHERE g.id IS NOT NULL AND g.project_id IS NULL) AS blocking_target_null,
  count(*) FILTER (WHERE g.project_id <> x.project_id) AS blocking_mismatch,
  count(*) FILTER (WHERE x.deleted_at IS NULL AND g.deleted_at IS NOT NULL) AS info_live_to_deleted_group
FROM public.estimate_items x LEFT JOIN public.estimate_groups g ON g.id = x.group_id
WHERE x.group_id IS NOT NULL
UNION ALL
SELECT 'R2 schedule_items.estimate_group_id',
  count(*),
  count(*) FILTER (WHERE g.id IS NULL),
  count(*) FILTER (WHERE g.id IS NOT NULL AND g.project_id IS NULL),
  count(*) FILTER (WHERE g.project_id <> x.project_id),
  count(*) FILTER (WHERE x.deleted_at IS NULL AND g.deleted_at IS NOT NULL)
FROM public.schedule_items x LEFT JOIN public.estimate_groups g ON g.id = x.estimate_group_id
WHERE x.estimate_group_id IS NOT NULL;

-- ⑥ estimate_groups の内訳（project_id が NULL の工種は参照されていなければ影響なし）
SELECT count(*) AS total,
       count(*) FILTER (WHERE project_id IS NULL) AS project_null,
       count(*) FILTER (WHERE company_id IS NULL) AS company_null,
       count(*) FILTER (WHERE deleted_at IS NOT NULL) AS soft_deleted
FROM public.estimate_groups;

-- ⑦ RLS ポリシー（3 テーブル）。適用後にもう一度実行し、結果が同じであることを確かめる
SELECT tablename, policyname, cmd, roles::text, qual, with_check
FROM pg_policies
WHERE schemaname = 'public' AND tablename IN ('estimate_groups', 'estimate_items', 'schedule_items')
ORDER BY tablename, policyname;

-- ⑧ 適用の直前: 長く開いたままのトランザクション（あればロック待ちになりやすい。終わるまで適用を待つ）
SELECT pid, usename, application_name, state, now() - xact_start AS xact_age, left(query, 80) AS query
FROM pg_stat_activity
WHERE datname = current_database() AND xact_start IS NOT NULL AND pid <> pg_backend_pid()
  AND now() - xact_start > interval '30 seconds'
ORDER BY xact_start;

-- ROLLBACK;  -- ⓪ で BEGIN READ ONLY; を実行した場合
