/**
 * KI-001 追加監査: estimate_items / line_events の「案件」と「会社」の一致（migration 20261013000002）の DB 検証。
 *
 * 実行: npm run test:db
 *   隔離されたローカル PostgreSQL（embedded-postgres）に実際の migration ファイルを適用して検証する。
 *   本番・Preview の DB には接続しない。
 *
 * 1. 修正前の DB で、ログイン済みユーザーが PostgREST と同じ権限（authenticated + RLS）で
 *    company_id = 自社・project_id = 他社の案件 という行を直接 INSERT / UPDATE できることを再現する。
 * 2. migration 適用後は、ロール・経路にかかわらず拒否され、正常な操作は変わらないことを確かめる。
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SUPABASE_STUB_SQL, readMigration, startLocalPostgres, type LocalPostgres } from './helpers/local-postgres'
import { LINE_EVENTS_BASE_SQL } from './helpers/line-events-base'

const MIGRATION_CATEGORY  = '20260711000002_estimate_items_category.sql'
const MIGRATION_REFLECTED = '20260711000005_reflected_to_estimate.sql'
const MIGRATION_KI_001    = '20261013000001_link_line_event_on_estimate_add.sql'
const MIGRATION_MATCH     = '20261013000002_enforce_project_company_match.sql'

let server: LocalPostgres
let admin: Client
let userA: Client
let userA2: Client

const COMPANY_A = randomUUID()
const COMPANY_B = randomUUID()
const USER_A = randomUUID()
const USER_AB = randomUUID() // A社・B社の両方に所属
let PROJECT_A: string
let PROJECT_A2: string
let PROJECT_B: string

/** 修正前（KI-001 の RPC まで適用済み、20261013000002 は未適用）の DB */
async function setupDatabase(c: Client) {
  await c.query(SUPABASE_STUB_SQL)
  await c.query(LINE_EVENTS_BASE_SQL)
  await c.query(readMigration(MIGRATION_CATEGORY))
  await c.query(readMigration(MIGRATION_REFLECTED))
  await c.query(readMigration(MIGRATION_KI_001))
}

async function seed(c: Client) {
  await c.query('INSERT INTO auth.users (id) VALUES ($1), ($2)', [USER_A, USER_AB])
  await c.query('INSERT INTO companies (id, name) VALUES ($1, $2), ($3, $4)', [COMPANY_A, 'A社', COMPANY_B, 'B社'])
  await c.query(
    'INSERT INTO company_members (company_id, user_id) VALUES ($1, $2), ($1, $3), ($4, $3)',
    [COMPANY_A, USER_A, USER_AB, COMPANY_B],
  )
}

async function newProject(c: Client, companyId: string): Promise<string> {
  const { rows } = await c.query('INSERT INTO projects (company_id) VALUES ($1) RETURNING id', [companyId])
  return rows[0].id
}

/** LINE イベント（Webhook と同じく service_role 相当の superuser で作る） */
async function newEvent(companyId: string, projectId: string | null = null): Promise<string> {
  const { rows } = await admin.query(
    `INSERT INTO line_events (company_id, line_user_id, line_event_id, event_type, project_id, is_processed)
     VALUES ($1, 'U-test', $2, 'audio', $3, true) RETURNING id`,
    [companyId, randomUUID(), projectId],
  )
  return rows[0].id
}

async function newItem(companyId: string, projectId: string): Promise<string> {
  const { rows } = await admin.query(
    "INSERT INTO estimate_items (company_id, project_id, name) VALUES ($1, $2, '既存項目') RETURNING id",
    [companyId, projectId],
  )
  return rows[0].id
}

async function begin(c: Client, userId: string | null, role = 'authenticated') {
  await c.query('BEGIN')
  await c.query(`SET LOCAL ROLE ${role}`)
  await c.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [userId ?? ''])
}

