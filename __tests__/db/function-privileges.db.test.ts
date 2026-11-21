/**
 * 限定試用前のセキュリティ修正: DB 関数の実行権限・search_path（20261121000001）と
 * 1 ユーザー 1 社の制約（20261121000002）の DB 検証。
 *
 * 実行: npm run test:db
 *   隔離されたローカル PostgreSQL（embedded-postgres）にリポジトリの全 migration を適用する。本番・Preview の DB には接続しない。
 *   rls_auto_enable() とイベントトリガー ensure_rls はリポジトリの migration に無い（本番で作られた）ため、
 *   本番と同じ定義をここで作る。データはすべて架空。
 *
 * 確かめること:
 *   - 修正前: ログイン済みの利用者が create_company_with_owner で 2 社目を作れる・anon が検索関数を実行できる（問題の再現）
 *   - 修正後: anon・authenticated・service_role は会社作成関数・イベントトリガー関数を実行できない。
 *     検索 4 関数は authenticated・service_role だけが実行でき、他社の ID を渡しても 0 件。
 *     get_my_company_ids()・RLS（public・storage）は従来どおり。イベントトリガーも動く。
 *   - 1 社制約: 2 社目の所属は拒否。所属の移動（DELETE → INSERT）は通る。2 社所属の行があれば migration は止まる。
 *   - SQL Editor 用の適用・ロールバックスクリプト
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readMigration, startLocalPostgres, type LocalPostgres } from './helpers/local-postgres'
import { applyFullSchema } from './helpers/full-schema'

const MIGRATION = '20261121000001_restrict_db_function_privileges.sql'
const MIGRATION_ONE_COMPANY = '20261121000002_one_company_per_user.sql'

const COMPANY_A = randomUUID()
const COMPANY_B = randomUUID()
const USER_A = randomUUID()
const USER_B = randomUUID()
const USER_MOVE = randomUUID()     // B 社の member。試用会社へ移す想定
const USER_NONE = randomUUID()     // どの会社にも所属しない
const PROJECT_A = randomUUID()
const PROJECT_B = randomUUID()

const SEARCH = {
  match: `public.match_estimate_items(uuid,text,integer,numeric)`,
  catalog: `public.search_catalog_items(uuid,text,integer,double precision,text)`,
  ledger: `public.search_cost_ledger_items(uuid,text,integer,double precision)`,
  estimate: `public.search_estimate_items(uuid,text,integer,double precision,uuid)`,
}

/** 本番の rls_auto_enable() とイベントトリガー（本番の定義を写したもの） */
const RLS_AUTO_ENABLE_SQL = `
CREATE FUNCTION public.rls_auto_enable() RETURNS event_trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog' AS $$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT * FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
      EXCEPTION WHEN OTHERS THEN
        RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     END IF;
  END LOOP;
END;
$$;
CREATE EVENT TRIGGER ensure_rls ON ddl_command_end
  WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
  EXECUTE FUNCTION public.rls_auto_enable();
`

let server: LocalPostgres
let dbSeq = 0

