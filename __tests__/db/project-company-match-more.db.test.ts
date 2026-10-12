/**
 * KI-002 PR-3: 案件にぶら下がる 12 テーブルの「案件」と「会社」の一致（migration 20261014000001）の DB 検証。
 *
 * 実行: npm run test:db
 *   隔離されたローカル PostgreSQL（embedded-postgres）にリポジトリの全 migration を適用して検証する。
 *   本番・Preview の DB には接続しない。
 *
 * 1. 修正前の DB（20261014000001 だけ未適用）で、ログイン済みユーザーが PostgREST と同じ権限（authenticated + RLS）で
 *    company_id = 自社・project_id = 他社の案件 という行を 12 テーブルすべてに直接 INSERT / UPDATE できることを再現する。
 * 2. 食い違いがあれば migration は何も作らずに止まり、適用後はロール・経路にかかわらず拒否され、正常な操作は変わらない。
 * 3. SQL Editor 用の適用・ロールバック・確認スクリプト（docs/db/ki-002-pr3-*.sql）を検証する。
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readMigration, startLocalPostgres, type LocalPostgres } from './helpers/local-postgres'
import { applyFullSchema } from './helpers/full-schema'

const MIGRATION_KI001_MATCH = '20261013000002_enforce_project_company_match.sql'
const MIGRATION = '20261014000001_enforce_project_company_match_more_tables.sql'

type Spec = {
  tbl: string
  /** company_id / project_id 以外に必要な列と値 */
  cols: string
  vals: string
  key: string
  /** company_id が NULL を許すため CHECK を付けるテーブル */
  check: boolean
  /** project_id が NULL を許す（未振り分け・案件なし） */
  nullableProject: boolean
  softDelete: boolean
  onDelete: 'c' | 'a'
}

const EVENT_A = randomUUID()

const SPECS: Spec[] = [
  { tbl: 'ai_summaries',               cols: 'result_type, content',      vals: "'summary', '{}'::jsonb",       key: 'id',       check: false, nullableProject: false, softDelete: false, onDelete: 'c' },
  { tbl: 'cost_ledger_items',          cols: 'name',                      vals: "'原価'",                        key: 'id',       check: true,  nullableProject: false, softDelete: true,  onDelete: 'c' },
  { tbl: 'estimate_documents',         cols: 'content',                   vals: "'[]'::jsonb",                  key: 'id',       check: false, nullableProject: false, softDelete: false, onDelete: 'c' },
  { tbl: 'estimate_groups',            cols: 'label',                     vals: "'工種'",                        key: 'id',       check: true,  nullableProject: true,  softDelete: true,  onDelete: 'c' },
  { tbl: 'invoice_documents',          cols: 'invoice_number',            vals: "'INV-T'",                      key: 'id',       check: true,  nullableProject: true,  softDelete: false, onDelete: 'c' },
  { tbl: 'line_event_notes',           cols: 'anchor_event_id, note_type', vals: `'${EVENT_A}', 'text'`,         key: 'id',       check: false, nullableProject: true,  softDelete: false, onDelete: 'a' },
  { tbl: 'project_billing_milestones', cols: 'type',                      vals: "'契約金'",                      key: 'id',       check: true,  nullableProject: false, softDelete: false, onDelete: 'c' },
  { tbl: 'project_files',              cols: 'file_type, storage_path',   vals: "'photo', 'x.jpg'",             key: 'id',       check: false, nullableProject: false, softDelete: true,  onDelete: 'c' },
  { tbl: 'project_notes',              cols: 'content',                   vals: "'メモ'",                        key: 'id',       check: false, nullableProject: false, softDelete: false, onDelete: 'c' },
  { tbl: 'schedule_draft_adoptions',   cols: 'draft_id',                  vals: 'gen_random_uuid()::text',      key: 'draft_id', check: true,  nullableProject: true,  softDelete: false, onDelete: 'c' },
  { tbl: 'schedule_items',             cols: 'name',                      vals: "'工程'",                        key: 'id',       check: false, nullableProject: false, softDelete: true,  onDelete: 'c' },
  { tbl: 'share_links',                cols: 'token',                     vals: 'gen_random_uuid()::text',      key: 'id',       check: false, nullableProject: false, softDelete: false, onDelete: 'c' },
]
const CHECK_SPECS = SPECS.filter(s => s.check)
const fkName = (tbl: string) => `${tbl}_project_company_fkey`
const checkName = (tbl: string) => `${tbl}_project_requires_company_check`
const NEW_CONSTRAINTS = [...SPECS.map(s => fkName(s.tbl)), ...CHECK_SPECS.map(s => checkName(s.tbl))]
const NEW_LIST = NEW_CONSTRAINTS.map(n => `'${n}'`).join(', ')
const KI001_LIST = ['projects_id_company_id_key', 'estimate_items_project_company_fkey', 'line_events_project_company_fkey', 'line_events_project_requires_company_check']
  .map(n => `'${n}'`).join(', ')

