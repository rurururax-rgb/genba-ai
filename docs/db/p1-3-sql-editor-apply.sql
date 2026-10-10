-- =====================================================================
-- P1-3 本番適用スクリプト（Supabase SQL Editor 専用・手動実行）
--
-- ・supabase db push / supabase migration up では使わない（CLI は migration ファイルを直接使う）。
-- ・人間の承認後に、このファイルの全文を SQL Editor に貼り付けて 1 回だけ実行する。
-- ・全体を 1 つのトランザクションで実行する。途中のどこで失敗しても、関数・トリガー・migration 履歴は
--   1 つも残らない（エラーが出たら、続けて `ROLLBACK;` だけを実行してから状況を確認する）。
-- ・migration 履歴（supabase_migrations.schema_migrations）への登録は、関数・トリガーの作成と検証が
--   すべて成功した場合だけ、同じトランザクションの最後で行う。「実体はあるが履歴が無い」状態を作らない。
-- ・トリガーの作成は cost_ledger_items のロックを取る。台帳への書き込みを長く止めないよう、
--   ロック待ちは 5 秒で打ち切る（55P03 で全体が取り消される。時間をおいて全文を実行し直す）。
-- ・業務データ（台帳項目・請求書）の INSERT / UPDATE / DELETE は行わない。既存の不整合データも修正しない。
-- ・「-- >>> MIGRATION BODY」から「-- <<< MIGRATION BODY」までは
--   supabase/migrations/20261011000001_lock_actual_cost_with_invoices.sql と 1 文字も違わない
--   （npm run test:db で照合している）。
-- 手順の全体: docs/db/p1-3-lock-actual-cost-with-invoices.md
-- =====================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 0. 適用前のガード（どれかに当てはまれば何もせずに止まる） ──
DO $guard$
BEGIN
  IF to_regclass('supabase_migrations.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'P1-3 apply aborted: supabase_migrations.schema_migrations not found';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'supabase_migrations' AND table_name = 'schema_migrations' AND column_name = 'version'
  ) THEN
    RAISE EXCEPTION 'P1-3 apply aborted: schema_migrations.version not found';
  END IF;
  -- 二重適用・二重登録の防止
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261011000001') THEN
    RAISE EXCEPTION 'P1-3 apply aborted: version 20261011000001 is already recorded';
  END IF;
  -- P1-2（RPC）が履歴どおりに適用済みであること（請求書の変更手段がなくならないように）
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261010000002') THEN
    RAISE EXCEPTION 'P1-3 apply aborted: version 20261010000002 (P1-2) is not recorded';
  END IF;
  -- 同名の関数・トリガーが既にあるなら、中身を確かめずに置き換えない
  IF to_regprocedure('public.cost_ledger_items_lock_actual_cost()') IS NOT NULL
     OR EXISTS (
       SELECT 1 FROM pg_trigger
       WHERE tgname = 'cost_ledger_items_lock_actual_cost' AND NOT tgisinternal
     ) THEN
    RAISE EXCEPTION 'P1-3 apply aborted: cost_ledger_items_lock_actual_cost already exists (history is missing)';
  END IF;
END
$guard$;