async function seed(c: Client) {
  await c.query('INSERT INTO auth.users (id) VALUES ($1), ($2), ($3), ($4)', [USER_A, USER_B, USER_MOVE, USER_NONE])
  await c.query('INSERT INTO companies (id, name) VALUES ($1, $2), ($3, $4)', [COMPANY_A, 'A社', COMPANY_B, 'B社'])
  await c.query(
    `INSERT INTO company_members (company_id, user_id, role) VALUES ($1, $2, 'owner'), ($3, $4, 'owner'), ($3, $5, 'member')`,
    [COMPANY_A, USER_A, COMPANY_B, USER_B, USER_MOVE],
  )
  await c.query(`INSERT INTO projects (id, company_id, name) VALUES ($1, $2, 'A社の案件'), ($3, $4, 'B社の秘密案件')`,
    [PROJECT_A, COMPANY_A, PROJECT_B, COMPANY_B])
  await c.query(
    `INSERT INTO estimate_items (project_id, company_id, name, quantity, unit, selling_price) VALUES
       ($1, $2, 'システムバス交換', 1, '式', 100000), ($3, $4, 'システムバス交換', 1, '式', 999999)`,
    [PROJECT_A, COMPANY_A, PROJECT_B, COMPANY_B])
  await c.query(
    `INSERT INTO cost_ledger_items (project_id, company_id, name) VALUES ($1, $2, 'システムバス交換'), ($3, $4, 'システムバス交換')`,
    [PROJECT_A, COMPANY_A, PROJECT_B, COMPANY_B])
  await c.query(
    `INSERT INTO company_estimate_items (company_id, name, unit, selling_price) VALUES ($1, 'システムバス', '式', 100000), ($2, 'システムバス', '式', 999999)`,
    [COMPANY_A, COMPANY_B])
  await c.query(`INSERT INTO storage.buckets (id, name, public) VALUES ('genba-ai', 'genba-ai', false)`)
  await c.query(
    `INSERT INTO storage.objects (bucket_id, name) VALUES ('genba-ai', $1 || '/p/photos/a.jpg'), ('genba-ai', $2 || '/p/photos/b.jpg')`,
    [COMPANY_A, COMPANY_B])
  // 本番の Storage API と同じく、ログイン済みの利用者は storage.objects を（RLS の範囲で）読める
  await c.query('GRANT USAGE ON SCHEMA storage TO anon, authenticated; GRANT SELECT ON storage.objects TO anon, authenticated')
}

/** 修正前（2 つの migration が未適用）の DB を新しく作る */
async function freshDb(): Promise<Client> {
  const name = `fp_${++dbSeq}`
  await server.createDatabase(name)
  const c = await server.connect(name)
  await applyFullSchema(c, { skip: [MIGRATION, MIGRATION_ONE_COMPANY] })
  await c.query(RLS_AUTO_ENABLE_SQL)
  await seed(c)
  return c
}

async function pgError(p: Promise<unknown>): Promise<{ code: string; message: string; constraint?: string }> {
  try {
    await p
  } catch (e) {
    const err = e as { code: string; message: string; constraint?: string }
    return { code: err.code, message: err.message, constraint: err.constraint }
  }
  throw new Error('expected an error')
}

/** ロールと利用者を指定して SQL を実行する（RLS 有効。最後に必ず取り消す） */
async function as(c: Client, role: 'anon' | 'authenticated' | 'service_role', user: string | null, sql: string, params: unknown[] = []) {
  await c.query('BEGIN')
  try {
    await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [user ?? ''])
    await c.query(`SET LOCAL ROLE ${role}`)
    return (await c.query(sql, params)).rows
  } finally {
    await c.query('ROLLBACK')
  }
}

const SEARCH_CALLS = (projectId: string, companyId: string): [string, string, unknown[]][] => [
  ['match', 'SELECT * FROM public.match_estimate_items($1, $2)', [companyId, 'システムバス']],
  ['catalog', 'SELECT * FROM public.search_catalog_items($1, $2)', [companyId, 'システムバス']],
  ['ledger', 'SELECT * FROM public.search_cost_ledger_items($1, $2)', [projectId, 'システムバス']],
  ['estimate', 'SELECT * FROM public.search_estimate_items($1, $2)', [projectId, 'システムバス']],
]

async function functionAcl(c: Client) {
  const { rows } = await c.query(`
    SELECT p.oid::regprocedure::text AS fn,
           (SELECT array_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END ORDER BY 1)
              FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.privilege_type = 'EXECUTE') AS exec,
           p.proconfig AS config
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind = 'f'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
    ORDER BY 1`)
  return rows.map(r => ({ ...r, exec: [...r.exec].sort() }))
}

