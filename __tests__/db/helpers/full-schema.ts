/**
 * リポジトリの migration を初期スキーマから順にすべて適用した DB（隔離ローカル PostgreSQL 上）を作る。
 *
 * 本番に近い全テーブル・RLS で API ルートを検証するためのもの。本番・Preview の DB には接続しない。
 * - Supabase の土台（ロール・auth.uid()・storage の最小限）だけを先に置く。
 * - データ投入だけの migration（デモ用データ・品目マスタの初期データ）と、初期スキーマとポリシーが重複する
 *   20260705000002_line_events.sql は除く。
 * - cost_ledger_items は本番で先に作られていたため、pg_trgm の検索関数は cost_ledger_items の後で流す。
 * - リポジトリに CREATE TABLE が無いテーブル（本番で直接作られた）は、現行 API が使う列だけの代用定義を置く：
 *     cost_ledger_invoices（BASE_INVOICES_SQL）、estimate_revisions・estimate_items.retail_price / row_type（ESTIMATE_REVISIONS_SQL）
 *   本番の実際の定義・RLS は適用前の読み取り専用 SQL で確かめる。
 */

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { Client } from 'pg'
import { BASE_INVOICES_SQL } from './local-postgres'

const MIGRATIONS = path.resolve(__dirname, '../../../supabase/migrations')

const SKIP = new Set([
  '20260705000002_line_events.sql',
  '20260711000001_demo_setup.sql',
  '20260711000006_seed_company_estimate_items.sql',
])
const TRGM = '20260815000000_add_pg_trgm_search_functions.sql'
const COST_LEDGER_ITEMS = '20260912000001_reconcile_cost_ledger_items.sql'

const BASE_SQL = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE SCHEMA storage;
CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean);
CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text, owner uuid);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array(name, '/') $$;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
`

/** estimate_revisions の代用定義（app/api/estimate-revisions が読み書きする列だけ。RLS は他テーブルと同じ形） */
export const ESTIMATE_REVISIONS_SQL = `
CREATE TABLE estimate_revisions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid REFERENCES projects(id) ON DELETE CASCADE,
  company_id        uuid REFERENCES companies(id),
  rev_number        int NOT NULL,
  label             text,
  snapshot          jsonb NOT NULL,
  subtotal          numeric,
  misc_expense      numeric,
  rounding_discount numeric,
  tax_amount        numeric,
  total             numeric,
  created_at        timestamptz DEFAULT now()
);
ALTER TABLE estimate_revisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "自社データのみ" ON estimate_revisions FOR ALL USING (
  company_id IN (SELECT company_id FROM company_members WHERE user_id = auth.uid())
);
-- estimate_items.retail_price / row_type もリポジトリの migration に無い（本番で直接追加された）。見積履歴の保存が読む
ALTER TABLE estimate_items ADD COLUMN IF NOT EXISTS retail_price numeric;
ALTER TABLE estimate_items ADD COLUMN IF NOT EXISTS row_type text DEFAULT 'item';
`

export async function applyFullSchema(c: Client): Promise<void> {
  await c.query(BASE_SQL)
  const order: string[] = []
  for (const f of readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql') && !SKIP.has(f)).sort()) {
    if (f === TRGM) continue
    order.push(f)
    if (f === COST_LEDGER_ITEMS) order.push('__BASE_INVOICES__', TRGM)
  }
  for (const f of order) {
    const sql = f === '__BASE_INVOICES__' ? BASE_INVOICES_SQL : readFileSync(path.join(MIGRATIONS, f), 'utf8')
    try {
      await c.query('BEGIN')
      await c.query(sql)
      await c.query('COMMIT')
    } catch (e) {
      await c.query('ROLLBACK')
      throw new Error(`migration ${f} failed: ${(e as Error).message}`)
    }
  }
  await c.query(ESTIMATE_REVISIONS_SQL)
}
