/**
 * KI-005: 見積同期・台帳項目の削除で、請求書・実績原価・予算のある台帳項目を論理削除しない。
 *
 * 実行: npm run test:db
 *   隔離されたローカル PostgreSQL（embedded-postgres）にリポジトリの全 migration を適用し、
 *   実際の API ルート（POST /api/cost-ledger/sync・DELETE /api/cost-ledger/[id]・GET /api/cost-ledger）を
 *   ログイン済みユーザー（authenticated + RLS）として動かす。請求書は本番と同じ RPC（P1-2〜P1-4）で登録する。
 *   本番・Preview の DB には接続しない。
 *
 * 確かめること:
 *   - 保護対象（請求書・実績原価・実行予算・完工予算のどれかがある）は、見積から削除されても台帳に残り、合計も変わらない
 *   - 保護対象でない行だけが論理削除される。何度同期しても同じ結果。見積行を戻せば元の台帳項目に戻る
 *   - 各 DB 操作の失敗を検出し、途中で止めて 500。保護対象は消えず、やり直しで収束する
 *   - 同時実行: 請求書の登録と同期・削除が重なっても「請求書があるのに論理削除された項目」はできない。
 *     同期が 2 つ同時に動いても台帳項目は 1 行に収束する
 *   - 手動の削除: 請求書がある行は 409、実績・予算がある行は確認が必要、確認後に値が変わったら 409
 */

import { randomUUID } from 'node:crypto'
import type { Client } from 'pg'
import { NextRequest } from 'next/server'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { startLocalPostgres, type LocalPostgres } from './helpers/local-postgres'
import { applyFullSchema } from './helpers/full-schema'
import { pgSupabase } from './helpers/pg-supabase'

let server: LocalPostgres
let admin: Client
/** API ルートが使う DB 接続（テストごとに差し替えて、失敗や待ち合わせを差し込む） */
let routeClient: Client
let currentUser: string | undefined

vi.mock('@/lib/supabase/server', () => ({
  getServerClient: async () => pgSupabase(routeClient, currentUser),
}))

const { POST: SYNC } = await import('@/app/api/cost-ledger/sync/route')
const { DELETE } = await import('@/app/api/cost-ledger/[id]/route')
const { GET } = await import('@/app/api/cost-ledger/route')

const COMPANY_A = randomUUID()
const COMPANY_B = randomUUID()
const USER_A = randomUUID()
const USER_B = randomUUID()

type SyncBody = {
  added: number; updated: number; removed: number; deduplicated: number
  kept: Array<{ id: string; name: string; reasons: string[] }>
  code?: string; step?: string; applied?: { added: number; updated: number; removed: number }
}

// ── 準備 ───────────────────────────────────────────────────

/** ログイン済みユーザーとして RPC を呼ぶ接続（セッション全体を authenticated にする） */
async function userConnection(user: string): Promise<Client> {
  const c = await server.connect()
  await c.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [user])
  await c.query('SET ROLE authenticated')
  return c
}

const rpcInsert = (c: Client, itemId: string, amount: number) =>
  c.query(`SELECT public.cost_ledger_invoice_insert(p_item_id => $1, p_amount => $2::numeric, p_source => 'manual') AS r`,
    [itemId, String(amount)])

async function newProject(companyId = COMPANY_A): Promise<string> {
  return (await admin.query('INSERT INTO projects (company_id) VALUES ($1) RETURNING id', [companyId])).rows[0].id
}

async function newEstimate(projectId: string, name: string, companyId = COMPANY_A): Promise<string> {
  return (await admin.query(
    `INSERT INTO estimate_items (company_id, project_id, name, quantity, unit, cost_price, sort_order)
     VALUES ($1, $2, $3, 1, '式', 1000, 0) RETURNING id`, [companyId, projectId, name])).rows[0].id
}

async function newLedger(projectId: string, estimateId: string | null, name: string,
  values: { actual_cost?: number; budget_cost?: number; completion_cost?: number } = {}, companyId = COMPANY_A): Promise<string> {
  return (await admin.query(
    `INSERT INTO cost_ledger_items (company_id, project_id, estimate_item_id, name, quantity, unit, estimate_cost, source,
                                    actual_cost, budget_cost, completion_cost)
     VALUES ($1, $2, $3, $4, 1, '式', 1000, 'from_estimate', $5, $6, $7) RETURNING id`,
    [companyId, projectId, estimateId, name, values.actual_cost ?? null, values.budget_cost ?? null, values.completion_cost ?? null])).rows[0].id
}