async function policies(c: Client) {
  const { rows } = await c.query(`
    SELECT schemaname, tablename, policyname, cmd, qual, with_check FROM pg_policies
    WHERE schemaname IN ('public', 'storage') ORDER BY 1, 2, 3`)
  return rows
}

async function counts(c: Client) {
  const { rows } = await c.query(`SELECT (SELECT count(*) FROM companies)::int AS companies, (SELECT count(*) FROM company_members)::int AS members`)
  return rows[0]
}

beforeAll(async () => {
  server = await startLocalPostgres()
}, 120_000)

afterAll(async () => {
  await server?.stop()
})

describe('修正前（20261121000001 未適用）: 問題の再現', () => {
  it('ログイン済みの利用者（A 社の owner）が create_company_with_owner で 2 社目を作り owner になれる', async () => {
    const c = await freshDb()
    await c.query('BEGIN')
    await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [USER_A])
    await c.query('SET LOCAL ROLE authenticated')
    await c.query(`SELECT public.create_company_with_owner('乗っ取り')`)
    await c.query('RESET ROLE')
    const { rows } = await c.query('SELECT count(*)::int AS n FROM company_members WHERE user_id = $1', [USER_A])
    await c.query('ROLLBACK')
    expect(rows[0].n).toBe(2)
  })

  it('anon（未ログイン）が会社作成関数と検索 4 関数を実行できる（会社作成は所属の user_id NOT NULL で中断・検索結果は RLS で 0 件）', async () => {
    const c = await freshDb()
    // 権限はあるので関数の本体まで進み、所属の INSERT で止まる（関数全体が取り消され、会社だけ残ることは無い）
    expect((await pgError(as(c, 'anon', null, `SELECT public.create_company_with_owner('anon')`))).code).toBe('23502')
    expect(await counts(c)).toEqual({ companies: 2, members: 3 })
    for (const [, sql, params] of SEARCH_CALLS(PROJECT_A, COMPANY_A)) {
      expect(await as(c, 'anon', null, sql, params)).toEqual([])
    }
  })
})