/** PostgREST と同じ形（ロール + JWT の sub）で 1 トランザクション実行する */
async function asUser<T>(c: Client, userId: string | null, fn: () => Promise<T>, role = 'authenticated'): Promise<T> {
  await begin(c, userId, role)
  try {
    const r = await fn()
    await c.query('COMMIT')
    return r
  } catch (e) {
    await c.query('ROLLBACK')
    throw e
  }
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

const insertItem = (c: Client, companyId: string, projectId: string) =>
  c.query("INSERT INTO estimate_items (company_id, project_id, name) VALUES ($1, $2, '直接INSERT') RETURNING id", [companyId, projectId])

async function itemRow(id: string) {
  const { rows } = await admin.query('SELECT company_id, project_id FROM estimate_items WHERE id = $1', [id])
  return rows[0] as { company_id: string; project_id: string } | undefined
}
async function eventProject(id: string) {
  const { rows } = await admin.query('SELECT project_id FROM line_events WHERE id = $1', [id])
  return rows[0].project_id as string | null
}

async function policies(c: Client) {
  const { rows } = await c.query(`
    SELECT tablename, policyname, cmd, roles::text, qual, with_check FROM pg_policies
    WHERE schemaname = 'public' ORDER BY tablename, policyname`)
  return rows
}
async function tablePrivileges(c: Client) {
  const { rows } = await c.query(`
    SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name IN ('estimate_items', 'line_events', 'projects')
    ORDER BY 1, 2, 3`)
  return rows
}

async function backendPid(c: Client): Promise<number> {
  const { rows } = await c.query('SELECT pg_backend_pid() AS pid')
  return rows[0].pid
}
async function waitUntilBlocked(pid: number, timeoutMs = 5000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const { rows } = await admin.query("SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'", [pid])
    if (rows.length > 0) return
    await new Promise(r => setTimeout(r, 20))
  }
  throw new Error(`backend ${pid} did not block on a lock`)
}

let policiesBefore: unknown[]
let privilegesBefore: unknown[]

beforeAll(async () => {
  server = await startLocalPostgres()
  await server.createDatabase('pcm')
  admin = await server.connect('pcm')
  await setupDatabase(admin)
  await seed(admin)
  PROJECT_A = await newProject(admin, COMPANY_A)
  PROJECT_A2 = await newProject(admin, COMPANY_A)
  PROJECT_B = await newProject(admin, COMPANY_B)
  userA = await server.connect('pcm')
  userA2 = await server.connect('pcm')
  policiesBefore = await policies(admin)
  privilegesBefore = await tablePrivileges(admin)
}, 120_000)

afterAll(async () => {
  await server?.stop()
})

// ── 1. 修正前: 抜け道の再現 ───────────────────────────────────

const reproduced: { items: string[]; events: string[] } = { items: [], events: [] }

describe('修正前（20261013000002 未適用）: PostgREST と同じ権限で他社の案件を指定できてしまう', () => {
  it('estimate_items への直接 INSERT（company_id = 自社, project_id = 他社の案件）が成功する', async () => {
    const { rows } = await asUser(userA, USER_A, () => insertItem(userA, COMPANY_A, PROJECT_B))
    reproduced.items.push(rows[0].id)
    expect(await itemRow(rows[0].id)).toEqual({ company_id: COMPANY_A, project_id: PROJECT_B })
  })

  it('自社の見積項目の project_id を他社の案件へ直接 UPDATE できる', async () => {
    const id = await newItem(COMPANY_A, PROJECT_A)
    const r = await asUser(userA, USER_A, () =>
      userA.query('UPDATE estimate_items SET project_id = $1 WHERE id = $2', [PROJECT_B, id]))
    expect(r.rowCount).toBe(1)
    reproduced.items.push(id)
    expect((await itemRow(id))?.project_id).toBe(PROJECT_B)
  })

  it('自社の LINE イベントの project_id を他社の案件へ直接 UPDATE できる', async () => {
    const ev = await newEvent(COMPANY_A)
    const r = await asUser(userA, USER_A, () =>
      userA.query('UPDATE line_events SET project_id = $1 WHERE id = $2', [PROJECT_B, ev]))
    expect(r.rowCount).toBe(1)
    reproduced.events.push(ev)
    expect(await eventProject(ev)).toBe(PROJECT_B)
  })

  it('（参考）RPC add_line_event_estimate_items は修正前から他社の案件を拒否している', async () => {
    const ev = await newEvent(COMPANY_A)
    const e = await pgError(asUser(userA, USER_A, () =>
      userA.query("SELECT public.add_line_event_estimate_items($1, $2, '[{\"name\":\"a\",\"unit\":\"式\"}]'::jsonb)", [PROJECT_B, ev])))
    expect(e.code).toBe('LE404')
  })
})

