-- =====================================================================
-- KI-002 PR-3: 適用後の確認 SQL（読み取り専用・Supabase SQL Editor で実行する）
--
-- ・SELECT・カタログ参照だけ。書き込み・DDL は一切しない。
-- ・期待値: 12 行すべて ok = true（fkey が VALID・ON DELETE が想定どおり・CHECK が必要なテーブルだけにある）、
--   最後の行（_summary）で history_recorded = true・ki001_constraints = 4。
-- ・ロールバック後に実行すると、12 行すべて fkey / check が NULL・ok = false、history_recorded = false になる。
-- =====================================================================

WITH t(tbl, expected_on_delete, needs_check) AS (VALUES
  ('ai_summaries',               'c'::"char", false),
  ('cost_ledger_items',          'c', true),
  ('estimate_documents',         'c', false),
  ('estimate_groups',            'c', true),
  ('invoice_documents',          'c', true),
  ('line_event_notes',           'a', false),
  ('project_billing_milestones', 'c', true),
  ('project_files',              'c', false),
  ('project_notes',              'c', false),
  ('schedule_draft_adoptions',   'c', true),
  ('schedule_items',             'c', false),
  ('share_links',                'c', false)
),
r AS (
  SELECT f.*,
    (SELECT c FROM pg_constraint c
     WHERE c.conrelid = to_regclass(format('public.%I', f.tbl)) AND c.conname = f.tbl || '_project_company_fkey') AS fk,
    (SELECT c FROM pg_constraint c
     WHERE c.conrelid = to_regclass(format('public.%I', f.tbl)) AND c.conname = f.tbl || '_project_requires_company_check') AS ck
  FROM t f
)
SELECT
  tbl,
  CASE WHEN (fk).oid IS NOT NULL THEN pg_get_constraintdef((fk).oid) END AS fkey,
  (fk).convalidated AS fkey_valid,
  CASE WHEN (ck).oid IS NOT NULL THEN pg_get_constraintdef((ck).oid) END AS "check",
  (ck).convalidated AS check_valid,
  coalesce(
    (fk).convalidated AND (fk).contype = 'f' AND (fk).confdeltype = expected_on_delete
    AND (fk).confrelid = to_regclass('public.projects')
    AND pg_get_constraintdef((fk).oid) LIKE 'FOREIGN KEY (project_id, company_id) REFERENCES projects(id, company_id)%'
    AND CASE WHEN needs_check
             THEN (ck).convalidated AND pg_get_constraintdef((ck).oid) = 'CHECK (((project_id IS NULL) OR (company_id IS NOT NULL)))'
             ELSE (ck).oid IS NULL END,
    false) AS ok,
  NULL::boolean AS history_recorded,
  NULL::bigint AS ki001_constraints
FROM r
UNION ALL
SELECT '_summary', NULL, NULL, NULL, NULL, NULL,
  EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261014000001'),
  (SELECT count(*) FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND convalidated AND conname IN
     ('projects_id_company_id_key', 'estimate_items_project_company_fkey', 'line_events_project_company_fkey', 'line_events_project_requires_company_check'))
ORDER BY 1;
