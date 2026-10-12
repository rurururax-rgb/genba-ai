-- =====================================================================
-- KI-002 PR-3: 適用前の読み取り専用確認 SQL（Supabase SQL Editor で 1 つずつ実行する）
--
-- ・SELECT・カタログ参照・SHOW だけ。書き込み・DDL・関数の作成は一切しない。
--   念のため ⓪ の BEGIN READ ONLY の中で実行してもよい（最後に ROLLBACK）。
-- ・対象テーブルが無い・列が無い場合もエラーにせず、その行に「無い」と出す。
-- ・本番への接続・実行は、人間が別途承認してから人間が行う。
-- ・期待値は docs/db/ki-002-pr3-project-company-match.md の「適用前の確認」を参照。
-- =====================================================================

-- ⓪（任意）読み取り専用トランザクションで囲む。①〜⑧ を流した後に ROLLBACK; を実行する
-- BEGIN READ ONLY;

-- ① PostgreSQL のバージョン
SHOW server_version;

-- ② migration 履歴（20261013000002 = 1 行、20261014000001 = 0 行 であること）
SELECT v.version,
       EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations m WHERE m.version = v.version) AS recorded
FROM (VALUES ('20261013000001'), ('20261013000002'), ('20261014000001')) AS v(version)
ORDER BY v.version;

-- ③ 参照先: projects の一意制約 (id, company_id)（名前ではなく定義で探す。1 行あること）
--    と、20261013000002 の制約 4 つ（すべて convalidated = true）
SELECT c.conname, c.contype, c.convalidated, pg_get_constraintdef(c.oid) AS definition
FROM pg_constraint c
WHERE c.conrelid = to_regclass('public.projects') AND c.contype IN ('u', 'p')
  AND (SELECT array_agg(a.attname::text ORDER BY a.attname)
       FROM unnest(c.conkey) k(n) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n)
      = ARRAY['company_id', 'id']
UNION ALL
SELECT c.conname, c.contype, c.convalidated, pg_get_constraintdef(c.oid)
FROM pg_constraint c
WHERE c.connamespace = 'public'::regnamespace
  AND c.conname IN ('estimate_items_project_company_fkey', 'line_events_project_company_fkey', 'line_events_project_requires_company_check')
ORDER BY 1;