describe('修正後: 権限', () => {
  let c: Client
  let aclBefore: Awaited<ReturnType<typeof functionAcl>>
  let policiesBefore: unknown[]

  beforeAll(async () => {
    c = await freshDb()
    aclBefore = await functionAcl(c)
    policiesBefore = await policies(c)
    await c.query(readMigration(MIGRATION))
  })

  it('会社作成関数は anon・authenticated・service_role のどれからも実行できない（42501）。会社・所属は増えない', async () => {
    for (const [role, user] of [['anon', null], ['authenticated', USER_A], ['authenticated', USER_NONE], ['service_role', null]] as const) {
      const e = await pgError(as(c, role, user, `SELECT public.create_company_with_owner('乗っ取り')`))
      expect(e.code).toBe('42501')
    }
    expect(await counts(c)).toEqual({ companies: 2, members: 3 })
  })

  it('所有者（SQL Editor の postgres）は従来どおり実行できる（所属の無い利用者で確かめて取り消す）', async () => {
    await c.query('BEGIN')
    await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [USER_NONE])
    const { rows } = await c.query(`SELECT public.create_company_with_owner('所有者の確認') IS NOT NULL AS ok`)
    await c.query('ROLLBACK')
    expect(rows).toEqual([{ ok: true }])
  })

  it('rls_auto_enable() は利用者から実行できないが、イベントトリガーとして新しい public のテーブルの RLS を有効にし続ける', async () => {
    for (const [role, user] of [['anon', null], ['authenticated', USER_A], ['service_role', null]] as const) {
      expect((await pgError(as(c, role, user, 'SELECT public.rls_auto_enable()'))).code).toBe('42501')
    }
    await c.query('BEGIN')
    await c.query('CREATE TABLE public.zz_rls_probe (id int)')
    const { rows } = await c.query(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.zz_rls_probe'::regclass`)
    await c.query('ROLLBACK')
    expect(rows).toEqual([{ relrowsecurity: true }])
  })

  it('検索 4 関数: anon は実行できない（42501）', async () => {
    for (const [, sql, params] of SEARCH_CALLS(PROJECT_A, COMPANY_A)) {
      expect((await pgError(as(c, 'anon', null, sql, params))).code).toBe('42501')
    }
  })

  it('検索 4 関数: ログイン済みの利用者は自社の行を検索でき、他社の ID を渡すと 0 件（RLS は従来どおり）', async () => {
    for (const [kind, sql, params] of SEARCH_CALLS(PROJECT_A, COMPANY_A)) {
      const rows = await as(c, 'authenticated', USER_A, sql, params)
      expect(rows, kind).toHaveLength(1)
    }
    for (const [kind, sql, params] of SEARCH_CALLS(PROJECT_B, COMPANY_B)) {
      expect(await as(c, 'authenticated', USER_A, sql, params), kind).toEqual([])
    }
    // B 社の利用者からは B 社の行（A 社の値は出ない）
    const b = await as(c, 'authenticated', USER_B, 'SELECT selling_price FROM public.search_estimate_items($1, $2)', [PROJECT_B, 'システムバス'])
    expect(b).toEqual([{ selling_price: '999999' }])
  })

  it('検索 4 関数: service_role（LINE Webhook の match_estimate_items）は従来どおり実行できる', async () => {
    for (const [kind, sql, params] of SEARCH_CALLS(PROJECT_A, COMPANY_A)) {
      expect(await as(c, 'service_role', null, sql, params), kind).toHaveLength(1)
    }
  })

  it('検索 4 関数・会社作成・RLS 補助関数の search_path は public, pg_temp に固定される', async () => {
    const { rows } = await c.query(`
      SELECT p.oid::regprocedure::text AS fn, p.proconfig FROM pg_proc p
      WHERE p.oid = ANY (ARRAY[$1, $2, $3, $4, 'public.create_company_with_owner(text)', 'public.get_my_company_ids()']::regprocedure[])`,
      Object.values(SEARCH))
    expect(rows).toHaveLength(6)
    for (const r of rows) expect(r.proconfig, r.fn).toEqual(['search_path=public, pg_temp'])
  })

  it('get_my_company_ids(): 権限は変わらず、anon は 0 件・利用者は自社の 1 件。public の RLS も従来どおり', async () => {
    const after = await functionAcl(c)
    const pick = (acl: typeof after) => acl.find(r => r.fn === 'get_my_company_ids()')?.exec
    expect(pick(after)).toEqual(pick(aclBefore))
    expect(await as(c, 'anon', null, 'SELECT * FROM public.get_my_company_ids()')).toEqual([])
    expect(await as(c, 'anon', null, 'SELECT id FROM projects')).toEqual([])
    expect(await as(c, 'authenticated', USER_A, 'SELECT * FROM public.get_my_company_ids()')).toEqual([{ get_my_company_ids: COMPANY_A }])
    expect(await as(c, 'authenticated', USER_A, 'SELECT id FROM projects')).toEqual([{ id: PROJECT_A }])
    expect(await as(c, 'authenticated', USER_A, 'SELECT id FROM companies')).toEqual([{ id: COMPANY_A }])
    expect(await as(c, 'authenticated', USER_A, 'SELECT count(*)::int AS n FROM estimate_items')).toEqual([{ n: 1 }])
    expect(await as(c, 'authenticated', USER_A, 'SELECT count(*)::int AS n FROM cost_ledger_items')).toEqual([{ n: 1 }])
  })

  it('Storage: 自社フォルダのファイルだけが見える（get_my_company_ids() を使うポリシーは従来どおり）', async () => {
    const rows = await as(c, 'authenticated', USER_A, `SELECT name FROM storage.objects WHERE bucket_id = 'genba-ai'`)
    expect(rows).toEqual([{ name: `${COMPANY_A}/p/photos/a.jpg` }])
    expect(await as(c, 'anon', null, 'SELECT name FROM storage.objects')).toEqual([])
  })

  it('対象外の関数の権限と、RLS ポリシー（public・storage）は変わらない', async () => {
    const targets = new Set(['create_company_with_owner(text)', 'rls_auto_enable()', 'get_my_company_ids()',
      ...Object.values(SEARCH).map(s => s.replace('public.', ''))])
    const norm = (s: string) => s.replace(/\s/g, '')
    const others = (acl: typeof aclBefore) => acl.filter(r => ![...targets].some(t => norm(r.fn) === norm(t)))
    expect(others(await functionAcl(c))).toEqual(others(aclBefore))
    expect(await policies(c)).toEqual(policiesBefore)
  })
})

