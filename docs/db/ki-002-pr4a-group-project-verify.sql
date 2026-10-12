-- =====================================================================
-- KI-002 PR-4a: 適用後の確認 SQL（読み取り専用・Supabase SQL Editor で実行する）
--
-- ・SELECT・カタログ参照だけ。書き込み・DDL は一切しない。
-- ・期待値: 3 行すべて ok = true（VALID・定義が想定どおり）、最後の行（_summary）で
--   history_recorded = true・single_fkeys = 2（既存の単独の外部キーが残る）・prior_constraints = 21（PR #35・PR-3）・
--   blocking_rows = 0（他の案件の工種を指す行が無い）。
-- ・ロールバック後に実行すると、3 行すべて definition が NULL・ok = false、history_recorded = false になる。
-- =====================================================================

WITH t(tbl, conname, expected) AS (VALUES
  ('estimate_groups', 'estimate_groups_id_project_id_key', 'UNIQUE (id, project_id)'),
  ('estimate_items',  'estimate_items_group_project_fkey',
   'FOREIGN KEY (group_id, project_id) REFERENCES estimate_groups(id, project_id) ON DELETE SET NULL (group_id)'),
  ('schedule_items',  'schedule_items_estimate_group_project_fkey',
   'FOREIGN KEY (estimate_group_id, project_id) REFERENCES estimate_groups(id, project_id) ON DELETE SET NULL (estimate_group_id)')
),
r AS (
  SELECT t.*, c.oid AS con_oid, c.convalidated
  FROM t LEFT JOIN pg_constraint c
    ON c.conrelid = to_regclass(format('public.%I', t.tbl)) AND c.conname = t.conname
)
SELECT
  conname AS name,
  CASE WHEN con_oid IS NOT NULL THEN pg_get_constraintdef(con_oid) END AS definition,
  convalidated AS valid,
  coalesce(convalidated AND pg_get_constraintdef(con_oid) = expected, false) AS ok,
  NULL::boolean AS history_recorded,
  NULL::bigint AS single_fkeys,
  NULL::bigint AS prior_constraints,
  NULL::bigint AS blocking_rows
FROM r
UNION ALL
SELECT '_summary', NULL, NULL, NULL,
  EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261015000001'),
  (SELECT count(*) FROM pg_constraint c
   WHERE c.contype = 'f' AND c.confrelid = to_regclass('public.estimate_groups') AND c.confdeltype = 'n'
     AND cardinality(c.conkey) = 1 AND c.conrelid IN (to_regclass('public.estimate_items'), to_regclass('public.schedule_items'))),
  (SELECT count(*) FROM pg_constraint
   WHERE connamespace = 'public'::regnamespace AND convalidated AND conname IN (
    'projects_id_company_id_key', 'estimate_items_project_company_fkey', 'line_events_project_company_fkey',
    'line_events_project_requires_company_check',
    'ai_summaries_project_company_fkey', 'cost_ledger_items_project_company_fkey', 'estimate_documents_project_company_fkey',
    'estimate_groups_project_company_fkey', 'invoice_documents_project_company_fkey', 'line_event_notes_project_company_fkey',
    'project_billing_milestones_project_company_fkey', 'project_files_project_company_fkey', 'project_notes_project_company_fkey',
    'schedule_draft_adoptions_project_company_fkey', 'schedule_items_project_company_fkey', 'share_links_project_company_fkey',
    'cost_ledger_items_project_requires_company_check', 'estimate_groups_project_requires_company_check',
    'invoice_documents_project_requires_company_check', 'project_billing_milestones_project_requires_company_check',
    'schedule_draft_adoptions_project_requires_company_check'
  )),
  (SELECT count(*) FROM public.estimate_items x JOIN public.estimate_groups g ON g.id = x.group_id
   WHERE g.project_id IS DISTINCT FROM x.project_id)
  + (SELECT count(*) FROM public.schedule_items x JOIN public.estimate_groups g ON g.id = x.estimate_group_id
     WHERE g.project_id IS DISTINCT FROM x.project_id)
ORDER BY 1;
