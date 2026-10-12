/**
 * KI-002 PR-4a: 見積行・工程が指す工種を同じ案件に限る（migration 20261015000001）の DB 検証。
 *
 * 実行: npm run test:db
 *   隔離されたローカル PostgreSQL（embedded-postgres）にリポジトリの全 migration を適用して検証する。
 *   本番・Preview の DB には接続しない。
 *
 * 1. 修正前の DB（20261015000001 だけ未適用）で、PostgREST と同じ権限（authenticated + RLS）から
 *    他の案件・他社の工種を estimate_items.group_id / schedule_items.estimate_group_id に入れられることを再現する。
 * 2. 食い違いがあれば migration は何も作らずに止まり、適用後はロール・経路にかかわらず拒否され、正常な操作は変わらない。
 * 3. SQL Editor 用の適用・ロールバック・確認スクリプト（docs/db/ki-002-pr4a-*.sql）を検証する。
 *
 * API を通る工種の保存・再読み込み（confirm-change・schedule-items など）は company-isolation-groups.db.test.ts が
 * この migration を含む全 migration の DB で確かめている。
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readMigration, startLocalPostgres, type LocalPostgres } from './helpers/local-postgres'
import { applyFullSchema } from './helpers/full-schema'

const MIGRATION = '20261015000001_enforce_group_project_match.sql'

type Ref = { tbl: 'estimate_items' | 'schedule_items'; col: string; fk: string; cols: string; vals: string }
const REFS: Ref[] = [
  { tbl: 'estimate_items', col: 'group_id',          fk: 'estimate_items_group_project_fkey',          cols: 'name', vals: "'項目'" },
  { tbl: 'schedule_items', col: 'estimate_group_id', fk: 'schedule_items_estimate_group_project_fkey', cols: 'name', vals: "'工程'" },
]
const UNIQUE = 'estimate_groups_id_project_id_key'
const NEW_CONSTRAINTS = [UNIQUE, ...REFS.map(r => r.fk)]
const NEW_LIST = NEW_CONSTRAINTS.map(n => `'${n}'`).join(', ')
const DEFS: Record<string, string> = {
  [UNIQUE]: 'UNIQUE (id, project_id)',
  estimate_items_group_project_fkey:
    'FOREIGN KEY (group_id, project_id) REFERENCES estimate_groups(id, project_id) ON DELETE SET NULL (group_id)',
  schedule_items_estimate_group_project_fkey:
    'FOREIGN KEY (estimate_group_id, project_id) REFERENCES estimate_groups(id, project_id) ON DELETE SET NULL (estimate_group_id)',
}

let server: LocalPostgres
let admin: Client

const COMPANY_A = randomUUID()
const COMPANY_B = randomUUID()
const USER_A = randomUUID()
let PROJECT_A: string
let PROJECT_A2: string
let PROJECT_B: string
let GROUP_A: string          // PROJECT_A の工種
let GROUP_A_2: string        // PROJECT_A の別の工種
let GROUP_A_DELETED: string  // PROJECT_A の論理削除済みの工種
let GROUP_A2: string         // 同じ会社の別案件 PROJECT_A2 の工種
let GROUP_B: string          // 他社 PROJECT_B の工種

async function seed(c: Client) {
  await c.query('INSERT INTO auth.users (id) VALUES ($1)', [USER_A])
  await c.query('INSERT INTO companies (id, name) VALUES ($1, $2), ($3, $4)', [COMPANY_A, 'A社', COMPANY_B, 'B社'])
  await c.query('INSERT INTO company_members (company_id, user_id) VALUES ($1, $2)', [COMPANY_A, USER_A])
}

async function newProject(c: Client, companyId: string): Promise<string> {
  return (await c.query('INSERT INTO projects (company_id) VALUES ($1) RETURNING id', [companyId])).rows[0].id
}
async function newGroup(c: Client, companyId: string | null, projectId: string | null, deleted = false): Promise<string> {
  return (await c.query(
    `INSERT INTO estimate_groups (company_id, project_id, label, deleted_at) VALUES ($1, $2, '工種', ${deleted ? 'now()' : 'NULL'}) RETURNING id`,
    [companyId, projectId])).rows[0].id
}
const insertRef = (c: Client, r: Ref, companyId: string, projectId: string, groupId: string | null) =>
  c.query(`INSERT INTO ${r.tbl} (company_id, project_id, ${r.col}, ${r.cols}) VALUES ($1, $2, $3, ${r.vals}) RETURNING id`,
    [companyId, projectId, groupId])
async function newRef(c: Client, r: Ref, companyId: string, projectId: string, groupId: string | null): Promise<string> {
  return (await insertRef(c, r, companyId, projectId, groupId)).rows[0].id
}
async function refOf(c: Client, r: Ref, id: string) {
  const { rows } = await c.query(`SELECT project_id, ${r.col} AS group_id FROM ${r.tbl} WHERE id = $1`, [id])
  return rows[0] as { project_id: string; group_id: string | null } | undefined
}

/** PostgREST と同じ形（ロール + JWT の sub）で 1 トランザクション実行する */
async function asUser<T>(c: Client, userId: string, fn: () => Promise<T>): Promise<T> {
  await c.query('BEGIN')
  await c.query('SET LOCAL ROLE authenticated')
  await c.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [userId])
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
async function applyMigration(c: Client) {
  await c.query('BEGIN')
  try {
    await c.query(readMigration(MIGRATION))
    await c.query('COMMIT')
  } catch (e) {
    await c.query('ROLLBACK')
    throw e
  }
}