const removeEstimate = (id: string) => admin.query('UPDATE estimate_items SET deleted_at = now() WHERE id = $1', [id])
const restoreEstimate = (id: string) => admin.query('UPDATE estimate_items SET deleted_at = NULL WHERE id = $1', [id])

async function ledger(id: string) {
  const { rows } = await admin.query(
    `SELECT deleted_at IS NOT NULL AS deleted, actual_cost::float8 AS actual_cost, budget_cost::float8 AS budget_cost,
            completion_cost::float8 AS completion_cost, estimate_item_id, name
     FROM cost_ledger_items WHERE id = $1`, [id])
  return rows[0] as { deleted: boolean; actual_cost: number | null; budget_cost: number | null; completion_cost: number | null; estimate_item_id: string | null; name: string }
}

/** 案件の合計（GET /api/cost-ledger の summary）と、一覧の行 */
async function ledgerView(projectId: string) {
  const res = await GET(new NextRequest(`http://localhost/api/cost-ledger?project_id=${projectId}`))
  expect(res.status).toBe(200)
  return await res.json() as {
    items: Array<{ id: string; estimate_removed: boolean; invoice_count: number }>
    summary: { actual_cost_total: number; budget_cost_total: number; completion_cost_total: number }
  }
}

async function sync(projectId: string): Promise<{ status: number; body: SyncBody }> {
  const res = await SYNC(new NextRequest('http://localhost/api/cost-ledger/sync', {
    method: 'POST', body: JSON.stringify({ project_id: projectId }), headers: { 'content-type': 'application/json' },
  }))
  return { status: res.status, body: await res.json() }
}

async function del(id: string, confirm = false) {
  const res = await DELETE(new NextRequest(`http://localhost/api/cost-ledger/${id}${confirm ? '?confirm=values' : ''}`, { method: 'DELETE' }),
    { params: Promise.resolve({ id }) })
  return { status: res.status, body: res.status === 204 ? null : await res.json() as { code?: string; reasons?: string[] } }
}

/** 本物の接続に、特定の SQL の直前で処理を差し込む（失敗・待ち合わせ・別の接続での書き込み） */
function hooked(real: Client, hook: (sql: string) => Promise<void> | void): Client {
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'query') {
        return async (arg: string | { text: string }, params?: unknown[]) => {
          const sql = typeof arg === 'string' ? arg : arg.text
          await hook(sql)
          return params === undefined ? target.query(arg as string) : target.query(arg as string, params)
        }
      }
      return Reflect.get(target, prop, receiver)
    },
  }) as Client
}

const isSoftDelete = (sql: string) => /^UPDATE "cost_ledger_items"/.test(sql) && sql.includes('"deleted_at" = $1')
const isLedgerInsert = (sql: string) => /^INSERT INTO "cost_ledger_items"/.test(sql)
const isLedgerUpdate = (sql: string) => /^UPDATE "cost_ledger_items"/.test(sql) && !sql.includes('"deleted_at" = $1')

beforeAll(async () => {
  server = await startLocalPostgres()
  admin = await server.connect()
  await applyFullSchema(admin)
  await admin.query('INSERT INTO auth.users (id) VALUES ($1), ($2)', [USER_A, USER_B])
  await admin.query('INSERT INTO companies (id, name) VALUES ($1, $2), ($3, $4)', [COMPANY_A, 'A社', COMPANY_B, 'B社'])
  await admin.query('INSERT INTO company_members (company_id, user_id, role) VALUES ($1, $2, $3), ($4, $5, $3)',
    [COMPANY_A, USER_A, 'owner', COMPANY_B, USER_B])
  routeClient = await server.connect()
}, 120000)

afterAll(async () => { await server?.stop() })

beforeEach(async () => {
  currentUser = USER_A
  routeClient = await server.connect()
})

// ── 1. 見積同期: 保護対象を残し、合計を変えない ─────────────────────

