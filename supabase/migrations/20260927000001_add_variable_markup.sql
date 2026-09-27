-- ============================================================
-- 20260927000001_add_variable_markup.sql
--
-- 目的: Variable Markup 機能の DB 基盤を追加する
--
-- 追加内容:
--   projects.markup_rate               案件標準掛け率（DEFAULT 1.45）
--   estimate_items.markup_rate_override 明細個別掛け率（NULL = 案件標準を使用）
--   estimate_items.selling_price_mode   売価権威モード（'auto' | 'manual'）
--
-- 安全方針:
--   ・既存 selling_price は一切変更しない
--   ・既存 cost_price は一切変更しない
--   ・既存 estimate_items は全件 selling_price_mode='manual' で初期化
--   ・新規 estimate_items のデフォルトは selling_price_mode='auto'
--   ・既存 projects.markup_rate は 1.45 で初期化（既存金額に影響しない）
--   ・selling_price への TRIGGER / UPDATE は実行しない
--
-- STOP CONDITION:
--   この migration を実行する前に Production DB への適用は行わない
--   ローカル / Staging 検証後に人間が判断する
-- ============================================================


-- ──────────────────────────────────────────────────────────
-- 1. projects.markup_rate
--    案件単位の標準掛け率。既存案件は DEFAULT 1.45 で初期化される。
-- ──────────────────────────────────────────────────────────

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS markup_rate NUMERIC NOT NULL DEFAULT 1.45;

-- バリデーション制約（冪等: 既に存在する場合はスキップ）
DO $$ BEGIN
  ALTER TABLE projects
    ADD CONSTRAINT projects_markup_rate_check
      CHECK (markup_rate >= 0.01 AND markup_rate <= 9.99);
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

COMMENT ON COLUMN projects.markup_rate IS
  '案件標準掛け率（selling_price = cost_price × markup_rate）。0.01〜9.99の範囲。';


-- ──────────────────────────────────────────────────────────
-- 2. estimate_items.markup_rate_override
--    明細ごとの個別掛け率。NULL = 案件標準を使用。
-- ──────────────────────────────────────────────────────────

ALTER TABLE estimate_items
  ADD COLUMN IF NOT EXISTS markup_rate_override NUMERIC;

-- NULL は許可（案件標準を使う意味）。値ありの場合のみバリデーション（冪等）
DO $$ BEGIN
  ALTER TABLE estimate_items
    ADD CONSTRAINT estimate_items_markup_rate_override_check
      CHECK (
        markup_rate_override IS NULL
        OR (markup_rate_override >= 0.01 AND markup_rate_override <= 9.99)
      );
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

COMMENT ON COLUMN estimate_items.markup_rate_override IS
  '明細個別掛け率。NULL=案件標準(projects.markup_rate)を使用。0.01〜9.99の範囲。';


-- ──────────────────────────────────────────────────────────
-- 3. estimate_items.selling_price_mode
--
--    既存行: 'manual' で初期化（selling_price を保護するため）
--    新規行: DEFAULT 'auto'（案件掛け率による自動計算）
--
--    3段階の手順:
--      3-1. NULL 許可で列追加（バックフィルのため）
--      3-2. 既存行を 'manual' で埋める（selling_price は変更しない）
--      3-3. NOT NULL + DEFAULT 'auto' を設定
--      3-4. CHECK 制約（DB レベルで許可値を限定）
--
--    将来 'import_original' 等を追加する場合は別 migration で
--    CHECK 制約を DROP → 再作成する。
-- ──────────────────────────────────────────────────────────

-- 3-1. NULL 許可で追加（既存行の backfill に必要）
ALTER TABLE estimate_items
  ADD COLUMN IF NOT EXISTS selling_price_mode TEXT;

-- 3-2. 既存行を 'manual' で初期化
--      selling_price / cost_price / amount は一切変更しない
UPDATE estimate_items
   SET selling_price_mode = 'manual'
 WHERE selling_price_mode IS NULL;

