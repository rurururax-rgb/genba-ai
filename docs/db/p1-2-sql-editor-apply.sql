-- =====================================================================
-- P1-2 本番適用スクリプト（Supabase SQL Editor 専用・手動実行）
--
-- ・supabase db push / supabase migration up では使わない（CLI は migration ファイルを直接使う）。
-- ・人間の承認後に、このファイルの全文を SQL Editor に貼り付けて 1 回だけ実行する。
-- ・全体を 1 つのトランザクションで実行する。途中のどこで失敗しても、関数・権限・migration 履歴は
--   1 つも残らない（エラーが出たら、続けて `ROLLBACK;` だけを実行してから状況を確認する）。
-- ・migration 履歴（supabase_migrations.schema_migrations）への登録は、関数の作成と検証が
--   すべて成功した場合だけ、同じトランザクションの最後で行う。「実体はあるが履歴が無い」状態を作らない。
-- ・「-- >>> MIGRATION BODY」から「-- <<< MIGRATION BODY」までは
--   supabase/migrations/20261010000002_atomic_cost_ledger_invoice_writes.sql と 1 文字も違わない
--   （npm run test:db で照合している）。
-- 手順の全体: docs/db/p1-2-atomic-cost-ledger-invoice-writes.md
-- =====================================================================

BEGIN;

-- ── 0. 適用前のガード（どれかに当てはまれば何もせずに止まる） ──
DO $guard$
BEGIN
  IF to_regclass('supabase_migrations.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'P1-2 apply aborted: supabase_migrations.schema_migrations not found';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'supabase_migrations' AND table_name = 'schema_migrations' AND column_name = 'version'
  ) THEN
    RAISE EXCEPTION 'P1-2 apply aborted: schema_migrations.version not found';
  END IF;
  -- 二重適用・二重登録の防止
  IF EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261010000002') THEN
    RAISE EXCEPTION 'P1-2 apply aborted: version 20261010000002 is already recorded';
  END IF;
  -- 同名の関数が既にあるなら、中身を確かめずに置き換えない
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('cost_ledger_invoice_insert', 'cost_ledger_invoice_update', 'cost_ledger_invoice_delete')
  ) THEN
    RAISE EXCEPTION 'P1-2 apply aborted: cost_ledger_invoice_* functions already exist (history is missing)';
  END IF;
END
$guard$;

-- >>> MIGRATION BODY
-- ============================================================
-- 業者請求書の登録・編集・削除と実績原価（actual_cost）の再集計を
-- 1つのトランザクションで行う RPC（P1-2 / DB 土台のみ）
--
-- 目的:
--   現行 API は「請求書の INSERT/UPDATE/DELETE」と「actual_cost の再集計」を
--   別々のリクエストで行うため、途中失敗や同時操作で actual_cost が内訳合計とずれうる。
--   この migration は、その2つを PostgreSQL の1トランザクションで行う関数を追加する。
--   アプリからの呼び出しは後続 PR #32 で行う（この migration だけではアプリの動作は変わらない）。
--
-- 追加する関数（すべて SECURITY INVOKER = 呼び出したユーザーの権限と RLS で動く）:
--   public.cost_ledger_invoice_insert(...)  … 請求書を1件登録し、親の actual_cost を再集計
--   public.cost_ledger_invoice_update(...)  … 請求書の金額・日付・備考を変更し、再集計
--   public.cost_ledger_invoice_delete(...)  … 請求書を削除し、再集計（0件になったら actual_cost = NULL）
--
-- 同時実行:
--   3関数とも最初に親の cost_ledger_items 行を SELECT ... FOR UPDATE でロックする。
--   同じ台帳項目への操作は直列化され、別の台帳項目への操作は互いを待たない。
--   ロックの順序は常に「台帳項目 → 請求書」なので、3関数どうしではデッドロックしない。
--   ロック待ちは lock_timeout = 5s で打ち切る（エラー 55P03。トランザクションごと取り消される）。
--
-- この migration で保証できないもの（PR #32 で対応する）:
--   ・この関数を通らない書き込み（現行の POST/PATCH/DELETE API、actual_cost の直接編集 PATCH、
--     AI チャットの変更確定）は親行をロックしない／内訳と無関係に actual_cost を書くため、
--     それらと同時に動くと actual_cost が内訳合計とずれうる
--
-- 安全方針:
--   - テーブル・列・制約・インデックス・RLS ポリシーは作成も変更もしない（関数の追加のみ）
--   - 既存データの UPDATE / DELETE / TRUNCATE なし
--   - 前提の列・一意インデックスが無い DB では、何も作らずにエラーで止まる（下の事前確認）
--   - EXECUTE は authenticated のみ。anon / service_role / PUBLIC からは実行できない
--   - search_path は空に固定し、すべて schema 修飾で参照する
--   - 想定内のエラーは独自の SQLSTATE（CL4xx）と短い英字の識別子だけを返す
--     （DB の内部情報を含めない。API 側で日本語メッセージに変換する）
--
-- エラーコード:
--   CL401 unauthenticated   … auth.uid() が無い
--   CL400 invalid_input     … 入力値が不正（金額 0・形式違い・許可されない列の変更など）
--   CL404 not_found         … 対象が無い・他社・削除済み（存在を区別して漏らさない）
--   CL409 inconsistent      … 請求書と台帳項目・案件の対応が食い違っている、再集計の対象行を更新できない
--   23505 unique_violation  … 同じ画像（同じ案件）・同じ idempotency_key（既存の一意インデックス）
--   55P03 lock_not_available… 同じ台帳項目のロック待ちが 5 秒を超えた
--   40P01 deadlock_detected … この関数を通らない書き込みとのデッドロック（再試行可能）
-- ============================================================

