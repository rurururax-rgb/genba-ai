-- =====================================================================
-- KI-001 追加監査: 案件と会社の一致のロールバックスクリプト（Supabase SQL Editor 専用・手動実行）
--
-- ・人間の承認後にだけ実行する。
-- ・複合外部キー 2 つと projects の UNIQUE (id, company_id) を削除し、migration 履歴
--   （20261013000002 の 1 行）を削除する。これらを 1 トランザクションで行う。
-- ・テーブル・列・業務データ・RLS・既存の単独の外部キーには触れない。
-- ・ロールバック後は、PostgREST から他社の案件 ID を指定した直接 INSERT / UPDATE が再び通る状態に戻る。
-- ・途中で失敗したら何も変わらない（エラーが出たら `ROLLBACK;` だけを実行してから状況を確認する）。
-- ・履歴を消した後も supabase/migrations/20261013000002_*.sql が main に残っていると、
--   CLI からは「未適用」に見える。ファイルも revert する。
-- =====================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $guard$
BEGIN
  IF to_regclass('supabase_migrations.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'project-company rollback aborted: supabase_migrations.schema_migrations not found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261013000002')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conname IN ('projects_id_company_id_key', 'estimate_items_project_company_fkey', 'line_events_project_company_fkey')) THEN
    RAISE EXCEPTION 'project-company rollback aborted: nothing to roll back (no history row, no constraints)';
  END IF;
END
$guard$;

-- ── 1. 複合外部キーの削除（一意制約より先に消す） ──
ALTER TABLE public.estimate_items DROP CONSTRAINT IF EXISTS estimate_items_project_company_fkey;
ALTER TABLE public.line_events    DROP CONSTRAINT IF EXISTS line_events_project_company_fkey;

-- ── 2. 一意制約の削除（他の外部キーが参照していれば CASCADE せずにエラーで止まる） ──
ALTER TABLE public.projects DROP CONSTRAINT IF EXISTS projects_id_company_id_key;

-- ── 3. migration 履歴の削除（この 1 行だけ） ──
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261013000002';

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ── 4. 最終照合（読み取りのみ。期待値: history_rows = 0, constraints = 0） ──
SELECT
  (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '20261013000002') AS history_rows,
  (SELECT count(*) FROM pg_constraint
   WHERE conname IN ('projects_id_company_id_key', 'estimate_items_project_company_fkey', 'line_events_project_company_fkey')) AS constraints;
