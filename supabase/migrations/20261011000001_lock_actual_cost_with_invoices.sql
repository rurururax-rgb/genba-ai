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
