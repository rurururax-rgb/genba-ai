-- =====================================================================
-- KI-002 PR-4b: 適用後の確認 SQL（読み取り専用・Supabase SQL Editor で実行する）
--
-- ・SELECT・カタログ参照だけ。書き込み・DDL は一切しない。
-- ・期待値: 2 行とも ok = true（VALID・定義が想定どおり）、最後の行（_summary）で
--   history_recorded = true・single_fkeys = 1（既存の単独の外部キーが残る）・prior_constraints = 21（PR #35・PR-3）・
--   blocking_rows = 0（他の案件の見積行を指す台帳行が無い）・lock_trigger_enabled が適用前と同じ（P1-3 適用済みなら true。PR-4b はトリガーに触れない）。
-- ・ロールバック後に実行すると、2 行とも definition が NULL・ok = false、history_recorded = false になる。
-- =====================================================================

WITH t(tbl, conname, expected) AS (VALUES
  ('estimate_items',    'estimate_items_id_project_id_key', 'UNIQUE (id, project_id)'),
  ('cost_ledger_items', 'cost_ledger_items_estimate_item_project_fkey',
   'FOREIGN KEY (estimate_item_id, project_id) REFERENCES estimate_items(id, project_id) ON DELETE SET NULL (estimate_item_id)')
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
  NULL::bigint AS blocking_rows,
  NULL::boolean AS lock_trigger_enabled
FROM r
UNION ALL
SELECT '_summary', NULL, NULL, NULL,
  EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261016000001'),
  (SELECT count(*) FROM pg_constraint c
   WHERE c.contype = 'f' AND c.confrelid = to_regclass('public.estimate_items') AND c.confdeltype = 'n'
     AND cardinality(c.conkey) = 1 AND c.conrelid = to_regclass('public.cost_ledger_items')),
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
  (SELECT count(*) FROM public.cost_ledger_items x JOIN public.estimate_items e ON e.id = x.estimate_item_id
   WHERE e.project_id IS DISTINCT FROM x.project_id),
  EXISTS (SELECT 1 FROM pg_trigger
          WHERE tgrelid = to_regclass('public.cost_ledger_items') AND tgname = 'cost_ledger_items_lock_actual_cost' AND tgenabled = 'O')
ORDER BY 1;