describe('見積同期：請求書・実績原価・予算のある台帳項目は、見積から削除されても残す', () => {
  it('保護対象 4 行は残り、空の行だけ論理削除。合計・請求書・見積データは変わらず、一覧に「見積から削除済み」と出る', async () => {
    const p = await newProject()
    const names = ['請求書あり', '実績のみ', '実行予算のみ', '完工予算のみ', '空', '見積に残る']
    const est = Object.fromEntries(await Promise.all(names.map(async n => [n, await newEstimate(p, n)] as const)))
    const led = {
      inv:   await newLedger(p, est['請求書あり'], '請求書あり'),
      act:   await newLedger(p, est['実績のみ'], '実績のみ', { actual_cost: 30000 }),
      bud:   await newLedger(p, est['実行予算のみ'], '実行予算のみ', { budget_cost: 40000 }),
      cmp:   await newLedger(p, est['完工予算のみ'], '完工予算のみ', { completion_cost: 50000 }),
      empty: await newLedger(p, est['空'], '空'),
      live:  await newLedger(p, est['見積に残る'], '見積に残る', { actual_cost: 7000 }),
    }
    const ua = await userConnection(USER_A)
    await rpcInsert(ua, led.inv, 12000)
    await rpcInsert(ua, led.inv, 3000)

    const before = await ledgerView(p)
    const estimatesBefore = (await admin.query('SELECT id, name, cost_price FROM estimate_items WHERE project_id = $1 ORDER BY id', [p])).rows
    for (const n of ['請求書あり', '実績のみ', '実行予算のみ', '完工予算のみ', '空']) await removeEstimate(est[n])

    const { status, body } = await sync(p)
    expect(status).toBe(200)
    expect(body).toMatchObject({ added: 0, removed: 1, deduplicated: 0 })
    expect(Object.fromEntries(body.kept.map(k => [k.name, k.reasons]))).toEqual({
      '請求書あり':   ['invoices', 'actual_cost'],
      '実績のみ':     ['actual_cost'],
      '実行予算のみ': ['budget_cost'],
      '完工予算のみ': ['completion_cost'],
    })

    expect(await ledger(led.empty)).toMatchObject({ deleted: true })
    expect(await ledger(led.inv)).toMatchObject({ deleted: false, actual_cost: 15000, estimate_item_id: est['請求書あり'] })
    expect(await ledger(led.act)).toMatchObject({ deleted: false, actual_cost: 30000 })
    expect(await ledger(led.bud)).toMatchObject({ deleted: false, budget_cost: 40000 })
    expect(await ledger(led.cmp)).toMatchObject({ deleted: false, completion_cost: 50000 })
    expect(Number((await admin.query('SELECT count(*) FROM cost_ledger_invoices WHERE cost_ledger_item_id = $1', [led.inv])).rows[0].count)).toBe(2)

    // 案件の合計は変わらない（実績 15,000 + 30,000 + 7,000・実行予算 40,000・完工予算 50,000）
    const after = await ledgerView(p)
    expect(after.summary).toMatchObject({
      actual_cost_total: before.summary.actual_cost_total,
      budget_cost_total: before.summary.budget_cost_total,
      completion_cost_total: before.summary.completion_cost_total,
    })
    expect(after.summary.actual_cost_total).toBe(52000)
    // 一覧: 残した 4 行は「見積から削除済み」、見積に残っている行は通常
    const flag = Object.fromEntries(after.items.map(i => [i.id, i.estimate_removed]))
    expect(flag).toEqual({ [led.inv]: true, [led.act]: true, [led.bud]: true, [led.cmp]: true, [led.live]: false })

    // 見積データは同期で変えない（削除の印を付けたのはテスト自身）
    const estimatesAfter = (await admin.query('SELECT id, name, cost_price FROM estimate_items WHERE project_id = $1 ORDER BY id', [p])).rows
    expect(estimatesAfter).toEqual(estimatesBefore)
    await ua.end()
  })

  it('何度同期しても同じ（残した行は毎回 kept・追加も削除もしない）。見積行を戻せば、元の台帳項目が通常の行に戻る', async () => {
    const p = await newProject()
    const e = await newEstimate(p, '戻す見積行')
    const l = await newLedger(p, e, '戻す見積行', { budget_cost: 9000 })
    await removeEstimate(e)

    for (let i = 0; i < 2; i++) {
      const { body } = await sync(p)
      expect(body).toMatchObject({ added: 0, updated: 0, removed: 0 })
      expect(body.kept.map(k => k.id)).toEqual([l])
    }

    await restoreEstimate(e)
    const { body } = await sync(p)
    expect(body).toMatchObject({ added: 0, removed: 0, kept: [] })
    const rows = (await admin.query('SELECT id FROM cost_ledger_items WHERE project_id = $1 AND deleted_at IS NULL', [p])).rows
    expect(rows.map(r => r.id)).toEqual([l])
    expect((await ledgerView(p)).items.find(i => i.id === l)?.estimate_removed).toBe(false)
    expect(await ledger(l)).toMatchObject({ budget_cost: 9000 })
  })

  it('他社の案件は同期できない（404）。他社の台帳項目は変わらない', async () => {
    const pb = await newProject(COMPANY_B)
    const eb = await newEstimate(pb, 'B社の見積行', COMPANY_B)
    const lb = await newLedger(pb, eb, 'B社の行', {}, COMPANY_B)
    await removeEstimate(eb)
    const { status } = await sync(pb)
    expect(status).toBe(404)
    expect(await ledger(lb)).toMatchObject({ deleted: false })
  })
})

