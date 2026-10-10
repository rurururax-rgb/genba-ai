-- ============================================================
-- 業者請求書（cost_ledger_invoices）への直接書き込みを禁止し、書き込みを RPC だけにする（P1-4）
--
-- ※ 本番への適用は人間の承認後に行う（docs/db/p1-4-restrict-cost-ledger-invoice-writes.md）。
--
-- 目的:
--   P1-2 の RPC（cost_ledger_invoice_insert / update / delete）は SECURITY INVOKER のため、
--   ログイン済みユーザー（authenticated）に請求書テーブルの INSERT / UPDATE / DELETE 権限が必要だった。
--   その権限があると、PostgREST（anon key + ログイン済みトークン）から RPC を通らずに
--   自社の請求書を直接書き換えられ、actual_cost（請求実績）と請求書の合計がずれる。
--   この migration は直接の書き込み権限を取り消し、書き込みを RPC だけに限定する。
--
-- 変更点:
--   1. 3つの RPC を SECURITY DEFINER に変更する（引数・戻り値・エラーコード・入力の検証・ロック順は P1-2 と同じ）。
--      RLS に頼れなくなるため、親の台帳項目をロックする箇所で
--      「auth.uid() が、その台帳項目の会社（company_members）のメンバーであること」を明示的に確かめる。
--      メンバーでない・存在しない・削除済みはすべて CL404（区別して漏らさない）。
--   2. cost_ledger_invoices の INSERT / UPDATE / DELETE / TRUNCATE を PUBLIC・anon・authenticated から取り消す。
--      SELECT（読み取り）と RLS ポリシーはそのまま（画面・API の読み取りは従来どおり RLS で自社分だけ）。
--
-- 他社データへのアクセスを作らないための条件（3関数共通）:
--   - auth.uid() が無ければ CL401。auth.uid() は PostgREST が検証済みの JWT から設定する値で、RLS と同じ根拠
--     （「RPC を通った証明」としてセッション変数やフラグは使わない。権限で直接書き込みを止める）
--   - 親の台帳項目・案件は「未削除」「案件の会社 = 台帳項目の会社」「呼び出したユーザーがその会社のメンバー」
--     をすべて満たすときだけロックする。満たさなければ何も書かずに CL404
--   - 編集・削除は、ロックした親と請求書の cost_ledger_item_id / project_id が一致しなければ CL409（P1-2 と同じ）
--   - company_id・project_id はリクエストから受け取らない。返すのは自分が書いた行だけ
--   - search_path は空に固定し、すべて schema 修飾で参照する
--   - EXECUTE は authenticated のみ（anon・service_role・PUBLIC は不可）
--
-- 同時実行: P1-2 と同じ（親の台帳項目 → 請求書 の順にロック。lock_timeout = 5s）。
--   P1-3 のトリガー（cost_ledger_items_lock_actual_cost）はそのまま。RPC は常に合計を書くので通る。
--
-- この migration で変えないもの:
--   - テーブル・列・制約・インデックス・RLS ポリシー・業務データ（既存の不整合データも修正しない）
--   - service_role の権限（RLS を回避する管理用ロール。アプリは請求書の書き込みに使っていない）
--   - 請求書の読み取り（SELECT）権限、cost_ledger_items の権限
--
-- ロールバック: docs/db/p1-4-sql-editor-rollback.sql（P1-2 の関数定義に戻し、取り消した権限を付け直す）
-- ============================================================

