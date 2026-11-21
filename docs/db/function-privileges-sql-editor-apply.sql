-- =====================================================================
-- DB 関数の権限修正 本番適用スクリプト（Supabase SQL Editor 専用・手動実行）
--
-- ・人間の承認後に、このファイルの全文を本番「現場愛」の SQL Editor に貼り付けて 1 回だけ実行する。
-- ・全体を 1 つのトランザクションで実行する。途中のどこで失敗しても、権限・search_path・migration 履歴の
--   どれも変わらない（エラーが出たら、続けて `ROLLBACK;` だけを実行してから状況を確認する）。
-- ・行うのは関数の EXECUTE 権限と search_path の変更だけ。関数の本体・テーブル・RLS ポリシー・
--   業務データ（会社・所属を含む）は変えない。関数の DROP もしない。
-- ・関数の権限変更はテーブルロックを取らない（実行中の画面操作を止めない）。
-- ・「-- >>> MIGRATION BODY」から「-- <<< MIGRATION BODY」までは
--   supabase/migrations/20261121000001_restrict_db_function_privileges.sql と 1 文字も違わない
--   （npm run test:db で照合している）。
-- 手順の全体: docs/db/function-privileges.md
-- =====================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 0. 適用前のガード（どれかに当てはまれば何もせずに止まる） ──
DO $guard$
BEGIN
  IF to_regclass('public.qa_environment_marker') IS NOT NULL THEN
    RAISE EXCEPTION 'function-privileges apply aborted: QA marker found (this is not production)';
  END IF;
  IF to_regclass('supabase_migrations.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'function-privileges apply aborted: supabase_migrations.schema_migrations not found';
  END IF;
  -- 直前の migration（KI-002 PR-4b）まで記録済みであること
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261016000001') THEN
    RAISE EXCEPTION 'function-privileges apply aborted: version 20261016000001 is not recorded';
  END IF;
  -- 二重適用・二重登録の防止
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261121000001') THEN
    RAISE EXCEPTION 'function-privileges apply aborted: version 20261121000001 is already recorded';
  END IF;
  -- 本番ではイベントトリガー ensure_rls と rls_auto_enable() があるはず（無ければ想定外の DB）
  IF to_regprocedure('public.rls_auto_enable()') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_event_trigger
                    WHERE evtname = 'ensure_rls' AND evtfoid = 'public.rls_auto_enable()'::regprocedure AND evtenabled <> 'D') THEN
    RAISE EXCEPTION 'function-privileges apply aborted: event trigger ensure_rls / rls_auto_enable() not found or disabled';
  END IF;
  -- 適用後に「関数の本体・RLS ポリシー・get_my_company_ids の権限が変わっていない」ことを確かめるため、適用前の状態を記録する
  PERFORM set_config('fp.src', (
    SELECT md5(string_agg(p.oid::regprocedure::text || ':' || md5(p.prosrc), ';' ORDER BY p.oid::regprocedure::text))
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind = 'f'
  ), true);
  PERFORM set_config('fp.policies', (
    SELECT coalesce(md5(string_agg(format('%s|%s|%s|%s|%s|%s', schemaname, tablename, policyname, cmd, qual, with_check), ';'
                                   ORDER BY schemaname, tablename, policyname)), '')
    FROM pg_policies WHERE schemaname IN ('public', 'storage')
  ), true);
  PERFORM set_config('fp.my_ids_acl', (
    SELECT coalesce(proacl::text, '(default)') FROM pg_proc WHERE oid = 'public.get_my_company_ids()'::regprocedure
  ), true);
  PERFORM set_config('fp.counts', (
    SELECT (SELECT count(*) FROM public.companies) || '/' || (SELECT count(*) FROM public.company_members)
  ), true);
END
$guard$;

