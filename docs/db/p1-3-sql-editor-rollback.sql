-- =====================================================================
-- P1-3 ロールバックスクリプト（Supabase SQL Editor 専用・手動実行）
--
-- ・人間の承認後にだけ実行する。アプリ（PR #32）はこのトリガーが無くても動く
--   （請求書がある項目の actual_cost の直接変更は、アプリ側の件数確認だけで止める状態に戻る）。
-- ・トリガーと関数の削除、migration 履歴（20261011000001 の 1 行）の削除を 1 トランザクションで行う。
--   テーブル・業務データ・RLS・P1-1 / P1-2 の関数とインデックスには触れない。
-- ・途中で失敗したら何も変わらない（エラーが出たら `ROLLBACK;` だけを実行してから状況を確認する）。
-- ・トリガーの削除は cost_ledger_items のロックを取る。ロック待ちは 5 秒で打ち切る（全体が取り消される）。
-- ・履歴を消した後も supabase/migrations/20261011000001_*.sql が main に残っていると、
--   CLI からは「未適用」に見える。手順書の「ロールバック」の節に従い、ファイルも revert する。
-- =====================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $guard$
BEGIN
  IF to_regclass('supabase_migrations.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'P1-3 rollback aborted: supabase_migrations.schema_migrations not found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261011000001')
     AND to_regprocedure('public.cost_ledger_items_lock_actual_cost()') IS NULL
     AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'cost_ledger_items_lock_actual_cost' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'P1-3 rollback aborted: nothing to roll back (no history row, no trigger, no function)';
  END IF;
END
$guard$;

DROP TRIGGER IF EXISTS cost_ledger_items_lock_actual_cost ON public.cost_ledger_items;
DROP FUNCTION IF EXISTS public.cost_ledger_items_lock_actual_cost();

-- 業務データではなく migration 履歴の 1 行だけを消す
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261011000001';

DO $verify$
BEGIN
  IF to_regprocedure('public.cost_ledger_items_lock_actual_cost()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'cost_ledger_items_lock_actual_cost' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'P1-3 rollback verify failed: trigger or function still exists';
  END IF;
END
$verify$;

COMMIT;

-- 最終照合（読み取りのみ。期待値: history_rows = 0, triggers = 0, functions = 0）
SELECT
  (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '20261011000001') AS history_rows,
  (SELECT count(*) FROM pg_trigger WHERE tgname = 'cost_ledger_items_lock_actual_cost' AND NOT tgisinternal) AS triggers,
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'cost_ledger_items_lock_actual_cost') AS functions;