async function newConstraintCount(c: Client): Promise<number> {
  return (await c.query(`SELECT count(*)::int AS n FROM pg_constraint WHERE conname IN (${NEW_LIST})`)).rows[0].n
}
async function otherConstraints(c: Client) {
  const { rows } = await c.query(`
    SELECT conrelid::regclass::text AS tbl, conname, convalidated, pg_get_constraintdef(oid) AS def FROM pg_constraint
    WHERE connamespace = 'public'::regnamespace AND conname NOT IN (${NEW_LIST}) ORDER BY 1, 2`)
  return rows
}
async function policies(c: Client) {
  return (await c.query(`
    SELECT tablename, policyname, cmd, roles::text, qual, with_check FROM pg_policies
    WHERE schemaname = 'public' ORDER BY tablename, policyname`)).rows
}
async function tablePrivileges(c: Client) {
  return (await c.query(`
    SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants
    WHERE table_schema = 'public' ORDER BY 1, 2, 3`)).rows
}

/** 修正前（20261015000001 だけ未適用）の DB を新しく作る。工種と案件も作る */
let dbSeq = 0
async function freshDb() {
  const name = `gpm1_${++dbSeq}`
  await server.createDatabase(name)
  const c = await server.connect(name)
  await applyFullSchema(c, { skip: [MIGRATION] })
  await seed(c)
  const pA = await newProject(c, COMPANY_A)
  const pA2 = await newProject(c, COMPANY_A)
  return { c, pA, pA2, gA: await newGroup(c, COMPANY_A, pA), gA2: await newGroup(c, COMPANY_A, pA2) }
}

let constraintsBefore: unknown[]
let policiesBefore: unknown[]
let privilegesBefore: unknown[]

beforeAll(async () => {
  server = await startLocalPostgres()
  await server.createDatabase('gpm1')
  admin = await server.connect('gpm1')
  await applyFullSchema(admin, { skip: [MIGRATION] })
  await seed(admin)
  PROJECT_A = await newProject(admin, COMPANY_A)
  PROJECT_A2 = await newProject(admin, COMPANY_A)
  PROJECT_B = await newProject(admin, COMPANY_B)
  GROUP_A = await newGroup(admin, COMPANY_A, PROJECT_A)
  GROUP_A_2 = await newGroup(admin, COMPANY_A, PROJECT_A)
  GROUP_A_DELETED = await newGroup(admin, COMPANY_A, PROJECT_A, true)
  GROUP_A2 = await newGroup(admin, COMPANY_A, PROJECT_A2)
  GROUP_B = await newGroup(admin, COMPANY_B, PROJECT_B)
  constraintsBefore = await otherConstraints(admin)
  policiesBefore = await policies(admin)
  privilegesBefore = await tablePrivileges(admin)
}, 120_000)