-- ── 1. migration 本体（権限と search_path） ──
-- >>> MIGRATION BODY
-- ============================================================
-- DB 関数の実行権限と search_path を絞る（限定試用前のセキュリティ修正）
--
-- 背景（本番の読み取り専用の確認で判明）:
--   - public.create_company_with_owner(text) は SECURITY DEFINER（所有者 postgres）で、
--     PUBLIC・anon・authenticated・service_role が EXECUTE できる。関数の中に認証・所属数の確認が無い。
--     ログイン済みの利用者が /rest/v1/rpc/create_company_with_owner を呼ぶと、RLS を通らずに
--     会社を作って自分を owner にできる（2 社目の所属ができ、getCurrentCompany() の .single() が失敗する）。
--     anon も実行できる（所属行の user_id が NOT NULL のため関数の中でエラーになり、会社だけが残ることは無い）。
--     アプリはこの関数を呼んでいない（サインアップは無効。会社の作成は人間が SQL Editor で行う）。
--   - public.rls_auto_enable() はイベントトリガー ensure_rls の関数（SECURITY DEFINER）。
--     イベントトリガーは関数の EXECUTE 権限を確認しないため、利用者の EXECUTE 権限は不要。
--   - 検索 4 関数（match_estimate_items / search_catalog_items / search_cost_ledger_items /
--     search_estimate_items）は SECURITY INVOKER（RLS が効く）だが、search_path が固定されておらず、
--     anon（未ログイン）も実行できる。アプリが呼ぶのは authenticated（チャットの検索・LINE の再処理）と
--     service_role（LINE Webhook の match_estimate_items）だけ。
--
-- 変更すること（関数の本体・テーブル・RLS ポリシー・業務データは変えない。DROP もしない）:
--   1. create_company_with_owner(text)
--        EXECUTE を PUBLIC・anon・authenticated・service_role から取り消す（所有者 postgres だけが実行できる）。
--        search_path を public, pg_temp に固定する（一時スキーマを最後に回す）。
--   2. rls_auto_enable()（存在する場合だけ。リポジトリの migration には無く、本番で作られた）
--        EXECUTE を PUBLIC・anon・authenticated・service_role から取り消す。イベントトリガーの動作は変わらない。
--   3. 検索 4 関数
--        EXECUTE を PUBLIC・anon から取り消し、authenticated・service_role には明示的に付与する。
--        search_path を public, pg_temp に固定する（pg_trgm は本番でも public にある）。
--   4. get_my_company_ids()
--        権限は変えない（RLS ポリシーの中で、呼び出したロールの権限で実行されるため。
--        anon から取り消すと、未ログインの読み取りが「0 件」ではなくエラーになる）。
--        search_path だけを public, pg_temp に固定する（返す値は変わらない）。
--
-- 変えないもの:
--   - 原価台帳の 3 RPC・add_line_event_estimate_items・cost_ledger_items_lock_actual_cost（対応済み）
--   - apply_markup_rate_change（別途検討。この migration の対象外）
--   - public の既定の権限（ALTER DEFAULT PRIVILEGES。今後作る関数に anon の EXECUTE が付く件は別途検討）
-- ============================================================

-- ── 事前確認：対象の関数が想定どおりの形で揃っていなければ何も変えずに止める ──
DO $$
DECLARE
  missing text[];
BEGIN
  SELECT array_agg(s ORDER BY s) INTO missing
  FROM unnest(ARRAY[
    'public.create_company_with_owner(text)',
    'public.get_my_company_ids()',
    'public.match_estimate_items(uuid,text,integer,numeric)',
    'public.search_catalog_items(uuid,text,integer,double precision,text)',
    'public.search_cost_ledger_items(uuid,text,integer,double precision)',
    'public.search_estimate_items(uuid,text,integer,double precision,uuid)'
  ]) AS s
  WHERE to_regprocedure(s) IS NULL;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'function-privileges precondition failed: missing functions %', missing;
  END IF;

  -- 検索関数は pg_trgm の similarity() を schema 修飾なしで呼ぶ。search_path = public で解決できること
  IF to_regprocedure('public.similarity(text,text)') IS NULL THEN
    RAISE EXCEPTION 'function-privileges precondition failed: pg_trgm is not in schema public';
  END IF;
END
$$;