-- >>> MIGRATION BODY
-- ============================================================
-- 業者請求書がある台帳項目の actual_cost（請求実績）を直接書き換えさせない（P1-3 / DB 側の保護）
--
-- ※ 本番への適用は人間の承認後に行う（PR #32 ではアプリ側の確認のみが有効）。
--
-- 目的:
--   請求書が1件以上ある台帳項目の actual_cost は「請求書の合計」でなければならない。
--   アプリ（PATCH /api/cost-ledger/[id]・AI の変更確定）は請求書の件数を確認してから書き込むが、
--     ・確認と書き込みの間に請求書が登録される競合
--     ・PostgREST（anon key + ログイン済みトークン）からの cost_ledger_items への直接 UPDATE
--   は防げない。この migration は DB のトリガーで、それらの書き込みも拒否する。
--
-- 動作:
--   cost_ledger_items の actual_cost が変わる UPDATE のとき、
--   その項目に請求書が1件以上あり、かつ新しい actual_cost が請求書の合計と一致しなければ
--   エラー CL423（actual_cost_locked）で拒否する（トランザクションごと取り消される）。
--     ・請求書が0件の項目 … 従来どおり自由に変更できる（直接入力）
--     ・RPC cost_ledger_invoice_*（20261010000002）… 常に合計値（0件なら NULL）を書くので通る
--     ・actual_cost 以外の列だけの UPDATE … トリガーは動かない（既存の不整合データがあっても名前等は変更できる）
--   「誰が書いたか」（設定値・ロール）では判定しない。値が合計と一致するかだけを見るので、
--   クライアントが設定値を偽装してすり抜けることはできない。
--
-- 同時実行:
--   BEFORE UPDATE トリガーは対象行のロック取得後に動く。RPC が親行を FOR UPDATE でロックして
--   請求書を登録している間、直接 UPDATE はそのロックを待ち、RPC のコミット後にトリガーが動く。
--   トリガー関数は VOLATILE なので READ COMMITTED では新しいスナップショットで請求書を数え、
--   コミット済みの請求書を見て拒否する。
--
-- この migration で防げないもの:
--   ・cost_ledger_invoices への直接 INSERT / UPDATE / DELETE（RPC を通らない書き込み）は
--     actual_cost を再集計しないため、内訳合計とずれうる（請求書テーブルの既存 RLS ポリシーは変更しない）
--   ・session_replication_role = replica で動く処理（トリガーが動かない。通常の API からは設定できない）
--
-- 安全方針:
--   - テーブル・列・制約・RLS ポリシーは変更しない（関数とトリガーの追加のみ）
--   - 既存データの UPDATE / DELETE / TRUNCATE なし（既存の不整合データも修正しない）
--   - 関数は SECURITY DEFINER（RLS に左右されずに請求書を数えるため）、search_path は空に固定
--   - トリガー関数は直接呼び出せない（RETURNS trigger）。念のため EXECUTE も取り消す
--
-- ロールバック:
--   DROP TRIGGER IF EXISTS cost_ledger_items_lock_actual_cost ON public.cost_ledger_items;
--   DROP FUNCTION IF EXISTS public.cost_ledger_items_lock_actual_cost();
-- ============================================================

-- ── 事前確認 ──
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'cost_ledger_items' AND column_name = 'actual_cost')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'cost_ledger_invoices' AND column_name = 'cost_ledger_item_id')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'cost_ledger_invoices' AND column_name = 'amount') THEN
    RAISE EXCEPTION 'P1-3 precondition failed: cost_ledger_items.actual_cost / cost_ledger_invoices columns not found';
  END IF;
  -- RPC（20261010000002）が先に適用されていること（請求書の変更手段がなくならないように）
  IF to_regprocedure('public.cost_ledger_invoice_insert(uuid, numeric, date, date, text, text, text, text, text, uuid)') IS NULL THEN
    RAISE EXCEPTION 'P1-3 precondition failed: apply 20261010000002 first';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.cost_ledger_items_lock_actual_cost()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count bigint;
  v_total numeric;
BEGIN
  SELECT count(*), sum(i.amount::numeric) INTO v_count, v_total
  FROM public.cost_ledger_invoices i
  WHERE i.cost_ledger_item_id = NEW.id;

  IF v_count > 0 AND NEW.actual_cost IS DISTINCT FROM v_total THEN
    RAISE EXCEPTION USING ERRCODE = 'CL423', MESSAGE = 'actual_cost_locked';
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.cost_ledger_items_lock_actual_cost() FROM PUBLIC;
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.cost_ledger_items_lock_actual_cost() FROM %I', r);
    END IF;
  END LOOP;
END
$$;

DROP TRIGGER IF EXISTS cost_ledger_items_lock_actual_cost ON public.cost_ledger_items;
CREATE TRIGGER cost_ledger_items_lock_actual_cost
  BEFORE UPDATE OF actual_cost ON public.cost_ledger_items
  FOR EACH ROW
  WHEN (NEW.actual_cost IS DISTINCT FROM OLD.actual_cost)
  EXECUTE FUNCTION public.cost_ledger_items_lock_actual_cost();

COMMENT ON FUNCTION public.cost_ledger_items_lock_actual_cost() IS
  '請求書がある台帳項目の actual_cost を、請求書の合計以外の値に変更させない（CL423 actual_cost_locked）';
