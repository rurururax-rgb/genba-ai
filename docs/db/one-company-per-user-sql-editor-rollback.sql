-- =====================================================================
-- 1 ユーザー 1 社の制約 ロールバックスクリプト（Supabase SQL Editor 専用・手動実行）
--
-- ・人間の承認後にだけ実行する。制約 company_members_user_id_key と migration 履歴（20261121000002 の 1 行）を
--   1 トランザクションで削除する。company_members の行・ほかの制約・RLS には触れない。
-- ・途中で失敗したら何も変わらない（エラーが出たら `ROLLBACK;` だけを実行してから状況を確認する）。
-- ・履歴を消した後も supabase/migrations/20261121000002_*.sql が main に残っていると、
--   CLI からは「未適用」に見える。手順書の「ロールバック」の節に従い、ファイルも revert する。
-- =====================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $guard$
BEGIN
  IF to_regclass('supabase_migrations.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'one-company-per-user rollback aborted: supabase_migrations.schema_migrations not found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261121000002')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.company_members'::regclass
                     AND conname = 'company_members_user_id_key') THEN
    RAISE EXCEPTION 'one-company-per-user rollback aborted: nothing to roll back (no history row, no constraint)';
  END IF;
END
$guard$;

ALTER TABLE public.company_members DROP CONSTRAINT IF EXISTS company_members_user_id_key;

DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261121000002';

COMMIT;

-- ── 最終照合（読み取りのみ。期待値: history_rows = 0, constraint_exists = false） ──
SELECT
  (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '20261121000002') AS history_rows,
  EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.company_members'::regclass
          AND conname = 'company_members_user_id_key') AS constraint_exists;
