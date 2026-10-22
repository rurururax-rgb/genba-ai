/**
 * KI-002 PR-4b: 原価台帳の行が指す見積行を同じ案件に限る（migration 20261016000001）の DB 検証。
 *
 * 実行: npm run test:db
 *   隔離されたローカル PostgreSQL（embedded-postgres）にリポジトリの全 migration を適用して検証する。
 *   本番・Preview の DB には接続しない。
 *
 * 1. 修正前の DB（20261016000001 だけ未適用）で、PostgREST と同じ権限（authenticated + RLS）から
 *    他の案件・他社の見積行を cost_ledger_items.estimate_item_id に入れられることを再現する。
 * 2. 食い違いがあれば migration は何も作らずに止まり、適用後はロール・経路にかかわらず拒否され、正常な操作は変わらない。
 * 3. SQL Editor 用の適用・ロールバック・確認スクリプト（docs/db/ki-002-pr4b-*.sql）を検証する。
 *
 * API を通る原価台帳の操作（cost-ledger・init・sync）は company-isolation-api.db.test.ts が
 * この migration を含む全 migration の DB で確かめている。
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readMigration, startLocalPostgres, type LocalPostgres } from './helpers/local-postgres'
import { applyFullSchema } from './helpers/full-schema'

const MIGRATION = '20261016000001_enforce_ledger_estimate_item_project_match.sql'
const PR4A_MIGRATION = '20261015000001_enforce_group_project_match.sql'

const FK = 'cost_ledger_items_estimate_item_project_fkey'
const UNIQUE = 'estimate_items_id_project_id_key'
const NEW_CONSTRAINTS = [FK, UNIQUE]
const NEW_LIST = NEW_CONSTRAINTS.map(n => `'${n}'`).join(', ')
const DEFS: Record<string, string> = {
  [FK]: 'FOREIGN KEY (estimate_item_id, project_id) REFERENCES estimate_items(id, project_id) ON DELETE SET NULL (estimate_item_id)',
  [UNIQUE]: 'UNIQUE (id, project_id)',
}

let server: LocalPostgres
let admin: Client

const COMPANY_A = randomUUID()
const COMPANY_B = randomUUID()
const USER_A = randomUUID()
const USER_B = randomUUID()
let PROJECT_A: string
let PROJECT_A2: string
let PROJECT_B: string
let ITEM_A: string          // PROJECT_A の見積行
let ITEM_A_2: string        // PROJECT_A の別の見積行
let ITEM_A_DELETED: string  // PROJECT_A の論理削除済みの見積行
let ITEM_A2: string         // 同じ会社の別案件 PROJECT_A2 の見積行
let ITEM_B: string          // 他社 PROJECT_B の見積行

async function seed(c: Client) {
  await c.query('INSERT INTO auth.users (id) VALUES ($1), ($2)', [USER_A, USER_B])
  await c.query('INSERT INTO companies (id, name) VALUES ($1, $2), ($3, $4)', [COMPANY_A, 'A社', COMPANY_B, 'B社'])
  await c.query('INSERT INTO company_members (company_id, user_id) VALUES ($1, $2), ($3, $4)', [COMPANY_A, USER_A, COMPANY_B, USER_B])
}

async function newProject(c: Client, companyId: string): Promise<string> {
  return (await c.query('INSERT INTO projects (company_id) VALUES ($1) RETURNING id', [companyId])).rows[0].id
}
async function newItem(c: Client, companyId: string, projectId: string, deleted = false): Promise<string> {
  return (await c.query(
    `INSERT INTO estimate_items (company_id, project_id, name, deleted_at) VALUES ($1, $2, '見積行', ${deleted ? 'now()' : 'NULL'}) RETURNING id`,
    [companyId, projectId])).rows[0].id
}
const insertLedger = (c: Client, companyId: string, projectId: string, itemId: string | null) =>
  c.query(`INSERT INTO cost_ledger_items (company_id, project_id, estimate_item_id, name, source)
           VALUES ($1, $2, $3, '台帳', $4) RETURNING id`,
    [companyId, projectId, itemId, itemId ? 'from_estimate' : 'manual'])
async function newLedger(c: Client, companyId: string, projectId: string, itemId: string | null): Promise<string> {
  return (await insertLedger(c, companyId, projectId, itemId)).rows[0].id
}
async function ledgerOf(c: Client, id: string) {
  const { rows } = await c.query(
    'SELECT project_id, estimate_item_id, actual_cost, deleted_at IS NOT NULL AS deleted FROM cost_ledger_items WHERE id = $1', [id])
  return rows[0] as { project_id: string; estimate_item_id: string | null; actual_cost: string | null; deleted: boolean } | undefined
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
async function triggers(c: Client) {
  return (await c.query(`
    SELECT tgrelid::regclass::text AS tbl, tgname, tgenabled FROM pg_trigger
    WHERE NOT tgisinternal AND tgrelid IN ('public.cost_ledger_items'::regclass, 'public.estimate_items'::regclass) ORDER BY 1, 2`)).rows
}

/** 修正前（20261016000001 だけ未適用。PR-4a は適用済み）の DB を新しく作る。見積行と案件も作る */
let dbSeq = 0
async function freshDb(skip: string[] = [MIGRATION]) {
  const name = `lip1_${++dbSeq}`
  await server.createDatabase(name)
  const c = await server.connect(name)
  await applyFullSchema(c, { skip })
  await seed(c)
  const pA = await newProject(c, COMPANY_A)
  const pA2 = await newProject(c, COMPANY_A)
  return { c, name, pA, pA2, iA: await newItem(c, COMPANY_A, pA), iA2: await newItem(c, COMPANY_A, pA2) }
}

let constraintsBefore: unknown[]
let policiesBefore: unknown[]
let privilegesBefore: unknown[]
let triggersBefore: unknown[]

