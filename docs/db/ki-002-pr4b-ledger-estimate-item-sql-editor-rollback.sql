-- =====================================================================
-- KI-002 PR-4b: 原価台帳の見積行を同じ案件に限る制約のロールバックスクリプト（Supabase SQL Editor 専用・手動実行）
--
-- ・人間の承認後にだけ実行する。
-- ・20261016000001 で追加した複合外部キー 1 つ・一意制約 1 つと、migration 履歴（20261016000001 の 1 行）だけを
--   1 トランザクションで削除する。外部キーを先に消してから、それが参照する一意制約を消す。
-- ・既存の単独の外部キー（cost_ledger_items_estimate_item_id_fkey）・PR #35 / PR-3 / PR-4a の制約・
--   テーブル・列・業務データ・RLS・権限・トリガーには触れない。
-- ・ロールバック後は、PostgREST・service_role から他の案件の見積行を指す直接 INSERT / UPDATE が再び通る状態に戻る
--   （API の cost-ledger/init・sync は同じ案件の見積行しか使わないので、アプリの動きは変わらない）。
-- ・PR-4a（20261015000001）・PR-3（20261014000001）もロールバックする場合は、このスクリプトを先に実行する
--   （依存はないが、新しい順に戻す）。
-- ・途中で失敗したら何も変わらない（エラーが出たら `ROLLBACK;` だけを実行してから状況を確認する）。
-- ・履歴を消した後も supabase/migrations/20261016000001_*.sql が main に残っていると、
--   CLI からは「未適用」に見える。ファイルも revert する。
-- =====================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $guard$
BEGIN
  IF to_regclass('supabase_migrations.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'ledger-item-project-1 rollback aborted: supabase_migrations.schema_migrations not found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261016000001')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND conname IN (
    'estimate_items_id_project_id_key',
    'cost_ledger_items_estimate_item_project_fkey'
  )) THEN
    RAISE EXCEPTION 'ledger-item-project-1 rollback aborted: nothing to roll back (no history row, no constraints)';
  END IF;
END
$guard$;

-- ── 1. 複合外部キーの削除 ──
ALTER TABLE public.cost_ledger_items DROP CONSTRAINT IF EXISTS cost_ledger_items_estimate_item_project_fkey;

-- ── 2. 参照先の一意制約の削除（外部キーを消した後） ──
ALTER TABLE public.estimate_items DROP CONSTRAINT IF EXISTS estimate_items_id_project_id_key;

-- ── 3. migration 履歴の削除（この 1 行だけ） ──
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261016000001';

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ── 4. 最終照合（読み取りのみ。期待値: history_rows = 0, constraints = 0, prior_constraints = 21） ──
SELECT
  (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '20261016000001') AS history_rows,
  (SELECT count(*) FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND conname IN (
    'estimate_items_id_project_id_key',
    'cost_ledger_items_estimate_item_project_fkey'
  )) AS constraints,
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
  )) AS prior_constraints;
