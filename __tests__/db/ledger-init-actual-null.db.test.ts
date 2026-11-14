/**
 * 「見積から初期化」（POST /api/cost-ledger/init）で、実績原価（actual_cost）を NULL（未集計）で始める。
 *
 * 実行: npm run test:db
 *   隔離されたローカル PostgreSQL（embedded-postgres）にリポジトリの全 migration を適用し、
 *   実際の API ルートをログイン済みユーザー（authenticated + RLS）として動かす。請求書は本番と同じ RPC（P1-2〜P1-4）で登録する。
 *   本番・Preview の DB には接続しない。
 *
 * 確かめること:
 *   - estimate_cost = 原価×数量、budget_cost = estimate_cost（従来どおり）、actual_cost = NULL
 *   - 請求粗利の集計は「未集計」（has_actual_data = false）。請求書を登録すると実績原価 = 請求書の合計、削除すると NULL に戻る
 *   - 0 円は NULL と区別する（入力済みとして数える）
 *   - 請求書がある行の実績原価は直接変更できない（実績ロック）。見積同期は実績原価・予算を変えない
 *   - エラー処理: 不正な JSON・project_id なし（400）、他社の案件（404）、初期化済み（409）、見積なし（422）、
 *     初期化済みかを確かめる読み取りの失敗（500・1 行も作らない）
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
/** API ルートが使う DB 接続（テストによって失敗を差し込む） */
let routeClient: Client
let currentUser: string | undefined

vi.mock('@/lib/supabase/server', () => ({
  getServerClient: async () => pgSupabase(routeClient, currentUser),
}))

const { POST: INIT } = await import('@/app/api/cost-ledger/init/route')
const { GET } = await import('@/app/api/cost-ledger/route')
const { PATCH } = await import('@/app/api/cost-ledger/[id]/route')
const { POST: SYNC } = await import('@/app/api/cost-ledger/sync/route')

const COMPANY_A = randomUUID()
const COMPANY_B = randomUUID()
const USER_A = randomUUID()
const USER_B = randomUUID()

async function userConnection(user: string): Promise<Client> {
  const c = await server.connect()
  await c.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [user])
  await c.query('SET ROLE authenticated')
  return c
}

async function newProject(companyId = COMPANY_A): Promise<string> {
  return (await admin.query('INSERT INTO projects (company_id) VALUES ($1) RETURNING id', [companyId])).rows[0].id
}

async function newEstimate(projectId: string, name: string, quantity: number, costPrice: number | null, sort = 0): Promise<string> {
  return (await admin.query(
    `INSERT INTO estimate_items (company_id, project_id, name, quantity, unit, cost_price, sort_order)
     VALUES ($1, $2, $3, $4, '式', $5, $6) RETURNING id`, [COMPANY_A, projectId, name, quantity, costPrice, sort])).rows[0].id
}

const post = (handler: (req: NextRequest) => Promise<Response>, url: string, body: string) =>
  handler(new NextRequest(url, { method: 'POST', body, headers: { 'content-type': 'application/json' } }))

async function init(projectId: string) {
  const res = await post(INIT, 'http://localhost/api/cost-ledger/init', JSON.stringify({ project_id: projectId }))
  return { status: res.status, body: await res.json() as { items?: Array<Record<string, unknown>>; error?: string } }
}

async function rows(projectId: string) {
  const { rows } = await admin.query(
    `SELECT id, name, estimate_cost::float8 AS estimate_cost, budget_cost::float8 AS budget_cost, actual_cost::float8 AS actual_cost
     FROM cost_ledger_items WHERE project_id = $1 AND deleted_at IS NULL ORDER BY sort_order, name`, [projectId])
  return rows as Array<{ id: string; name: string; estimate_cost: number | null; budget_cost: number | null; actual_cost: number | null }>
}