beforeAll(async () => {
  server = await startLocalPostgres()
  await server.createDatabase('lip1')
  admin = await server.connect('lip1')
  await applyFullSchema(admin, { skip: [MIGRATION] })
  await seed(admin)
  PROJECT_A = await newProject(admin, COMPANY_A)
  PROJECT_A2 = await newProject(admin, COMPANY_A)
  PROJECT_B = await newProject(admin, COMPANY_B)
  ITEM_A = await newItem(admin, COMPANY_A, PROJECT_A)
  ITEM_A_2 = await newItem(admin, COMPANY_A, PROJECT_A)
  ITEM_A_DELETED = await newItem(admin, COMPANY_A, PROJECT_A, true)
  ITEM_A2 = await newItem(admin, COMPANY_A, PROJECT_A2)
  ITEM_B = await newItem(admin, COMPANY_B, PROJECT_B)
  constraintsBefore = await otherConstraints(admin)
  policiesBefore = await policies(admin)
  privilegesBefore = await tablePrivileges(admin)
  triggersBefore = await triggers(admin)
}, 120_000)

afterAll(async () => {
  await server?.stop()
})

// ── 1. 修正前: 抜け道の再現 ───────────────────────────────────

const reproduced: string[] = []

describe('修正前（20261016000001 未適用）: PostgREST と同じ権限で他の案件の見積行を指定できてしまう', () => {
  it('前提: 単独の外部キー（ON DELETE SET NULL）だけがあり、新しい制約は無い。台帳の project_id は NOT NULL', async () => {
    expect(await newConstraintCount(admin)).toBe(0)
    const { rows } = await admin.query(`
      SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE contype = 'f' AND conrelid = 'public.cost_ledger_items'::regclass AND confrelid = 'public.estimate_items'::regclass`)
    expect(rows).toEqual([{
      conname: 'cost_ledger_items_estimate_item_id_fkey',
      def: 'FOREIGN KEY (estimate_item_id) REFERENCES estimate_items(id) ON DELETE SET NULL',
    }])
    const { rows: cols } = await admin.query(`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'cost_ledger_items' AND column_name = 'project_id'`)
    expect(cols).toEqual([{ is_nullable: 'NO' }])
  })

  it('同じ会社の別案件の見積行・他社の見積行を指す台帳行を直接 INSERT できる', async () => {
    for (const item of [ITEM_A2, ITEM_B]) {
      const id = await asUser(admin, USER_A, async () => newLedger(admin, COMPANY_A, PROJECT_A, item))
      reproduced.push(id)
      expect(await ledgerOf(admin, id)).toMatchObject({ project_id: PROJECT_A, estimate_item_id: item })
    }
  })

  it('自社の台帳行の見積行を他社の見積行へ直接 UPDATE できる', async () => {
    const id = await newLedger(admin, COMPANY_A, PROJECT_A, ITEM_A)
    await asUser(admin, USER_A, () => admin.query('UPDATE cost_ledger_items SET estimate_item_id = $1 WHERE id = $2', [ITEM_B, id]))
    reproduced.push(id)
    expect((await ledgerOf(admin, id))?.estimate_item_id).toBe(ITEM_B)
  })
})

// ── 2. migration の適用 ─────────────────────────────────────