-- ── 1. 会社作成関数：所有者以外は実行できないようにする ──
REVOKE ALL ON FUNCTION public.create_company_with_owner(text) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION public.create_company_with_owner(text) SET search_path = public, pg_temp;

-- ── 2. RLS 自動有効化のイベントトリガー関数：利用者からの直接実行権限は不要 ──
DO $$
BEGIN
  IF to_regprocedure('public.rls_auto_enable()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated, service_role;
  END IF;
END
$$;

-- ── 3. 検索 4 関数：未ログインでは実行できないようにし、search_path を固定する ──
REVOKE ALL ON FUNCTION public.match_estimate_items(uuid, text, integer, numeric) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.search_catalog_items(uuid, text, integer, double precision, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.search_cost_ledger_items(uuid, text, integer, double precision) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.search_estimate_items(uuid, text, integer, double precision, uuid) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.match_estimate_items(uuid, text, integer, numeric) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.search_catalog_items(uuid, text, integer, double precision, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.search_cost_ledger_items(uuid, text, integer, double precision) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.search_estimate_items(uuid, text, integer, double precision, uuid) TO authenticated, service_role;

ALTER FUNCTION public.match_estimate_items(uuid, text, integer, numeric) SET search_path = public, pg_temp;
ALTER FUNCTION public.search_catalog_items(uuid, text, integer, double precision, text) SET search_path = public, pg_temp;
ALTER FUNCTION public.search_cost_ledger_items(uuid, text, integer, double precision) SET search_path = public, pg_temp;
ALTER FUNCTION public.search_estimate_items(uuid, text, integer, double precision, uuid) SET search_path = public, pg_temp;

-- ── 4. RLS 補助関数：権限は変えず、search_path だけ固定する ──
ALTER FUNCTION public.get_my_company_ids() SET search_path = public, pg_temp;
-- <<< MIGRATION BODY

-- ── 2. 適用後の検証（どれかが外れればトランザクション全体を取り消す） ──
DO $verify$
DECLARE
  f text;
  v_fn regprocedure;
BEGIN
  -- PUBLIC（grantee = 0）に EXECUTE が残っていない
  FOREACH f IN ARRAY ARRAY[
    'public.create_company_with_owner(text)',
    'public.rls_auto_enable()',
    'public.match_estimate_items(uuid,text,integer,numeric)',
    'public.search_catalog_items(uuid,text,integer,double precision,text)',
    'public.search_cost_ledger_items(uuid,text,integer,double precision)',
    'public.search_estimate_items(uuid,text,integer,double precision,uuid)'
  ] LOOP
    v_fn := f::regprocedure;
    IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
               WHERE p.oid = v_fn AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
      RAISE EXCEPTION 'function-privileges verify failed: PUBLIC can execute %', f;
    END IF;
    IF has_function_privilege('anon', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'function-privileges verify failed: anon can execute %', f;
    END IF;
  END LOOP;

  -- 会社作成・イベントトリガー関数は利用者のどのロールも実行できない
  FOREACH f IN ARRAY ARRAY['public.create_company_with_owner(text)', 'public.rls_auto_enable()'] LOOP
    IF has_function_privilege('authenticated', f::regprocedure, 'EXECUTE')
       OR has_function_privilege('service_role', f::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'function-privileges verify failed: authenticated or service_role can execute %', f;
    END IF;
  END LOOP;

  -- 検索 4 関数は authenticated・service_role が実行でき、search_path が固定されている
  FOREACH f IN ARRAY ARRAY[
    'public.match_estimate_items(uuid,text,integer,numeric)',
    'public.search_catalog_items(uuid,text,integer,double precision,text)',
    'public.search_cost_ledger_items(uuid,text,integer,double precision)',
    'public.search_estimate_items(uuid,text,integer,double precision,uuid)'
  ] LOOP
    IF NOT has_function_privilege('authenticated', f::regprocedure, 'EXECUTE')
       OR NOT has_function_privilege('service_role', f::regprocedure, 'EXECUTE') THEN
      RAISE EXCEPTION 'function-privileges verify failed: authenticated or service_role cannot execute %', f;
    END IF;
  END LOOP;
  FOREACH f IN ARRAY ARRAY[
    'public.create_company_with_owner(text)',
    'public.get_my_company_ids()',
    'public.match_estimate_items(uuid,text,integer,numeric)',
    'public.search_catalog_items(uuid,text,integer,double precision,text)',
    'public.search_cost_ledger_items(uuid,text,integer,double precision)',
    'public.search_estimate_items(uuid,text,integer,double precision,uuid)'
  ] LOOP
    IF (SELECT proconfig FROM pg_proc WHERE oid = f::regprocedure) IS DISTINCT FROM ARRAY['search_path=public, pg_temp'] THEN
      RAISE EXCEPTION 'function-privileges verify failed: unexpected settings for % (%)', f, (SELECT proconfig FROM pg_proc WHERE oid = f::regprocedure);
    END IF;
  END LOOP;

  -- get_my_company_ids の権限・関数の本体・RLS ポリシー（public・storage）・会社と所属の件数は適用前と同じ
  IF (SELECT coalesce(proacl::text, '(default)') FROM pg_proc WHERE oid = 'public.get_my_company_ids()'::regprocedure)
     IS DISTINCT FROM current_setting('fp.my_ids_acl', true) THEN
    RAISE EXCEPTION 'function-privileges verify failed: get_my_company_ids privileges changed';
  END IF;
  IF (SELECT md5(string_agg(p.oid::regprocedure::text || ':' || md5(p.prosrc), ';' ORDER BY p.oid::regprocedure::text))
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prokind = 'f') IS DISTINCT FROM current_setting('fp.src', true) THEN
    RAISE EXCEPTION 'function-privileges verify failed: function bodies changed';
  END IF;
  IF (SELECT coalesce(md5(string_agg(format('%s|%s|%s|%s|%s|%s', schemaname, tablename, policyname, cmd, qual, with_check), ';'
                                     ORDER BY schemaname, tablename, policyname)), '')
      FROM pg_policies WHERE schemaname IN ('public', 'storage')) IS DISTINCT FROM current_setting('fp.policies', true) THEN
    RAISE EXCEPTION 'function-privileges verify failed: RLS policies changed';
  END IF;
  IF ((SELECT count(*) FROM public.companies) || '/' || (SELECT count(*) FROM public.company_members))
     IS DISTINCT FROM current_setting('fp.counts', true) THEN
    RAISE EXCEPTION 'function-privileges verify failed: companies / members changed';
  END IF;
END
$verify$;

-- ── 3. migration 履歴の登録（ここまで成功した場合だけ到達する） ──
DO $history$
BEGIN
  INSERT INTO supabase_migrations.schema_migrations (version) VALUES ('20261121000001');
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'supabase_migrations' AND table_name = 'schema_migrations' AND column_name = 'name'
  ) THEN
    EXECUTE 'UPDATE supabase_migrations.schema_migrations SET name = $1 WHERE version = $2'
      USING 'restrict_db_function_privileges', '20261121000001';
  END IF;
END
$history$;

-- PostgREST に権限の変更を読み込ませる（通知はコミット時に送られる。取り消された場合は送られない）
NOTIFY pgrst, 'reload schema';

COMMIT;

-- ── 4. 最終照合（読み取りのみ。期待値: history_rows = 1, anon_can_create = false, authenticated_can_create = false,
--       authenticated_can_search = true, anon_can_search = false） ──
SELECT
  (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '20261121000001') AS history_rows,
  has_function_privilege('anon', 'public.create_company_with_owner(text)', 'EXECUTE') AS anon_can_create,
  has_function_privilege('authenticated', 'public.create_company_with_owner(text)', 'EXECUTE') AS authenticated_can_create,
  has_function_privilege('authenticated', 'public.search_estimate_items(uuid,text,integer,double precision,uuid)', 'EXECUTE') AS authenticated_can_search,
  has_function_privilege('anon', 'public.search_estimate_items(uuid,text,integer,double precision,uuid)', 'EXECUTE') AS anon_can_search;
