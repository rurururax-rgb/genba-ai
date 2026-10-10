-- =====================================================================
-- KI-001 ロールバックスクリプト（Supabase SQL Editor 専用・手動実行）
--
-- ・人間の承認後にだけ実行する。
-- ・関数 public.add_line_event_estimate_items を削除し、migration 履歴（20261013000001 の 1 行）を
--   削除する。これらを 1 トランザクションで行う。
-- ・テーブル・業務データ・RLS には触れない。関数が作った見積項目・紐付け（line_events.project_id）は
--   そのまま残る（通常の操作で作られたデータと同じ扱い）。
-- ・関数を消すと、この PR のアプリ（POST /api/estimate-items）は「見積に追加」で 500 を返す。
--   先にアプリを revert（Vercel で直前のデプロイに戻す等）してから実行する。
-- ・途中で失敗したら何も変わらない（エラーが出たら `ROLLBACK;` だけを実行してから状況を確認する）。
-- ・履歴を消した後も supabase/migrations/20261013000001_*.sql が main に残っていると、
--   CLI からは「未適用」に見える。手順書の「ロールバック」の節に従い、ファイルも revert する。
-- =====================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $guard$
BEGIN
  IF to_regclass('supabase_migrations.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'KI-001 rollback aborted: supabase_migrations.schema_migrations not found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261013000001')
     AND to_regprocedure('public.add_line_event_estimate_items(uuid, uuid, jsonb)') IS NULL THEN
    RAISE EXCEPTION 'KI-001 rollback aborted: nothing to roll back (no history row, no function)';
  END IF;
END
$guard$;

-- ── 1. 関数の削除（他のオブジェクトが依存していれば CASCADE せずにエラーで止まる） ──
DROP FUNCTION IF EXISTS public.add_line_event_estimate_items(uuid, uuid, jsonb);

-- ── 2. migration 履歴の削除（この 1 行だけ） ──
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261013000001';

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ── 3. 最終照合（読み取りのみ。期待値: history_rows = 0, function_exists = false） ──
SELECT
  (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '20261013000001') AS history_rows,
  to_regprocedure('public.add_line_event_estimate_items(uuid, uuid, jsonb)') IS NOT NULL AS function_exists;