-- ── 事前確認：前提が揃っていなければ何も変えずに止める ──
DO $$
BEGIN
  -- P1-2 の RPC と P1-3 のトリガー関数が適用済みであること
  IF to_regprocedure('public.cost_ledger_invoice_insert(uuid, numeric, date, date, text, text, text, text, text, uuid)') IS NULL
     OR to_regprocedure('public.cost_ledger_invoice_update(uuid, jsonb)') IS NULL
     OR to_regprocedure('public.cost_ledger_invoice_delete(uuid)') IS NULL THEN
    RAISE EXCEPTION 'P1-4 precondition failed: apply 20261010000002 first';
  END IF;
  IF to_regprocedure('public.cost_ledger_items_lock_actual_cost()') IS NULL THEN
    RAISE EXCEPTION 'P1-4 precondition failed: apply 20261011000001 first';
  END IF;
  -- 所属の確認に使う列があること
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'company_members' AND column_name = 'company_id')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'company_members' AND column_name = 'user_id') THEN
    RAISE EXCEPTION 'P1-4 precondition failed: company_members.company_id / user_id not found';
  END IF;
END
$$;

-- ============================================================
-- 登録
-- ============================================================
--
-- 入力の検証は現行 POST API（lib/cost-ledger/invoice-dedupe.ts の parseInvoiceRequest）と同じ。
-- project_id は引数で受け取らず、ロックした親の台帳項目から取る。
-- 同じ idempotency_key・同じ案件に同じ画像は既存の一意インデックスで 23505 になり、
-- 請求書も actual_cost も変わらない（再送の判定・応答は API 側で行う）。
-- 「以前の請求書と似ている」の確認は API 側で行う（ここでは行わない）。