afterAll(async () => {
  await server?.stop()
})

// ── 1. 修正前: 抜け道の再現 ───────────────────────────────────

const reproduced: Array<[Ref, string]> = []

describe('修正前（20261015000001 未適用）: PostgREST と同じ権限で他の案件の工種を指定できてしまう', () => {
  it('前提: 単独の外部キー（ON DELETE SET NULL）だけがあり、新しい制約は無い', async () => {
    expect(await newConstraintCount(admin)).toBe(0)
    const { rows } = await admin.query(`
      SELECT conrelid::regclass::text AS tbl, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE contype = 'f' AND confrelid = 'public.estimate_groups'::regclass ORDER BY 1`)
    expect(rows).toEqual([
      { tbl: 'estimate_items', def: 'FOREIGN KEY (group_id) REFERENCES estimate_groups(id) ON DELETE SET NULL' },
      { tbl: 'schedule_items', def: 'FOREIGN KEY (estimate_group_id) REFERENCES estimate_groups(id) ON DELETE SET NULL' },
    ])
  })

  it.each(REFS)('$tbl: 同じ会社の別案件の工種・他社の工種を直接 INSERT できる', async r => {
    for (const g of [GROUP_A2, GROUP_B]) {
      const id = await asUser(admin, USER_A, async () => newRef(admin, r, COMPANY_A, PROJECT_A, g))
      reproduced.push([r, id])
      expect(await refOf(admin, r, id)).toEqual({ project_id: PROJECT_A, group_id: g })
    }
  })

  it.each(REFS)('$tbl: 自社の行の工種を他社の工種へ直接 UPDATE できる', async r => {
    const id = await newRef(admin, r, COMPANY_A, PROJECT_A, GROUP_A)
    await asUser(admin, USER_A, () => admin.query(`UPDATE ${r.tbl} SET ${r.col} = $1 WHERE id = $2`, [GROUP_B, id]))
    reproduced.push([r, id])
    expect((await refOf(admin, r, id))?.group_id).toBe(GROUP_B)
  })
})

// ── 2. migration の適用 ─────────────────────────────────────

