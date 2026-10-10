/**
 * KI-001 migration（20261013000001_link_line_event_on_estimate_add.sql）の DB 検証。
 *
 * 実行: npm run test:db
 *   隔離されたローカル PostgreSQL（embedded-postgres）に実際の migration ファイルを適用して検証する。
 *   本番・Preview の DB には接続しない。
 *   同時実行のテストは、独立した複数の DB 接続で実際にトランザクションを重ねる。
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SUPABASE_STUB_SQL, readMigration, startLocalPostgres, type LocalPostgres } from './helpers/local-postgres'
import { LINE_EVENTS_BASE_SQL as BASE_SQL } from './helpers/line-events-base'

const MIGRATION_CATEGORY  = '20260711000002_estimate_items_category.sql'
const MIGRATION_REFLECTED = '20260711000005_reflected_to_estimate.sql'
const MIGRATION_KI_001    = '20261013000001_link_line_event_on_estimate_add.sql'

let server: LocalPostgres
let admin: Client

const COMPANY_A = randomUUID()
const COMPANY_B = randomUUID()
const USER_A = randomUUID()
const USER_B = randomUUID()
const USER_AB = randomUUID() // A社・B社の両方に所属
let PROJECT_A: string
let PROJECT_A2: string
let PROJECT_A_DELETED: string
let PROJECT_B: string

async function setupDatabase(c: Client, withKi001 = true) {
  await c.query(SUPABASE_STUB_SQL)
  await c.query(BASE_SQL)
  await c.query(readMigration(MIGRATION_CATEGORY))
  await c.query(readMigration(MIGRATION_REFLECTED))
  if (withKi001) await c.query(readMigration(MIGRATION_KI_001))
}

let policiesBefore: unknown[]
async function policies(c: Client) {
  const { rows } = await c.query(`
    SELECT tablename, policyname, cmd, roles::text, qual, with_check FROM pg_policies
    WHERE schemaname = 'public' ORDER BY tablename, policyname`)
  return rows
}

beforeAll(async () => {
  server = await startLocalPostgres()
  await server.createDatabase('ki001')
  admin = await server.connect('ki001')

  await setupDatabase(admin, false)
  policiesBefore = await policies(admin)
  await admin.query(readMigration(MIGRATION_KI_001))

  await admin.query('INSERT INTO auth.users (id) VALUES ($1), ($2), ($3)', [USER_A, USER_B, USER_AB])
  await admin.query('INSERT INTO companies (id, name) VALUES ($1, $2), ($3, $4)', [COMPANY_A, 'A社', COMPANY_B, 'B社'])
  await admin.query(
    'INSERT INTO company_members (company_id, user_id) VALUES ($1, $2), ($3, $4), ($1, $5), ($3, $5)',
    [COMPANY_A, USER_A, COMPANY_B, USER_B, USER_AB],
  )
  PROJECT_A = await newProject(COMPANY_A)
  PROJECT_A2 = await newProject(COMPANY_A)
  PROJECT_A_DELETED = await newProject(COMPANY_A, true)
  PROJECT_B = await newProject(COMPANY_B)
}, 120_000)

afterAll(async () => {
  await server?.stop()
})

async function newProject(companyId: string, deleted = false): Promise<string> {
  const { rows } = await admin.query(
    'INSERT INTO projects (company_id, deleted_at) VALUES ($1, $2) RETURNING id',
    [companyId, deleted ? new Date().toISOString() : null],
  )
  return rows[0].id
}

/** LINE イベント（Webhook と同じく service_role 相当の superuser で作る） */
async function newEvent(companyId: string, opts: { projectId?: string | null; reflected?: boolean } = {}): Promise<string> {
  const { rows } = await admin.query(
    `INSERT INTO line_events (company_id, line_user_id, line_event_id, event_type, project_id, is_processed, reflected_to_estimate)
     VALUES ($1, 'U-test', $2, 'audio', $3, true, $4) RETURNING id`,
    [companyId, randomUUID(), opts.projectId ?? null, opts.reflected ?? false],
  )
  return rows[0].id
}