let server: LocalPostgres
let admin: Client
let userA: Client

const COMPANY_A = randomUUID()
const COMPANY_B = randomUUID()
const USER_A = randomUUID()
const USER_AB = randomUUID() // A社・B社の両方に所属
let PROJECT_A: string
let PROJECT_A2: string
let PROJECT_B: string

async function seed(c: Client) {
  await c.query('INSERT INTO auth.users (id) VALUES ($1), ($2)', [USER_A, USER_AB])
  await c.query('INSERT INTO companies (id, name) VALUES ($1, $2), ($3, $4)', [COMPANY_A, 'A社', COMPANY_B, 'B社'])
  await c.query(
    'INSERT INTO company_members (company_id, user_id) VALUES ($1, $2), ($1, $3), ($4, $3)',
    [COMPANY_A, USER_A, USER_AB, COMPANY_B],
  )
  await c.query(
    "INSERT INTO line_events (id, company_id, line_user_id, line_event_id, event_type) VALUES ($1, $2, 'U-test', $3, 'text')",
    [EVENT_A, COMPANY_A, randomUUID()],
  )
}

async function newProject(c: Client, companyId: string | null): Promise<string> {
  const { rows } = await c.query('INSERT INTO projects (company_id) VALUES ($1) RETURNING id', [companyId])
  return rows[0].id
}

const insertRow = (c: Client, s: Spec, companyId: string | null, projectId: string | null) =>
  c.query(`INSERT INTO ${s.tbl} (company_id, project_id, ${s.cols}) VALUES ($1, $2, ${s.vals}) RETURNING ${s.key} AS id`,
    [companyId, projectId])

/** service_role 相当の superuser で作る（RLS・外部キーは通常どおり効く） */
async function newRow(s: Spec, companyId: string | null, projectId: string | null, c: Client = admin): Promise<string> {
  const { rows } = await insertRow(c, s, companyId, projectId)
  return rows[0].id
}

