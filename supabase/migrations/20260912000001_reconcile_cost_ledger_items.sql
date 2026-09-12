-- ============================================================
-- 20260912000001_reconcile_cost_ledger_items.sql
--
-- 目的: cost_ledger_items は本番DBに既に存在するが、
--       Migration 履歴には存在しない。このファイルは
--       既存本番テーブルを Migration 管理下へ取り込む
--       「リコンシリエーション」として作成した。
--
-- 安全方針:
--   - CREATE TABLE IF NOT EXISTS: 既存テーブルはスキップ
--   - ADD COLUMN IF NOT EXISTS: 既存列への影響なし
--   - DROP / DELETE / TRUNCATE / destructive ALTER は実行しない
--   - 既存データは一切変更しない
--
-- コードから確認した使用カラム（APIコード照合済み）:
--   id, project_id, company_id, estimate_item_id,
--   name, quantity, unit,
--   estimate_cost, budget_cost, completion_cost, actual_cost,
--   note, vendor_name, sort_order, source,
--   deleted_at, created_at, updated_at
--
-- 本番DBとの差異:
--   - deleted_at, updated_at カラムは API コードで使用されているが、
--     初期 schema には定義がないため ADD COLUMN IF NOT EXISTS で補完。
--   - completion_cost は init/route.ts の INSERT には含まれないが
--     PATCH/select で使用されているため定義に含める。
-- ============================================================

-- ── テーブル本体 ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cost_ledger_items (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  company_id       UUID REFERENCES companies(id),

  -- 見積参照（スナップショット）
  estimate_item_id UUID REFERENCES estimate_items(id) ON DELETE SET NULL,

  -- 項目情報
  name             TEXT NOT NULL,
  quantity         NUMERIC DEFAULT 1,
  unit             TEXT DEFAULT '式',

  -- 原価フェーズ（estimate_cost は読取専用スナップショット）
  estimate_cost    NUMERIC,   -- 見積原価（estimate_items.cost_price × quantity）
  budget_cost      NUMERIC,   -- 実行予算
  completion_cost  NUMERIC,   -- 完工予算
  actual_cost      NUMERIC,   -- 実際原価（cost_ledger_invoices の合計、または直接入力）

  -- メタデータ
  note             TEXT,
  vendor_name      TEXT,
  sort_order       INT DEFAULT 0,
  source           TEXT DEFAULT 'manual',  -- 'manual' | 'from_estimate'

  -- 論理削除・タイムスタンプ
  deleted_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now()
);

-- ── 既存テーブルへの列補完（IF NOT EXISTS で安全に追加）──

ALTER TABLE cost_ledger_items
  ADD COLUMN IF NOT EXISTS estimate_item_id UUID REFERENCES estimate_items(id) ON DELETE SET NULL;

ALTER TABLE cost_ledger_items
  ADD COLUMN IF NOT EXISTS completion_cost NUMERIC;

ALTER TABLE cost_ledger_items
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

ALTER TABLE cost_ledger_items
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

-- ── インデックス ──────────────────────────────────────────

CREATE INDEX IF NOT EXISTS cost_ledger_items_project_id_idx
  ON cost_ledger_items(project_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS cost_ledger_items_company_id_idx
  ON cost_ledger_items(company_id)
  WHERE deleted_at IS NULL;

-- ── RLS ──────────────────────────────────────────────────
--
-- ENABLE ROW LEVEL SECURITY は既に有効な場合も無害（冪等）。
--
-- policy は DROP IF EXISTS → CREATE で「同名なら正しい定義に上書き」する。
-- これにより:
--   - 同名 policy が存在しない場合: CREATE で追加
--   - 同名 policy が存在する場合 : DROP + CREATE で定義を正しい内容に更新
-- get_my_company_ids() はプロジェクト標準の SECURITY DEFINER 関数。
-- auth.uid() の直接参照より再帰呼び出しリスクが低く、キャッシュ効率が良い。

ALTER TABLE cost_ledger_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "自社データのみ" ON cost_ledger_items;

CREATE POLICY "自社データのみ" ON cost_ledger_items
  FOR ALL USING (
    company_id IN (SELECT get_my_company_ids())
  );