// ── 2. 各 DB 操作の失敗の検出と、部分成功からの回復 ─────────────────────

describe('見積同期：各 DB 操作の失敗を検出し、途中で止める。やり直すと収束する', () => {
  const failOn = (match: (sql: string) => boolean, nth = 1) => {
    let seen = 0
    return (sql: string) => {
      if (match(sql) && ++seen === nth) throw Object.assign(new Error('injected failure'), { code: '57014' })
    }
  }

  const cases: Array<[string, (sql: string) => boolean, number, string]> = [
    ['見積の読み取り', sql => /^SELECT .* FROM "estimate_items"/.test(sql), 1, 'read_estimates'],
    ['台帳の読み取り', sql => /^SELECT .* FROM "cost_ledger_items"/.test(sql), 1, 'read_ledger'],
    ['2 件目の更新', isLedgerUpdate, 2, 'update'],
    ['2 件目の追加', isLedgerInsert, 2, 'insert'],
    ['請求書の件数の読み取り', sql => /FROM "cost_ledger_invoices"/.test(sql), 1, 'count_invoices'],
    ['2 件目の論理削除', isSoftDelete, 2, 'remove'],
  ]

  for (const [name, match, nth, step] of cases) {
    it(`${name}で失敗 → 500（code: sync_failed・step: ${step}）。保護対象は消えず、やり直しで正しい状態になる`, async () => {
      const p = await newProject()
      const upd1 = await newEstimate(p, '更新1'); const upd2 = await newEstimate(p, '更新2')
      const l1 = await newLedger(p, upd1, '古い名前1'); const l2 = await newLedger(p, upd2, '古い名前2')
      await newEstimate(p, '追加1'); await newEstimate(p, '追加2')
      const r1 = await newEstimate(p, '削除1'); const r2 = await newEstimate(p, '削除2'); const rk = await newEstimate(p, '保護')
      const d1 = await newLedger(p, r1, '削除1'); const d2 = await newLedger(p, r2, '削除2')
      const keep = await newLedger(p, rk, '保護', { actual_cost: 5000 })
      for (const e of [r1, r2, rk]) await removeEstimate(e)
      const total = (await ledgerView(p)).summary.actual_cost_total

      routeClient = hooked(await server.connect(), failOn(match, nth))
      const failed = await sync(p)
      expect(failed.status).toBe(500)
      expect(failed.body).toMatchObject({ code: 'sync_failed', step })
      expect(await ledger(keep)).toMatchObject({ deleted: false, actual_cost: 5000 })

      // やり直し（失敗なし）→ 収束: 名前の更新・追加 2 行・空の 2 行の削除・保護 1 行
      routeClient = await server.connect()
      const ok = await sync(p)
      expect(ok.status).toBe(200)
      expect(ok.body.kept.map(k => k.id)).toEqual([keep])
      expect(await ledger(l1)).toMatchObject({ name: '更新1', deleted: false })
      expect(await ledger(l2)).toMatchObject({ name: '更新2', deleted: false })
      expect(await ledger(d1)).toMatchObject({ deleted: true })
      expect(await ledger(d2)).toMatchObject({ deleted: true })
      const live = (await admin.query(
        `SELECT name FROM cost_ledger_items WHERE project_id = $1 AND deleted_at IS NULL`, [p])).rows.map(r => r.name as string)
      expect(live.sort()).toEqual(['保護', '更新1', '更新2', '追加1', '追加2'].sort())
      expect((await ledgerView(p)).summary.actual_cost_total).toBe(total)
      // 同じ見積行を指す台帳項目は 1 行だけ（部分成功のあとでも二重にならない）
      const dup = (await admin.query(
        `SELECT count(*)::int AS n FROM (SELECT 1 FROM cost_ledger_items WHERE project_id = $1 AND deleted_at IS NULL
           GROUP BY estimate_item_id HAVING count(*) > 1) g`, [p])).rows[0].n
      expect(dup).toBe(0)
    })
  }
})