async function rowOf(s: Spec, id: string, c: Client = admin) {
  const { rows } = await c.query(`SELECT company_id, project_id FROM ${s.tbl} WHERE ${s.key} = $1`, [id])
  return rows[0] as { company_id: string | null; project_id: string | null } | undefined
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

/** supabase の migration と同じく 1 ファイル = 1 トランザクションで流す */
async function applyMigration(c: Client, name = MIGRATION) {
  await c.query('BEGIN')
  try {
    await c.query(readMigration(name))
    await c.query('COMMIT')
  } catch (e) {
    await c.query('ROLLBACK')
    throw e
  }
}

async function newConstraintCount(c: Client): Promise<number> {
  const { rows } = await c.query(`SELECT count(*)::int AS n FROM pg_constraint WHERE conname IN (${NEW_LIST})`)
  return rows[0].n
}
async function ki001ConstraintCount(c: Client): Promise<number> {
  const { rows } = await c.query(`SELECT count(*)::int AS n FROM pg_constraint WHERE convalidated AND conname IN (${KI001_LIST})`)
  return rows[0].n
}
async function allConstraints(c: Client) {
  const { rows } = await c.query(`
    SELECT conrelid::regclass::text AS tbl, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
    WHERE connamespace = 'public'::regnamespace ORDER BY 1, 2`)
  return rows
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
    WHERE table_schema = 'public' ORDER BY 1, 2, 3`)
  return rows
}

/** 修正前（20261014000001 だけ未適用）の DB を新しく作る */
async function freshDb(name: string, skip: string[] = [MIGRATION]) {
  await server.createDatabase(name)
  const c = await server.connect(name)
  await applyFullSchema(c, { skip })
  await seed(c)
  return c
}

let policiesBefore: unknown[]
let privilegesBefore: unknown[]

beforeAll(async () => {
  server = await startLocalPostgres()
  await server.createDatabase('pcm2')
  admin = await server.connect('pcm2')
  await applyFullSchema(admin, { skip: [MIGRATION] })
  await seed(admin)
  PROJECT_A = await newProject(admin, COMPANY_A)
  PROJECT_A2 = await newProject(admin, COMPANY_A)
  PROJECT_B = await newProject(admin, COMPANY_B)
  userA = await server.connect('pcm2')
  policiesBefore = await policies(admin)
  privilegesBefore = await tablePrivileges(admin)
}, 120_000)

afterAll(async () => {
  await server?.stop()
})

// ── 1. 修正前: 抜け道の再現 ───────────────────────────────────

/** 再現で作った行（適用前に人間が解消する想定。隔離 DB なのでテストが消す） */
const reproduced = new Map<string, string[]>()
const remember = (tbl: string, id: string) => reproduced.set(tbl, [...(reproduced.get(tbl) ?? []), id])

describe('修正前（20261014000001 未適用）: PostgREST と同じ権限で他社の案件を指定できてしまう', () => {
  it('前提: 20261013000002（estimate_items / line_events と projects の一意制約）は適用済み、新しい制約は無い', async () => {
    expect(await ki001ConstraintCount(admin)).toBe(4)
    expect(await newConstraintCount(admin)).toBe(0)
  })

  it.each(SPECS)('$tbl: 直接 INSERT（company_id = 自社, project_id = 他社の案件）が成功する', async (s) => {
    const { rows } = await asUser(userA, USER_A, () => insertRow(userA, s, COMPANY_A, PROJECT_B))
    remember(s.tbl, rows[0].id)
    expect(await rowOf(s, rows[0].id)).toEqual({ company_id: COMPANY_A, project_id: PROJECT_B })
  })

  it.each(SPECS)('$tbl: 自社の行の project_id を他社の案件へ直接 UPDATE できる', async (s) => {
    const id = await newRow(s, COMPANY_A, PROJECT_A)
    const r = await asUser(userA, USER_A, () =>
      userA.query(`UPDATE ${s.tbl} SET project_id = $1 WHERE ${s.key} = $2`, [PROJECT_B, id]))
    expect(r.rowCount).toBe(1)
    remember(s.tbl, id)
    expect((await rowOf(s, id))?.project_id).toBe(PROJECT_B)
  })

  it.each(CHECK_SPECS)('$tbl: service_role は company_id = NULL のまま他社の案件に紐付けられる（複合外部キーだけでは塞げない）', async (s) => {
    const { rows } = await asUser(userA, null, () => insertRow(userA, s, null, PROJECT_B), 'service_role')
    remember(s.tbl, rows[0].id)
    expect(await rowOf(s, rows[0].id)).toEqual({ company_id: null, project_id: PROJECT_B })
  })
})

// ── 2. 適用 ─────────────────────────────────────────────────

describe('migration の適用', () => {
  it('食い違っている既存行があれば、全テーブル分を 1 つのメッセージで出して何も作らずに止まる（補正はしない）', async () => {
    const constraintsBefore = await allConstraints(admin)
    const e = await pgError(applyMigration(admin))
    expect(e.message).toBe('project-company-2 precondition failed: ' + SPECS.map(s =>
      `${s.tbl}: mismatched=2 orphan=0 null_company=${s.check ? 1 : 0}`).join('; '))
    expect(await newConstraintCount(admin)).toBe(0)
    expect(await allConstraints(admin)).toEqual(constraintsBefore)
    for (const s of SPECS) {
      for (const id of reproduced.get(s.tbl)!) expect((await rowOf(s, id))?.project_id).toBe(PROJECT_B) // 既存行は変えない
    }
  })

  it('参照先の案件が無い行（外部キー導入前の残り）があれば止まる', async () => {
    for (const s of SPECS) await admin.query(`DELETE FROM ${s.tbl} WHERE ${s.key} = ANY($1)`, [reproduced.get(s.tbl)])
    const notes = SPECS.find(s => s.tbl === 'project_notes')!
    await admin.query('BEGIN')
    await admin.query("SET LOCAL session_replication_role = 'replica'")
    const orphan = await newRow(notes, COMPANY_A, randomUUID())
    await admin.query('COMMIT')
    const e = await pgError(applyMigration(admin))
    expect(e.message).toBe('project-company-2 precondition failed: project_notes: mismatched=0 orphan=1 null_company=0')
    expect(await newConstraintCount(admin)).toBe(0)
    await admin.query('DELETE FROM project_notes WHERE id = $1', [orphan])
  })

  it('20261013000002（projects の UNIQUE (id, company_id)）が未適用なら止まる（一意制約は作らない）', async () => {
    const c = await freshDb('pcm2_no_ki001', [MIGRATION_KI001_MATCH, MIGRATION])
    const e = await pgError(applyMigration(c))
    expect(e.message).toBe('project-company-2 precondition failed: projects has no UNIQUE (id, company_id) (apply 20261013000002 first)')
    expect(await newConstraintCount(c)).toBe(0)
    await c.end()
  })

  it('本番の定義がリポジトリと違えば止まる（列が NULL 可・既存の外部キーの ON DELETE・同じ名前で別定義の制約・テーブルが無い）', async () => {
    const c = await freshDb('pcm2_drift')
    await c.query('ALTER TABLE project_notes ALTER COLUMN company_id DROP NOT NULL')
    await c.query(`ALTER TABLE line_event_notes DROP CONSTRAINT line_event_notes_project_id_fkey,
      ADD CONSTRAINT line_event_notes_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE`)
    await c.query('ALTER TABLE share_links ADD CONSTRAINT share_links_project_company_fkey CHECK (true)')
    await c.query(`ALTER TABLE estimate_groups ADD CONSTRAINT estimate_groups_project_company_fkey
      FOREIGN KEY (project_id, company_id) REFERENCES projects (id, company_id) ON DELETE SET NULL NOT VALID`)
    await c.query('DROP TABLE schedule_draft_adoptions')
    const before = await allConstraints(c)
    const e = await pgError(applyMigration(c))
    expect(e.message).toBe('project-company-2 precondition failed: ' + [
      'estimate_groups: constraint estimate_groups_project_company_fkey exists with a different definition',
      'line_event_notes: existing project_id fkey on delete is {c} (expected a)',
      'project_notes: company_id is nullable',
      'schedule_draft_adoptions: table missing',
      'share_links: constraint share_links_project_company_fkey exists with a different definition',
    ].join('; '))
    expect(await allConstraints(c)).toEqual(before)
    await c.end()
  })

  it('ロック待ちで打ち切られても、途中まで追加した制約は残らない（lock_timeout・全体が 1 トランザクション）', async () => {
    const c = await freshDb('pcm2_lock')
    const locker = await server.connect('pcm2_lock')
    await locker.query('BEGIN')
    await locker.query('LOCK TABLE share_links IN ROW EXCLUSIVE MODE') // 書き込み中のトランザクション（最後のテーブル）
    const started = Date.now()
    const e = await pgError(applyMigration(c))
    expect(e.code).toBe('55P03')
    expect(Date.now() - started).toBeLessThan(20_000)
    await locker.query('ROLLBACK')
    expect(await newConstraintCount(c)).toBe(0)
    await applyMigration(c) // ロックが外れれば適用できる
    expect(await newConstraintCount(c)).toBe(NEW_CONSTRAINTS.length)
    await locker.end()
    await c.end()
  }, 60_000)

  it('食い違いを人間が解消した後なら適用できる。外部キー 12・CHECK 5 が VALID、ON DELETE は既存と同じ', async () => {
    await applyMigration(admin)
    const { rows } = await admin.query(`
      SELECT conrelid::regclass::text AS tbl, conname, contype, convalidated, confdeltype, pg_get_constraintdef(oid) AS def
      FROM pg_constraint WHERE conname IN (${NEW_LIST}) ORDER BY conname`)
    const expected = [
      ...SPECS.map(s => ({
        tbl: s.tbl, conname: fkName(s.tbl), contype: 'f', convalidated: true, confdeltype: s.onDelete,
        def: `FOREIGN KEY (project_id, company_id) REFERENCES projects(id, company_id)${s.onDelete === 'c' ? ' ON DELETE CASCADE' : ''}`,
      })),
      ...CHECK_SPECS.map(s => ({
        tbl: s.tbl, conname: checkName(s.tbl), contype: 'c', convalidated: true, confdeltype: ' ',
        def: 'CHECK (((project_id IS NULL) OR (company_id IS NOT NULL)))',
      })),
    ].sort((a, b) => a.conname.localeCompare(b.conname))
    expect(rows).toEqual(expected)
    // 既存の単独の外部キー（project_id → projects(id)）も残っている
    const { rows: single } = await admin.query(`
      SELECT count(*)::int AS n FROM pg_constraint
      WHERE conname = ANY($1) AND contype = 'f'`, [SPECS.map(s => `${s.tbl}_project_id_fkey`)])
    expect(single[0].n).toBe(SPECS.length)
  })

  it('20261013000002 の制約は残り、RLS ポリシー・テーブル権限は変わらない。再適用しても制約は増えない', async () => {
    expect(await ki001ConstraintCount(admin)).toBe(4)
    expect(await policies(admin)).toEqual(policiesBefore)
    expect(await tablePrivileges(admin)).toEqual(privilegesBefore)
    const before = await allConstraints(admin)
    await applyMigration(admin)
    expect(await allConstraints(admin)).toEqual(before)
    expect(await newConstraintCount(admin)).toBe(NEW_CONSTRAINTS.length)
  })
})

// ── 3. 修正後: 直接操作の拒否 ────────────────────────────────

describe('修正後: 他社の案件を指定した直接 INSERT / UPDATE は拒否される', () => {
  it.each(SPECS)('$tbl: 直接 INSERT（自社 / 他社の案件）→ 23503', async (s) => {
    const e = await pgError(asUser(userA, USER_A, () => insertRow(userA, s, COMPANY_A, PROJECT_B)))
    expect(e).toMatchObject({ code: '23503', constraint: fkName(s.tbl) })
  })

  it.each(SPECS)('$tbl: project_id を他社の案件へ UPDATE → 23503。行は変わらない', async (s) => {
    const id = await newRow(s, COMPANY_A, PROJECT_A)
    const e = await pgError(asUser(userA, USER_A, () =>
      userA.query(`UPDATE ${s.tbl} SET project_id = $1 WHERE ${s.key} = $2`, [PROJECT_B, id])))
    expect(e).toMatchObject({ code: '23503', constraint: fkName(s.tbl) })
    expect(await rowOf(s, id)).toEqual({ company_id: COMPANY_A, project_id: PROJECT_A })
  })

  it.each(SPECS)('$tbl: service_role（RLS をバイパス）でも 23503', async (s) => {
    const e = await pgError(asUser(userA, null, () => insertRow(userA, s, COMPANY_A, PROJECT_B), 'service_role'))
    expect(e).toMatchObject({ code: '23503', constraint: fkName(s.tbl) })
  })

  it.each(SPECS)('$tbl: 両社に所属するユーザーが company_id だけを書き換えて他社へ移すことも 23503', async (s) => {
    const id = await newRow(s, COMPANY_A, PROJECT_A)
    const e = await pgError(asUser(userA, USER_AB, () =>
      userA.query(`UPDATE ${s.tbl} SET company_id = $1 WHERE ${s.key} = $2`, [COMPANY_B, id])))
    expect(e).toMatchObject({ code: '23503', constraint: fkName(s.tbl) })
    // 会社の組み合わせが合っていれば、両社に所属するユーザーはどちらにも作れる
    await asUser(userA, USER_AB, () => insertRow(userA, s, COMPANY_B, PROJECT_B))
  })

  it.each(CHECK_SPECS)('$tbl: service_role で company_id = NULL のまま案件に紐付け（INSERT / UPDATE）→ 23514', async (s) => {
    for (const p of [PROJECT_B, PROJECT_A]) {
      const e = await pgError(asUser(userA, null, () => insertRow(userA, s, null, p), 'service_role'))
      expect(e).toMatchObject({ code: '23514', constraint: checkName(s.tbl) })
    }
    const id = await newRow(s, COMPANY_A, PROJECT_A)
    const e = await pgError(asUser(userA, null, () =>
      userA.query(`UPDATE ${s.tbl} SET company_id = NULL WHERE ${s.key} = $1`, [id]), 'service_role'))
    expect(e).toMatchObject({ code: '23514', constraint: checkName(s.tbl) })
  })

  it.each(SPECS.filter(s => !s.check))('$tbl: company_id は NOT NULL（service_role でも NULL は 23502）', async (s) => {
    const e = await pgError(asUser(userA, null, () => insertRow(userA, s, null, PROJECT_A), 'service_role'))
    expect(e.code).toBe('23502')
  })

  it('他社の company_id での INSERT は従来どおり RLS で拒否（42501）', async () => {
    for (const s of SPECS) {
      const e = await pgError(asUser(userA, USER_A, () => insertRow(userA, s, COMPANY_B, PROJECT_B)))
      expect(e.code, s.tbl).toBe('42501')
    }
  })

  it('案件の会社を変えることはできない（子の行がある案件。アプリに変更する経路は無い）', async () => {
    const p = await newProject(admin, COMPANY_A)
    await newRow(SPECS.find(s => s.tbl === 'project_notes')!, COMPANY_A, p)
    const e = await pgError(admin.query('UPDATE projects SET company_id = $1 WHERE id = $2', [COMPANY_B, p]))
    expect(e).toMatchObject({ code: '23503', constraint: 'project_notes_project_company_fkey' })
  })
})

// ── 4. 修正後: 正常な操作 ───────────────────────────────────

describe('修正後: 正常な操作は変わらない', () => {
  it.each(SPECS)('$tbl: 登録・編集・自社の別案件への移動・論理削除', async (s) => {
    const { rows } = await asUser(userA, USER_A, () => insertRow(userA, s, COMPANY_A, PROJECT_A))
    const id = rows[0].id as string
    await asUser(userA, USER_A, async () => {
      await userA.query(`UPDATE ${s.tbl} SET project_id = $1 WHERE ${s.key} = $2`, [PROJECT_A2, id])
      if (s.softDelete) await userA.query(`UPDATE ${s.tbl} SET deleted_at = now() WHERE ${s.key} = $1`, [id])
    })
    expect(await rowOf(s, id)).toEqual({ company_id: COMPANY_A, project_id: PROJECT_A2 })
    if (s.softDelete) {
      const { rows: [r] } = await admin.query(`SELECT deleted_at IS NOT NULL AS deleted FROM ${s.tbl} WHERE id = $1`, [id])
      expect(r.deleted).toBe(true)
    }
  })

  it.each(SPECS.filter(s => s.nullableProject))('$tbl: project_id = NULL（未振り分け・案件なし）の行は従来どおり作れ、紐付けを外せる', async (s) => {
    const { rows } = await asUser(userA, USER_A, () => insertRow(userA, s, COMPANY_A, null))
    const id = rows[0].id as string
    await asUser(userA, USER_A, () => userA.query(`UPDATE ${s.tbl} SET project_id = $1 WHERE ${s.key} = $2`, [PROJECT_A, id]))
    await asUser(userA, USER_A, () => userA.query(`UPDATE ${s.tbl} SET project_id = NULL WHERE ${s.key} = $1`, [id]))
    expect(await rowOf(s, id)).toEqual({ company_id: COMPANY_A, project_id: null })
  })

  it.each(CHECK_SPECS.filter(s => s.nullableProject))('$tbl: company_id も project_id も NULL の行（既存の取り込み等）は service_role で作れる', async (s) => {
    const { rows } = await asUser(userA, null, () => insertRow(userA, s, null, null), 'service_role')
    expect(await rowOf(s, rows[0].id)).toEqual({ company_id: null, project_id: null })
  })

  it('案件の物理削除: 11 テーブルは従来どおりカスケード、line_event_notes は従来どおり拒否（NO ACTION）', async () => {
    const p = await newProject(admin, COMPANY_A)
    const ids = new Map<string, string>()
    for (const s of SPECS.filter(s => s.onDelete === 'c')) ids.set(s.tbl, await newRow(s, COMPANY_A, p))
    await admin.query('DELETE FROM projects WHERE id = $1', [p])
    for (const s of SPECS.filter(s => s.onDelete === 'c')) expect(await rowOf(s, ids.get(s.tbl)!), s.tbl).toBeUndefined()

    const notes = SPECS.find(s => s.tbl === 'line_event_notes')!
    const p2 = await newProject(admin, COMPANY_A)
    const n = await newRow(notes, COMPANY_A, p2)
    const e = await pgError(admin.query('DELETE FROM projects WHERE id = $1', [p2]))
    expect(e.code).toBe('23503')
    expect(await rowOf(notes, n)).toEqual({ company_id: COMPANY_A, project_id: p2 })
  })

  it('案件の論理削除（deleted_at）は子の行に影響しない', async () => {
    const p = await newProject(admin, COMPANY_A)
    const notes = SPECS.find(s => s.tbl === 'project_notes')!
    const id = await newRow(notes, COMPANY_A, p)
    await asUser(userA, USER_A, () => userA.query('UPDATE projects SET deleted_at = now() WHERE id = $1', [p]))
    expect(await rowOf(notes, id)).toEqual({ company_id: COMPANY_A, project_id: p })
  })

  it('業者請求書の登録・編集・削除（RPC cost_ledger_invoice_*）と原価台帳の実績原価の連動はそのまま動く', async () => {
    const ledger = SPECS.find(s => s.tbl === 'cost_ledger_items')!
    const { rows } = await asUser(userA, USER_A, () => insertRow(userA, ledger, COMPANY_A, PROJECT_A))
    const item = rows[0].id as string
    const actual = async () => (await admin.query('SELECT actual_cost::text AS v FROM cost_ledger_items WHERE id = $1', [item])).rows[0].v
    const { rows: [ins] } = await asUser(userA, USER_A, () =>
      userA.query('SELECT public.cost_ledger_invoice_insert($1, 1000) AS r', [item]))
    expect(await actual()).toBe('1000')
    const invoiceId = ins.r.invoice?.id ?? ins.r.id
    expect(invoiceId).toBeTruthy()
    await asUser(userA, USER_A, () =>
      userA.query(`SELECT public.cost_ledger_invoice_update($1, '{"amount": 2500}'::jsonb)`, [invoiceId]))
    expect(await actual()).toBe('2500')
    await asUser(userA, USER_A, () => userA.query('SELECT public.cost_ledger_invoice_delete($1)', [invoiceId]))
    expect(await actual()).toBeNull() // 最後の 1 件を消すと NULL に戻る（従来どおり）
  })
})

// ── 5. SQL Editor 用の適用・ロールバック・確認スクリプト ─────────

describe('SQL Editor 用スクリプト（docs/db/ki-002-pr3-project-company-*.sql）', () => {
  const DOCS = path.resolve(__dirname, '../../docs/db')
  const read = (f: string) => readFileSync(path.join(DOCS, f), 'utf8')
  const APPLY = read('ki-002-pr3-project-company-sql-editor-apply.sql')
  const ROLLBACK = read('ki-002-pr3-project-company-sql-editor-rollback.sql')
  const PRECHECK = read('ki-002-pr3-project-company-precheck.sql')
  const VERIFY = read('ki-002-pr3-project-company-verify.sql')
  const KI001_ROLLBACK = read('ki-001-project-company-sql-editor-rollback.sql')
  const HISTORY_SQL = `
    CREATE SCHEMA supabase_migrations;
    CREATE TABLE supabase_migrations.schema_migrations (version text PRIMARY KEY, statements text[], name text);
    INSERT INTO supabase_migrations.schema_migrations (version) VALUES ('20261013000001'), ('20261013000002');`
  const APPLIED = [{ history_rows: '1', valid_constraints: String(NEW_CONSTRAINTS.length) }]

  let dbSeq = 0
  async function editorDb() {
    const c = await freshDb(`pcm2_editor_${++dbSeq}`)
    await c.query(HISTORY_SQL)
    return c
  }
  async function history(c: Client) {
    const { rows } = await c.query("SELECT version, name FROM supabase_migrations.schema_migrations WHERE version = '20261014000001'")
    return rows
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
  /** 読み取り専用トランザクションで流し、各文の結果を返す */
  async function runReadOnly(c: Client, sql: string): Promise<Record<string, unknown>[][]> {
    await c.query('BEGIN READ ONLY')
    try {
      const res = await c.query(sql)
      return (Array.isArray(res) ? res : [res]).filter(r => r.command === 'SELECT' || r.command === 'SHOW').map(r => r.rows)
    } finally {
      await c.query('ROLLBACK')
    }
  }

  it('適用スクリプトの本体は migration ファイルと完全に一致する。BEGIN / COMMIT は 1 回ずつ', () => {
    const start = APPLY.indexOf('-- >>> MIGRATION BODY\n')
    const end = APPLY.lastIndexOf('-- <<< MIGRATION BODY')
    expect(start).toBeGreaterThan(0)
    expect(APPLY.slice(start + '-- >>> MIGRATION BODY\n'.length, end)).toBe(readMigration(MIGRATION))
    expect(readMigration(MIGRATION)).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK|START TRANSACTION)\s*;/im)
    for (const sql of [APPLY, ROLLBACK]) {
      expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1)
      expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1)
    }
  })

  it('適用前・適用後の確認 SQL は読み取り専用で動き、書き込み・DDL を含まない', () => {
    for (const sql of [PRECHECK, VERIFY]) {
      const code = sql.replace(/--.*$/gm, '').replace(/\$q\$[\s\S]*?\$q\$/g, '').replace(/'[^']*'/g, "''")
      expect(code).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP|GRANT|REVOKE|COMMENT|NOTIFY|COPY|DO)\b/i)
    }
  })

  it('成功時: 制約と履歴がそろって確定し、RLS ポリシー・権限は変わらない。確認 SQL が全テーブル ok', async () => {
    const c = await editorDb()
    const before = [await policies(c), await tablePrivileges(c)]
    expect(await runScript(c, APPLY)).toEqual(APPLIED)
    expect(await history(c)).toEqual([{ version: '20261014000001', name: 'enforce_project_company_match_more_tables' }])
    expect([await policies(c), await tablePrivileges(c)]).toEqual(before)
    const { rows } = await c.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = pg_backend_pid() AND state = 'idle in transaction'")
    expect(rows[0].n).toBe(0)

    const [verify] = await runReadOnly(c, VERIFY)
    expect(verify.filter(r => r.tbl !== '_summary').map(r => [r.tbl, r.ok, r.check != null]))
      .toEqual(SPECS.map(s => [s.tbl, true, s.check]))
    expect(verify.find(r => r.tbl === '_summary')).toMatchObject({ history_recorded: true, ki001_constraints: '4' })
    await c.end()
  })

  it('ガード: 二度目の実行・履歴なしで制約だけある DB・20261013000002 が未記録の DB では止まる', async () => {
    const c = await editorDb()
    await runScript(c, APPLY)
    expect((await runScriptExpectingError(c, APPLY)).message)
      .toBe('project-company-2 apply aborted: version 20261014000001 is already recorded')
    const c2 = await editorDb()
    await applyMigration(c2)
    expect((await runScriptExpectingError(c2, APPLY)).message)
      .toBe('project-company-2 apply aborted: constraints already exist (history is missing)')
    expect(await history(c2)).toHaveLength(0)
    const c3 = await editorDb()
    await c3.query("DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261013000002'")
    expect((await runScriptExpectingError(c3, APPLY)).message)
      .toBe('project-company-2 apply aborted: version 20261013000002 is not recorded (apply it first)')
    expect(await newConstraintCount(c3)).toBe(0)
    for (const x of [c, c2, c3]) await x.end()
  })

  it('食い違っている行があれば、制約も履歴も残らない', async () => {
    const c = await editorDb()
    const pB = await newProject(c, COMPANY_B)
    await c.query("INSERT INTO invoice_documents (company_id, project_id, invoice_number) VALUES ($1, $2, 'x')", [COMPANY_A, pB])
    const e = await runScriptExpectingError(c, APPLY)
    expect(e.message).toBe('project-company-2 precondition failed: invoice_documents: mismatched=1 orphan=0 null_company=0')
    expect(await newConstraintCount(c)).toBe(0)
    expect(await history(c)).toHaveLength(0)
    await c.end()
  })

  it('適用前の確認 SQL: 食い違い・テーブルが無い DB でもエラーにならず、テーブルごとに件数を出す（読み取り専用）', async () => {
    const c = await editorDb()
    const pB = await newProject(c, COMPANY_B)
    const pA = await newProject(c, COMPANY_A)
    await c.query("INSERT INTO invoice_documents (company_id, project_id, invoice_number) VALUES ($1, $2, 'x'), (NULL, $2, 'y'), ($1, NULL, 'z')", [COMPANY_A, pB])
    await c.query("INSERT INTO project_notes (company_id, project_id, content) VALUES ($1, $2, 'ok')", [COMPANY_A, pA])
    await c.query('DROP TABLE share_links')
    const results = await runReadOnly(c, PRECHECK)
    expect(results).toHaveLength(8) // ①〜⑧
    const [version, hist, unique, perTable, , excluded] = results
    expect(version[0].server_version).toMatch(/^\d+/)
    expect(hist).toEqual([
      { version: '20261013000001', recorded: true },
      { version: '20261013000002', recorded: true },
      { version: '20261014000001', recorded: false },
    ])
    expect(unique.map(r => r.conname)).toEqual(['estimate_items_project_company_fkey', 'line_events_project_company_fkey',
      'line_events_project_requires_company_check', 'projects_id_company_id_key'])
    const byTbl = Object.fromEntries(perTable.map(r => [r.tbl, r]))
    expect(Object.keys(byTbl).sort()).toEqual(SPECS.map(s => s.tbl))
    expect(byTbl.invoice_documents).toMatchObject({
      table_exists: true, project_id_col: 'uuid NULL', company_id_col: 'uuid NULL', needs_check: true,
      expected_on_delete: 'CASCADE', project_fkeys: 'invoice_documents_project_id_fkey(project_id) ON DELETE CASCADE',
      pr3_constraints: null, total_rows: '3', project_null_rows: '1', mismatched: '1', orphan: '0', null_company: '1',
    })
    expect(byTbl.project_notes).toMatchObject({ company_id_col: 'uuid NOT NULL', total_rows: '1', mismatched: '0' })
    expect(byTbl.line_event_notes).toMatchObject({ project_fkeys: 'line_event_notes_project_id_fkey(project_id) ON DELETE NO ACTION' })
    expect(byTbl.share_links).toMatchObject({ table_exists: false, project_id_col: null, total_rows: null, mismatched: null })
    expect(excluded.map(r => [r.tbl, r.table_exists])).toEqual([['cost_ledger_invoices', true], ['estimate_revisions', true]])
    await c.end()
  })

  it('ロールバック: 追加した制約 17 個と履歴の 1 行だけを消す（20261013000002 の制約は残す）。二度目はガードで止まり、適用し直せる', async () => {
    const c = await editorDb()
    const before = [await policies(c), await tablePrivileges(c), await allConstraints(c)]
    await runScript(c, APPLY)
    expect(await runScript(c, ROLLBACK)).toEqual([{ history_rows: '0', constraints: '0', ki001_constraints: '4' }])
    expect([await policies(c), await tablePrivileges(c), await allConstraints(c)]).toEqual(before)
    const [verify] = await runReadOnly(c, VERIFY)
    expect(verify.filter(r => r.tbl !== '_summary').every(r => r.ok === false && r.fkey === null)).toBe(true)
    const e = await runScriptExpectingError(c, ROLLBACK)
    expect(e.message).toBe('project-company-2 rollback aborted: nothing to roll back (no history row, no constraints)')
    expect(await runScript(c, APPLY)).toEqual(APPLIED)
    await c.end()
  })

  it('順序の保護: PR-3 を適用したまま 20261013000002 だけをロールバックしようとするとエラーで止まり、何も変わらない', async () => {
    const c = await editorDb()
    await runScript(c, APPLY)
    const before = await allConstraints(c)
    const e = await runScriptExpectingError(c, KI001_ROLLBACK)
    expect(e.code).toBe('2BP01') // 一意制約を参照する外部キーがある
    expect(await allConstraints(c)).toEqual(before)
    // 正しい順序（PR-3 → 20261013000002）なら両方戻せる
    await runScript(c, ROLLBACK)
    expect(await runScript(c, KI001_ROLLBACK)).toEqual([{ history_rows: '0', constraints: '0' }])
    await c.end()
  })
})