describe('migration の適用', () => {
  it('他の案件の見積行を指す既存行があれば、件数を出して何も作らずに止まる（補正はしない）', async () => {
    const e = await pgError(applyMigration(admin))
    expect(e.message).toBe('ledger-item-project-1 precondition failed: '
      + 'cost_ledger_items: orphan=0 estimate_item_project_null=0 mismatched=3')
    expect(await newConstraintCount(admin)).toBe(0)
    // 行は補正されていない
    for (const id of reproduced) expect((await ledgerOf(admin, id))?.project_id).toBe(PROJECT_A)
  })

  it('論理削除済みの台帳行が他の案件の見積行を指していても止まる（論理削除済みも数える）', async () => {
    const { c, pA, iA2 } = await freshDb()
    const id = await newLedger(c, COMPANY_A, pA, iA2)
    await c.query('UPDATE cost_ledger_items SET deleted_at = now() WHERE id = $1', [id])
    const e = await pgError(applyMigration(c))
    expect(e.message).toBe('ledger-item-project-1 precondition failed: cost_ledger_items: orphan=0 estimate_item_project_null=0 mismatched=1')
    expect(await newConstraintCount(c)).toBe(0)
    await c.end()
  })

  it('参照先の見積行が無い行・project_id が NULL の見積行を指す行（本番の定義の違い・外部キー導入前の残り）があれば止まる', async () => {
    const { c, pA } = await freshDb()
    await c.query('BEGIN')
    await c.query("SET LOCAL session_replication_role = 'replica'") // 外部キーのトリガーを止めて孤児行を作る
    await insertLedger(c, COMPANY_A, pA, randomUUID())
    await c.query('COMMIT')
    let e = await pgError(applyMigration(c))
    expect(e.message).toBe('ledger-item-project-1 precondition failed: cost_ledger_items: orphan=1 estimate_item_project_null=0 mismatched=0')
    expect(await newConstraintCount(c)).toBe(0)
    await c.end()

    // リポジトリでは estimate_items.project_id は NOT NULL。本番が NULL 可だった場合を再現する
    const { c: c2, pA: pA2 } = await freshDb()
    await c2.query('ALTER TABLE estimate_items ALTER COLUMN project_id DROP NOT NULL')
    await c2.query('BEGIN')
    await c2.query("SET LOCAL session_replication_role = 'replica'")
    const orphanItem = (await c2.query(
      "INSERT INTO estimate_items (company_id, project_id, name) VALUES ($1, NULL, '案件なし') RETURNING id", [COMPANY_A])).rows[0].id
    await c2.query('COMMIT')
    await newLedger(c2, COMPANY_A, pA2, orphanItem)
    e = await pgError(applyMigration(c2))
    expect(e.message).toBe('ledger-item-project-1 precondition failed: cost_ledger_items: orphan=0 estimate_item_project_null=1 mismatched=0')
    expect(await newConstraintCount(c2)).toBe(0)
    await c2.end()
  })

  it('本番の定義がリポジトリと違えば止まる（project_id が NULL 可・既存の外部キーの ON DELETE・同じ名前で別定義の制約・テーブルが無い）', async () => {
    const cases: Array<[string, string, number]> = [
      ['ALTER TABLE cost_ledger_items ALTER COLUMN project_id DROP NOT NULL', 'cost_ledger_items: project_id is nullable', 0],
      [`ALTER TABLE cost_ledger_items DROP CONSTRAINT cost_ledger_items_estimate_item_id_fkey;
        ALTER TABLE cost_ledger_items ADD CONSTRAINT cost_ledger_items_estimate_item_id_fkey
          FOREIGN KEY (estimate_item_id) REFERENCES estimate_items(id) ON DELETE CASCADE`,
       'cost_ledger_items: existing estimate_item_id fkey on delete is {c} (expected n)', 0],
      ['ALTER TABLE cost_ledger_items DROP CONSTRAINT cost_ledger_items_estimate_item_id_fkey',
       'cost_ledger_items: existing estimate_item_id fkey on delete is missing (expected n)', 0],
      ['ALTER TABLE estimate_items ADD CONSTRAINT estimate_items_id_project_id_key UNIQUE (project_id, id)',
       'estimate_items: constraint estimate_items_id_project_id_key exists with a different definition', 1],
      [`ALTER TABLE estimate_items ADD CONSTRAINT x_u UNIQUE (id, project_id);
        ALTER TABLE cost_ledger_items ADD CONSTRAINT cost_ledger_items_estimate_item_project_fkey FOREIGN KEY (estimate_item_id, project_id)
          REFERENCES estimate_items (id, project_id) ON DELETE CASCADE`,
       'cost_ledger_items: constraint cost_ledger_items_estimate_item_project_fkey exists with a different definition', 1],
      ['DROP TABLE cost_ledger_items CASCADE', 'cost_ledger_items: table missing', 0],
    ]
    for (const [ddl, problem, remaining] of cases) {
      const { c } = await freshDb()
      await c.query(ddl)
      const e = await pgError(applyMigration(c))
      expect(e.message).toBe(`ledger-item-project-1 precondition failed: ${problem}`)
      expect(await newConstraintCount(c)).toBe(remaining) // 既に置いた同名の制約だけが残る（新しくは作らない）
      await c.end()
    }
  })

  it('ロック待ちで打ち切られても、途中まで追加した一意制約・外部キーは残らない（lock_timeout・全体が 1 トランザクション）', async () => {
    for (const lock of ['LOCK TABLE cost_ledger_items IN ROW EXCLUSIVE MODE', 'LOCK TABLE estimate_items IN ROW EXCLUSIVE MODE']) {
      const { c, name } = await freshDb()
      const blocker = await server.connect(name)
      await blocker.query('BEGIN')
      await blocker.query(lock) // 書き込み中のトランザクションと同じロック
      const started = Date.now()
      const e = await pgError(applyMigration(c))
      expect(e.code).toBe('55P03')
      expect(Date.now() - started).toBeLessThan(15_000)
      await blocker.query('ROLLBACK')
      expect(await newConstraintCount(c)).toBe(0)
      await applyMigration(c) // 待ちが解消すれば適用できる
      expect(await newConstraintCount(c)).toBe(2)
      await blocker.end()
      await c.end()
    }
  }, 60_000)

  it('食い違いを人間が解消した後なら適用できる。一意制約 1・外部キー 1 が VALID で、定義は想定どおり', async () => {
    for (const id of reproduced) await admin.query('UPDATE cost_ledger_items SET estimate_item_id = NULL WHERE id = $1', [id])
    await applyMigration(admin)
    const { rows } = await admin.query(`
      SELECT conname, convalidated, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname IN (${NEW_LIST}) ORDER BY 1`)
    expect(rows).toEqual(Object.entries(DEFS).sort().map(([conname, def]) => ({ conname, convalidated: true, def })))
  })

  it('既存の制約（単独の外部キー・PR #35・PR-3・PR-4a）・RLS ポリシー・テーブル権限・トリガーは変わらない。再適用しても制約は増えない', async () => {
    expect(await otherConstraints(admin)).toEqual(constraintsBefore)
    expect(await policies(admin)).toEqual(policiesBefore)
    expect(await tablePrivileges(admin)).toEqual(privilegesBefore)
    expect(await triggers(admin)).toEqual(triggersBefore)
    await applyMigration(admin)
    expect(await newConstraintCount(admin)).toBe(2)
    expect(await otherConstraints(admin)).toEqual(constraintsBefore)
  })

  it('PR-4a（20261015000001）が未適用の DB でも適用でき、後から PR-4a を適用できる（独立）', async () => {
    const { c } = await freshDb([MIGRATION, PR4A_MIGRATION])
    await applyMigration(c)
    expect(await newConstraintCount(c)).toBe(2)
    await applyMigration(c, PR4A_MIGRATION)
    const { rows } = await c.query(`SELECT count(*)::int AS n FROM pg_constraint WHERE convalidated AND conname IN (
      'estimate_groups_id_project_id_key', 'estimate_items_group_project_fkey', 'schedule_items_estimate_group_project_fkey')`)
    expect(rows[0].n).toBe(3)
    await c.end()
  })
})

// ── 3. 修正後: 拒否される操作 ─────────────────────────────────