async function eventState(eventId: string) {
  const { rows: [e] } = await admin.query('SELECT project_id, reflected_to_estimate FROM line_events WHERE id = $1', [eventId])
  const { rows: items } = await admin.query(
    `SELECT project_id, company_id, name, unit, selling_price::text, category, quantity::text, memo, source, sort_order, amount::text
     FROM estimate_items WHERE line_event_id = $1 AND deleted_at IS NULL ORDER BY sort_order`, [eventId])
  return { projectId: e.project_id as string | null, reflected: e.reflected_to_estimate as boolean, items }
}

async function begin(c: Client, userId: string | null, role = 'authenticated') {
  await c.query('BEGIN')
  await c.query(`SET LOCAL ROLE ${role}`)
  await c.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [userId ?? ''])
}

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

type Item = { name: unknown; unit: unknown; selling_price?: unknown; category?: unknown; quantity?: unknown; memo?: unknown }
type AddResult = { created: number; project_id: string; line_event_id: string; linked: boolean }

const ITEMS: Item[] = [
  { name: 'システムバス', unit: '式', selling_price: 850000, category: '設備', quantity: null, memo: '1616サイズ' },
  { name: '床張替え', unit: '㎡', selling_price: 4800.5, category: '内装', quantity: 12.5 },
]

async function rpcAdd(c: Client, projectId: string, eventId: string, items: unknown = ITEMS): Promise<AddResult> {
  const { rows } = await c.query(
    'SELECT public.add_line_event_estimate_items($1::uuid, $2::uuid, $3::jsonb) AS r',
    [projectId, eventId, JSON.stringify(items)],
  )
  return rows[0].r
}

async function pgError(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p
  } catch (e) {
    const err = e as { code: string; message: string }
    return { code: err.code, message: err.message }
  }
  throw new Error('expected an error')
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

let userA: Client
let userA2: Client
beforeAll(async () => {
  userA = await server.connect('ki001')
  userA2 = await server.connect('ki001')
})

// ── 紐付け ──────────────────────────────────────────────────

describe('見積に追加と紐付け', () => {
  it('未振り分けのイベント: 見積項目を追加し、同じトランザクションで project_id を案件に設定する', async () => {
    const ev = await newEvent(COMPANY_A)
    const r = await asUser(userA, USER_A, () => rpcAdd(userA, PROJECT_A, ev))
    expect(r).toEqual({ created: 2, project_id: PROJECT_A, line_event_id: ev, linked: true })

    const s = await eventState(ev)
    expect(s.projectId).toBe(PROJECT_A)
    expect(s.reflected).toBe(true)
    // 現行 API と同じ値で入る（quantity 無し → 1、source = past_item、sort_order = 配列の順番、company_id = 案件の会社）
    expect(s.items).toEqual([
      { project_id: PROJECT_A, company_id: COMPANY_A, name: 'システムバス', unit: '式', selling_price: '850000', category: '設備', quantity: '1', memo: '1616サイズ', source: 'past_item', sort_order: 0, amount: '850000' },
      { project_id: PROJECT_A, company_id: COMPANY_A, name: '床張替え', unit: '㎡', selling_price: '4800.5', category: '内装', quantity: '12.5', memo: null, source: 'past_item', sort_order: 1, amount: '60006.25' },
    ])
  })

  it('同じ案件に振り分け済みのイベント: 追加でき、project_id は変わらない（linked = false）', async () => {
    const ev = await newEvent(COMPANY_A, { projectId: PROJECT_A })
    const r = await asUser(userA, USER_A, () => rpcAdd(userA, PROJECT_A, ev))
    expect(r.linked).toBe(false)
    expect(await eventState(ev)).toMatchObject({ projectId: PROJECT_A, reflected: true })
  })

  it('別の案件に振り分け済みのイベント: 拒否し、既存の紐付けを上書きしない（見積項目も追加しない）', async () => {
    const ev = await newEvent(COMPANY_A, { projectId: PROJECT_A2 })
    const e = await pgError(asUser(userA, USER_A, () => rpcAdd(userA, PROJECT_A, ev)))
    expect(e).toEqual({ code: 'LE409', message: 'linked_to_other_project' })
    expect(await eventState(ev)).toEqual({ projectId: PROJECT_A2, reflected: false, items: [] })
  })

  it('反映済みのイベント（重複実行）: 拒否し、見積項目を二重に追加しない', async () => {
    const ev = await newEvent(COMPANY_A)
    await asUser(userA, USER_A, () => rpcAdd(userA, PROJECT_A, ev))
    const e = await pgError(asUser(userA, USER_A, () => rpcAdd(userA, PROJECT_A, ev)))
    expect(e).toEqual({ code: 'LE409', message: 'already_reflected' })
    expect((await eventState(ev)).items).toHaveLength(2)
  })

  it('「取り消す」（現行 DELETE API と同じ更新）の後は追加し直せる。紐付けは残る', async () => {
    const ev = await newEvent(COMPANY_A)
    await asUser(userA, USER_A, () => rpcAdd(userA, PROJECT_A, ev))
    await asUser(userA, USER_A, async () => {
      await userA.query('UPDATE estimate_items SET deleted_at = now() WHERE line_event_id = $1 AND deleted_at IS NULL', [ev])
      await userA.query('UPDATE line_events SET reflected_to_estimate = false WHERE id = $1', [ev])
    })
    expect(await eventState(ev)).toEqual({ projectId: PROJECT_A, reflected: false, items: [] })

    const r = await asUser(userA, USER_A, () => rpcAdd(userA, PROJECT_A, ev, [ITEMS[0]]))
    expect(r).toMatchObject({ created: 1, linked: false })
    expect(await eventState(ev)).toMatchObject({ projectId: PROJECT_A, reflected: true })
  })
})