describe('migration の適用', () => {
  it('他の案件の工種を指す既存行があれば、両方の参照の件数を 1 つのメッセージで出して何も作らずに止まる（補正はしない）', async () => {
    const e = await pgError(applyMigration(admin))
    expect(e.message).toBe('group-project-1 precondition failed: '
      + 'estimate_items: orphan=0 group_project_null=0 mismatched=3; schedule_items: orphan=0 group_project_null=0 mismatched=3')
    expect(await newConstraintCount(admin)).toBe(0)
    // 行は補正されていない
    for (const [r, id] of reproduced) expect((await refOf(admin, r, id))?.project_id).toBe(PROJECT_A)
  })

  it('project_id が NULL の工種を指す行・参照先の工種が無い行（外部キー導入前の残り）があれば止まる', async () => {
    const { c, pA } = await freshDb()
    const gNull = await newGroup(c, COMPANY_A, null)
    await newRef(c, REFS[0], COMPANY_A, pA, gNull)
    await c.query('BEGIN')
    await c.query("SET LOCAL session_replication_role = 'replica'") // 外部キーのトリガーを止めて孤児行を作る
    await insertRef(c, REFS[1], COMPANY_A, pA, randomUUID())
    await c.query('COMMIT')
    const e = await pgError(applyMigration(c))
    expect(e.message).toBe('group-project-1 precondition failed: '
      + 'estimate_items: orphan=0 group_project_null=1 mismatched=0; schedule_items: orphan=1 group_project_null=0 mismatched=0')
    expect(await newConstraintCount(c)).toBe(0)
    await c.end()
  })

  it('本番の定義がリポジトリと違えば止まる（project_id が NULL 可・既存の外部キーの ON DELETE・同じ名前で別定義の制約・テーブルが無い）', async () => {
    const cases: Array<[string, string]> = [
      ['ALTER TABLE schedule_items ALTER COLUMN project_id DROP NOT NULL', 'schedule_items: project_id is nullable'],
      [`ALTER TABLE estimate_items DROP CONSTRAINT estimate_items_group_id_fkey;
        ALTER TABLE estimate_items ADD CONSTRAINT estimate_items_group_id_fkey FOREIGN KEY (group_id) REFERENCES estimate_groups(id) ON DELETE CASCADE`,
       'estimate_items: existing group_id fkey on delete is {c} (expected n)'],
      ['ALTER TABLE schedule_items DROP CONSTRAINT schedule_items_estimate_group_id_fkey',
       'schedule_items: existing estimate_group_id fkey on delete is missing (expected n)'],
      [`ALTER TABLE estimate_groups ADD CONSTRAINT estimate_groups_id_project_id_key UNIQUE (project_id, id)`,
       'estimate_groups: constraint estimate_groups_id_project_id_key exists with a different definition'],
      [`ALTER TABLE estimate_groups ADD CONSTRAINT x_u UNIQUE (id, project_id);
        ALTER TABLE estimate_items ADD CONSTRAINT estimate_items_group_project_fkey FOREIGN KEY (group_id, project_id)
          REFERENCES estimate_groups (id, project_id) ON DELETE CASCADE`,
       'estimate_items: constraint estimate_items_group_project_fkey exists with a different definition'],
      ['DROP TABLE schedule_items CASCADE', 'schedule_items: table missing'],
    ]
    for (const [ddl, problem] of cases) {
      const { c } = await freshDb()
      await c.query(ddl)
      const e = await pgError(applyMigration(c))
      expect(e.message).toBe(`group-project-1 precondition failed: ${problem}`)
      expect((await c.query(`SELECT count(*)::int AS n FROM pg_constraint WHERE conname IN (
        'estimate_groups_id_project_id_key', 'schedule_items_estimate_group_project_fkey')`)).rows[0].n)
        .toBe(ddl.includes('estimate_groups_id_project_id_key') ? 1 : 0)
      await c.end()
    }
  })

  it('ロック待ちで打ち切られても、途中まで追加した一意制約・外部キーは残らない（lock_timeout・全体が 1 トランザクション）', async () => {
    const { c } = await freshDb()
    const blocker = await server.connect(`gpm1_${dbSeq}`)
    await blocker.query('BEGIN')
    await blocker.query('LOCK TABLE schedule_items IN ROW EXCLUSIVE MODE') // 書き込み中のトランザクションと同じロック
    const started = Date.now()
    const e = await pgError(applyMigration(c))
    expect(e.code).toBe('55P03')
    expect(Date.now() - started).toBeLessThan(15_000)
    await blocker.query('ROLLBACK')
    expect(await newConstraintCount(c)).toBe(0)
    await applyMigration(c) // 待ちが解消すれば適用できる
    expect(await newConstraintCount(c)).toBe(3)
    await blocker.end()
    await c.end()
  }, 30_000)

  it('食い違いを人間が解消した後なら適用できる。一意制約 1・外部キー 2 が VALID で、定義は想定どおり', async () => {
    for (const [r, id] of reproduced) await admin.query(`UPDATE ${r.tbl} SET ${r.col} = NULL WHERE id = $1`, [id])
    await applyMigration(admin)
    const { rows } = await admin.query(`
      SELECT conname, convalidated, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname IN (${NEW_LIST}) ORDER BY 1`)
    expect(rows).toEqual(Object.entries(DEFS).sort().map(([conname, def]) => ({ conname, convalidated: true, def })))
  })

  it('既存の制約（単独の外部キー・PR #35・PR-3）・RLS ポリシー・テーブル権限は変わらない。再適用しても制約は増えない', async () => {
    expect(await otherConstraints(admin)).toEqual(constraintsBefore)
    expect(await policies(admin)).toEqual(policiesBefore)
    expect(await tablePrivileges(admin)).toEqual(privilegesBefore)
    await applyMigration(admin)
    expect(await newConstraintCount(admin)).toBe(3)
    expect(await otherConstraints(admin)).toEqual(constraintsBefore)
  })
})