async function summary(projectId: string) {
  const res = await GET(new NextRequest(`http://localhost/api/cost-ledger?project_id=${projectId}`))
  expect(res.status).toBe(200)
  return (await res.json() as { summary: { actual_cost_total: number; has_actual_data: boolean; budget_cost_total: number } }).summary
}

async function patch(id: string, body: Record<string, unknown>) {
  const res = await PATCH(new NextRequest(`http://localhost/api/cost-ledger/${id}`, {
    method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  }), { params: Promise.resolve({ id }) })
  return { status: res.status, body: await res.json() as { code?: string; actual_cost?: number | null } }
}

/** 本物の接続に、特定の SQL の直前で処理を差し込む */
function hooked(real: Client, hook: (sql: string) => void): Client {
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'query') {
        return async (arg: string | { text: string }, params?: unknown[]) => {
          hook(typeof arg === 'string' ? arg : arg.text)
          return params === undefined ? target.query(arg as string) : target.query(arg as string, params)
        }
      }
      return Reflect.get(target, prop, receiver)
    },
  }) as Client
}

beforeAll(async () => {
  server = await startLocalPostgres()
  admin = await server.connect()
  await applyFullSchema(admin)
  await admin.query('INSERT INTO auth.users (id) VALUES ($1), ($2)', [USER_A, USER_B])
  await admin.query('INSERT INTO companies (id, name) VALUES ($1, $2), ($3, $4)', [COMPANY_A, 'A社', COMPANY_B, 'B社'])
  await admin.query('INSERT INTO company_members (company_id, user_id, role) VALUES ($1, $2, $3), ($4, $5, $3)',
    [COMPANY_A, USER_A, 'owner', COMPANY_B, USER_B])
}, 120000)

afterAll(async () => { await server?.stop() })

beforeEach(async () => {
  currentUser = USER_A
  routeClient = await server.connect()
})

describe('見積から初期化: 実績原価は NULL（未集計）で始める', () => {
  it('estimate_cost・budget_cost は従来どおり、actual_cost だけ NULL。原価のない行は 3 つとも NULL', async () => {
    const p = await newProject()
    await newEstimate(p, 'a 給湯器', 1, 197760, 0)
    await newEstimate(p, 'b クロス', 12.5, 660, 1)
    await newEstimate(p, 'c 原価なし', 1, null, 2)

    const { status, body } = await init(p)
    expect(status).toBe(201)
    expect(body.items).toHaveLength(3)
    for (const item of body.items ?? []) expect(item.actual_cost).toBeNull()

    expect(await rows(p)).toEqual([
      expect.objectContaining({ name: 'a 給湯器', estimate_cost: 197760, budget_cost: 197760, actual_cost: null }),
      expect.objectContaining({ name: 'b クロス', estimate_cost: 8250, budget_cost: 8250, actual_cost: null }),
      expect.objectContaining({ name: 'c 原価なし', estimate_cost: null, budget_cost: null, actual_cost: null }),
    ])

    // 請求粗利は未集計（業者請求 0 円の粗利率を出さない）。予算の集計は従来どおり
    expect(await summary(p)).toMatchObject({ has_actual_data: false, actual_cost_total: 0, budget_cost_total: 197760 + 8250 })
  })

  it('請求書を登録すると実績原価 = 請求書の合計、直接変更は拒否（実績ロック）、最後の請求書を削除すると NULL に戻る', async () => {
    const p = await newProject()
    await newEstimate(p, 'a 給湯器', 1, 197760)
    await init(p)
    const [item] = await rows(p)

    const ua = await userConnection(USER_A)
    const ins = await ua.query(`SELECT public.cost_ledger_invoice_insert(p_item_id => $1, p_amount => 200000::numeric, p_source => 'manual') AS r`, [item.id])
    expect((await rows(p))[0].actual_cost).toBe(200000)
    expect(await summary(p)).toMatchObject({ has_actual_data: true, actual_cost_total: 200000 })

    const locked = await patch(item.id, { actual_cost: 1 })
    expect(locked).toMatchObject({ status: 409, body: { code: 'actual_cost_locked' } })
    expect((await rows(p))[0].actual_cost).toBe(200000)

    const invoiceId = (ins.rows[0].r as { invoice: { id: string } }).invoice.id
    await ua.query('SELECT public.cost_ledger_invoice_delete($1)', [invoiceId])
    expect((await rows(p))[0].actual_cost).toBeNull()
    expect(await summary(p)).toMatchObject({ has_actual_data: false })
    await ua.end()
  })

  it('0 円は NULL と区別する（入力済みとして集計に入る）。NULL に戻すこともできる', async () => {
    const p = await newProject()
    await newEstimate(p, 'a', 1, 1000)
    await newEstimate(p, 'b', 1, 2000, 1)
    await init(p)
    const [a] = await rows(p)

    expect((await patch(a.id, { actual_cost: 0 })).status).toBe(200)
    expect((await rows(p))[0].actual_cost).toBe(0)
    expect(await summary(p)).toMatchObject({ has_actual_data: true, actual_cost_total: 0 })

    expect((await patch(a.id, { actual_cost: null })).status).toBe(200)
    expect((await rows(p))[0].actual_cost).toBeNull()
    expect(await summary(p)).toMatchObject({ has_actual_data: false })
  })

  it('見積同期は実績原価（NULL）と予算を変えない', async () => {
    const p = await newProject()
    const est = await newEstimate(p, 'a', 2, 1000)
    await init(p)
    await admin.query('UPDATE estimate_items SET cost_price = 1500 WHERE id = $1', [est])

    const res = await post(SYNC, 'http://localhost/api/cost-ledger/sync', JSON.stringify({ project_id: p }))
    expect(res.status).toBe(200)
    expect((await rows(p))[0]).toMatchObject({ estimate_cost: 3000, budget_cost: 2000, actual_cost: null })
  })
})