// ── 会社・権限 ───────────────────────────────────────────────

describe('会社の一致・他社アクセス・未認証', () => {
  it('他社のイベント: 存在しない場合と同じ LE404。何も変わらない', async () => {
    const ev = await newEvent(COMPANY_B)
    for (const target of [ev, randomUUID()]) {
      const e = await pgError(asUser(userA, USER_A, () => rpcAdd(userA, PROJECT_A, target)))
      expect(e).toEqual({ code: 'LE404', message: 'not_found' })
    }
    expect(await eventState(ev)).toEqual({ projectId: null, reflected: false, items: [] })
  })

  it('他社の案件・削除済みの案件・存在しない案件: LE404。自社イベントは未振り分けのまま', async () => {
    const ev = await newEvent(COMPANY_A)
    for (const project of [PROJECT_B, PROJECT_A_DELETED, randomUUID()]) {
      const e = await pgError(asUser(userA, USER_A, () => rpcAdd(userA, project, ev)))
      expect(e).toEqual({ code: 'LE404', message: 'not_found' })
    }
    expect(await eventState(ev)).toEqual({ projectId: null, reflected: false, items: [] })
    const { rows } = await admin.query('SELECT count(*)::int AS n FROM estimate_items WHERE project_id = $1', [PROJECT_B])
    expect(rows[0].n).toBe(0)
  })

  it('両社に所属するユーザー: イベント（A社）と案件（B社）の会社が違えば LE403', async () => {
    const evA = await newEvent(COMPANY_A)
    const evB = await newEvent(COMPANY_B)
    expect(await pgError(asUser(userA, USER_AB, () => rpcAdd(userA, PROJECT_B, evA))))
      .toEqual({ code: 'LE403', message: 'company_mismatch' })
    expect(await pgError(asUser(userA, USER_AB, () => rpcAdd(userA, PROJECT_A, evB))))
      .toEqual({ code: 'LE403', message: 'company_mismatch' })
    expect(await eventState(evA)).toEqual({ projectId: null, reflected: false, items: [] })
    expect(await eventState(evB)).toEqual({ projectId: null, reflected: false, items: [] })
    // 同じ会社どうしなら追加できる
    expect((await asUser(userA, USER_AB, () => rpcAdd(userA, PROJECT_B, evB))).linked).toBe(true)
  })

  it('未認証（auth.uid() が無い）: LE401。anon・service_role は関数を実行できない（42501）', async () => {
    const ev = await newEvent(COMPANY_A)
    expect(await pgError(asUser(userA, null, () => rpcAdd(userA, PROJECT_A, ev))))
      .toEqual({ code: 'LE401', message: 'unauthenticated' })
    for (const role of ['anon', 'service_role']) {
      const e = await pgError(asUser(userA, USER_A, () => rpcAdd(userA, PROJECT_A, ev), role))
      expect(e.code).toBe('42501')
    }
    expect(await eventState(ev)).toEqual({ projectId: null, reflected: false, items: [] })
  })

  it('入力が不正: LE400（何も変わらない）', async () => {
    const ev = await newEvent(COMPANY_A)
    const bad: unknown[] = [
      [],
      {},
      Array.from({ length: 101 }, () => ({ name: 'x', unit: '式' })),
      [{ name: '', unit: '式' }],
      [{ name: '  ', unit: '式' }],
      [{ name: 'x', unit: '' }],
      [{ name: 'x' }],
      [{ name: 1, unit: '式' }],
      [{ name: 'x', unit: '式', selling_price: '1000' }],
      [{ name: 'x', unit: '式', quantity: -1 }],
      [{ name: 'x', unit: '式', quantity: '2' }],
      [{ name: 'x', unit: '式', selling_price: 1e12 }],
      [{ name: 'x', unit: '式', memo: 5 }],
      [{ name: 'x'.repeat(501), unit: '式' }],
      ['x'],
    ]
    for (const items of bad) {
      const e = await pgError(asUser(userA, USER_A, () => rpcAdd(userA, PROJECT_A, ev, items)))
      expect(e, JSON.stringify(items).slice(0, 60)).toEqual({ code: 'LE400', message: 'invalid_input' })
    }
    expect(await eventState(ev)).toEqual({ projectId: null, reflected: false, items: [] })
  })
})