-- 3-3. NOT NULL を設定（backfill 後なので全行が非 NULL のはず）
ALTER TABLE estimate_items
  ALTER COLUMN selling_price_mode SET NOT NULL;

-- 3-4. 新規行のデフォルトを 'auto' に設定
ALTER TABLE estimate_items
  ALTER COLUMN selling_price_mode SET DEFAULT 'auto';

-- 3-5. 許可値を DB 制約で保護（冪等）
DO $$ BEGIN
  ALTER TABLE estimate_items
    ADD CONSTRAINT estimate_items_selling_price_mode_check
      CHECK (selling_price_mode IN ('auto', 'manual'));
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

COMMENT ON COLUMN estimate_items.selling_price_mode IS
  '売価の権威: auto=掛け率×原価で自動計算、manual=ユーザー直接入力。将来 import_original 追加予定。';


-- ──────────────────────────────────────────────────────────
-- 4. RPC: apply_markup_rate_change
--
--    案件標準掛け率を変更し、対象の estimate_items の
--    selling_price を atomic に一括再計算する。
--
--    SECURITY INVOKER（デフォルト）:
--      呼び出しユーザーの RLS が適用されるため、
--      別会社の project_id を指定しても RLS でブロックされる。
--      admin.ts（service_role）経由では呼ばれない想定。
--
--    再計算対象（すべての条件を満たす行のみ）:
--      selling_price_mode  = 'auto'
--      markup_rate_override IS NULL
--      cost_price           IS NOT NULL
--      deleted_at           IS NULL
--
--    絶対に変更しない:
--      selling_price_mode = 'manual' の行
--      markup_rate_override IS NOT NULL の行
--      他プロジェクトの行（project_id フィルタ + RLS）
--      cost_price が NULL の行
--      quantity / amount（amount は selling_price 変更時に DB が自動再計算）
-- ──────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION apply_markup_rate_change(
  p_project_id UUID,
  p_new_rate   NUMERIC
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_old_rate      NUMERIC;
  v_updated_count INTEGER;
BEGIN
  -- ── Validation ──────────────────────────────────────────
  IF p_new_rate IS NULL THEN
    RAISE EXCEPTION 'markup_rate cannot be null';
  END IF;

  IF p_new_rate < 0.01 OR p_new_rate > 9.99 THEN
    RAISE EXCEPTION 'markup_rate must be between 0.01 and 9.99, got %', p_new_rate;
  END IF;

  -- ── 1. プロジェクト存在確認（RLS で自社チェック兼ねる） ─────
  SELECT markup_rate
    INTO v_old_rate
    FROM projects
   WHERE id = p_project_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Project not found or access denied: %', p_project_id;
  END IF;

  -- ── 2. projects.markup_rate を更新 ──────────────────────
  UPDATE projects
     SET markup_rate = p_new_rate,
         updated_at  = now()
   WHERE id = p_project_id;

  -- ── 3. 対象 estimate_items の selling_price を一括再計算 ──
  --   amount（GENERATED ALWAYS AS quantity * selling_price STORED）は
  --   selling_price の変更に連動して DB が自動再計算する。
  UPDATE estimate_items
     SET selling_price = ROUND(cost_price * p_new_rate),
         updated_at    = now()
   WHERE project_id           = p_project_id
     AND selling_price_mode   = 'auto'
     AND markup_rate_override IS NULL
     AND cost_price           IS NOT NULL
     AND deleted_at           IS NULL;

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;

  -- ── 4. 結果を返す（UI確認モーダル用） ────────────────────
  RETURN jsonb_build_object(
    'old_rate',      v_old_rate,
    'new_rate',      p_new_rate,
    'updated_count', v_updated_count
  );
END;
$$;

COMMENT ON FUNCTION apply_markup_rate_change(UUID, NUMERIC) IS
  '案件標準掛け率を変更し、selling_price_mode=auto かつ markup_rate_override IS NULL の明細を一括再計算する。SECURITY INVOKER: 呼び出しユーザーの RLS が適用される。';