// ── 3. 修正後: 拒否される操作 ─────────────────────────────────

describe('修正後: 他の案件の工種を指定した直接 INSERT / UPDATE は拒否される', () => {
  it.each(REFS)('$tbl: 同じ会社の別案件の工種・他社の工種を INSERT → 23503', async r => {
    for (const g of [GROUP_A2, GROUP_B]) {
      const e = await pgError(asUser(admin, USER_A, () => insertRef(admin, r, COMPANY_A, PROJECT_A, g)))
      expect(e).toMatchObject({ code: '23503', constraint: r.fk })
    }
  })

  it.each(REFS)('$tbl: service_role（RLS をバイパス）でも 23503', async r => {
    const e = await pgError(insertRef(admin, r, COMPANY_A, PROJECT_A, GROUP_B))
    expect(e).toMatchObject({ code: '23503', constraint: r.fk })
  })

  it.each(REFS)('$tbl: 工種を他の案件の工種へ UPDATE → 23503。行は変わらない', async r => {
    const id = await newRef(admin, r, COMPANY_A, PROJECT_A, GROUP_A)
    for (const g of [GROUP_A2, GROUP_B]) {
      const e = await pgError(asUser(admin, USER_A, () => admin.query(`UPDATE ${r.tbl} SET ${r.col} = $1 WHERE id = $2`, [g, id])))
      expect(e).toMatchObject({ code: '23503', constraint: r.fk })
    }
    expect(await refOf(admin, r, id)).toEqual({ project_id: PROJECT_A, group_id: GROUP_A })
  })

  it.each(REFS)('$tbl: 工種を指したまま行の案件だけを別の案件へ移すこともできない（アプリに経路は無い）', async r => {
    const id = await newRef(admin, r, COMPANY_A, PROJECT_A, GROUP_A)
    const e = await pgError(admin.query(`UPDATE ${r.tbl} SET project_id = $1 WHERE id = $2`, [PROJECT_A2, id]))
    expect(e).toMatchObject({ code: '23503', constraint: r.fk })
    // 工種を外せば移せる（未分類として）
    await admin.query(`UPDATE ${r.tbl} SET project_id = $1, ${r.col} = NULL WHERE id = $2`, [PROJECT_A2, id])
    expect(await refOf(admin, r, id)).toEqual({ project_id: PROJECT_A2, group_id: null })
  })

  it('参照されている工種の案件は変えられない（アプリに経路は無い）。参照が無い工種は変えられる', async () => {
    const used = await newGroup(admin, COMPANY_A, PROJECT_A)
    await newRef(admin, REFS[0], COMPANY_A, PROJECT_A, used)
    const e = await pgError(admin.query('UPDATE estimate_groups SET project_id = $1 WHERE id = $2', [PROJECT_A2, used]))
    expect(e).toMatchObject({ code: '23503', constraint: 'estimate_items_group_project_fkey' })
    const unused = await newGroup(admin, COMPANY_A, PROJECT_A)
    await admin.query('UPDATE estimate_groups SET project_id = $1 WHERE id = $2', [PROJECT_A2, unused])
  })
})

// ── 4. 修正後: 正常な操作は変わらない ────────────────────────────