// ── 一体性・同時実行 ─────────────────────────────────────────

describe('一体性・同時実行', () => {
  it('イベントの更新が失敗したら見積項目の追加も取り消される（見積だけ追加された状態が残らない）', async () => {
    const ev = await newEvent(COMPANY_A)
    await admin.query(`
      CREATE FUNCTION fail_line_event_update() RETURNS trigger LANGUAGE plpgsql AS
        $$ BEGIN RAISE EXCEPTION 'forced failure'; END $$;
      CREATE TRIGGER fail_line_event_update BEFORE UPDATE ON line_events
        FOR EACH ROW EXECUTE FUNCTION fail_line_event_update();`)
    try {
      const e = await pgError(asUser(userA, USER_A, () => rpcAdd(userA, PROJECT_A, ev)))
      expect(e.message).toBe('forced failure')
    } finally {
      await admin.query('DROP TRIGGER fail_line_event_update ON line_events; DROP FUNCTION fail_line_event_update();')
    }
    expect(await eventState(ev)).toEqual({ projectId: null, reflected: false, items: [] })
  })

  it('同じイベントへの同時の追加: 後の操作はロックを待ち、先の操作のコミット後に already_reflected で拒否される', async () => {
    const ev = await newEvent(COMPANY_A)
    await begin(userA, USER_A)
    await rpcAdd(userA, PROJECT_A, ev)

    const pid2 = await backendPid(userA2)
    await begin(userA2, USER_A)
    const second = pgError(rpcAdd(userA2, PROJECT_A, ev))
    await waitUntilBlocked(pid2)
    await userA.query('COMMIT')
    expect(await second).toEqual({ code: 'LE409', message: 'already_reflected' })
    await userA2.query('ROLLBACK')

    const s = await eventState(ev)
    expect(s).toMatchObject({ projectId: PROJECT_A, reflected: true })
    expect(s.items).toHaveLength(2)
  })

  it('同じ未振り分けイベントを別々の案件へ同時に追加: 先にコミットした案件だけに紐付き、後は linked_to_other_project', async () => {
    const ev = await newEvent(COMPANY_A)
    await begin(userA, USER_A)
    await rpcAdd(userA, PROJECT_A2, ev)

    const pid2 = await backendPid(userA2)
    await begin(userA2, USER_A)
    const second = pgError(rpcAdd(userA2, PROJECT_A, ev))
    await waitUntilBlocked(pid2)
    await userA.query('COMMIT')
    expect(await second).toEqual({ code: 'LE409', message: 'linked_to_other_project' })
    await userA2.query('ROLLBACK')

    const s = await eventState(ev)
    expect(s.projectId).toBe(PROJECT_A2)
    expect(s.items.every(i => i.project_id === PROJECT_A2)).toBe(true)
  })

  it('先の操作が取り消された場合: 待っていた操作がそのまま成功する', async () => {
    const ev = await newEvent(COMPANY_A)
    await begin(userA, USER_A)
    await rpcAdd(userA, PROJECT_A2, ev)

    const pid2 = await backendPid(userA2)
    await begin(userA2, USER_A)
    const second = rpcAdd(userA2, PROJECT_A, ev)
    await waitUntilBlocked(pid2)
    await userA.query('ROLLBACK')
    expect((await second).linked).toBe(true)
    await userA2.query('COMMIT')

    const s = await eventState(ev)
    expect(s.projectId).toBe(PROJECT_A)
    expect(s.items).toHaveLength(2)
  })
})