-- <<< MIGRATION BODY

-- ── 2. 作成結果をトランザクションの中で検証（失敗すれば全体を取り消す） ──
DO $verify$
DECLARE
  v_fn    oid := to_regprocedure('public.cost_ledger_items_lock_actual_cost()');
  v_def   boolean;
  v_cfg   text[];
  v_count int;
  r       text;
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'P1-3 verify failed: function not found';
  END IF;
  SELECT p.prosecdef, coalesce(p.proconfig, '{}') INTO v_def, v_cfg FROM pg_proc p WHERE p.oid = v_fn;
  IF NOT v_def THEN
    RAISE EXCEPTION 'P1-3 verify failed: function is not SECURITY DEFINER';
  END IF;
  IF v_cfg <> ARRAY['search_path=""'] THEN
    RAISE EXCEPTION 'P1-3 verify failed: proconfig %', v_cfg;
  END IF;
  -- EXECUTE は誰にも付けない（PUBLIC = grantee 0 を含む）
  IF EXISTS (
    SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    WHERE p.oid = v_fn AND a.privilege_type = 'EXECUTE' AND a.grantee = 0
  ) THEN
    RAISE EXCEPTION 'P1-3 verify failed: PUBLIC can execute the trigger function';
  END IF;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) AND has_function_privilege(r, v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'P1-3 verify failed: % can execute the trigger function', r;
    END IF;
  END LOOP;

  -- トリガー: cost_ledger_items に 1 つだけ、有効、BEFORE UPDATE OF actual_cost・行単位・WHEN 条件つき
  --   tgtype のビット: 1 = ROW, 2 = BEFORE, 4 = INSERT, 8 = DELETE, 16 = UPDATE, 32 = TRUNCATE
  SELECT count(*) INTO v_count
  FROM pg_trigger t
  WHERE t.tgrelid = 'public.cost_ledger_items'::regclass
    AND t.tgname = 'cost_ledger_items_lock_actual_cost'
    AND NOT t.tgisinternal
    AND t.tgenabled = 'O'
    AND t.tgfoid = v_fn
    AND (t.tgtype & (1 | 2 | 16)) = (1 | 2 | 16)
    AND (t.tgtype & (4 | 8 | 32)) = 0
    AND t.tgqual IS NOT NULL
    -- UPDATE OF の対象列が actual_cost だけ（int2vector は 0 始まりなので文字列で比べる）
    AND t.tgattr::text = (
      SELECT a.attnum::text FROM pg_attribute a
      WHERE a.attrelid = 'public.cost_ledger_items'::regclass AND a.attname = 'actual_cost' AND NOT a.attisdropped
    );
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'P1-3 verify failed: expected 1 enabled trigger on cost_ledger_items, found %', v_count;
  END IF;
  -- 同じ関数を使うトリガーが他の表に付いていない
  IF (SELECT count(*) FROM pg_trigger WHERE tgfoid = v_fn AND NOT tgisinternal) <> 1 THEN
    RAISE EXCEPTION 'P1-3 verify failed: trigger function is used by other triggers';
  END IF;
END
$verify$;

-- ── 3. migration 履歴の登録（ここまで成功した場合だけ到達する） ──
-- version 列だけを必須とし、name 列は存在する場合だけ埋める（列の有無を推測しない）。
DO $history$
BEGIN
  INSERT INTO supabase_migrations.schema_migrations (version) VALUES ('20261011000001');
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'supabase_migrations' AND table_name = 'schema_migrations' AND column_name = 'name'
  ) THEN
    EXECUTE 'UPDATE supabase_migrations.schema_migrations SET name = $1 WHERE version = $2'
      USING 'lock_actual_cost_with_invoices', '20261011000001';
  END IF;
END
$history$;

COMMIT;

-- ── 4. 最終照合（読み取りのみ。期待値: history_rows = 1, triggers = 1, functions = 1） ──
SELECT
  (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '20261011000001') AS history_rows,
  (SELECT count(*) FROM pg_trigger
   WHERE tgrelid = 'public.cost_ledger_items'::regclass
     AND tgname = 'cost_ledger_items_lock_actual_cost' AND tgenabled = 'O' AND NOT tgisinternal) AS triggers,
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'cost_ledger_items_lock_actual_cost') AS functions;