describe('1 ユーザー 1 社の制約（20261121000002）', () => {
  it('2 社以上に所属するユーザーがいれば、件数を出して何も作らずに止まる（行の削除・移動はしない）', async () => {
    const c = await freshDb()
    await c.query(`INSERT INTO company_members (company_id, user_id) VALUES ($1, $2)`, [COMPANY_A, USER_B])
    await c.query('BEGIN')
    const e = await pgError(c.query(readMigration(MIGRATION_ONE_COMPANY)))
    await c.query('ROLLBACK')
    expect(e.message).toBe('one-company-per-user precondition failed: 1 user(s) belong to 2+ companies')
    const { rows } = await c.query(`SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'company_members_user_id_key'`)
    expect(rows[0].n).toBe(0)
    expect(await counts(c)).toEqual({ companies: 2, members: 4 })
  })

  it('適用後: 2 社目の所属は拒否（23505）。所属の移動（DELETE → INSERT）は通り、逆の順は拒否される', async () => {
    const c = await freshDb()
    await c.query(readMigration(MIGRATION_ONE_COMPANY))
    const dup = await pgError(c.query(`INSERT INTO company_members (company_id, user_id) VALUES ($1, $2)`, [COMPANY_A, USER_B]))
    expect(dup).toMatchObject({ code: '23505', constraint: 'company_members_user_id_key' })

    // 試用会社への移行 SQL と同じ順（同じトランザクションで B 社の所属を消してから試用会社に入れる）
    const trial = randomUUID()
    await c.query('BEGIN')
    await c.query(`INSERT INTO companies (id, name) VALUES ($1, 'ラグズ建築（試用）')`, [trial])
    await c.query('DELETE FROM company_members WHERE user_id = $1', [USER_MOVE])
    await c.query(`INSERT INTO company_members (company_id, user_id, role) VALUES ($1, $2, 'owner')`, [trial, USER_MOVE])
    await c.query('COMMIT')
    const moved = await c.query('SELECT company_id, role FROM company_members WHERE user_id = $1', [USER_MOVE])
    expect(moved.rows).toEqual([{ company_id: trial, role: 'owner' }])

    const reverse = await pgError(c.query(`INSERT INTO company_members (company_id, user_id) VALUES ($1, $2)`, [COMPANY_B, USER_MOVE]))
    expect(reverse.code).toBe('23505')
  })

  it('既存の UNIQUE (company_id, user_id)・外部キー・RLS は変わらず、所属の無い利用者は新しく 1 社に入れる', async () => {
    const c = await freshDb()
    const before = (await c.query(`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'company_members'::regclass ORDER BY 1`)).rows
    const pol = await policies(c)
    await c.query(readMigration(MIGRATION_ONE_COMPANY))
    const after = (await c.query(`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'company_members'::regclass ORDER BY 1`)).rows
    expect(after.filter(r => r.conname !== 'company_members_user_id_key')).toEqual(before)
    expect(after.find(r => r.conname === 'company_members_user_id_key')?.def).toBe('UNIQUE (user_id)')
    expect(await policies(c)).toEqual(pol)
    await c.query(`INSERT INTO company_members (company_id, user_id) VALUES ($1, $2)`, [COMPANY_A, USER_NONE])
    expect(await as(c, 'authenticated', USER_NONE, 'SELECT id FROM companies')).toEqual([{ id: COMPANY_A }])
  })
})