describe('修正後: 正常な操作は変わらない', () => {
  it.each(REFS)('$tbl: 同じ案件の工種で登録・別の工種へ移動・未分類（NULL）に戻す・未分類で登録（PostgREST と同じ権限）', async r => {
    await asUser(admin, USER_A, async () => {
      const id = await newRef(admin, r, COMPANY_A, PROJECT_A, GROUP_A)
      await admin.query(`UPDATE ${r.tbl} SET ${r.col} = $1 WHERE id = $2`, [GROUP_A_2, id])
      expect(await refOf(admin, r, id)).toEqual({ project_id: PROJECT_A, group_id: GROUP_A_2 })
      await admin.query(`UPDATE ${r.tbl} SET ${r.col} = NULL WHERE id = $1`, [id])
      expect(await refOf(admin, r, id)).toEqual({ project_id: PROJECT_A, group_id: null })
      const id2 = await newRef(admin, r, COMPANY_A, PROJECT_A, null)
      expect(await refOf(admin, r, id2)).toEqual({ project_id: PROJECT_A, group_id: null })
    })
  })

  it.each(REFS)('$tbl: 同じ案件の論理削除済みの工種を指す行は作れ、残せる（外部キーは deleted_at を見ない）', async r => {
    const id = await newRef(admin, r, COMPANY_A, PROJECT_A, GROUP_A_DELETED)
    expect((await refOf(admin, r, id))?.group_id).toBe(GROUP_A_DELETED)
  })

  it('工種の削除 API と同じ操作（所属する見積行を NULL → 工種を論理削除）。工程は削除済みの工種を指したまま残る（従来どおり）', async () => {
    const g = await newGroup(admin, COMPANY_A, PROJECT_A)
    const item = await newRef(admin, REFS[0], COMPANY_A, PROJECT_A, g)
    const sched = await newRef(admin, REFS[1], COMPANY_A, PROJECT_A, g)
    await asUser(admin, USER_A, async () => {
      await admin.query('UPDATE estimate_items SET group_id = NULL WHERE group_id = $1', [g])
      await admin.query('UPDATE estimate_groups SET deleted_at = now() WHERE id = $1', [g])
    })
    expect((await refOf(admin, REFS[0], item))?.group_id).toBeNull()
    expect((await refOf(admin, REFS[1], sched))?.group_id).toBe(g)
  })

  it('工種の物理削除: 見積行・工程の工種の列だけが NULL になり、project_id・論理削除済みの行もそのまま', async () => {
    const g = await newGroup(admin, COMPANY_A, PROJECT_A)
    const item = await newRef(admin, REFS[0], COMPANY_A, PROJECT_A, g)
    const deletedItem = await newRef(admin, REFS[0], COMPANY_A, PROJECT_A, g)
    await admin.query('UPDATE estimate_items SET deleted_at = now() WHERE id = $1', [deletedItem])
    const sched = await newRef(admin, REFS[1], COMPANY_A, PROJECT_A, g)
    await admin.query('DELETE FROM estimate_groups WHERE id = $1', [g])
    for (const [r, id] of [[REFS[0], item], [REFS[0], deletedItem], [REFS[1], sched]] as const) {
      expect(await refOf(admin, r, id)).toEqual({ project_id: PROJECT_A, group_id: null })
    }
  })

  it('案件の物理削除: 工種・見積行・工程は従来どおりカスケードで消える（工種の SET NULL と競合しない）', async () => {
    const p = await newProject(admin, COMPANY_A)
    const g = await newGroup(admin, COMPANY_A, p)
    const item = await newRef(admin, REFS[0], COMPANY_A, p, g)
    const sched = await newRef(admin, REFS[1], COMPANY_A, p, g)
    await admin.query('DELETE FROM projects WHERE id = $1', [p])
    expect(await refOf(admin, REFS[0], item)).toBeUndefined()
    expect(await refOf(admin, REFS[1], sched)).toBeUndefined()
    expect((await admin.query('SELECT 1 FROM estimate_groups WHERE id = $1', [g])).rowCount).toBe(0)
  })

  it('他の案件・工種の行には影響しない（案件 A を消しても案件 A2 の工種・行は残る）', async () => {
    const item = await newRef(admin, REFS[0], COMPANY_A, PROJECT_A2, GROUP_A2)
    const p = await newProject(admin, COMPANY_A)
    await newGroup(admin, COMPANY_A, p)
    await admin.query('DELETE FROM projects WHERE id = $1', [p])
    expect(await refOf(admin, REFS[0], item)).toEqual({ project_id: PROJECT_A2, group_id: GROUP_A2 })
  })
})