describe('修正後: 他の案件の見積行を指定した直接 INSERT / UPDATE は拒否される', () => {
  it('同じ会社の別案件の見積行・他社の見積行を INSERT → 23503', async () => {
    for (const item of [ITEM_A2, ITEM_B]) {
      const e = await pgError(asUser(admin, USER_A, () => insertLedger(admin, COMPANY_A, PROJECT_A, item)))
      expect(e).toMatchObject({ code: '23503', constraint: FK })
    }
  })

  it('service_role（RLS をバイパス）でも 23503', async () => {
    const e = await pgError(insertLedger(admin, COMPANY_A, PROJECT_A, ITEM_B))
    expect(e).toMatchObject({ code: '23503', constraint: FK })
  })

  it('台帳行の見積行を他の案件の見積行へ UPDATE → 23503。行は変わらない', async () => {
    const id = await newLedger(admin, COMPANY_A, PROJECT_A, ITEM_A)
    for (const item of [ITEM_A2, ITEM_B]) {
      const e = await pgError(asUser(admin, USER_A, () =>
        admin.query('UPDATE cost_ledger_items SET estimate_item_id = $1 WHERE id = $2', [item, id])))
      expect(e).toMatchObject({ code: '23503', constraint: FK })
    }
    expect(await ledgerOf(admin, id)).toMatchObject({ project_id: PROJECT_A, estimate_item_id: ITEM_A })
  })

  it('見積行を指したまま台帳行の案件だけを別の案件へ移すこともできない（アプリに経路は無い）', async () => {
    const id = await newLedger(admin, COMPANY_A, PROJECT_A, ITEM_A)
    const e = await pgError(admin.query('UPDATE cost_ledger_items SET project_id = $1 WHERE id = $2', [PROJECT_A2, id]))
    expect(e).toMatchObject({ code: '23503', constraint: FK })
    // 見積行を外せば移せる（手動の行として）
    await admin.query('UPDATE cost_ledger_items SET project_id = $1, estimate_item_id = NULL WHERE id = $2', [PROJECT_A2, id])
    expect(await ledgerOf(admin, id)).toMatchObject({ project_id: PROJECT_A2, estimate_item_id: null })
  })

  it('台帳から参照されている見積行の案件は変えられない（アプリに経路は無い）。参照が無い見積行は変えられる', async () => {
    const used = await newItem(admin, COMPANY_A, PROJECT_A)
    await newLedger(admin, COMPANY_A, PROJECT_A, used)
    const e = await pgError(admin.query('UPDATE estimate_items SET project_id = $1 WHERE id = $2', [PROJECT_A2, used]))
    expect(e).toMatchObject({ code: '23503', constraint: FK })
    const unused = await newItem(admin, COMPANY_A, PROJECT_A)
    await admin.query('UPDATE estimate_items SET project_id = $1 WHERE id = $2', [PROJECT_A2, unused])
  })
})

// ── 4. 修正後: 正常な操作は変わらない ────────────────────────────