-- ── 事前確認：前提の列・インデックスが揃っていなければ何も作らずに止める ──
DO $$
DECLARE
  missing text[];
BEGIN
  SELECT array_agg(format('%s.%s', r.tbl, r.col) ORDER BY r.tbl, r.col) INTO missing
  FROM (VALUES
    ('cost_ledger_invoices', 'id'),
    ('cost_ledger_invoices', 'cost_ledger_item_id'),
    ('cost_ledger_invoices', 'project_id'),
    ('cost_ledger_invoices', 'amount'),
    ('cost_ledger_invoices', 'invoice_date'),
    ('cost_ledger_invoices', 'payment_date'),
    ('cost_ledger_invoices', 'note'),
    ('cost_ledger_invoices', 'source'),
    ('cost_ledger_invoices', 'vendor_name'),
    ('cost_ledger_invoices', 'invoice_number'),
    ('cost_ledger_invoices', 'document_sha256'),
    ('cost_ledger_invoices', 'idempotency_key'),
    ('cost_ledger_invoices', 'created_at'),
    ('cost_ledger_items', 'id'),
    ('cost_ledger_items', 'project_id'),
    ('cost_ledger_items', 'company_id'),
    ('cost_ledger_items', 'actual_cost'),
    ('cost_ledger_items', 'deleted_at'),
    ('cost_ledger_items', 'updated_at'),
    ('projects', 'id'),
    ('projects', 'company_id'),
    ('projects', 'deleted_at')
  ) AS r(tbl, col)
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.table_name = r.tbl AND c.column_name = r.col
  );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'P1-2 precondition failed: missing columns %', missing;
  END IF;

  -- P1-1（20261010000001）の一意インデックスが適用済みであること
  IF to_regclass('public.cost_ledger_invoices_idempotency_key_uq') IS NULL
     OR to_regclass('public.cost_ledger_invoices_project_sha256_ocr_uq') IS NULL THEN
    RAISE EXCEPTION 'P1-2 precondition failed: apply 20261010000001 first';
  END IF;

  -- auth.uid() があること（Supabase の標準関数）
  IF to_regprocedure('auth.uid()') IS NULL THEN
    RAISE EXCEPTION 'P1-2 precondition failed: auth.uid() not found';
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
SECURITY INVOKER
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

  -- ── 親の台帳項目をロック（RLS: 自社の行だけが見える。削除済みの項目・案件は対象外） ──
  SELECT ci.project_id INTO v_project_id
  FROM public.cost_ledger_items ci
  JOIN public.projects p ON p.id = ci.project_id
  WHERE ci.id = p_item_id
    AND ci.deleted_at IS NULL
    AND p.deleted_at IS NULL
    AND p.company_id = ci.company_id
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
SECURITY INVOKER
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

  -- ── 対象の請求書から親の台帳項目を知る（RLS: 他社の請求書は見えない） ──
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
    -- RLS の UPDATE ポリシーで更新できなかった
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
SECURITY INVOKER
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
    -- RLS の DELETE ポリシーで削除できなかった
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

