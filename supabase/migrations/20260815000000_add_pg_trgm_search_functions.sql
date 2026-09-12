-- ============================================================
-- pg_trgm 有効化 + チャットエージェント用 RPC 関数 3本
-- ============================================================
-- 実行場所: Supabase ダッシュボード > SQL Editor
-- SECURITY INVOKER = 呼び出しユーザーの RLS が適用される（admin.ts 不使用）
-- ============================================================

-- 1. estimate_items に内部管理カラムを追加（存在しない場合のみ）
ALTER TABLE estimate_items ADD COLUMN IF NOT EXISTS cost_price   NUMERIC;
ALTER TABLE estimate_items ADD COLUMN IF NOT EXISTS vendor_name  TEXT;

-- 2. 拡張機能の有効化
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 3. トライグラムインデックス（日本語は文字数が少ないため GIN を推奨）
CREATE INDEX IF NOT EXISTS estimate_items_name_trgm_idx
  ON estimate_items USING gin (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS company_estimate_items_name_trgm_idx
  ON company_estimate_items USING gin (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS cost_ledger_items_name_trgm_idx
  ON cost_ledger_items USING gin (name gin_trgm_ops);

-- ============================================================
-- RPC ① : search_estimate_items
-- 案件の見積項目を pg_trgm 曖昧検索
-- ============================================================
CREATE OR REPLACE FUNCTION search_estimate_items(
  p_project_id  UUID,
  p_query       TEXT,
  p_limit       INT     DEFAULT 10,
  p_threshold   FLOAT   DEFAULT 0.15,
  p_group_id    UUID    DEFAULT NULL
)
RETURNS TABLE (
  id            UUID,
  name          TEXT,
  quantity      NUMERIC,
  unit          TEXT,
  selling_price NUMERIC,
  amount        NUMERIC,
  cost_price    NUMERIC,
  vendor_name   TEXT,
  group_id      UUID,
  group_label   TEXT,
  source        TEXT,
  memo          TEXT,
  _similarity   FLOAT
)
LANGUAGE sql
STABLE
-- SECURITY INVOKER はデフォルトなので明示不要だが意図を示す
AS $$
  SELECT
    ei.id,
    ei.name,
    ei.quantity,
    ei.unit,
    ei.selling_price,
    ei.amount,
    ei.cost_price,
    ei.vendor_name,
    ei.group_id,
    eg.label          AS group_label,
    ei.source,
    ei.memo,
    similarity(ei.name, p_query)::FLOAT AS _similarity
  FROM estimate_items ei
  LEFT JOIN estimate_groups eg ON eg.id = ei.group_id
  WHERE ei.project_id    = p_project_id
    AND ei.deleted_at    IS NULL
    AND similarity(ei.name, p_query) >= p_threshold
    AND (p_group_id IS NULL OR ei.group_id = p_group_id)
  ORDER BY _similarity DESC
  LIMIT p_limit;
$$;

-- ============================================================
-- RPC ② : search_catalog_items
-- 自社カタログ（company_estimate_items）を pg_trgm 曖昧検索
-- company_id は RLS が auth.uid() 経由で絞り込むため引数不要だが、
-- インデックス効率のため明示的に渡す
-- ============================================================
CREATE OR REPLACE FUNCTION search_catalog_items(
  p_company_id UUID,
  p_query      TEXT,
  p_limit      INT     DEFAULT 10,
  p_threshold  FLOAT   DEFAULT 0.20,
  p_category   TEXT    DEFAULT NULL
)
RETURNS TABLE (
  id            UUID,
  name          TEXT,
  category      TEXT,
  unit          TEXT,
  cost_price    NUMERIC,
  selling_price NUMERIC,
  usage_count   INT,
  last_used_at  TIMESTAMPTZ,
  _similarity   FLOAT
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    id,
    name,
    category,
    unit,
    cost_price,
    selling_price,
    usage_count,
    last_used_at,
    similarity(name, p_query)::FLOAT AS _similarity
  FROM company_estimate_items
  WHERE company_id = p_company_id
    AND similarity(name, p_query) >= p_threshold
    AND (p_category IS NULL OR category = p_category)
  ORDER BY _similarity DESC, usage_count DESC
  LIMIT p_limit;
$$;

-- ============================================================
-- RPC ③ : search_cost_ledger_items
-- 原価台帳（cost_ledger_items）を pg_trgm 曖昧検索
-- 品名・業者名の両方を対象にする
-- ============================================================
CREATE OR REPLACE FUNCTION search_cost_ledger_items(
  p_project_id UUID,
  p_query      TEXT,
  p_limit      INT   DEFAULT 10,
  p_threshold  FLOAT DEFAULT 0.15
)
RETURNS TABLE (
  id               UUID,
  name             TEXT,
  quantity         NUMERIC,
  unit             TEXT,
  estimate_cost    NUMERIC,
  budget_cost      NUMERIC,
  actual_cost      NUMERIC,
  vendor_name      TEXT,
  note             TEXT,
  estimate_item_id UUID,
  _similarity      FLOAT
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    id,
    name,
    quantity,
    unit,
    estimate_cost,
    budget_cost,
    actual_cost,
    vendor_name,
    note,
    estimate_item_id,
    GREATEST(
      similarity(name, p_query),
      similarity(COALESCE(vendor_name, ''), p_query)
    )::FLOAT AS _similarity
  FROM cost_ledger_items
  WHERE project_id = p_project_id
    AND deleted_at IS NULL
    AND GREATEST(
      similarity(name, p_query),
      similarity(COALESCE(vendor_name, ''), p_query)
    ) >= p_threshold
  ORDER BY _similarity DESC
  LIMIT p_limit;
$$;