// ── 2. 適用 ─────────────────────────────────────────────────

describe('migration の適用', () => {
  it('食い違っている既存行があれば、何も作らずに止まる（補正はしない）', async () => {
    const e = await pgError(admin.query(readMigration(MIGRATION_MATCH)))
    expect(e.message).toBe('project-company precondition failed: mismatched rows (estimate_items=2, line_events=1)')
    const { rows } = await admin.query(`
      SELECT count(*)::int AS n FROM pg_constraint
      WHERE conname IN ('projects_id_company_id_key', 'estimate_items_project_company_fkey', 'line_events_project_company_fkey')`)
    expect(rows[0].n).toBe(0)
    expect((await itemRow(reproduced.items[0]))?.project_id).toBe(PROJECT_B) // 既存行は変えない
  })

  it('食い違いを人間が解消した後なら適用できる（隔離 DB で再現行を消してから適用）', async () => {
    await admin.query('DELETE FROM estimate_items WHERE id = ANY($1)', [reproduced.items])
    await admin.query('UPDATE line_events SET project_id = NULL WHERE id = ANY($1)', [reproduced.events])
    await admin.query(readMigration(MIGRATION_MATCH))
    const { rows } = await admin.query(`
      SELECT conrelid::regclass::text AS tbl, conname, contype, convalidated, confdeltype
      FROM pg_constraint
      WHERE conname IN ('projects_id_company_id_key', 'estimate_items_project_company_fkey', 'line_events_project_company_fkey')
      ORDER BY conname`)
    expect(rows).toEqual([
      { tbl: 'estimate_items', conname: 'estimate_items_project_company_fkey', contype: 'f', convalidated: true, confdeltype: 'c' },
      { tbl: 'line_events', conname: 'line_events_project_company_fkey', contype: 'f', convalidated: true, confdeltype: 'a' },
      { tbl: 'projects', conname: 'projects_id_company_id_key', contype: 'u', convalidated: true, confdeltype: ' ' },
    ])
  })

  it('RLS ポリシー・テーブル権限は変わらない。再適用しても何も変わらない', async () => {
    expect(await policies(admin)).toEqual(policiesBefore)
    expect(await tablePrivileges(admin)).toEqual(privilegesBefore)
    await admin.query(readMigration(MIGRATION_MATCH))
    const { rows } = await admin.query(`
      SELECT count(*)::int AS n FROM pg_constraint
      WHERE conname IN ('projects_id_company_id_key', 'estimate_items_project_company_fkey', 'line_events_project_company_fkey')`)
    expect(rows[0].n).toBe(3)
  })
})

// ── 3. 修正後: 直接操作の拒否 ────────────────────────────────