describe('SQL Editor 用スクリプト（docs/db/function-privileges-*.sql・one-company-per-user-*.sql）', () => {
  const DOCS = path.resolve(__dirname, '../../docs/db')
  const read = (f: string) => readFileSync(path.join(DOCS, f), 'utf8')
  const APPLY = read('function-privileges-sql-editor-apply.sql')
  const ROLLBACK = read('function-privileges-sql-editor-rollback.sql')
  const OC_APPLY = read('one-company-per-user-sql-editor-apply.sql')
  const OC_ROLLBACK = read('one-company-per-user-sql-editor-rollback.sql')
  const PRECHECK = read('function-privileges-precheck.sql')
  const HISTORY_SQL = `
    CREATE SCHEMA supabase_migrations;
    CREATE TABLE supabase_migrations.schema_migrations (version text PRIMARY KEY, statements text[], name text);
    INSERT INTO supabase_migrations.schema_migrations (version) VALUES ('20261015000001'), ('20261016000001');`

  async function editorDb() {
    const c = await freshDb()
    await c.query(HISTORY_SQL)
    return c
  }
  async function runScript(c: Client, sql: string) {
    const res = await c.query(sql)
    const results = Array.isArray(res) ? res : [res]
    return results[results.length - 1].rows
  }
  async function runScriptExpectingError(c: Client, sql: string) {
    const e = await pgError(c.query(sql))
    await c.query('ROLLBACK')
    return e
  }
  async function history(c: Client, version: string) {
    return (await c.query('SELECT version, name FROM supabase_migrations.schema_migrations WHERE version = $1', [version])).rows
  }

  it('適用スクリプトの本体は migration ファイルと完全に一致する。BEGIN / COMMIT は 1 回ずつ', () => {
    for (const [apply, migration] of [[APPLY, MIGRATION], [OC_APPLY, MIGRATION_ONE_COMPANY]]) {
      const start = apply.indexOf('-- >>> MIGRATION BODY\n')
      const end = apply.lastIndexOf('-- <<< MIGRATION BODY')
      expect(start).toBeGreaterThan(0)
      expect(apply.slice(start + '-- >>> MIGRATION BODY\n'.length, end)).toBe(readMigration(migration))
      expect(readMigration(migration)).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK|START TRANSACTION)\s*;/im)
    }
    for (const sql of [APPLY, ROLLBACK, OC_APPLY, OC_ROLLBACK]) {
      expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1)
      expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1)
    }
  })

  it('確認 SQL は読み取り専用で動き、書き込み・DDL を含まない', async () => {
    const code = PRECHECK.replace(/--.*$/gm, '').replace(/'[^']*'/g, "''")
    expect(code).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP|GRANT|REVOKE|COMMENT|NOTIFY|COPY|DO)\b/i)
    const c = await editorDb()
    await c.query('BEGIN READ ONLY')
    const { rows } = await c.query(PRECHECK)
    await c.query('ROLLBACK')
    const detail = (item: string) => rows.find(r => r.item === item)?.detail as string
    expect(detail('create_company_with_owner(text)')).toContain('PUBLIC=X | anon=X | authenticated=X')
    expect(rows.find(r => r.section === '2 event_trigger' && r.item === 'ensure_rls')).toBeTruthy()
    expect(detail('users_with_2plus_companies')).toBe('0')
  })

  it('関数の権限: 成功時は権限・search_path と履歴がそろって確定し、二度目はガードで止まる', async () => {
    const c = await editorDb()
    expect(await runScript(c, APPLY)).toEqual([{
      history_rows: '1', anon_can_create: false, authenticated_can_create: false, authenticated_can_search: true, anon_can_search: false,
    }])
    expect(await history(c, '20261121000001')).toEqual([{ version: '20261121000001', name: 'restrict_db_function_privileges' }])
    expect((await pgError(as(c, 'authenticated', USER_A, `SELECT public.create_company_with_owner('x')`))).code).toBe('42501')
    expect((await runScriptExpectingError(c, APPLY)).message)
      .toBe('function-privileges apply aborted: version 20261121000001 is already recorded')
  })

  it('関数の権限: イベントトリガーが無い DB・直前の migration が未記録の DB・検証 DB の目印がある DB では何も変えずに止まる', async () => {
    const c1 = await editorDb()
    await c1.query('DROP EVENT TRIGGER ensure_rls')
    expect((await runScriptExpectingError(c1, APPLY)).message).toMatch(/event trigger ensure_rls/)
    const c2 = await editorDb()
    await c2.query(`DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261016000001'`)
    expect((await runScriptExpectingError(c2, APPLY)).message).toMatch(/20261016000001 is not recorded/)
    const c3 = await editorDb()
    await c3.query('CREATE TABLE public.qa_environment_marker (id int)')
    expect((await runScriptExpectingError(c3, APPLY)).message).toMatch(/QA marker found/)
    for (const c of [c1, c2, c3]) {
      expect(await history(c, '20261121000001')).toEqual([])
      expect((await c.query(`SELECT has_function_privilege('anon', 'public.create_company_with_owner(text)', 'EXECUTE') AS x`)).rows)
        .toEqual([{ x: true }])
    }
  })

  it('関数の権限: ロールバックで適用前と同じ権限・search_path に戻り（問題も再発する）、履歴の 1 行だけが消える。適用し直せる', async () => {
    const c = await editorDb()
    const before = await functionAcl(c)
    await runScript(c, APPLY)
    expect(await runScript(c, ROLLBACK)).toEqual([{ history_rows: '0', anon_can_create: true, authenticated_can_create: true }])
    expect(await functionAcl(c)).toEqual(before)
    expect((await c.query('SELECT version FROM supabase_migrations.schema_migrations ORDER BY 1')).rows)
      .toEqual([{ version: '20261015000001' }, { version: '20261016000001' }])
    expect((await runScriptExpectingError(c, ROLLBACK)).message).toMatch(/is not recorded/)
    expect((await runScript(c, APPLY))[0].history_rows).toBe('1')
  })

  it('1 社制約: 適用・二度目のガード・2 社所属があるときの停止・ロールバック', async () => {
    const c = await editorDb()
    expect(await runScript(c, OC_APPLY)).toEqual([{ history_rows: '1', constraint_exists: true, users_with_2plus_companies: '0' }])
    expect((await runScriptExpectingError(c, OC_APPLY)).message).toMatch(/20261121000002 is already recorded/)
    expect(await runScript(c, OC_ROLLBACK)).toEqual([{ history_rows: '0', constraint_exists: false }])
    expect(await counts(c)).toEqual({ companies: 2, members: 3 })

    const c2 = await editorDb()
    await c2.query(`INSERT INTO company_members (company_id, user_id) VALUES ($1, $2)`, [COMPANY_A, USER_B])
    expect((await runScriptExpectingError(c2, OC_APPLY)).message).toMatch(/1 user\(s\) belong to 2\+ companies/)
    expect(await history(c2, '20261121000002')).toEqual([])
  })

  it('2 つのスクリプトは独立している（どちらの順でも適用・ロールバックできる）', async () => {
    const c = await editorDb()
    await runScript(c, OC_APPLY)
    await runScript(c, APPLY)
    await runScript(c, ROLLBACK)
    expect((await c.query(`SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'company_members_user_id_key'`)).rows[0].n).toBe(1)
    await runScript(c, OC_ROLLBACK)
    await runScript(c, APPLY)
    expect((await pgError(as(c, 'anon', null, `SELECT public.create_company_with_owner('x')`))).code).toBe('42501')
  })
})
