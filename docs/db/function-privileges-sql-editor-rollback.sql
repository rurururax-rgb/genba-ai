-- =====================================================================
-- DB 関数の権限修正 ロールバックスクリプト（Supabase SQL Editor 専用・手動実行）
--
-- ・人間の承認後にだけ実行する。20261121000001 を適用する前の権限・search_path に戻し、
--   migration 履歴（20261121000001 の 1 行）を削除する。これらを 1 トランザクションで行う。
--   戻した後は、create_company_with_owner を再びログイン済みの利用者・anon が実行できる状態になる
--   （問題が再発する）。アプリに不具合が出たときの一時的な手段として使う。
-- ・関数の本体・テーブル・RLS ポリシー・業務データには触れない。関数の DROP もしない。
-- ・アプリ側の変更は無いので、アプリを revert する必要は無い。
-- ・途中で失敗したら何も変わらない（エラーが出たら `ROLLBACK;` だけを実行してから状況を確認する）。
-- ・履歴を消した後も supabase/migrations/20261121000001_*.sql が main に残っていると、
--   CLI からは「未適用」に見える。手順書の「ロールバック」の節に従い、ファイルも revert する。
-- =====================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $guard$
BEGIN
  IF to_regclass('supabase_migrations.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'function-privileges rollback aborted: supabase_migrations.schema_migrations not found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261121000001') THEN
    RAISE EXCEPTION 'function-privileges rollback aborted: version 20261121000001 is not recorded (nothing to roll back)';
  END IF;
END
$guard$;

-- ── 1. 適用前の権限に戻す（本番の適用前: PUBLIC・anon・authenticated・service_role が EXECUTE できた） ──
GRANT EXECUTE ON FUNCTION public.create_company_with_owner(text) TO PUBLIC, anon, authenticated, service_role;
DO $$
BEGIN
  IF to_regprocedure('public.rls_auto_enable()') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.rls_auto_enable() TO PUBLIC, anon, authenticated, service_role;
  END IF;
END
$$;
GRANT EXECUTE ON FUNCTION public.match_estimate_items(uuid, text, integer, numeric) TO PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_catalog_items(uuid, text, integer, double precision, text) TO PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_cost_ledger_items(uuid, text, integer, double precision) TO PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_estimate_items(uuid, text, integer, double precision, uuid) TO PUBLIC, anon;

-- ── 2. 適用前の search_path に戻す（会社作成・RLS 補助は public、検索 4 関数は未設定） ──
ALTER FUNCTION public.create_company_with_owner(text) SET search_path = public;
ALTER FUNCTION public.get_my_company_ids() SET search_path = public;
ALTER FUNCTION public.match_estimate_items(uuid, text, integer, numeric) RESET search_path;
ALTER FUNCTION public.search_catalog_items(uuid, text, integer, double precision, text) RESET search_path;
ALTER FUNCTION public.search_cost_ledger_items(uuid, text, integer, double precision) RESET search_path;
ALTER FUNCTION public.search_estimate_items(uuid, text, integer, double precision, uuid) RESET search_path;

-- ── 3. migration 履歴の削除（この 1 行だけ） ──
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261121000001';

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ── 4. 最終照合（読み取りのみ。期待値: history_rows = 0, anon_can_create = true, authenticated_can_create = true） ──
SELECT
  (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '20261121000001') AS history_rows,
  has_function_privilege('anon', 'public.create_company_with_owner(text)', 'EXECUTE') AS anon_can_create,
  has_function_privilege('authenticated', 'public.create_company_with_owner(text)', 'EXECUTE') AS authenticated_can_create;