describe('初期化 API のエラー処理', () => {
  it('不正な JSON・project_id なし・文字列でない project_id は 400', async () => {
    expect((await post(INIT, 'http://localhost/api/cost-ledger/init', '{not json')).status).toBe(400)
    expect((await post(INIT, 'http://localhost/api/cost-ledger/init', '{}')).status).toBe(400)
    expect((await post(INIT, 'http://localhost/api/cost-ledger/init', JSON.stringify({ project_id: 123 }))).status).toBe(400)
  })

  it('他社の案件は 404 で、1 行も作らない', async () => {
    const pb = await newProject(COMPANY_B)
    await admin.query(`INSERT INTO estimate_items (company_id, project_id, name, quantity, cost_price) VALUES ($1, $2, 'b', 1, 100)`, [COMPANY_B, pb])
    expect((await init(pb)).status).toBe(404)
    expect(Number((await admin.query('SELECT count(*) FROM cost_ledger_items WHERE project_id = $1', [pb])).rows[0].count)).toBe(0)
  })

  it('初期化済みは 409（行は増えない）。見積がなければ 422', async () => {
    const p = await newProject()
    await newEstimate(p, 'a', 1, 1000)
    expect((await init(p)).status).toBe(201)
    expect((await init(p)).status).toBe(409)
    expect(await rows(p)).toHaveLength(1)

    expect((await init(await newProject())).status).toBe(422)
  })

  it('初期化済みかを確かめる読み取りが失敗したら 500 で止め、1 行も作らない', async () => {
    const p = await newProject()
    await newEstimate(p, 'a', 1, 1000)
    const real = await server.connect()
    routeClient = hooked(real, sql => {
      if (/^SELECT count\(\*\)::int AS n FROM "cost_ledger_items"/.test(sql)) throw Object.assign(new Error('injected'), { code: '57014' })
    })
    const { status } = await init(p)
    expect(status).toBe(500)
    expect(Number((await admin.query('SELECT count(*) FROM cost_ledger_items WHERE project_id = $1', [p])).rows[0].count)).toBe(0)
    await real.end()
  })
})
