-- =====================================================================
-- P1-2 ロールバックスクリプト（Supabase SQL Editor 専用・手動実行）
--
-- ・人間の承認後にだけ実行する。PR #32（アプリの RPC 切り替え）を本番に出した後なら、
--   先にアプリを PR #32 より前に戻してから実行する（戻さないと請求書の登録・編集・削除が 404/500 になる）。
-- ・関数 3 つの削除と migration 履歴（20261010000002 の 1 行）の削除を 1 トランザクションで行う。
--   テーブル・データ・RLS・インデックスには触れない。
-- ・途中で失敗したら何も変わらない（エラーが出たら `ROLLBACK;` だけを実行してから状況を確認する）。
-- ・履歴を消した後も supabase/migrations/20261010000002_*.sql が main に残っていると、
--   CLI からは「未適用」に見える。手順書の「ロールバック」の節に従い、ファイルも revert する。
-- =====================================================================

BEGIN;

DO $guard$
BEGIN
  IF to_regclass('supabase_migrations.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'P1-2 rollback aborted: supabase_migrations.schema_migrations not found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261010000002')
     AND NOT EXISTS (
       SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('cost_ledger_invoice_insert', 'cost_ledger_invoice_update', 'cost_ledger_invoice_delete')
     ) THEN
    RAISE EXCEPTION 'P1-2 rollback aborted: nothing to roll back (no history row, no functions)';
  END IF;
END
$guard$;

DROP FUNCTION IF EXISTS public.cost_ledger_invoice_insert(uuid, numeric, date, date, text, text, text, text, text, uuid);
DROP FUNCTION IF EXISTS public.cost_ledger_invoice_update(uuid, jsonb);
DROP FUNCTION IF EXISTS public.cost_ledger_invoice_delete(uuid);

-- 業務データではなく migration 履歴の 1 行だけを消す
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261010000002';

DO $verify$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('cost_ledger_invoice_insert', 'cost_ledger_invoice_update', 'cost_ledger_invoice_delete')
  ) THEN
    RAISE EXCEPTION 'P1-2 rollback verify failed: functions still exist (signature differs?)';
  END IF;
END
$verify$;

COMMIT;

-- 最終照合（読み取りのみ。期待値: history_rows = 0, functions = 0）
SELECT
  (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '20261010000002') AS history_rows,
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('cost_ledger_invoice_insert', 'cost_ledger_invoice_update', 'cost_ledger_invoice_delete')) AS functions;