describe('修正後: 原価台帳の既存の操作は変わらない', () => {
  it('台帳の初期化（cost-ledger/init と同じ: 同じ案件の見積行から一括 INSERT）・手動の行（estimate_item_id = NULL）', async () => {
    const p = await newProject(admin, COMPANY_A)
    const items = [await newItem(admin, COMPANY_A, p), await newItem(admin, COMPANY_A, p)]
    await asUser(admin, USER_A, async () => {
      await admin.query(`
        INSERT INTO cost_ledger_items (project_id, company_id, estimate_item_id, name, source)
        SELECT project_id, company_id, id, name, 'from_estimate' FROM estimate_items WHERE project_id = $1 AND deleted_at IS NULL`, [p])
      await newLedger(admin, COMPANY_A, p, null)
    })
    const { rows } = await admin.query(
      'SELECT estimate_item_id FROM cost_ledger_items WHERE project_id = $1 ORDER BY estimate_item_id NULLS LAST', [p])
    expect(rows.map(r => r.estimate_item_id)).toEqual([...items.sort(), null])
  })

  it('同期（cost-ledger/sync と同じ）: 見積の変更の反映・見積行の論理削除に合わせた台帳行の論理削除・見積行の追加', async () => {
    const p = await newProject(admin, COMPANY_A)
    const keep = await newItem(admin, COMPANY_A, p)
    const gone = await newItem(admin, COMPANY_A, p)
    const ledKeep = await newLedger(admin, COMPANY_A, p, keep)
    const ledGone = await newLedger(admin, COMPANY_A, p, gone)
    await admin.query('UPDATE estimate_items SET deleted_at = now() WHERE id = $1', [gone]) // 見積から削除（論理削除）
    const added = await newItem(admin, COMPANY_A, p)
    await asUser(admin, USER_A, async () => {
      await admin.query("UPDATE cost_ledger_items SET name = '変更後', sort_order = 2 WHERE id = $1", [ledKeep])
      await admin.query('UPDATE cost_ledger_items SET deleted_at = now() WHERE id = $1', [ledGone])
      await newLedger(admin, COMPANY_A, p, added)
    })
    expect(await ledgerOf(admin, ledKeep)).toMatchObject({ estimate_item_id: keep, deleted: false })
    // 論理削除済みの見積行を指したまま残る（外部キーは deleted_at を見ない）
    expect(await ledgerOf(admin, ledGone)).toMatchObject({ estimate_item_id: gone, deleted: true })
  })

  it('同じ案件の論理削除済みの見積行を指す台帳行は作れ、残せる。同じ案件の別の見積行へ付け替えられる', async () => {
    const id = await asUser(admin, USER_A, () => newLedger(admin, COMPANY_A, PROJECT_A, ITEM_A_DELETED))
    expect((await ledgerOf(admin, id))?.estimate_item_id).toBe(ITEM_A_DELETED)
    await asUser(admin, USER_A, () => admin.query('UPDATE cost_ledger_items SET estimate_item_id = $1 WHERE id = $2', [ITEM_A_2, id]))
    expect((await ledgerOf(admin, id))?.estimate_item_id).toBe(ITEM_A_2)
  })

  it('台帳の編集（予算・実績・業者・メモ）は見積行の参照に関係なく通る。請求書がある行の actual_cost ロック（P1-3）も従来どおり', async () => {
    const id = await newLedger(admin, COMPANY_A, PROJECT_A, ITEM_A)
    await asUser(admin, USER_A, () => admin.query(
      "UPDATE cost_ledger_items SET budget_cost = 100, completion_cost = 120, actual_cost = 90, vendor_name = '業者', note = 'メモ' WHERE id = $1", [id]))
    expect((await ledgerOf(admin, id))?.actual_cost).toBe('90')
    await admin.query('INSERT INTO cost_ledger_invoices (cost_ledger_item_id, project_id, amount) VALUES ($1, $2, 500)', [id, PROJECT_A])
    await admin.query('UPDATE cost_ledger_items SET actual_cost = 500 WHERE id = $1', [id])
    const e = await pgError(asUser(admin, USER_A, () => admin.query('UPDATE cost_ledger_items SET actual_cost = 1 WHERE id = $1', [id])))
    expect(e).toMatchObject({ code: 'CL423', message: 'actual_cost_locked' })
  })

  it('見積行の物理削除: 台帳行の estimate_item_id だけが NULL になり、project_id・実績・請求書・論理削除済みの行もそのまま（P1-3 のトリガーに当たらない）', async () => {
    const item = await newItem(admin, COMPANY_A, PROJECT_A)
    const led = await newLedger(admin, COMPANY_A, PROJECT_A, item)
    const deletedLed = await newLedger(admin, COMPANY_A, PROJECT_A, item)
    await admin.query('UPDATE cost_ledger_items SET deleted_at = now() WHERE id = $1', [deletedLed])
    await admin.query('INSERT INTO cost_ledger_invoices (cost_ledger_item_id, project_id, amount) VALUES ($1, $2, 700)', [led, PROJECT_A])
    await admin.query('UPDATE cost_ledger_items SET actual_cost = 700 WHERE id = $1', [led])
    await admin.query('DELETE FROM estimate_items WHERE id = $1', [item])
    expect(await ledgerOf(admin, led)).toEqual({ project_id: PROJECT_A, estimate_item_id: null, actual_cost: '700', deleted: false })
    expect(await ledgerOf(admin, deletedLed)).toMatchObject({ project_id: PROJECT_A, estimate_item_id: null, deleted: true })
    expect((await admin.query('SELECT count(*)::int AS n FROM cost_ledger_invoices WHERE cost_ledger_item_id = $1', [led])).rows[0].n).toBe(1)
  })

  it('案件の物理削除: 見積行・台帳行・請求書は従来どおりカスケードで消える（見積行の SET NULL と競合しない）', async () => {
    const p = await newProject(admin, COMPANY_A)
    const item = await newItem(admin, COMPANY_A, p)
    const led = await newLedger(admin, COMPANY_A, p, item)
    await admin.query('INSERT INTO cost_ledger_invoices (cost_ledger_item_id, project_id, amount) VALUES ($1, $2, 1)', [led, p])
    await admin.query('DELETE FROM projects WHERE id = $1', [p])
    expect(await ledgerOf(admin, led)).toBeUndefined()
    expect((await admin.query('SELECT 1 FROM estimate_items WHERE id = $1', [item])).rowCount).toBe(0)
  })

  it('他の案件の行には影響しない（案件を消しても別案件の見積行・台帳行は残る）', async () => {
    const led = await newLedger(admin, COMPANY_A, PROJECT_A2, ITEM_A2)
    const p = await newProject(admin, COMPANY_A)
    await newLedger(admin, COMPANY_A, p, await newItem(admin, COMPANY_A, p))
    await admin.query('DELETE FROM projects WHERE id = $1', [p])
    expect(await ledgerOf(admin, led)).toMatchObject({ project_id: PROJECT_A2, estimate_item_id: ITEM_A2 })
  })
})

// ── 4-2. 修正後: 業者請求書の RPC（P1-2 / P1-4。OCR の登録もこの経路）と組み合わせても変わらない ──────────

type InvoiceRpcResult = { invoice: { id: string; amount: number; note: string | null }; item_id: string; actual_cost: number | null; invoice_count: number }

/** source = 'ocr' は OCR 画面と同じく原本の SHA-256・idempotency_key 付きで登録する */
const rpcInsert = async (c: Client, itemId: string, amount: number, source: 'manual' | 'ocr' = 'manual'): Promise<InvoiceRpcResult> =>
  (await c.query(
    `SELECT public.cost_ledger_invoice_insert(p_item_id => $1, p_amount => $2::numeric, p_source => $3,
       p_document_sha256 => $4, p_idempotency_key => $5::uuid) AS r`,
    [itemId, String(amount), source,
     source === 'ocr' ? randomUUID().replace(/-/g, '').repeat(2) : null, source === 'ocr' ? randomUUID() : null])).rows[0].r
const rpcUpdate = async (c: Client, invoiceId: string, patch: Record<string, unknown>): Promise<InvoiceRpcResult> =>
  (await c.query('SELECT public.cost_ledger_invoice_update($1, $2::jsonb) AS r', [invoiceId, JSON.stringify(patch)])).rows[0].r
const rpcDelete = async (c: Client, invoiceId: string): Promise<{ deleted_id: string; actual_cost: number | null; invoice_count: number }> =>
  (await c.query('SELECT public.cost_ledger_invoice_delete($1) AS r', [invoiceId])).rows[0].r

/** 台帳行の実績原価と請求書の合計・件数（請求書の project_id はすべて台帳行と同じであること） */
async function invoiceTotals(c: Client, ledgerId: string) {
  const { rows } = await c.query(`
    SELECT l.actual_cost::text AS actual_cost, sum(v.amount)::text AS total, count(v.id)::int AS n,
           bool_and(v.project_id = l.project_id) AS same_project
    FROM cost_ledger_items l LEFT JOIN cost_ledger_invoices v ON v.cost_ledger_item_id = l.id
    WHERE l.id = $1 GROUP BY l.id, l.actual_cost`, [ledgerId])
  return rows[0] as { actual_cost: string | null; total: string | null; n: number; same_project: boolean | null }
}