// ── migration の範囲 ─────────────────────────────────────────

describe('migration の範囲', () => {
  it('RLS ポリシーを変えない。EXECUTE は authenticated のみ', async () => {
    expect(await policies(admin)).toEqual(policiesBefore)
    const { rows } = await admin.query(`
      SELECT r.rolname, has_function_privilege(r.rolname, 'public.add_line_event_estimate_items(uuid, uuid, jsonb)', 'EXECUTE') AS can
      FROM pg_roles r WHERE r.rolname IN ('anon', 'authenticated', 'service_role') ORDER BY r.rolname`)
    expect(rows).toEqual([
      { rolname: 'anon', can: false },
      { rolname: 'authenticated', can: true },
      { rolname: 'service_role', can: false },
    ])
    const { rows: [fn] } = await admin.query(`
      SELECT p.prosecdef, p.proconfig FROM pg_proc p WHERE p.oid = 'public.add_line_event_estimate_items(uuid, uuid, jsonb)'::regprocedure`)
    expect(fn.prosecdef).toBe(false) // SECURITY INVOKER（RLS が効く）
    expect(fn.proconfig).toEqual(expect.arrayContaining(['search_path=""', 'lock_timeout=5s']))
  })

  it('前提の列が無い DB では何も作らずに止まる', async () => {
    await server.createDatabase('ki001_pre')
    const c = await server.connect('ki001_pre')
    await c.query(SUPABASE_STUB_SQL)
    await c.query(BASE_SQL)
    await c.query(readMigration(MIGRATION_CATEGORY)) // reflected_to_estimate / line_event_id が無い
    const e = await pgError(c.query(readMigration(MIGRATION_KI_001)))
    expect(e.message).toContain('KI-001 precondition failed')
    const { rows } = await c.query("SELECT to_regprocedure('public.add_line_event_estimate_items(uuid, uuid, jsonb)') AS f")
    expect(rows[0].f).toBeNull()
  })

  it('再適用できる（CREATE OR REPLACE）', async () => {
    await admin.query(readMigration(MIGRATION_KI_001))
    const ev = await newEvent(COMPANY_A)
    expect((await asUser(userA, USER_A, () => rpcAdd(userA, PROJECT_A, ev))).linked).toBe(true)
  })
})

// ── SQL Editor 用の適用・ロールバックスクリプト（docs/db/ki-001-sql-editor-*.sql） ──

