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