-- ④ 対象 12 テーブル: 列・既存の外部キー・データの食い違い（1 テーブル 1 行）
--    止まる条件: table_exists = false / 列の型が uuid でない / needs_check = false なのに company_id が NULL 可 /
--                project_fkeys の ON DELETE が expected_on_delete と違う / pr3_constraints が既にある /
--                mismatched・orphan・null_company のどれかが 1 以上
WITH t(tbl, expected_on_delete, needs_check) AS (VALUES
  ('ai_summaries',               'CASCADE',   false),
  ('cost_ledger_items',          'CASCADE',   true),
  ('estimate_documents',         'CASCADE',   false),
  ('estimate_groups',            'CASCADE',   true),
  ('invoice_documents',          'CASCADE',   true),
  ('line_event_notes',           'NO ACTION', false),
  ('project_billing_milestones', 'CASCADE',   true),
  ('project_files',              'CASCADE',   false),
  ('project_notes',              'CASCADE',   false),
  ('schedule_draft_adoptions',   'CASCADE',   true),
  ('schedule_items',             'CASCADE',   false),
  ('share_links',                'CASCADE',   false)
),
info AS (
  SELECT t.*, to_regclass(format('public.%I', t.tbl)) AS rel,
    (SELECT c.data_type || CASE WHEN c.is_nullable = 'NO' THEN ' NOT NULL' ELSE ' NULL' END
     FROM information_schema.columns c
     WHERE c.table_schema = 'public' AND c.table_name = t.tbl AND c.column_name = 'project_id') AS project_id_col,
    (SELECT c.data_type || CASE WHEN c.is_nullable = 'NO' THEN ' NOT NULL' ELSE ' NULL' END
     FROM information_schema.columns c
     WHERE c.table_schema = 'public' AND c.table_name = t.tbl AND c.column_name = 'company_id') AS company_id_col
  FROM t
),
x AS (
  SELECT info.*,
    CASE WHEN rel IS NOT NULL AND project_id_col IS NOT NULL AND company_id_col IS NOT NULL THEN
      query_to_xml(format(
        $q$SELECT count(*) AS total,
                  count(*) FILTER (WHERE x.project_id IS NULL) AS project_null,
                  count(*) FILTER (WHERE x.project_id IS NOT NULL AND x.company_id IS NOT NULL AND p.id IS NOT NULL
                                     AND p.company_id IS DISTINCT FROM x.company_id) AS mismatched,
                  count(*) FILTER (WHERE x.project_id IS NOT NULL AND p.id IS NULL) AS orphan,
                  count(*) FILTER (WHERE x.project_id IS NOT NULL AND x.company_id IS NULL) AS null_company
           FROM public.%I x LEFT JOIN public.projects p ON p.id = x.project_id$q$, tbl), false, true, '')
    END AS counts
  FROM info
)
SELECT
  tbl,
  rel IS NOT NULL AS table_exists,
  project_id_col,
  company_id_col,
  needs_check,
  expected_on_delete,
  (SELECT string_agg(format('%s(%s) ON DELETE %s%s', c.conname,
            (SELECT string_agg(a.attname::text, ',' ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(n, ord)
             JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n),
            CASE c.confdeltype WHEN 'c' THEN 'CASCADE' WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT'
                               WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' END,
            CASE WHEN c.convalidated THEN '' ELSE ' NOT VALID' END), '; ' ORDER BY c.conname)
   FROM pg_constraint c
   WHERE c.conrelid = x.rel AND c.contype = 'f' AND c.confrelid = to_regclass('public.projects')) AS project_fkeys,
  (SELECT string_agg(c.conname, ', ' ORDER BY c.conname) FROM pg_constraint c
   WHERE c.conrelid = x.rel
     AND c.conname IN (tbl || '_project_company_fkey', tbl || '_project_requires_company_check')) AS pr3_constraints,
  (xpath('/row/total/text()', counts))[1]::text::bigint        AS total_rows,
  (xpath('/row/project_null/text()', counts))[1]::text::bigint AS project_null_rows,
  (xpath('/row/mismatched/text()', counts))[1]::text::bigint   AS mismatched,
  (xpath('/row/orphan/text()', counts))[1]::text::bigint       AS orphan,
  (xpath('/row/null_company/text()', counts))[1]::text::bigint AS null_company
FROM x
ORDER BY tbl;

-- ⑤ 対象 12 テーブルの制約・インデックス（project_id を先頭に含むインデックスの有無。性能の参考）
SELECT c.conrelid::regclass::text AS tbl, 'constraint' AS kind, c.conname AS name, pg_get_constraintdef(c.oid) AS definition
FROM pg_constraint c
WHERE c.connamespace = 'public'::regnamespace
  AND c.conrelid::regclass::text IN ('ai_summaries', 'cost_ledger_items', 'estimate_documents', 'estimate_groups',
    'invoice_documents', 'line_event_notes', 'project_billing_milestones', 'project_files', 'project_notes',
    'schedule_draft_adoptions', 'schedule_items', 'share_links')
UNION ALL
SELECT i.tablename, 'index', i.indexname, i.indexdef
FROM pg_indexes i
WHERE i.schemaname = 'public'
  AND i.tablename IN ('ai_summaries', 'cost_ledger_items', 'estimate_documents', 'estimate_groups',
    'invoice_documents', 'line_event_notes', 'project_billing_milestones', 'project_files', 'project_notes',
    'schedule_draft_adoptions', 'schedule_items', 'share_links')
ORDER BY 1, 2, 3;

-- ⑥ 対象外の 2 テーブル（estimate_revisions / cost_ledger_invoices）の定義の調査（今回は制約を追加しない）
--    列・制約・RLS ポリシー・行数と、company_id 列があれば食い違いの件数
WITH t(tbl) AS (VALUES ('estimate_revisions'), ('cost_ledger_invoices')),
info AS (
  SELECT t.tbl, to_regclass(format('public.%I', t.tbl)) AS rel,
    EXISTS (SELECT 1 FROM information_schema.columns c
            WHERE c.table_schema = 'public' AND c.table_name = t.tbl AND c.column_name = 'project_id') AS has_project,
    EXISTS (SELECT 1 FROM information_schema.columns c
            WHERE c.table_schema = 'public' AND c.table_name = t.tbl AND c.column_name = 'company_id') AS has_company
  FROM t
)
SELECT
  tbl,
  rel IS NOT NULL AS table_exists,
  (SELECT string_agg(format('%s %s%s', c.column_name, c.data_type, CASE WHEN c.is_nullable = 'NO' THEN ' NOT NULL' ELSE '' END),
                     ', ' ORDER BY c.ordinal_position)
   FROM information_schema.columns c WHERE c.table_schema = 'public' AND c.table_name = info.tbl) AS columns,
  (SELECT string_agg(format('%s: %s', c.conname, pg_get_constraintdef(c.oid)), '; ' ORDER BY c.conname)
   FROM pg_constraint c WHERE c.conrelid = info.rel) AS constraints,
  (SELECT string_agg(format('%s [%s] USING (%s) WITH CHECK (%s)', p.policyname, p.cmd, p.qual, p.with_check), '; ' ORDER BY p.policyname)
   FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = info.tbl) AS policies,
  CASE WHEN rel IS NOT NULL THEN
    (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', tbl), false, true, '')))[1]::text::bigint
  END AS total_rows,
  CASE WHEN rel IS NOT NULL AND has_project AND has_company THEN
    (xpath('/row/n/text()', query_to_xml(format(
      $q$SELECT count(*) AS n FROM public.%I x JOIN public.projects p ON p.id = x.project_id
         WHERE x.company_id IS DISTINCT FROM p.company_id$q$, tbl), false, true, '')))[1]::text::bigint
  END AS mismatched_or_null_company
FROM info
ORDER BY tbl;

-- ⑦ RLS ポリシー（対象 12 テーブル + projects）。適用後にもう一度実行し、結果が同じであることを確かめる
SELECT tablename, policyname, cmd, roles::text, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('projects', 'ai_summaries', 'cost_ledger_items', 'estimate_documents', 'estimate_groups',
    'invoice_documents', 'line_event_notes', 'project_billing_milestones', 'project_files', 'project_notes',
    'schedule_draft_adoptions', 'schedule_items', 'share_links')
ORDER BY tablename, policyname;

-- ⑧ 適用の直前: 長く開いたままのトランザクション（あればロック待ちになりやすい。終わるまで適用を待つ）
SELECT pid, usename, application_name, state, now() - xact_start AS xact_age, left(query, 80) AS query
FROM pg_stat_activity
WHERE datname = current_database() AND xact_start IS NOT NULL AND pid <> pg_backend_pid()
  AND now() - xact_start > interval '30 seconds'
ORDER BY xact_start;

-- ROLLBACK;  -- ⓪ で BEGIN READ ONLY; を実行した場合
