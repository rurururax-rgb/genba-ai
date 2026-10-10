/**
 * DB 検証テスト用の隔離 PostgreSQL（embedded-postgres）。
 *
 * - OS の一時ディレクトリに使い捨てのクラスタを作り、127.0.0.1 の空きポートで起動する。
 *   本番・Preview の Supabase には一切接続しない（接続先はこのプロセスが起動したローカル DB のみ）。
 * - Supabase のうちテストに必要な部分だけを再現する：
 *     ロール anon / authenticated / service_role（BYPASSRLS）、auth.uid()（request.jwt.claim.sub）、
 *     public schema の既定の権限付与、get_my_company_ids()、companies / company_members / projects。
 * - cost_ledger_invoices の元の CREATE TABLE はリポジトリの migration に無い（本番で直接作られた）。
 *   ここでは現行 API が使う列だけを持つ「代用の定義」を置く（BASE_INVOICES_SQL）。
 *   本番の実際の定義・RLS ポリシーは適用前の確認 SQL（docs/db/p1-2-atomic-cost-ledger-invoice-writes.md）で確かめる。
 * - その上にリポジトリの実際の migration ファイルを順に適用する。
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import EmbeddedPostgres from 'embedded-postgres'
import { Client } from 'pg'

const MIGRATIONS = path.resolve(__dirname, '../../../supabase/migrations')

export const MIGRATION_COST_LEDGER_ITEMS = '20260912000001_reconcile_cost_ledger_items.sql'
export const MIGRATION_P1_1 = '20261010000001_add_dedupe_keys_to_cost_ledger_invoices.sql'
export const MIGRATION_P1_2 = '20261010000002_atomic_cost_ledger_invoice_writes.sql'
export const MIGRATION_P1_3 = '20261011000001_lock_actual_cost_with_invoices.sql'

export function readMigration(name: string): string {
  return readFileSync(path.join(MIGRATIONS, name), 'utf8')
}

/** Supabase の土台（テストに必要な部分だけ） */
export const SUPABASE_STUB_SQL = `
-- ロールはクラスタ共通なので、2つ目以降のデータベースでは作成済み
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

-- Supabase と同じく、public に作られるテーブル・関数には3ロールへ既定で権限が付く
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;

CREATE TABLE companies (
  id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL
);
CREATE TABLE company_members (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES companies(id) ON DELETE CASCADE,
  user_id    uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  role       text DEFAULT 'member',
  UNIQUE (company_id, user_id)
);
CREATE TABLE projects (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES companies(id) ON DELETE CASCADE,
  name       text NOT NULL DEFAULT '新規現調',
  deleted_at timestamptz
);
CREATE TABLE estimate_items (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE
);

CREATE FUNCTION get_my_company_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
  $$ SELECT company_id FROM company_members WHERE user_id = auth.uid() $$;

ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
CREATE POLICY "自社データのみ" ON companies FOR ALL USING (id IN (SELECT get_my_company_ids()));
ALTER TABLE company_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY "自社データのみ" ON company_members FOR ALL USING (company_id IN (SELECT get_my_company_ids()));
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY "自社データのみ" ON projects FOR ALL USING (company_id IN (SELECT get_my_company_ids()));
ALTER TABLE estimate_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "自社データのみ" ON estimate_items FOR ALL USING (
  project_id IN (SELECT id FROM projects)
);
`

/**
 * cost_ledger_invoices の代用の定義（P1-1 より前の形）。
 * 列は現行 API が読み書きする列だけ。RLS は「親の台帳項目が見えること」（親は会社所属で絞られる）。
 */
export const BASE_INVOICES_SQL = `
CREATE TABLE cost_ledger_invoices (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cost_ledger_item_id uuid NOT NULL REFERENCES cost_ledger_items(id) ON DELETE CASCADE,
  project_id          uuid REFERENCES projects(id) ON DELETE CASCADE,
  amount              numeric NOT NULL,
  invoice_date        date,
  payment_date        date,
  note                text,
  created_at          timestamptz DEFAULT now()
);
ALTER TABLE cost_ledger_invoices ENABLE ROW LEVEL SECURITY;
CREATE POLICY "自社データのみ" ON cost_ledger_invoices FOR ALL USING (
  cost_ledger_item_id IN (SELECT id FROM cost_ledger_items)
);
`

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })
}

export type LocalPostgres = {
  /** 新しい接続（superuser。テストでは SET LOCAL ROLE で権限を落として使う） */
  connect: (database?: string) => Promise<Client>
  createDatabase: (name: string) => Promise<void>
  stop: () => Promise<void>
}

export async function startLocalPostgres(): Promise<LocalPostgres> {
  const dir = mkdtempSync(path.join(tmpdir(), 'ragz-pg-'))
  const port = await freePort()
  // ローカルの使い捨てクラスタ専用の値（外部に公開しない・本番とは無関係）
  const password = 'local-test-only'
  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    user: 'postgres',
    password,
    port,
    persistent: false,
    onLog: () => {},
    onError: () => {},
    postgresFlags: ['-c', 'listen_addresses=127.0.0.1', '-c', 'deadlock_timeout=200ms'],
  })
  await pg.initialise()
  await pg.start()

  const clients: Client[] = []
  return {
    async connect(database = 'postgres') {
      const c = new Client({ host: '127.0.0.1', port, user: 'postgres', password, database })
      await c.connect()
      clients.push(c)
      return c
    },
    async createDatabase(name: string) {
      await pg.createDatabase(name)
    },
    async stop() {
      await Promise.allSettled(clients.map(c => c.end()))
      await pg.stop()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