describe('修正後: 見積行を指す台帳行への業者請求書の登録・編集・削除（RPC）は従来どおり', () => {
  it('登録 → 金額・日付・備考の編集 → 削除で actual_cost が常に請求書の合計と一致し、見積行の参照・案件は変わらない', async () => {
    const item = await newItem(admin, COMPANY_A, PROJECT_A)
    const led = await newLedger(admin, COMPANY_A, PROJECT_A, item)

    const r1 = await asUser(admin, USER_A, () => rpcInsert(admin, led, 1000, 'ocr'))
    const r2 = await asUser(admin, USER_A, () => rpcInsert(admin, led, 250))
    expect([r1.invoice_count, r2.invoice_count, Number(r2.actual_cost)]).toEqual([1, 2, 1250])
    expect(await invoiceTotals(admin, led)).toEqual({ actual_cost: '1250', total: '1250', n: 2, same_project: true })

    const u = await asUser(admin, USER_A, () => rpcUpdate(admin, r1.invoice.id,
      { amount: 800, invoice_date: '2026-10-01', payment_date: '2026-10-31', note: '税抜で訂正' }))
    expect([Number(u.invoice.amount), u.invoice.note, Number(u.actual_cost)]).toEqual([800, '税抜で訂正', 1050])
    const { rows } = await admin.query('SELECT invoice_date::text, payment_date::text FROM cost_ledger_invoices WHERE id = $1', [r1.invoice.id])
    expect(rows[0]).toEqual({ invoice_date: '2026-10-01', payment_date: '2026-10-31' })
    expect(await invoiceTotals(admin, led)).toEqual({ actual_cost: '1050', total: '1050', n: 2, same_project: true })

    const d1 = await asUser(admin, USER_A, () => rpcDelete(admin, r2.invoice.id))
    expect([d1.invoice_count, Number(d1.actual_cost)]).toEqual([1, 800])
    const d2 = await asUser(admin, USER_A, () => rpcDelete(admin, r1.invoice.id))
    expect([d2.invoice_count, d2.actual_cost]).toEqual([0, null])
    expect(await ledgerOf(admin, led)).toEqual({ project_id: PROJECT_A, estimate_item_id: item, actual_cost: null, deleted: false })
  })

  it('P1-3: 請求書がある台帳行の actual_cost の直接変更は CL423。請求書をすべて消せば直接入力できる', async () => {
    const led = await newLedger(admin, COMPANY_A, PROJECT_A, await newItem(admin, COMPANY_A, PROJECT_A))
    const r = await asUser(admin, USER_A, () => rpcInsert(admin, led, 300))
    const e = await pgError(asUser(admin, USER_A, () => admin.query('UPDATE cost_ledger_items SET actual_cost = 1 WHERE id = $1', [led])))
    expect(e).toMatchObject({ code: 'CL423', message: 'actual_cost_locked' })
    expect(await invoiceTotals(admin, led)).toMatchObject({ actual_cost: '300', total: '300' })
    await asUser(admin, USER_A, () => rpcDelete(admin, r.invoice.id))
    await asUser(admin, USER_A, () => admin.query('UPDATE cost_ledger_items SET actual_cost = 1 WHERE id = $1', [led]))
    expect((await ledgerOf(admin, led))?.actual_cost).toBe('1')
  })

  it('論理削除済みの見積行を指す台帳行・物理削除で見積行の参照が NULL になった台帳行にも、登録・編集・削除できる', async () => {
    const ledToDeleted = await newLedger(admin, COMPANY_A, PROJECT_A, ITEM_A_DELETED)
    const item = await newItem(admin, COMPANY_A, PROJECT_A)
    const ledNulled = await newLedger(admin, COMPANY_A, PROJECT_A, item)
    const before = await asUser(admin, USER_A, () => rpcInsert(admin, ledNulled, 100))
    await admin.query('DELETE FROM estimate_items WHERE id = $1', [item]) // SET NULL (estimate_item_id)
    expect(await ledgerOf(admin, ledNulled)).toMatchObject({ estimate_item_id: null, actual_cost: '100' })
    for (const led of [ledToDeleted, ledNulled]) {
      const r = await asUser(admin, USER_A, () => rpcInsert(admin, led, 40))
      await asUser(admin, USER_A, () => rpcUpdate(admin, r.invoice.id, { amount: 60 }))
    }
    await asUser(admin, USER_A, () => rpcDelete(admin, before.invoice.id))
    expect(await invoiceTotals(admin, ledToDeleted)).toEqual({ actual_cost: '60', total: '60', n: 1, same_project: true })
    expect(await invoiceTotals(admin, ledNulled)).toEqual({ actual_cost: '60', total: '60', n: 1, same_project: true })
    expect((await ledgerOf(admin, ledToDeleted))?.estimate_item_id).toBe(ITEM_A_DELETED)
  })

  it('RPC が台帳行をロックしている間の見積行の物理削除は待ち合わせ、デッドロックせずに両方とも反映される', async () => {
    const item = await newItem(admin, COMPANY_A, PROJECT_A)
    const led = await newLedger(admin, COMPANY_A, PROJECT_A, item)
    const other = await server.connect('lip1')
    await other.query('BEGIN')
    await other.query('SET LOCAL ROLE authenticated')
    await other.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [USER_A])
    await rpcInsert(other, led, 500) // コミット前: 台帳行の行ロックを持ったまま
    const pid = (await other.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
    const deleting = admin.query('DELETE FROM estimate_items WHERE id = $1', [item]) // SET NULL が台帳行のロックを待つ
    const monitor = await server.connect('lip1')
    let waited = false
    for (let i = 0; i < 100 && !waited; i++) {
      const { rows } = await monitor.query(
        "SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND pid <> $1 AND query LIKE 'DELETE FROM estimate_items%'", [pid])
      waited = rows.length > 0
      if (!waited) await new Promise(r => setTimeout(r, 20))
    }
    expect(waited).toBe(true)
    await other.query('COMMIT')
    await deleting
    expect(await ledgerOf(admin, led)).toEqual({ project_id: PROJECT_A, estimate_item_id: null, actual_cost: '500', deleted: false })
    expect(await invoiceTotals(admin, led)).toEqual({ actual_cost: '500', total: '500', n: 1, same_project: true })
    await Promise.all([other.end(), monitor.end()])
  }, 30_000)

  it('他社・別案件の分離: 他社の台帳行・請求書への登録・編集・削除は CL404 で、どちらのデータも変わらない', async () => {
    const ledA = await newLedger(admin, COMPANY_A, PROJECT_A, await newItem(admin, COMPANY_A, PROJECT_A))
    const ledB = await newLedger(admin, COMPANY_B, PROJECT_B, ITEM_B)
    const invA = (await asUser(admin, USER_A, () => rpcInsert(admin, ledA, 10))).invoice.id
    const invB = (await asUser(admin, USER_B, () => rpcInsert(admin, ledB, 20))).invoice.id
    for (const [user, led, inv] of [[USER_A, ledB, invB], [USER_B, ledA, invA]] as const) {
      const calls: Array<() => Promise<unknown>> = [() => rpcInsert(admin, led, 1), () => rpcUpdate(admin, inv, { amount: 1 }), () => rpcDelete(admin, inv)]
      for (const call of calls) {
        expect(await pgError(asUser(admin, user, call))).toMatchObject({ code: 'CL404' })
      }
    }
    expect(await invoiceTotals(admin, ledA)).toEqual({ actual_cost: '10', total: '10', n: 1, same_project: true })
    expect(await invoiceTotals(admin, ledB)).toEqual({ actual_cost: '20', total: '20', n: 1, same_project: true })
    // 台帳行の見積行を他社・別案件の見積行へ付け替えることは、請求書があっても 23503（請求書・実績は変わらない）
    for (const target of [ITEM_A2, ITEM_B]) {
      const e = await pgError(asUser(admin, USER_A, () =>
        admin.query('UPDATE cost_ledger_items SET estimate_item_id = $1 WHERE id = $2', [target, ledA])))
      expect(e).toMatchObject({ code: '23503', constraint: FK })
    }
    expect(await invoiceTotals(admin, ledA)).toEqual({ actual_cost: '10', total: '10', n: 1, same_project: true })
  })
})