describe('修正後: 他社の案件を指定した直接 INSERT / UPDATE は拒否される', () => {
  const FK_ITEMS = { code: '23503', constraint: 'estimate_items_project_company_fkey' }
  const FK_EVENTS = { code: '23503', constraint: 'line_events_project_company_fkey' }

  it('直接 INSERT（company_id = 自社, project_id = 他社）→ 23503', async () => {
    const e = await pgError(asUser(userA, USER_A, () => insertItem(userA, COMPANY_A, PROJECT_B)))
    expect(e).toMatchObject(FK_ITEMS)
  })

  it('見積項目の project_id を他社の案件へ UPDATE → 23503。行は変わらない', async () => {
    const id = await newItem(COMPANY_A, PROJECT_A)
    const e = await pgError(asUser(userA, USER_A, () =>
      userA.query('UPDATE estimate_items SET project_id = $1 WHERE id = $2', [PROJECT_B, id])))
    expect(e).toMatchObject(FK_ITEMS)
    expect(await itemRow(id)).toEqual({ company_id: COMPANY_A, project_id: PROJECT_A })
  })

  it('LINE イベントの project_id を他社の案件へ UPDATE → 23503。未振り分けのまま', async () => {
    const ev = await newEvent(COMPANY_A)
    const e = await pgError(asUser(userA, USER_A, () =>
      userA.query('UPDATE line_events SET project_id = $1 WHERE id = $2', [PROJECT_B, ev])))
    expect(e).toMatchObject(FK_EVENTS)
    expect(await eventProject(ev)).toBeNull()
  })

  it('他社の company_id での INSERT は従来どおり RLS で拒否（42501）', async () => {
    const e = await pgError(asUser(userA, USER_A, () => insertItem(userA, COMPANY_B, PROJECT_B)))
    expect(e.code).toBe('42501')
  })

  it('未認証（sub なし）・anon: INSERT は RLS で拒否、UPDATE は 0 行', async () => {
    for (const [user, role] of [[null, 'authenticated'], [null, 'anon']] as const) {
      const e = await pgError(asUser(userA, user, () => insertItem(userA, COMPANY_A, PROJECT_A), role))
      expect(e.code).toBe('42501')
    }
    const id = await newItem(COMPANY_A, PROJECT_A)
    const r = await asUser(userA, null, () => userA.query("UPDATE estimate_items SET name = 'x' WHERE id = $1", [id]), 'anon')
    expect(r.rowCount).toBe(0)
  })

  it('両社に所属するユーザー: 会社の組み合わせが合っていれば可、食い違えば 23503', async () => {
    await asUser(userA, USER_AB, () => insertItem(userA, COMPANY_A, PROJECT_A))
    await asUser(userA, USER_AB, () => insertItem(userA, COMPANY_B, PROJECT_B))
    expect(await pgError(asUser(userA, USER_AB, () => insertItem(userA, COMPANY_A, PROJECT_B)))).toMatchObject(FK_ITEMS)
    expect(await pgError(asUser(userA, USER_AB, () => insertItem(userA, COMPANY_B, PROJECT_A)))).toMatchObject(FK_ITEMS)
    // company_id だけを書き換えて他社へ移すこともできない
    const id = await newItem(COMPANY_A, PROJECT_A)
    const e = await pgError(asUser(userA, USER_AB, () =>
      userA.query('UPDATE estimate_items SET company_id = $1 WHERE id = $2', [COMPANY_B, id])))
    expect(e).toMatchObject(FK_ITEMS)
  })

  it('service_role（RLS をバイパス）でも食い違いは拒否される', async () => {
    const e = await pgError(asUser(userA, null, () => insertItem(userA, COMPANY_A, PROJECT_B), 'service_role'))
    expect(e).toMatchObject(FK_ITEMS)
    const ev = await newEvent(COMPANY_A)
    const e2 = await pgError(asUser(userA, null, () =>
      userA.query('UPDATE line_events SET project_id = $1 WHERE id = $2', [PROJECT_B, ev]), 'service_role'))
    expect(e2).toMatchObject(FK_EVENTS)
  })
})

// ── 4. 修正後: 正常な操作 ───────────────────────────────────

describe('修正後: 正常な操作は変わらない', () => {
  it('見積項目の登録・編集・並び替え・論理削除・自社の別案件への移動', async () => {
    const { rows } = await asUser(userA, USER_A, () => insertItem(userA, COMPANY_A, PROJECT_A))
    const id = rows[0].id as string
    await asUser(userA, USER_A, async () => {
      await userA.query("UPDATE estimate_items SET name = '編集', quantity = 3, selling_price = 1000 WHERE id = $1", [id])
      await userA.query('UPDATE estimate_items SET sort_order = 5 WHERE id = $1 AND company_id = $2 AND project_id = $3', [id, COMPANY_A, PROJECT_A])
      await userA.query('UPDATE estimate_items SET project_id = $1 WHERE id = $2', [PROJECT_A2, id])
      await userA.query('UPDATE estimate_items SET deleted_at = now() WHERE id = $1', [id])
    })
    const { rows: [r] } = await admin.query('SELECT name, amount::text, sort_order, project_id, deleted_at IS NOT NULL AS deleted FROM estimate_items WHERE id = $1', [id])
    expect(r).toEqual({ name: '編集', amount: '3000', sort_order: 5, project_id: PROJECT_A2, deleted: true })
  })

  it('LINE イベント: 自社の案件への振り分け・未振り分けへの戻し・Webhook と同じ未振り分けの INSERT', async () => {
    const ev = await newEvent(COMPANY_A)
    await asUser(userA, USER_A, () => userA.query('UPDATE line_events SET project_id = $1 WHERE id = $2', [PROJECT_A, ev]))
    expect(await eventProject(ev)).toBe(PROJECT_A)
    await asUser(userA, USER_A, () => userA.query('UPDATE line_events SET project_id = NULL WHERE id = $1', [ev]))
    expect(await eventProject(ev)).toBeNull()
  })

  it('RPC add_line_event_estimate_items（KI-001）はそのまま動き、他社の案件は LE404', async () => {
    const ev = await newEvent(COMPANY_A)
    const items = JSON.stringify([{ name: 'システムバス', unit: '式', selling_price: 850000 }])
    const { rows } = await asUser(userA, USER_A, () =>
      userA.query('SELECT public.add_line_event_estimate_items($1, $2, $3::jsonb) AS r', [PROJECT_A, ev, items]))
    expect(rows[0].r).toMatchObject({ created: 1, linked: true })
    expect(await eventProject(ev)).toBe(PROJECT_A)
    const ev2 = await newEvent(COMPANY_A)
    const e = await pgError(asUser(userA, USER_A, () =>
      userA.query('SELECT public.add_line_event_estimate_items($1, $2, $3::jsonb)', [PROJECT_B, ev2, items])))
    expect(e.code).toBe('LE404')
  })

  it('案件の物理削除は従来どおり見積項目へカスケードする', async () => {
    const p = await newProject(admin, COMPANY_A)
    const id = await newItem(COMPANY_A, p)
    await admin.query('DELETE FROM projects WHERE id = $1', [p])
    expect(await itemRow(id)).toBeUndefined()
  })
})