describe('SQL Editor 用スクリプト（1 トランザクションでの適用と migration 履歴）', () => {
  const DOCS = path.resolve(__dirname, '../../docs/db')
  const APPLY = readFileSync(path.join(DOCS, 'ki-001-sql-editor-apply.sql'), 'utf8')
  const ROLLBACK = readFileSync(path.join(DOCS, 'ki-001-sql-editor-rollback.sql'), 'utf8')
  const HISTORY_SQL = `
    CREATE SCHEMA supabase_migrations;
    CREATE TABLE supabase_migrations.schema_migrations (version text PRIMARY KEY, statements text[], name text);
    INSERT INTO supabase_migrations.schema_migrations (version) VALUES ('20260711000005');`

  let dbSeq = 0
  /** KI-001 未適用の DB（SQL Editor で適用する前の本番に相当） */
  async function freshDb() {
    const name = `ki001_editor_${++dbSeq}`
    await server.createDatabase(name)
    const c = await server.connect(name)
    await setupDatabase(c, false)
    await c.query(HISTORY_SQL)
    return c
  }
  async function history(c: Client) {
    const { rows } = await c.query("SELECT version, name FROM supabase_migrations.schema_migrations WHERE version = '20261013000001'")
    return rows
  }
  async function fnExists(c: Client) {
    const { rows } = await c.query("SELECT to_regprocedure('public.add_line_event_estimate_items(uuid, uuid, jsonb)') IS NOT NULL AS f")
    return rows[0].f as boolean
  }
  /** 全文を 1 回のクエリ（simple query protocol・複数文）で送る */
  async function runScript(c: Client, sql: string) {
    const res = await c.query(sql)
    const results = Array.isArray(res) ? res : [res]
    return results[results.length - 1].rows
  }
  /** 失敗したら、SQL Editor で案内しているとおり ROLLBACK だけを送る */
  async function runScriptExpectingError(c: Client, sql: string) {
    const e = await pgError(c.query(sql))
    await c.query('ROLLBACK')
    return e
  }

  it('適用スクリプトの本体は migration ファイルと完全に一致する', () => {
    const start = APPLY.indexOf('-- >>> MIGRATION BODY\n')
    const end = APPLY.lastIndexOf('-- <<< MIGRATION BODY')
    expect(start).toBeGreaterThan(0)
    expect(APPLY.slice(start + '-- >>> MIGRATION BODY\n'.length, end)).toBe(readMigration(MIGRATION_KI_001))
    expect(readMigration(MIGRATION_KI_001)).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK|START TRANSACTION)\s*;/im)
    for (const sql of [APPLY, ROLLBACK]) {
      expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1)
      expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1)
    }
  })

  it('成功時: 関数と履歴がそろって確定し、RLS ポリシーは変わらない。トランザクションは閉じている', async () => {
    const c = await freshDb()
    const before = await policies(c)
    expect(await runScript(c, APPLY)).toEqual([{ history_rows: '1', function_exists: true, security_invoker: true }])
    expect(await history(c)).toEqual([{ version: '20261013000001', name: 'link_line_event_on_estimate_add' }])
    expect(await policies(c)).toEqual(before)
    const { rows } = await c.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = pg_backend_pid() AND state = 'idle in transaction'")
    expect(rows[0].n).toBe(0)
    await c.end()
  })

  it('二度目の実行はガードで止まり、何も変わらない', async () => {
    const c = await freshDb()
    await runScript(c, APPLY)
    const e = await runScriptExpectingError(c, APPLY)
    expect(e.message).toBe('KI-001 apply aborted: version 20261013000001 is already recorded')
    expect(await history(c)).toHaveLength(1)
    await c.end()
  })

  it('履歴なしで関数だけある DB では上書きせずに止まる', async () => {
    const c = await freshDb()
    await c.query(readMigration(MIGRATION_KI_001))
    const e = await runScriptExpectingError(c, APPLY)
    expect(e.message).toBe('KI-001 apply aborted: function already exists (history is missing)')
    expect(await history(c)).toHaveLength(0)
    await c.end()
  })

  it('前提の列が無ければ関数も履歴も残らない', async () => {
    const c = await freshDb()
    await c.query('ALTER TABLE estimate_items DROP COLUMN line_event_id')
    const e = await runScriptExpectingError(c, APPLY)
    expect(e.message).toContain('KI-001 precondition failed')
    expect(await fnExists(c)).toBe(false)
    expect(await history(c)).toHaveLength(0)
    await c.end()
  })

  it('ロールバック: 関数と履歴の 1 行だけを消す。二度目はガードで止まり、適用し直せる', async () => {
    const c = await freshDb()
    await runScript(c, APPLY)
    const { rows: [{ count: before }] } = await c.query('SELECT count(*) FROM supabase_migrations.schema_migrations')
    expect(await runScript(c, ROLLBACK)).toEqual([{ history_rows: '0', function_exists: false }])
    const { rows: [{ count: after }] } = await c.query('SELECT count(*) FROM supabase_migrations.schema_migrations')
    expect(Number(after)).toBe(Number(before) - 1)
    const e = await runScriptExpectingError(c, ROLLBACK)
    expect(e.message).toBe('KI-001 rollback aborted: nothing to roll back (no history row, no function)')
    // ロールバック後に適用し直せる
    expect(await runScript(c, APPLY)).toEqual([{ history_rows: '1', function_exists: true, security_invoker: true }])
    await c.end()
  })
})