// ── 5. SQL Editor 用スクリプト ──────────────────────────────────

describe('SQL Editor 用スクリプト（docs/db/ki-002-pr4a-group-project-*.sql）', () => {
  const DOCS = path.resolve(__dirname, '../../docs/db')
  const read = (f: string) => readFileSync(path.join(DOCS, f), 'utf8')
  const APPLY = read('ki-002-pr4a-group-project-sql-editor-apply.sql')
  const ROLLBACK = read('ki-002-pr4a-group-project-sql-editor-rollback.sql')
  const PRECHECK = read('ki-002-pr4a-group-project-precheck.sql')
  const VERIFY = read('ki-002-pr4a-group-project-verify.sql')
  const PR3_ROLLBACK = read('ki-002-pr3-project-company-sql-editor-rollback.sql')
  const HISTORY_SQL = `
    CREATE SCHEMA supabase_migrations;
    CREATE TABLE supabase_migrations.schema_migrations (version text PRIMARY KEY, statements text[], name text);
    INSERT INTO supabase_migrations.schema_migrations (version) VALUES ('20261013000001'), ('20261013000002'), ('20261014000001');`
  const APPLIED = [{ history_rows: '1', valid_constraints: '3', prior_constraints: '21' }]

  async function editorDb() {
    const db = await freshDb()
    await db.c.query(HISTORY_SQL)
    return db
  }
  async function history(c: Client) {
    return (await c.query("SELECT version, name FROM supabase_migrations.schema_migrations WHERE version = '20261015000001'")).rows
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
      const code = sql.replace(/--.*$/gm, '').replace(/'[^']*'/g, "''")
      expect(code).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP|GRANT|REVOKE|COMMENT|NOTIFY|COPY|DO)\b/i)
    }
  })

  it('成功時: 制約と履歴がそろって確定し、既存の制約・RLS ポリシー・権限は変わらない。確認 SQL が全行 ok', async () => {
    const { c } = await editorDb()
    const before = [await otherConstraints(c), await policies(c), await tablePrivileges(c)]
    expect(await runScript(c, APPLY)).toEqual(APPLIED)
    expect(await history(c)).toEqual([{ version: '20261015000001', name: 'enforce_group_project_match' }])
    expect([await otherConstraints(c), await policies(c), await tablePrivileges(c)]).toEqual(before)
    const { rows } = await c.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = pg_backend_pid() AND state = 'idle in transaction'")
    expect(rows[0].n).toBe(0)

    const [verify] = await runReadOnly(c, VERIFY)
    expect(verify.filter(r => r.name !== '_summary').map(r => [r.name, r.ok])).toEqual(NEW_CONSTRAINTS.sort().map(n => [n, true]))
    expect(verify.find(r => r.name === '_summary')).toMatchObject({
      history_recorded: true, single_fkeys: '2', prior_constraints: '21', blocking_rows: '0',
    })
    await c.end()
  })

  it('ガード: 二度目の実行・履歴なしで制約だけある DB・20261014000001 が未記録の DB では止まる', async () => {
    const { c } = await editorDb()
    await runScript(c, APPLY)
    expect((await runScriptExpectingError(c, APPLY)).message)
      .toBe('group-project-1 apply aborted: version 20261015000001 is already recorded')
    const { c: c2 } = await editorDb()
    await applyMigration(c2)
    expect((await runScriptExpectingError(c2, APPLY)).message)
      .toBe('group-project-1 apply aborted: constraints already exist (history is missing)')
    expect(await history(c2)).toHaveLength(0)
    const { c: c3 } = await editorDb()
    await c3.query("DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261014000001'")
    expect((await runScriptExpectingError(c3, APPLY)).message)
      .toBe('group-project-1 apply aborted: version 20261014000001 is not recorded (apply it first)')
    expect(await newConstraintCount(c3)).toBe(0)
    for (const x of [c, c2, c3]) await x.end()
  })

  it('他の案件の工種を指す行があれば、制約も履歴も残らない', async () => {
    const { c, pA, gA2 } = await editorDb()
    await newRef(c, REFS[1], COMPANY_A, pA, gA2)
    const e = await runScriptExpectingError(c, APPLY)
    expect(e.message).toBe('group-project-1 precondition failed: schedule_items: orphan=0 group_project_null=0 mismatched=1')
    expect(await newConstraintCount(c)).toBe(0)
    expect(await history(c)).toHaveLength(0)
    await c.end()
  })

  it('適用前の確認 SQL: 食い違いの件数・論理削除済みの工種への参照を出す（読み取り専用）', async () => {
    const { c, pA, gA, gA2 } = await editorDb()
    const gDel = await newGroup(c, COMPANY_A, pA, true)
    await newRef(c, REFS[0], COMPANY_A, pA, gA)
    await newRef(c, REFS[0], COMPANY_A, pA, gA2)
    await newRef(c, REFS[1], COMPANY_A, pA, gDel)
    const results = await runReadOnly(c, PRECHECK)
    expect(results).toHaveLength(8) // ①〜⑧
    const [version, hist, cols, fkeys, refs, groups] = results
    expect(version[0].server_version).toMatch(/^\d+/)
    expect(hist).toEqual([
      { version: '20261013000002', recorded: true },
      { version: '20261014000001', recorded: true },
      { version: '20261015000001', recorded: false },
    ])
    expect(cols.filter(r => r.column_name === 'project_id').map(r => [r.table_name, r.nullable]))
      .toEqual([['estimate_groups', true], ['estimate_items', false], ['schedule_items', false]])
    expect(fkeys.map(r => r.conname)).toEqual(['estimate_items_group_id_fkey', 'schedule_items_estimate_group_id_fkey'])
    expect(refs).toEqual([
      { ref: 'R1 estimate_items.group_id', with_ref: '2', blocking_orphan: '0', blocking_target_null: '0', blocking_mismatch: '1', info_live_to_deleted_group: '0' },
      { ref: 'R2 schedule_items.estimate_group_id', with_ref: '1', blocking_orphan: '0', blocking_target_null: '0', blocking_mismatch: '0', info_live_to_deleted_group: '1' },
    ])
    expect(groups[0]).toMatchObject({ total: '3', project_null: '0', soft_deleted: '1' })
    await c.end()
  })

  it('ロールバック: 追加した 3 つの制約と履歴の 1 行だけを消す（単独の外部キー・PR #35・PR-3 は残す）。二度目はガードで止まり、適用し直せる', async () => {
    const { c } = await editorDb()
    const before = [await otherConstraints(c), await policies(c), await tablePrivileges(c)]
    await runScript(c, APPLY)
    expect(await runScript(c, ROLLBACK)).toEqual([{ history_rows: '0', constraints: '0', prior_constraints: '21' }])
    expect([await otherConstraints(c), await policies(c), await tablePrivileges(c)]).toEqual(before)
    const [verify] = await runReadOnly(c, VERIFY)
    expect(verify.filter(r => r.name !== '_summary').every(r => r.ok === false && r.definition === null)).toBe(true)
    expect(verify.find(r => r.name === '_summary')).toMatchObject({ history_recorded: false, single_fkeys: '2' })
    const e = await runScriptExpectingError(c, ROLLBACK)
    expect(e.message).toBe('group-project-1 rollback aborted: nothing to roll back (no history row, no constraints)')
    expect(await runScript(c, APPLY)).toEqual(APPLIED)
    await c.end()
  })

  it('PR-3 のロールバックは PR-4a を適用したままでも動き、PR-4a の制約は残る（依存なし）', async () => {
    const { c } = await editorDb()
    await runScript(c, APPLY)
    expect(await runScript(c, PR3_ROLLBACK)).toEqual([{ history_rows: '0', constraints: '0', ki001_constraints: '4' }])
    expect(await newConstraintCount(c)).toBe(3)
    await c.end()
  })
})