// ── 5. 修正後: 同時実行 ─────────────────────────────────────

describe('修正後: 同時実行（案件の会社の変更と見積項目の追加が重なる）', () => {
  it('見積項目の追加が先: 案件の会社の変更はロックを待ち、追加のコミット後に 23503 で拒否される', async () => {
    const p = await newProject(admin, COMPANY_A)
    await begin(userA, USER_A)
    await insertItem(userA, COMPANY_A, p)

    const pid2 = await backendPid(userA2)
    await userA2.query('BEGIN')
    const move = pgError(userA2.query('UPDATE projects SET company_id = $1 WHERE id = $2', [COMPANY_B, p]))
    await waitUntilBlocked(pid2)
    await userA.query('COMMIT')
    expect(await move).toMatchObject({ code: '23503', constraint: 'estimate_items_project_company_fkey' })
    await userA2.query('ROLLBACK')
    const { rows } = await admin.query('SELECT company_id FROM projects WHERE id = $1', [p])
    expect(rows[0].company_id).toBe(COMPANY_A)
  })

  it('案件の会社の変更が先: 見積項目の追加はロックを待ち、変更のコミット後に 23503 で拒否される', async () => {
    const p = await newProject(admin, COMPANY_A)
    await userA2.query('BEGIN')
    await userA2.query('UPDATE projects SET company_id = $1 WHERE id = $2', [COMPANY_B, p])

    const pid = await backendPid(userA)
    await begin(userA, USER_A)
    const add = pgError(insertItem(userA, COMPANY_A, p))
    await waitUntilBlocked(pid)
    await userA2.query('COMMIT')
    expect(await add).toMatchObject({ code: '23503', constraint: 'estimate_items_project_company_fkey' })
    await userA.query('ROLLBACK')
    const { rows } = await admin.query('SELECT count(*)::int AS n FROM estimate_items WHERE project_id = $1', [p])
    expect(rows[0].n).toBe(0)
  })
})

// ── 6. SQL Editor 用の適用・ロールバックスクリプト ─────────────