// ── 3. 同時実行 ─────────────────────────────────────────────

/** 接続 pid がロック待ちになるまで待つ */
async function waitForLock(pid: number) {
  for (let i = 0; i < 200; i++) {
    const { rows } = await admin.query(`SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1`, [pid])
    if (rows[0]?.wait_event_type === 'Lock') return
    await new Promise(r => setTimeout(r, 25))
  }
  throw new Error('did not wait for lock')
}

describe('同時実行：請求書の登録と同期・削除が重なっても、請求書のある項目を論理削除しない', () => {
  it('請求書の登録（RPC が項目をロック中）→ 同期の論理削除は待たされ、登録の確定後に条件を見直して残す', async () => {
    const p = await newProject()
    const e = await newEstimate(p, '重なる行')
    const l = await newLedger(p, e, '重なる行')
    await removeEstimate(e)

    const ua = await userConnection(USER_A)
    await ua.query('BEGIN')
    await rpcInsert(ua, l, 8000) // まだ確定していない（台帳項目の行ロックを持ったまま）

    const conn = await server.connect()
    const pid = (await conn.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number
    routeClient = conn
    const pending = sync(p)
    await waitForLock(pid)
    await ua.query('COMMIT')

    const { status, body } = await pending
    expect(status).toBe(200)
    expect(body.removed).toBe(0)
    expect(body.kept.map(k => k.id)).toEqual([l])
    expect(await ledger(l)).toMatchObject({ deleted: false, actual_cost: 8000 })
    await ua.end()
  })

  it('同期の論理削除が先に確定 → そのあとの請求書の登録は削除済みの項目として拒否される（宙に浮いた請求書を作らない）', async () => {
    const p = await newProject()
    const e = await newEstimate(p, '先に消える行')
    const l = await newLedger(p, e, '先に消える行')
    await removeEstimate(e)
    expect((await sync(p)).body.removed).toBe(1)

    const ua = await userConnection(USER_A)
    await expect(rpcInsert(ua, l, 8000)).rejects.toMatchObject({ code: 'CL404' })
    expect(Number((await admin.query('SELECT count(*) FROM cost_ledger_invoices WHERE cost_ledger_item_id = $1', [l])).rows[0].count)).toBe(0)
    await ua.end()
  })

  it('同期が確かめた直後に実行予算が入力された → 論理削除しない（条件付き UPDATE が 0 行）', async () => {
    const p = await newProject()
    const e = await newEstimate(p, '直後に入力')
    const l = await newLedger(p, e, '直後に入力')
    await removeEstimate(e)

    let done = false
    routeClient = hooked(await server.connect(), async sql => {
      if (isSoftDelete(sql) && !done) {
        done = true
        await admin.query('UPDATE cost_ledger_items SET budget_cost = 1234 WHERE id = $1', [l])
      }
    })
    const { body } = await sync(p)
    expect(body.removed).toBe(0)
    expect(body.kept).toEqual([{ id: l, name: '直後に入力', reasons: [] }])
    expect(await ledger(l)).toMatchObject({ deleted: false, budget_cost: 1234 })
  })

  it('同期が 2 つ同時に同じ見積行の台帳項目を作っても、1 行に収束する（余分な行だけ論理削除）', async () => {
    const p = await newProject()
    await newEstimate(p, '新しい見積行A')
    await newEstimate(p, '新しい見積行B')

    // 2 つの同期が、どちらも「台帳に無い」と読んだあとで追加するよう、最初の INSERT の直前で待ち合わせる
    let arrived = 0
    let release!: () => void
    const barrier = new Promise<void>(r => { release = r })
    const gate = () => {
      let first = true
      return async (sql: string) => {
        if (isLedgerInsert(sql) && first) {
          first = false
          if (++arrived === 2) release()
          await barrier
        }
      }
    }
    const c1 = hooked(await server.connect(), gate())
    const c2 = hooked(await server.connect(), gate())

    routeClient = c1
    const s1 = sync(p)
    routeClient = c2
    const s2 = sync(p)
    const [r1, r2] = await Promise.all([s1, s2])
    expect([r1.status, r2.status]).toEqual([200, 200])

    const { rows } = await admin.query(
      `SELECT e.name, count(*) FILTER (WHERE l.deleted_at IS NULL)::int AS live, count(*)::int AS total
       FROM cost_ledger_items l JOIN estimate_items e ON e.id = l.estimate_item_id
       WHERE l.project_id = $1 GROUP BY e.name ORDER BY e.name`, [p])
    // 両方の同期が追加した（total 2）うえで、未削除は 1 行
    expect(rows).toEqual([
      { name: '新しい見積行A', live: 1, total: 2 },
      { name: '新しい見積行B', live: 1, total: 2 },
    ])
    expect(r1.body.added + r2.body.added).toBe(2)
    expect(r1.body.deduplicated + r2.body.deduplicated).toBe(2)
  })
})

// ── 4. 手動の削除 ───────────────────────────────────────────

describe('台帳項目の削除：請求書のある行は削除しない。実績・予算のある行は確認が必要', () => {
  it('請求書がある → 409 has_invoices（確認付きでも削除しない）', async () => {
    const p = await newProject()
    const l = await newLedger(p, null, '請求書あり')
    const ua = await userConnection(USER_A)
    await rpcInsert(ua, l, 5000)
    for (const confirm of [false, true]) {
      const r = await del(l, confirm)
      expect(r.status).toBe(409)
      expect(r.body).toMatchObject({ code: 'has_invoices' })
    }
    expect(await ledger(l)).toMatchObject({ deleted: false, actual_cost: 5000 })
    await ua.end()
  })

  it('実績原価・予算がある → 409 needs_confirm。確認（?confirm=values）すれば削除できる', async () => {
    const p = await newProject()
    const l = await newLedger(p, null, '予算あり', { budget_cost: 3000, actual_cost: 100 })
    const r = await del(l)
    expect(r.status).toBe(409)
    expect(r.body).toMatchObject({ code: 'needs_confirm', reasons: ['actual_cost', 'budget_cost'] })
    expect(await ledger(l)).toMatchObject({ deleted: false })
    expect((await del(l, true)).status).toBe(204)
    expect(await ledger(l)).toMatchObject({ deleted: true })
  })

  it('値のない行はそのまま削除できる（従来どおり）。他社の行は 404', async () => {
    const p = await newProject()
    const l = await newLedger(p, null, '空の行')
    expect((await del(l)).status).toBe(204)
    expect(await ledger(l)).toMatchObject({ deleted: true })

    const pb = await newProject(COMPANY_B)
    const lb = await newLedger(pb, null, 'B社の行', {}, COMPANY_B)
    expect((await del(lb)).status).toBe(404)
    expect(await ledger(lb)).toMatchObject({ deleted: false })
  })

  it('確かめた直後に請求書が登録された → 409 changed（削除しない）。請求書と実績原価は残る', async () => {
    const p = await newProject()
    const l = await newLedger(p, null, '直後に請求書', { budget_cost: 1000 })
    const ua = await userConnection(USER_A)
    let done = false
    routeClient = hooked(await server.connect(), async sql => {
      if (isSoftDelete(sql) && !done) {
        done = true
        await rpcInsert(ua, l, 4500)
      }
    })
    const r = await del(l, true)
    expect(r.status).toBe(409)
    expect(r.body).toMatchObject({ code: 'changed' })
    expect(await ledger(l)).toMatchObject({ deleted: false, actual_cost: 4500, budget_cost: 1000 })
    await ua.end()
  })

  it('確かめた直後に値が変わった（予算の更新）→ 409 changed', async () => {
    const p = await newProject()
    const l = await newLedger(p, null, '直後に予算', { budget_cost: 1000 })
    let done = false
    routeClient = hooked(await server.connect(), async sql => {
      if (isSoftDelete(sql) && !done) {
        done = true
        await admin.query('UPDATE cost_ledger_items SET budget_cost = 2000, updated_at = now() WHERE id = $1', [l])
      }
    })
    const r = await del(l, true)
    expect(r.status).toBe(409)
    expect(await ledger(l)).toMatchObject({ deleted: false, budget_cost: 2000 })
  })
})
