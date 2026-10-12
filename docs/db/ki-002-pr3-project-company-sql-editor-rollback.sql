-- =====================================================================
-- KI-002 PR-3: 案件と会社の一致（12 テーブル）のロールバックスクリプト（Supabase SQL Editor 専用・手動実行）
--
-- ・人間の承認後にだけ実行する。
-- ・20261014000001 で追加した複合外部キー 12 個・CHECK 5 個と、migration 履歴（20261014000001 の 1 行）だけを
--   1 トランザクションで削除する。
-- ・projects の UNIQUE (id, company_id) と estimate_items / line_events の制約（20261013000002）は消さない。
--   テーブル・列・業務データ・RLS・権限・既存の単独の外部キーにも触れない。
-- ・20261013000002 もロールバックする場合は、必ずこのスクリプトを先に実行する
--   （順序を逆にすると、一意制約を参照する外部キーが残っているため 20261013000002 のロールバックがエラーで止まる）。
-- ・ロールバック後は、PostgREST・service_role から他社の案件 ID を指定した直接 INSERT / UPDATE が
--   この 12 テーブルで再び通る状態に戻る（API 側の確認 KI-002 PR-1 / PR-2 は残る）。
-- ・途中で失敗したら何も変わらない（エラーが出たら `ROLLBACK;` だけを実行してから状況を確認する）。
-- ・履歴を消した後も supabase/migrations/20261014000001_*.sql が main に残っていると、
--   CLI からは「未適用」に見える。ファイルも revert する。
-- =====================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $guard$
BEGIN
  IF to_regclass('supabase_migrations.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'project-company-2 rollback aborted: supabase_migrations.schema_migrations not found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261014000001')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND conname IN (
    'ai_summaries_project_company_fkey',
    'cost_ledger_items_project_company_fkey',
    'estimate_documents_project_company_fkey',
    'estimate_groups_project_company_fkey',
    'invoice_documents_project_company_fkey',
    'line_event_notes_project_company_fkey',
    'project_billing_milestones_project_company_fkey',
    'project_files_project_company_fkey',
    'project_notes_project_company_fkey',
    'schedule_draft_adoptions_project_company_fkey',
    'schedule_items_project_company_fkey',
    'share_links_project_company_fkey',
    'cost_ledger_items_project_requires_company_check',
    'estimate_groups_project_requires_company_check',
    'invoice_documents_project_requires_company_check',
    'project_billing_milestones_project_requires_company_check',
    'schedule_draft_adoptions_project_requires_company_check'
  )) THEN
    RAISE EXCEPTION 'project-company-2 rollback aborted: nothing to roll back (no history row, no constraints)';
  END IF;
END
$guard$;

-- ── 1. 複合外部キーの削除 ──
ALTER TABLE public.ai_summaries DROP CONSTRAINT IF EXISTS ai_summaries_project_company_fkey;
ALTER TABLE public.cost_ledger_items DROP CONSTRAINT IF EXISTS cost_ledger_items_project_company_fkey;
ALTER TABLE public.estimate_documents DROP CONSTRAINT IF EXISTS estimate_documents_project_company_fkey;
ALTER TABLE public.estimate_groups DROP CONSTRAINT IF EXISTS estimate_groups_project_company_fkey;
ALTER TABLE public.invoice_documents DROP CONSTRAINT IF EXISTS invoice_documents_project_company_fkey;
ALTER TABLE public.line_event_notes DROP CONSTRAINT IF EXISTS line_event_notes_project_company_fkey;
ALTER TABLE public.project_billing_milestones DROP CONSTRAINT IF EXISTS project_billing_milestones_project_company_fkey;
ALTER TABLE public.project_files DROP CONSTRAINT IF EXISTS project_files_project_company_fkey;
ALTER TABLE public.project_notes DROP CONSTRAINT IF EXISTS project_notes_project_company_fkey;
ALTER TABLE public.schedule_draft_adoptions DROP CONSTRAINT IF EXISTS schedule_draft_adoptions_project_company_fkey;
ALTER TABLE public.schedule_items DROP CONSTRAINT IF EXISTS schedule_items_project_company_fkey;
ALTER TABLE public.share_links DROP CONSTRAINT IF EXISTS share_links_project_company_fkey;

-- ── 2. CHECK の削除 ──
ALTER TABLE public.cost_ledger_items DROP CONSTRAINT IF EXISTS cost_ledger_items_project_requires_company_check;
ALTER TABLE public.estimate_groups DROP CONSTRAINT IF EXISTS estimate_groups_project_requires_company_check;
ALTER TABLE public.invoice_documents DROP CONSTRAINT IF EXISTS invoice_documents_project_requires_company_check;
ALTER TABLE public.project_billing_milestones DROP CONSTRAINT IF EXISTS project_billing_milestones_project_requires_company_check;
ALTER TABLE public.schedule_draft_adoptions DROP CONSTRAINT IF EXISTS schedule_draft_adoptions_project_requires_company_check;

-- ── 3. migration 履歴の削除（この 1 行だけ） ──
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261014000001';

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ── 4. 最終照合（読み取りのみ。期待値: history_rows = 0, constraints = 0, ki001_constraints = 4） ──
SELECT
  (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '20261014000001') AS history_rows,
  (SELECT count(*) FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND conname IN (
    'ai_summaries_project_company_fkey',
    'cost_ledger_items_project_company_fkey',
    'estimate_documents_project_company_fkey',
    'estimate_groups_project_company_fkey',
    'invoice_documents_project_company_fkey',
    'line_event_notes_project_company_fkey',
    'project_billing_milestones_project_company_fkey',
    'project_files_project_company_fkey',
    'project_notes_project_company_fkey',
    'schedule_draft_adoptions_project_company_fkey',
    'schedule_items_project_company_fkey',
    'share_links_project_company_fkey',
    'cost_ledger_items_project_requires_company_check',
    'estimate_groups_project_requires_company_check',
    'invoice_documents_project_requires_company_check',
    'project_billing_milestones_project_requires_company_check',
    'schedule_draft_adoptions_project_requires_company_check'
  )) AS constraints,
  (SELECT count(*) FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND conname IN
     ('projects_id_company_id_key', 'estimate_items_project_company_fkey', 'line_events_project_company_fkey', 'line_events_project_requires_company_check')) AS ki001_constraints;