describe('SQL Editor 用スクリプト（docs/db/ki-001-project-company-*.sql）', () => {
  const DOCS = path.resolve(__dirname, '../../docs/db')
  const APPLY = readFileSync(path.join(DOCS, 'ki-001-project-company-sql-editor-apply.sql'), 'utf8')
  const ROLLBACK = readFileSync(path.join(DOCS, 'ki-001-project-company-sql-editor-rollback.sql'), 'utf8')
  const HISTORY_SQL = `
    CREATE SCHEMA supabase_migrations;
    CREATE TABLE supabase_migrations.schema_migrations (version text PRIMARY KEY, statements text[], name text);
    INSERT INTO supabase_migrations.schema_migrations (version) VALUES ('20260711000005');`
  const APPLIED = [{ history_rows: '1', valid_constraints: '3' }]

  let dbSeq = 0
  async function freshDb() {
    const name = `pcm_editor_${++dbSeq}`
    await server.createDatabase(name)
    const c = await server.connect(name)
    await setupDatabase(c)
    await c.query(HISTORY_SQL)
    return c
  }
  async function history(c: Client) {
    const { rows } = await c.query("SELECT version, name FROM supabase_migrations.schema_migrations WHERE version = '20261013000002'")
    return rows
  }
  async function constraints(c: Client) {
    const { rows } = await c.query(`
      SELECT count(*)::int AS n FROM pg_constraint
      WHERE conname IN ('projects_id_company_id_key', 'estimate_items_project_company_fkey', 'line_events_project_company_fkey')`)
    return rows[0].n as number
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

  it('適用スクリプトの本体は migration ファイルと完全に一致する', () => {
    const start = APPLY.indexOf('-- >>> MIGRATION BODY\n')
    const end = APPLY.lastIndexOf('-- <<< MIGRATION BODY')
    expect(start).toBeGreaterThan(0)
    expect(APPLY.slice(start + '-- >>> MIGRATION BODY\n'.length, end)).toBe(readMigration(MIGRATION_MATCH))
    expect(readMigration(MIGRATION_MATCH)).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK|START TRANSACTION)\s*;/im)
    for (const sql of [APPLY, ROLLBACK]) {
      expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1)
      expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1)
    }
  })

  it('成功時: 制約と履歴がそろって確定し、RLS ポリシー・権限は変わらない', async () => {
    const c = await freshDb()
    const before = [await policies(c), await tablePrivileges(c)]
    expect(await runScript(c, APPLY)).toEqual(APPLIED)
    expect(await history(c)).toEqual([{ version: '20261013000002', name: 'enforce_project_company_match' }])
    expect([await policies(c), await tablePrivileges(c)]).toEqual(before)
    const { rows } = await c.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = pg_backend_pid() AND state = 'idle in transaction'")
    expect(rows[0].n).toBe(0)
    await c.end()
  })

  it('二度目の実行・履歴なしで制約だけある DB はガードで止まる', async () => {
    const c = await freshDb()
    await runScript(c, APPLY)
    expect((await runScriptExpectingError(c, APPLY)).message)
      .toBe('project-company apply aborted: version 20261013000002 is already recorded')
    const c2 = await freshDb()
    await c2.query(readMigration(MIGRATION_MATCH))
    expect((await runScriptExpectingError(c2, APPLY)).message)
      .toBe('project-company apply aborted: constraints already exist (history is missing)')
    expect(await history(c2)).toHaveLength(0)
    await c.end()
    await c2.end()
  })

  it('食い違っている行があれば、制約も履歴も残らない', async () => {
    const c = await freshDb()
    await c.query('INSERT INTO auth.users (id) VALUES ($1)', [USER_A])
    await c.query('INSERT INTO companies (id, name) VALUES ($1, $2), ($3, $4)', [COMPANY_A, 'A社', COMPANY_B, 'B社'])
    const pB = await newProject(c, COMPANY_B)
    await c.query("INSERT INTO estimate_items (company_id, project_id, name) VALUES ($1, $2, 'x')", [COMPANY_A, pB])
    const e = await runScriptExpectingError(c, APPLY)
    expect(e.message).toBe('project-company precondition failed: mismatched rows (estimate_items=1, line_events=0)')
    expect(await constraints(c)).toBe(0)
    expect(await history(c)).toHaveLength(0)
    await c.end()
  })

  it('ロールバック: 制約 3 つと履歴の 1 行だけを消す。二度目はガードで止まり、適用し直せる', async () => {
    const c = await freshDb()
    const before = [await policies(c), await tablePrivileges(c)]
    await runScript(c, APPLY)
    expect(await runScript(c, ROLLBACK)).toEqual([{ history_rows: '0', constraints: '0' }])
    expect([await policies(c), await tablePrivileges(c)]).toEqual(before)
    expect(await constraints(c)).toBe(0)
    const e = await runScriptExpectingError(c, ROLLBACK)
    expect(e.message).toBe('project-company rollback aborted: nothing to roll back (no history row, no constraints)')
    expect(await runScript(c, APPLY)).toEqual(APPLIED)
    await c.end()
  })
})
