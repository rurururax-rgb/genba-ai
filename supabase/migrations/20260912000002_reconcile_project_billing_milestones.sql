-- ============================================================
-- 20260912000002_reconcile_project_billing_milestones.sql
--
-- 目的: project_billing_milestones は本番DBに既に存在するが、
--       Migration 履歴には存在しない。リコンシリエーション。
--
-- 安全方針: CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS のみ。
--   DROP / DELETE / TRUNCATE / destructive ALTER は実行しない。
--
-- コードから確認したカラム（APIコード照合済み）:
--   id, project_id, company_id, type, sort_order,
--   invoice_date, invoice_amount,
--   payment_date, payment_amount,
--   fee, created_at, updated_at
--
-- 本番DBとの差異:
--   - updated_at は PATCH API で使用されているため追加。
-- ============================================================

-- ── テーブル本体 ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS project_billing_milestones (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  company_id     UUID REFERENCES companies(id),

  -- マイルストーン種別（契約金 / 着工金 / 中間金 / 完工金）
  type           TEXT,
  sort_order     INT DEFAULT 0,

  -- 請求
  invoice_date   DATE,
  invoice_amount NUMERIC,

  -- 入金
  payment_date   DATE,
  payment_amount NUMERIC,

  -- 手数料
  fee            NUMERIC,

  created_at     TIMESTAMPTZ DEFAULT now(),
  updated_at     TIMESTAMPTZ DEFAULT now()
);

-- ── 既存テーブルへの列補完 ────────────────────────────────

ALTER TABLE project_billing_milestones
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

-- ── インデックス ──────────────────────────────────────────

CREATE INDEX IF NOT EXISTS project_billing_milestones_project_id_idx
  ON project_billing_milestones(project_id);

CREATE INDEX IF NOT EXISTS project_billing_milestones_company_id_idx
  ON project_billing_milestones(company_id);

-- ── RLS ──────────────────────────────────────────────────
--
-- ENABLE ROW LEVEL SECURITY は既に有効な場合も無害（冪等）。
-- policy は DROP IF EXISTS → CREATE で正しい定義に統一する。
-- get_my_company_ids() はプロジェクト標準の SECURITY DEFINER 関数。

ALTER TABLE project_billing_milestones ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "自社データのみ" ON project_billing_milestones;

CREATE POLICY "自社データのみ" ON project_billing_milestones
  FOR ALL USING (
    company_id IN (SELECT get_my_company_ids())
  );