-- ── 実行権限：ログイン済みユーザー（authenticated）のみ ──
-- Supabase は public schema の関数に anon / authenticated / service_role の EXECUTE を
-- 既定で付けるため、明示的に取り消す。service_role は RLS を回避するので実行させない。
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

COMMENT ON FUNCTION public.cost_ledger_invoice_insert(uuid, numeric, date, date, text, text, text, text, text, uuid) IS
  '業者請求書を1件登録し、同じトランザクションで親の actual_cost を内訳合計に更新する（SECURITY INVOKER / 親行をロック）';
COMMENT ON FUNCTION public.cost_ledger_invoice_update(uuid, jsonb) IS
  '業者請求書の amount / invoice_date / payment_date / note を変更し、同じトランザクションで親の actual_cost を再集計する';
COMMENT ON FUNCTION public.cost_ledger_invoice_delete(uuid) IS
  '業者請求書を削除し、同じトランザクションで親の actual_cost を再集計する（0件なら NULL）';
-- <<< MIGRATION BODY

-- ── 2. 作成結果をトランザクションの中で検証（失敗すれば全体を取り消す） ──
DO $verify$
DECLARE
  r record;
  n int := 0;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname, p.prosecdef, coalesce(p.proconfig, '{}') AS cfg
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('cost_ledger_invoice_insert', 'cost_ledger_invoice_update', 'cost_ledger_invoice_delete')
  LOOP
    n := n + 1;
    IF r.prosecdef THEN
      RAISE EXCEPTION 'P1-2 verify failed: % is SECURITY DEFINER', r.proname;
    END IF;
    IF NOT ('search_path=""' = ANY (r.cfg)) OR NOT ('lock_timeout=5s' = ANY (r.cfg)) THEN
      RAISE EXCEPTION 'P1-2 verify failed: % proconfig %', r.proname, r.cfg;
    END IF;
    IF NOT has_function_privilege('authenticated', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'P1-2 verify failed: authenticated cannot execute %', r.proname;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
       AND has_function_privilege('anon', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'P1-2 verify failed: anon can execute %', r.proname;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role')
       AND has_function_privilege('service_role', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'P1-2 verify failed: service_role can execute %', r.proname;
    END IF;
  END LOOP;
  IF n <> 3 THEN
    RAISE EXCEPTION 'P1-2 verify failed: expected 3 functions, found %', n;
  END IF;
END
$verify$;

-- ── 3. migration 履歴の登録（ここまで成功した場合だけ到達する） ──
-- version 列だけを必須とし、name 列は存在する場合だけ埋める（列の有無を推測しない）。
DO $history$
BEGIN
  INSERT INTO supabase_migrations.schema_migrations (version) VALUES ('20261010000002');
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'supabase_migrations' AND table_name = 'schema_migrations' AND column_name = 'name'
  ) THEN
    EXECUTE 'UPDATE supabase_migrations.schema_migrations SET name = $1 WHERE version = $2'
      USING 'atomic_cost_ledger_invoice_writes', '20261010000002';
  END IF;
END
$history$;

COMMIT;

-- ── 4. 最終照合（読み取りのみ。期待値: history_rows = 1, functions = 3） ──
SELECT
  (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '20261010000002') AS history_rows,
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('cost_ledger_invoice_insert', 'cost_ledger_invoice_update', 'cost_ledger_invoice_delete')) AS functions;