CREATE OR REPLACE FUNCTION public.cost_ledger_invoice_insert(
  p_item_id          uuid,
  p_amount           numeric,
  p_invoice_date     date    DEFAULT NULL,
  p_payment_date     date    DEFAULT NULL,
  p_note             text    DEFAULT NULL,
  p_source           text    DEFAULT 'manual',
  p_vendor_name      text    DEFAULT NULL,
  p_invoice_number   text    DEFAULT NULL,
  p_document_sha256  text    DEFAULT NULL,
  p_idempotency_key  uuid    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '5s'
AS $$
DECLARE
  v_source     text := coalesce(p_source, 'manual');
  v_note       text := nullif(btrim(p_note), '');
  v_vendor     text := nullif(btrim(p_vendor_name), '');
  v_number     text := nullif(btrim(p_invoice_number), '');
  v_project_id uuid;
  v_invoice    jsonb;
  v_count      bigint;
  v_total      numeric;
  v_rows       int;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'CL401', MESSAGE = 'unauthenticated';
  END IF;

  -- ── 入力の検証 ──
  IF p_item_id IS NULL
     OR p_amount IS NULL OR p_amount = 0 OR abs(p_amount) >= 1000000000000
     OR v_source NOT IN ('ocr', 'manual')
     OR length(v_note) > 500 OR length(v_vendor) > 200 OR length(v_number) > 100 THEN
    RAISE EXCEPTION USING ERRCODE = 'CL400', MESSAGE = 'invalid_input';
  END IF;
  IF v_source = 'ocr' THEN
    IF p_document_sha256 IS NULL OR p_document_sha256 !~ '^[0-9a-f]{64}$' OR p_idempotency_key IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'CL400', MESSAGE = 'invalid_input';
    END IF;
  ELSE
    IF p_document_sha256 IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'CL400', MESSAGE = 'invalid_input';
    END IF;
    -- 手動登録には OCR の読み取り情報を持たせない（現行 API と同じ）
    v_vendor := NULL;
    v_number := NULL;
  END IF;

  -- ── 親の台帳項目をロック（自社のメンバーであること・削除済みの項目・案件でないこと） ──
  SELECT ci.project_id INTO v_project_id
  FROM public.cost_ledger_items ci
  JOIN public.projects p ON p.id = ci.project_id
  WHERE ci.id = p_item_id
    AND ci.deleted_at IS NULL
    AND p.deleted_at IS NULL
    AND p.company_id = ci.company_id
    -- SECURITY DEFINER では RLS に頼らない。呼び出したユーザーがこの会社のメンバーであることを明示的に確かめる
    AND EXISTS (SELECT 1 FROM public.company_members m
                WHERE m.company_id = ci.company_id AND m.user_id = auth.uid())
  FOR UPDATE OF ci;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'CL404', MESSAGE = 'not_found';
  END IF;

  -- ── 登録 ──
  INSERT INTO public.cost_ledger_invoices AS i (
    cost_ledger_item_id, project_id, amount, invoice_date, payment_date, note,
    source, vendor_name, invoice_number, document_sha256, idempotency_key
  ) VALUES (
    p_item_id, v_project_id, p_amount, p_invoice_date, p_payment_date, v_note,
    v_source, v_vendor, v_number, p_document_sha256, p_idempotency_key
  )
  RETURNING jsonb_build_object(
    'id', i.id, 'cost_ledger_item_id', i.cost_ledger_item_id, 'amount', i.amount,
    'invoice_date', i.invoice_date, 'payment_date', i.payment_date, 'note', i.note,
    'source', i.source, 'vendor_name', i.vendor_name, 'invoice_number', i.invoice_number,
    'created_at', i.created_at
  ) INTO v_invoice;

  -- ── 再集計（同じトランザクション。失敗すれば登録も取り消される） ──
  SELECT count(*), sum(i.amount::numeric) INTO v_count, v_total
  FROM public.cost_ledger_invoices i
  WHERE i.cost_ledger_item_id = p_item_id;

  UPDATE public.cost_ledger_items
  SET actual_cost = CASE WHEN v_count = 0 THEN NULL ELSE v_total END,
      updated_at  = now()
  WHERE id = p_item_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION USING ERRCODE = 'CL409', MESSAGE = 'inconsistent';
  END IF;

  RETURN jsonb_build_object(
    'invoice', v_invoice,
    'item_id', p_item_id,
    'actual_cost', CASE WHEN v_count = 0 THEN NULL ELSE v_total END,
    'invoice_count', v_count
  );
END
$$;

-- ============================================================
-- 編集
-- ============================================================
--
-- p_patch に含まれるキーだけを変更する（含まれないキーは変更しない。null は「空にする」）。
-- 変更できるのは amount / invoice_date / payment_date / note のみ（現行 PATCH API と同じ）。
-- cost_ledger_item_id・project_id・source・画像ハッシュ・idempotency_key などは変更できない
-- （別の台帳項目への移動はできない）。それ以外のキーが含まれていたら何も変更せずに CL400。

CREATE OR REPLACE FUNCTION public.cost_ledger_invoice_update(
  p_invoice_id uuid,
  p_patch      jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '5s'
AS $$
DECLARE
  v_item_id      uuid;
  v_project_id   uuid;
  v_inv_item_id  uuid;
  v_inv_project  uuid;
  v_has_amount   boolean;
  v_has_inv_date boolean;
  v_has_pay_date boolean;
  v_has_note     boolean;
  v_amount       numeric;
  v_inv_date     date;
  v_pay_date     date;
  v_note         text;
  v_invoice      jsonb;
  v_count        bigint;
  v_total        numeric;
  v_rows         int;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'CL401', MESSAGE = 'unauthenticated';
  END IF;

  -- ── 入力の検証（ロックを取る前に済ませる） ──
  IF p_invoice_id IS NULL OR p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object'
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_patch) k
                WHERE k NOT IN ('amount', 'invoice_date', 'payment_date', 'note'))
     OR NOT EXISTS (SELECT 1 FROM jsonb_object_keys(p_patch)) THEN
    RAISE EXCEPTION USING ERRCODE = 'CL400', MESSAGE = 'invalid_input';
  END IF;

  v_has_amount   := p_patch ? 'amount';
  v_has_inv_date := p_patch ? 'invoice_date';
  v_has_pay_date := p_patch ? 'payment_date';
  v_has_note     := p_patch ? 'note';

  BEGIN
    IF v_has_amount THEN
      -- 文字列の数値も受け付けない（JSON の数値のみ）。numeric のまま扱い、浮動小数点を経由しない
      IF jsonb_typeof(p_patch -> 'amount') <> 'number' THEN
        RAISE EXCEPTION USING ERRCODE = 'CL400', MESSAGE = 'invalid_input';
      END IF;
      v_amount := (p_patch ->> 'amount')::numeric;
      IF v_amount = 0 OR abs(v_amount) >= 1000000000000 THEN
        RAISE EXCEPTION USING ERRCODE = 'CL400', MESSAGE = 'invalid_input';
      END IF;
    END IF;
    IF v_has_inv_date THEN
      IF jsonb_typeof(p_patch -> 'invoice_date') NOT IN ('string', 'null') THEN
        RAISE EXCEPTION USING ERRCODE = 'CL400', MESSAGE = 'invalid_input';
      END IF;
      IF nullif(p_patch ->> 'invoice_date', '') IS NOT NULL THEN
        IF (p_patch ->> 'invoice_date') !~ '^\d{4}-\d{2}-\d{2}$' THEN
          RAISE EXCEPTION USING ERRCODE = 'CL400', MESSAGE = 'invalid_input';
        END IF;
        v_inv_date := (p_patch ->> 'invoice_date')::date;
      END IF;
    END IF;
    IF v_has_pay_date THEN
      IF jsonb_typeof(p_patch -> 'payment_date') NOT IN ('string', 'null') THEN
        RAISE EXCEPTION USING ERRCODE = 'CL400', MESSAGE = 'invalid_input';
      END IF;
      IF nullif(p_patch ->> 'payment_date', '') IS NOT NULL THEN
        IF (p_patch ->> 'payment_date') !~ '^\d{4}-\d{2}-\d{2}$' THEN
          RAISE EXCEPTION USING ERRCODE = 'CL400', MESSAGE = 'invalid_input';
        END IF;
        v_pay_date := (p_patch ->> 'payment_date')::date;
      END IF;
    END IF;
    IF v_has_note THEN
      IF jsonb_typeof(p_patch -> 'note') NOT IN ('string', 'null') THEN
        RAISE EXCEPTION USING ERRCODE = 'CL400', MESSAGE = 'invalid_input';
      END IF;
      v_note := nullif(btrim(p_patch ->> 'note'), '');
      IF length(v_note) > 500 THEN
        RAISE EXCEPTION USING ERRCODE = 'CL400', MESSAGE = 'invalid_input';
      END IF;
    END IF;
  EXCEPTION
    -- 日付・数値の変換エラー（存在しない日付など）は内部エラーを出さずに CL400 にする
    WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_text_representation
         OR numeric_value_out_of_range THEN
      RAISE EXCEPTION USING ERRCODE = 'CL400', MESSAGE = 'invalid_input';
  END;

  -- ── 対象の請求書から親の台帳項目を知る（他社の請求書でも見つかるが、次の親の確認で CL404 になる） ──
  SELECT i.cost_ledger_item_id INTO v_item_id
  FROM public.cost_ledger_invoices i
  WHERE i.id = p_invoice_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'CL404', MESSAGE = 'not_found';
  END IF;

  -- ── 親の台帳項目をロック → 請求書をロック（順序は常に 台帳項目 → 請求書） ──
  SELECT ci.project_id INTO v_project_id
  FROM public.cost_ledger_items ci
  JOIN public.projects p ON p.id = ci.project_id
  WHERE ci.id = v_item_id
    AND ci.deleted_at IS NULL
    AND p.deleted_at IS NULL
    AND p.company_id = ci.company_id
    -- SECURITY DEFINER では RLS に頼らない。呼び出したユーザーがこの会社のメンバーであることを明示的に確かめる
    AND EXISTS (SELECT 1 FROM public.company_members m
                WHERE m.company_id = ci.company_id AND m.user_id = auth.uid())
  FOR UPDATE OF ci;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'CL404', MESSAGE = 'not_found';
  END IF;

  SELECT i.cost_ledger_item_id, i.project_id INTO v_inv_item_id, v_inv_project
  FROM public.cost_ledger_invoices i
  WHERE i.id = p_invoice_id
  FOR UPDATE;
  IF NOT FOUND THEN
    -- ロック待ちの間に削除された
    RAISE EXCEPTION USING ERRCODE = 'CL404', MESSAGE = 'not_found';
  END IF;
  -- ロック待ちの間に別の項目へ付け替えられた・案件が食い違う（既存行は project_id が NULL のことがある）
  IF v_inv_item_id IS DISTINCT FROM v_item_id
     OR (v_inv_project IS NOT NULL AND v_inv_project IS DISTINCT FROM v_project_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'CL409', MESSAGE = 'inconsistent';
  END IF;

  -- ── 変更 ──
  UPDATE public.cost_ledger_invoices AS i
  SET amount       = CASE WHEN v_has_amount   THEN v_amount   ELSE i.amount       END,
      invoice_date = CASE WHEN v_has_inv_date THEN v_inv_date ELSE i.invoice_date END,
      payment_date = CASE WHEN v_has_pay_date THEN v_pay_date ELSE i.payment_date END,
      note         = CASE WHEN v_has_note     THEN v_note     ELSE i.note         END
  WHERE i.id = p_invoice_id
  RETURNING jsonb_build_object(
    'id', i.id, 'cost_ledger_item_id', i.cost_ledger_item_id, 'amount', i.amount,
    'invoice_date', i.invoice_date, 'payment_date', i.payment_date, 'note', i.note,
    'source', i.source, 'vendor_name', i.vendor_name, 'invoice_number', i.invoice_number,
    'created_at', i.created_at
  ) INTO v_invoice;
  IF v_invoice IS NULL THEN
    -- 更新できなかった（ロック後なので通常は起きない）
    RAISE EXCEPTION USING ERRCODE = 'CL404', MESSAGE = 'not_found';
  END IF;

  -- ── 再集計 ──
  SELECT count(*), sum(i.amount::numeric) INTO v_count, v_total
  FROM public.cost_ledger_invoices i
  WHERE i.cost_ledger_item_id = v_item_id;

  UPDATE public.cost_ledger_items
  SET actual_cost = CASE WHEN v_count = 0 THEN NULL ELSE v_total END,
      updated_at  = now()
  WHERE id = v_item_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION USING ERRCODE = 'CL409', MESSAGE = 'inconsistent';
  END IF;

  RETURN jsonb_build_object(
    'invoice', v_invoice,
    'item_id', v_item_id,
    'actual_cost', CASE WHEN v_count = 0 THEN NULL ELSE v_total END,
    'invoice_count', v_count
  );
END
$$;

-- ============================================================
-- 削除
-- ============================================================
--
-- 最後の1件を削除したら actual_cost は NULL に戻す（現行 DELETE API と同じ。
-- 請求書を登録する前の直接入力値・初期値には戻らない）。

CREATE OR REPLACE FUNCTION public.cost_ledger_invoice_delete(
  p_invoice_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '5s'
AS $$
DECLARE
  v_item_id     uuid;
  v_project_id  uuid;
  v_inv_item_id uuid;
  v_inv_project uuid;
  v_count       bigint;
  v_total       numeric;
  v_rows        int;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'CL401', MESSAGE = 'unauthenticated';
  END IF;
  IF p_invoice_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'CL400', MESSAGE = 'invalid_input';
  END IF;

  SELECT i.cost_ledger_item_id INTO v_item_id
  FROM public.cost_ledger_invoices i
  WHERE i.id = p_invoice_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'CL404', MESSAGE = 'not_found';
  END IF;

  SELECT ci.project_id INTO v_project_id
  FROM public.cost_ledger_items ci
  JOIN public.projects p ON p.id = ci.project_id
  WHERE ci.id = v_item_id
    AND ci.deleted_at IS NULL
    AND p.deleted_at IS NULL
    AND p.company_id = ci.company_id
    -- SECURITY DEFINER では RLS に頼らない。呼び出したユーザーがこの会社のメンバーであることを明示的に確かめる
    AND EXISTS (SELECT 1 FROM public.company_members m
                WHERE m.company_id = ci.company_id AND m.user_id = auth.uid())
  FOR UPDATE OF ci;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'CL404', MESSAGE = 'not_found';
  END IF;

  SELECT i.cost_ledger_item_id, i.project_id INTO v_inv_item_id, v_inv_project
  FROM public.cost_ledger_invoices i
  WHERE i.id = p_invoice_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'CL404', MESSAGE = 'not_found';
  END IF;
  IF v_inv_item_id IS DISTINCT FROM v_item_id
     OR (v_inv_project IS NOT NULL AND v_inv_project IS DISTINCT FROM v_project_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'CL409', MESSAGE = 'inconsistent';
  END IF;

  DELETE FROM public.cost_ledger_invoices i WHERE i.id = p_invoice_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    -- 削除できなかった（ロック後なので通常は起きない）
    RAISE EXCEPTION USING ERRCODE = 'CL404', MESSAGE = 'not_found';
  END IF;

  SELECT count(*), sum(i.amount::numeric) INTO v_count, v_total
  FROM public.cost_ledger_invoices i
  WHERE i.cost_ledger_item_id = v_item_id;

  UPDATE public.cost_ledger_items
  SET actual_cost = CASE WHEN v_count = 0 THEN NULL ELSE v_total END,
      updated_at  = now()
  WHERE id = v_item_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION USING ERRCODE = 'CL409', MESSAGE = 'inconsistent';
  END IF;

  RETURN jsonb_build_object(
    'deleted_id', p_invoice_id,
    'item_id', v_item_id,
    'actual_cost', CASE WHEN v_count = 0 THEN NULL ELSE v_total END,
    'invoice_count', v_count
  );
END
$$;

-- ── 実行権限：ログイン済みユーザー（authenticated）のみ（P1-2 と同じ。CREATE OR REPLACE は権限を保つが明示する） ──
REVOKE ALL ON FUNCTION public.cost_ledger_invoice_insert(uuid, numeric, date, date, text, text, text, text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cost_ledger_invoice_update(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cost_ledger_invoice_delete(uuid) FROM PUBLIC;

DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.cost_ledger_invoice_insert(uuid, numeric, date, date, text, text, text, text, text, uuid) FROM %I', r);
      EXECUTE format('REVOKE ALL ON FUNCTION public.cost_ledger_invoice_update(uuid, jsonb) FROM %I', r);
      EXECUTE format('REVOKE ALL ON FUNCTION public.cost_ledger_invoice_delete(uuid) FROM %I', r);
    END IF;
  END LOOP;
END
$$;

GRANT EXECUTE ON FUNCTION public.cost_ledger_invoice_insert(uuid, numeric, date, date, text, text, text, text, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cost_ledger_invoice_update(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cost_ledger_invoice_delete(uuid) TO authenticated;

-- ── 請求書テーブルへの直接書き込みを取り消す（読み取り = SELECT は残す） ──
-- テーブル単位の REVOKE は列単位の権限も取り消す。
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.cost_ledger_invoices FROM PUBLIC;
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.cost_ledger_invoices FROM %I', r);
    END IF;
  END LOOP;
END
$$;

COMMENT ON FUNCTION public.cost_ledger_invoice_insert(uuid, numeric, date, date, text, text, text, text, text, uuid) IS
  '業者請求書を1件登録し、同じトランザクションで親の actual_cost を内訳合計に更新する（SECURITY DEFINER / 会社メンバーを明示確認 / 親行をロック）';
COMMENT ON FUNCTION public.cost_ledger_invoice_update(uuid, jsonb) IS
  '業者請求書の amount / invoice_date / payment_date / note を変更し、同じトランザクションで親の actual_cost を再集計する（SECURITY DEFINER / 会社メンバーを明示確認）';
COMMENT ON FUNCTION public.cost_ledger_invoice_delete(uuid) IS
  '業者請求書を削除し、同じトランザクションで親の actual_cost を再集計する（0件なら NULL。SECURITY DEFINER / 会社メンバーを明示確認）';