// ── 5. SQL Editor 用スクリプト ──────────────────────────────────

describe('SQL Editor 用スクリプト（docs/db/ki-002-pr4b-ledger-estimate-item-*.sql）', () => {
  const DOCS = path.resolve(__dirname, '../../docs/db')
  const read = (f: string) => readFileSync(path.join(DOCS, f), 'utf8')
  const APPLY = read('ki-002-pr4b-ledger-estimate-item-sql-editor-apply.sql')
  const ROLLBACK = read('ki-002-pr4b-ledger-estimate-item-sql-editor-rollback.sql')
  const PRECHECK = read('ki-002-pr4b-ledger-estimate-item-precheck.sql')
  const VERIFY = read('ki-002-pr4b-ledger-estimate-item-verify.sql')
  const PR4A_APPLY = read('ki-002-pr4a-group-project-sql-editor-apply.sql')
  const PR4A_ROLLBACK = read('ki-002-pr4a-group-project-sql-editor-rollback.sql')
  const HISTORY_SQL = `
    CREATE SCHEMA supabase_migrations;
    CREATE TABLE supabase_migrations.schema_migrations (version text PRIMARY KEY, statements text[], name text);
    INSERT INTO supabase_migrations.schema_migrations (version) VALUES ('20261013000001'), ('20261013000002'), ('20261014000001');`
  const APPLIED = [{ history_rows: '1', valid_constraints: '2', prior_constraints: '21' }]

  /** 本番と同じく PR-4a 未適用（履歴も制約も無い）の DB */
  async function editorDb() {
    const db = await freshDb([MIGRATION, PR4A_MIGRATION])
    await db.c.query(HISTORY_SQL)
    return db
  }
  async function history(c: Client) {
    return (await c.query("SELECT version, name FROM supabase_migrations.schema_migrations WHERE version = '20261016000001'")).rows
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
      expect(code).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP|GRANT|REVOKE|COMMENT|NOTIFY|COPY|DO|LOCK)\b/i)
    }
  })

  it('成功時: 制約と履歴がそろって確定し、既存の制約・RLS ポリシー・権限・トリガーは変わらない。確認 SQL が全行 ok', async () => {
    const { c } = await editorDb()
    const before = [await otherConstraints(c), await policies(c), await tablePrivileges(c), await triggers(c)]
    expect(await runScript(c, APPLY)).toEqual(APPLIED)
    expect(await history(c)).toEqual([{ version: '20261016000001', name: 'enforce_ledger_estimate_item_project_match' }])
    expect([await otherConstraints(c), await policies(c), await tablePrivileges(c), await triggers(c)]).toEqual(before)
    const { rows } = await c.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = pg_backend_pid() AND state = 'idle in transaction'")
    expect(rows[0].n).toBe(0)

    const [verify] = await runReadOnly(c, VERIFY)
    expect(verify.filter(r => r.name !== '_summary').map(r => [r.name, r.ok])).toEqual([...NEW_CONSTRAINTS].sort().map(n => [n, true]))
    expect(verify.find(r => r.name === '_summary')).toMatchObject({
      history_recorded: true, single_fkeys: '1', prior_constraints: '21', blocking_rows: '0', lock_trigger_enabled: true,
    })
    await c.end()
  })

  it('PR-4a → PR-4b の順でも PR-4b → PR-4a の順でも適用でき、互いの制約を変えない', async () => {
    const { c } = await editorDb()
    await runScript(c, PR4A_APPLY)
    expect(await runScript(c, APPLY)).toEqual(APPLIED)
    const { c: c2 } = await editorDb()
    expect(await runScript(c2, APPLY)).toEqual(APPLIED)
    expect(await runScript(c2, PR4A_APPLY)).toEqual([{ history_rows: '1', valid_constraints: '3', prior_constraints: '21' }])
    expect(await otherConstraints(c)).toEqual(await otherConstraints(c2))
    for (const x of [c, c2]) await x.end()
  })

  it('ガード: 二度目の実行・履歴なしで制約だけある DB・20261014000001 が未記録の DB では止まる', async () => {
    const { c } = await editorDb()
    await runScript(c, APPLY)
    expect((await runScriptExpectingError(c, APPLY)).message)
      .toBe('ledger-item-project-1 apply aborted: version 20261016000001 is already recorded')
    const { c: c2 } = await editorDb()
    await applyMigration(c2)
    expect((await runScriptExpectingError(c2, APPLY)).message)
      .toBe('ledger-item-project-1 apply aborted: constraints already exist (history is missing)')
    expect(await history(c2)).toHaveLength(0)
    const { c: c3 } = await editorDb()
    await c3.query("DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261014000001'")
    expect((await runScriptExpectingError(c3, APPLY)).message)
      .toBe('ledger-item-project-1 apply aborted: version 20261014000001 is not recorded (apply it first)')
    expect(await newConstraintCount(c3)).toBe(0)
    for (const x of [c, c2, c3]) await x.end()
  })

  it('他の案件の見積行を指す行があれば、制約も履歴も残らない', async () => {
    const { c, pA, iA2 } = await editorDb()
    await newLedger(c, COMPANY_A, pA, iA2)
    const e = await runScriptExpectingError(c, APPLY)
    expect(e.message).toBe('ledger-item-project-1 precondition failed: cost_ledger_items: orphan=0 estimate_item_project_null=0 mismatched=1')
    expect(await newConstraintCount(c)).toBe(0)
    expect(await history(c)).toHaveLength(0)
    await c.end()
  })

  it('適用前の確認 SQL: 食い違いの件数・論理削除済みの見積行への参照を出す（読み取り専用）', async () => {
    const { c, pA, iA, iA2 } = await editorDb()
    const iDel = await newItem(c, COMPANY_A, pA, true)
    await newLedger(c, COMPANY_A, pA, iA)
    await newLedger(c, COMPANY_A, pA, iA2)
    const deletedLed = await newLedger(c, COMPANY_A, pA, iDel)
    await newLedger(c, COMPANY_A, pA, null)
    await c.query('UPDATE cost_ledger_items SET deleted_at = now() WHERE id = $1', [deletedLed])
    const results = await runReadOnly(c, PRECHECK)
    expect(results).toHaveLength(8) // ①〜⑧
    const [version, hist, cols, cons, refs, sizes] = results
    expect(version[0].server_version).toMatch(/^\d+/)
    expect(hist).toEqual([
      { version: '20261013000002', recorded: true },
      { version: '20261014000001', recorded: true },
      { version: '20261015000001', recorded: false },
      { version: '20261016000001', recorded: false },
    ])
    expect(cols.filter(r => r.column_name === 'project_id').map(r => [r.table_name, r.nullable]))
      .toEqual([['cost_ledger_items', false], ['estimate_items', false]])
    expect(cons.map(r => r.conname)).toEqual(['cost_ledger_items_estimate_item_id_fkey', 'estimate_items_pkey'])
    expect(refs).toEqual([{
      ref: 'R3 cost_ledger_items.estimate_item_id', with_ref: '3', blocking_orphan: '0', blocking_target_null: '0',
      blocking_mismatch: '1', info_live_to_deleted_item: '0', info_deleted_ledger_rows: '1',
    }])
    expect(sizes[0]).toMatchObject({ estimate_items_total: '3', cost_ledger_items_total: '4', ledger_without_estimate_item: '1' })
    await c.end()
  })

  it('ロールバック: 追加した 2 つの制約と履歴の 1 行だけを消す（単独の外部キー・PR #35・PR-3・PR-4a は残す）。二度目はガードで止まり、適用し直せる', async () => {
    const { c } = await editorDb()
    await runScript(c, PR4A_APPLY)
    const before = [await otherConstraints(c), await policies(c), await tablePrivileges(c), await triggers(c)]
    await runScript(c, APPLY)
    expect(await runScript(c, ROLLBACK)).toEqual([{ history_rows: '0', constraints: '0', prior_constraints: '21' }])
    expect([await otherConstraints(c), await policies(c), await tablePrivileges(c), await triggers(c)]).toEqual(before)
    const [verify] = await runReadOnly(c, VERIFY)
    expect(verify.filter(r => r.name !== '_summary').every(r => r.ok === false && r.definition === null)).toBe(true)
    expect(verify.find(r => r.name === '_summary')).toMatchObject({ history_recorded: false, single_fkeys: '1' })
    const e = await runScriptExpectingError(c, ROLLBACK)
    expect(e.message).toBe('ledger-item-project-1 rollback aborted: nothing to roll back (no history row, no constraints)')
    expect(await runScript(c, APPLY)).toEqual(APPLIED)
    await c.end()
  })

  it('PR-4a のロールバックは PR-4b を適用したままでも動き、PR-4b の制約は残る（依存なし）', async () => {
    const { c } = await editorDb()
    await runScript(c, PR4A_APPLY)
    await runScript(c, APPLY)
    expect(await runScript(c, PR4A_ROLLBACK)).toEqual([{ history_rows: '0', constraints: '0', prior_constraints: '21' }])
    expect(await newConstraintCount(c)).toBe(2)
    expect(await history(c)).toHaveLength(1)
    await c.end()
  })
})
