/**
 * KI-002 PR-2: AI チャットの見積操作・工程管理で、他社・別案件・削除済み・存在しない工種（見積グループ）を
 * 指定できないことの DB 検証。
 *
 * 実行: npm run test:db
 *   隔離されたローカル PostgreSQL（embedded-postgres）にリポジトリの全 migration を適用し、
 *   実際の API ルートを「ログイン済みユーザー（authenticated + RLS）」として動かす。本番・Preview の DB には接続しない。
 *
 * 前提（DB にはまだ制約が無い）: estimate_items.group_id / schedule_items.estimate_group_id の外部キー検査は
 *   RLS を通らないため、API が確かめないと他社・別案件の工種を参照する行を作れる（DB 側の制約は PR-3 / PR-4）。
 */

import { randomUUID } from 'node:crypto'
import type { Client } from 'pg'
import { NextRequest } from 'next/server'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { startLocalPostgres, type LocalPostgres } from './helpers/local-postgres'
import { applyFullSchema } from './helpers/full-schema'
import { pgSupabase } from './helpers/pg-supabase'
import { calculateSellingPrice } from '@/lib/estimate/pricing'

let server: LocalPostgres
let admin: Client
let currentUser: string | undefined

vi.mock('@/lib/supabase/server', () => ({
  getServerClient: async () => pgSupabase(admin, currentUser),
}))

const COMPANY_A = randomUUID()
const COMPANY_B = randomUUID()
const USER_A = randomUUID()
const USER_B = randomUUID()

const PA1 = randomUUID()        // A社・操作対象の案件（掛け率 1.3）
const PA2 = randomUUID()        // A社・別案件
const PA_DEL = randomUUID()     // A社・削除済み案件
const PB = randomUUID()         // B社の案件

const GA1 = randomUUID()        // PA1 の工種
const GA1B = randomUUID()       // PA1 の別の工種
const GA1_DEL = randomUUID()    // PA1 の削除済み工種
const GA2 = randomUUID()        // A社・別案件（PA2）の工種
const GB = randomUUID()         // B社の工種
const G_MISSING = randomUUID()

const IA1 = randomUUID()        // PA1 の見積項目（工種 GA1）
const IA_DEL_PROJECT = randomUUID() // 削除済み案件の見積項目
const IB = randomUUID()         // B社の見積項目

const SA1 = randomUUID()        // PA1 の工程
const SA_DEL_PROJECT = randomUUID()
const SB = randomUUID()         // B社の工程

const SECRET_B = 'B社の秘密案件'

/** 他社・別案件・削除済み・存在しない工種（すべて 404） */
const FOREIGN_GROUPS: Array<[string, string]> = [
  ['他社の工種', GB],
  ['同じ会社の別案件の工種', GA2],
  ['削除済みの工種', GA1_DEL],
  ['存在しない工種', G_MISSING],
]

/** 不正な形式（すべて 400） */
const MALFORMED_GROUPS: Array<[string, unknown]> = [
  ['UUID でない文字列', 'not-a-uuid'],
  ['数値', 123],
  ['オブジェクト', { id: GA1 }],
]

/** 利用者に返してはいけない内部情報（DB のエラー文・制約名・他社の名前・ID） */
const LEAK = new RegExp(`violates|constraint|relation|syntax|invalid input|column|B社|${COMPANY_A}|${COMPANY_B}|${PB}|${GB}`)

async function count(table: string): Promise<number> {
  return Number((await admin.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n)
}

async function snapshot(table: string): Promise<string> {
  const { rows } = await admin.query(`SELECT * FROM ${table} ORDER BY id`)
  return JSON.stringify(rows)
}

async function rowOf(table: string, id: string) {
  return (await admin.query(`SELECT * FROM ${table} WHERE id = $1`, [id])).rows[0]
}

function post(url: string, body: unknown) {
  return new NextRequest(`http://localhost${url}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
}

async function confirm(change: Record<string, unknown>) {
  const { POST } = await import('@/app/api/ai/chat/confirm-change/route')
  return POST(post('/api/ai/chat/confirm-change', { change: { id: 'c', target_table: 'estimate_items', ...change } }))
}

async function createSchedule(body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/schedule-items/route')
  return POST(post('/api/schedule-items', { project_id: PA1, name: '工程', ...body }))
}

async function patchSchedule(id: string, body: Record<string, unknown>) {
  const { PATCH } = await import('@/app/api/schedule-items/[id]/route')
  const req = new NextRequest(`http://localhost/api/schedule-items/${id}`, { method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
  return PATCH(req, { params: Promise.resolve({ id }) })
}

/** 拒否されたこと・内部情報を返していないこと・表が1行も変わっていないことを確かめる */
async function expectRejected(table: string, status: number, call: () => Promise<Response>) {
  const before = await snapshot(table)
  const res = await call()
  const body = await res.json()
  expect(res.status, JSON.stringify(body)).toBe(status)
  expect(body.ok).toBeUndefined()
  expect(JSON.stringify(body)).not.toMatch(LEAK)
  expect(await snapshot(table)).toBe(before)
  return body
}

beforeAll(async () => {
  server = await startLocalPostgres()
  admin = await server.connect()
  await applyFullSchema(admin)
  await admin.query('INSERT INTO auth.users (id) VALUES ($1), ($2)', [USER_A, USER_B])
  await admin.query('INSERT INTO companies (id, name) VALUES ($1, $2), ($3, $4)', [COMPANY_A, 'A社', COMPANY_B, 'B社'])
  await admin.query('INSERT INTO company_members (company_id, user_id, role) VALUES ($1, $2, $3), ($4, $5, $3)', [COMPANY_A, USER_A, 'owner', COMPANY_B, USER_B])
  await admin.query(
    `INSERT INTO projects (id, company_id, name, status, markup_rate, deleted_at) VALUES
       ($1, $5, 'A社の案件', 'collecting', 1.3, NULL),
       ($2, $5, 'A社の別案件', 'collecting', 1.45, NULL),
       ($3, $5, 'A社の削除済み案件', 'collecting', 1.45, now()),
       ($4, $6, $7, 'collecting', 1.45, NULL)`,
    [PA1, PA2, PA_DEL, PB, COMPANY_A, COMPANY_B, SECRET_B],
  )
  await admin.query(
    `INSERT INTO estimate_groups (id, company_id, project_id, label, sort_order, deleted_at) VALUES
       ($1, $6, $7, '解体', 0, NULL),
       ($2, $6, $7, '内装', 1, NULL),
       ($3, $6, $7, '削除済み', 2, now()),
       ($4, $6, $8, '別案件の工種', 0, NULL),
       ($5, $9, $10, 'B社の工種', 0, NULL)`,
    [GA1, GA1B, GA1_DEL, GA2, GB, COMPANY_A, PA1, PA2, COMPANY_B, PB],
  )
  await admin.query(
    `INSERT INTO estimate_items (id, company_id, project_id, group_id, name, quantity, unit, cost_price, selling_price) VALUES
       ($1, $4, $5, $6, '解体工事', 1, '式', 100000, 150000),
       ($2, $4, $7, NULL, '削除済み案件の項目', 1, '式', 1, 1),
       ($3, $8, $9, $10, 'B社の項目', 1, '式', 1, 1)`,
    [IA1, IA_DEL_PROJECT, IB, COMPANY_A, PA1, GA1, PA_DEL, COMPANY_B, PB, GB],
  )
  await admin.query(
    `INSERT INTO schedule_items (id, company_id, project_id, name, estimate_group_id, sort_order) VALUES
       ($1, $4, $5, '解体', $6, 0),
       ($2, $4, $7, '削除済み案件の工程', NULL, 0),
       ($3, $8, $9, 'B社の工程', $10, 0)`,
    [SA1, SA_DEL_PROJECT, SB, COMPANY_A, PA1, GA1, PA_DEL, COMPANY_B, PB, GB],
  )
}, 180_000)

afterAll(async () => {
  await server?.stop()
})

beforeEach(() => {
  currentUser = USER_A
})

// ─────────────────────────────────────────────────────────────────────────────
// AI チャット: estimate_items create
// ─────────────────────────────────────────────────────────────────────────────

describe('confirm-change estimate_items create', () => {
  const create = (proposed: Record<string, unknown>) =>
    confirm({ change_type: 'create', proposed: { project_id: PA1, name: '追加項目', quantity: 2, unit: '式', ...proposed } })

  it('同じ案件の工種を指定すると、その工種に登録される（売価は案件の掛け率で自動計算・従来どおり）', async () => {
    const res = await create({ group_id: GA1, cost_price: 1000 })
    const body = await res.json()
    expect(res.status, JSON.stringify(body)).toBe(200)
    expect(body.ok).toBe(true)
    const row = await rowOf('estimate_items', body.data.id)
    expect(row).toMatchObject({ company_id: COMPANY_A, project_id: PA1, group_id: GA1, selling_price_mode: 'auto' })
    expect(Number(row.selling_price)).toBe(calculateSellingPrice(1000, 1.3))
  })

  it('工種を省略・null にすると未分類で登録される（売価を明示すると手動・従来どおり）', async () => {
    for (const proposed of [{}, { group_id: null }]) {
      const res = await create({ ...proposed, selling_price: 5000, cost_price: 1000 })
      const body = await res.json()
      expect(res.status, JSON.stringify(body)).toBe(200)
      const row = await rowOf('estimate_items', body.data.id)
      expect(row).toMatchObject({ project_id: PA1, group_id: null, selling_price_mode: 'manual' })
      expect(Number(row.selling_price)).toBe(5000)
    }
  })

  it.each(FOREIGN_GROUPS)('%s は 404 で、何も登録しない', async (_l, groupId) => {
    const body = await expectRejected('estimate_items', 404, () => create({ group_id: groupId }))
    expect(body).toEqual({ error: 'Group not found' })
  })

  it.each(MALFORMED_GROUPS)('工種 ID が %s なら 400 で、何も登録しない', async (_l, groupId) => {
    await expectRejected('estimate_items', 400, () => create({ group_id: groupId }))
  })

  it('PR-1: 他社の案件・削除済み案件は引き続き 404', async () => {
    for (const projectId of [PB, PA_DEL]) {
      await expectRejected('estimate_items', 404, () => create({ project_id: projectId, group_id: null }))
    }
  })

  it('数量に数値でない値を入れると 400 で、DB のエラー文を返さない', async () => {
    await expectRejected('estimate_items', 400, () => create({ quantity: 'たくさん' }))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AI チャット: estimate_items bulk_create（他案件からのコピー）
// ─────────────────────────────────────────────────────────────────────────────

describe('confirm-change estimate_items bulk_create', () => {
  const items = [
    { name: 'コピー1', quantity: 1, unit: '式', selling_price: 2000, cost_price: 1000 },
    { name: 'コピー2', quantity: 3, unit: 'm2', cost_price: 1000 },
  ]
  const bulk = (proposed: Record<string, unknown>) =>
    confirm({ change_type: 'bulk_create', proposed: { project_id: PA1, target_group_id: GA1, items, ...proposed } })

  it('追加先に同じ案件の工種を指定すると、全行がその工種に登録される（売価の扱いは従来どおり）', async () => {
    const before = await count('estimate_items')
    const res = await bulk({})
    const body = await res.json()
    expect(res.status, JSON.stringify(body)).toBe(200)
    expect(body.inserted_count).toBe(2)
    expect(await count('estimate_items')).toBe(before + 2)
    const { rows } = await admin.query(
      `SELECT name, company_id, project_id, group_id, selling_price, selling_price_mode FROM estimate_items WHERE id = ANY($1) ORDER BY sort_order`,
      [body.data.map((d: { id: string }) => d.id)],
    )
    expect(rows.map(r => ({ ...r, selling_price: Number(r.selling_price) }))).toEqual([
      { name: 'コピー1', company_id: COMPANY_A, project_id: PA1, group_id: GA1, selling_price: 2000, selling_price_mode: 'manual' },
      { name: 'コピー2', company_id: COMPANY_A, project_id: PA1, group_id: GA1, selling_price: calculateSellingPrice(1000, 1.3), selling_price_mode: 'auto' },
    ])
  })

  it('追加先が null なら未分類。各行の group_id は追加先で上書きされる（従来どおり）', async () => {
    const res = await bulk({ target_group_id: null, items: [{ ...items[0], group_id: GA1B }] })
    const body = await res.json()
    expect(res.status, JSON.stringify(body)).toBe(200)
    expect((await rowOf('estimate_items', body.data[0].id)).group_id).toBeNull()
  })

  it.each(FOREIGN_GROUPS)('追加先が %s なら 404 で、1件も登録しない', async (_l, groupId) => {
    await expectRejected('estimate_items', 404, () => bulk({ target_group_id: groupId }))
  })

  it.each(FOREIGN_GROUPS)('行の中に %s を含むと 404 で、他の正常な行も登録しない', async (_l, groupId) => {
    await expectRejected('estimate_items', 404, () => bulk({ items: [items[0], { ...items[1], group_id: groupId }] }))
  })

  it.each(MALFORMED_GROUPS)('追加先・行の工種 ID が %s なら 400 で、1件も登録しない', async (_l, groupId) => {
    await expectRejected('estimate_items', 400, () => bulk({ target_group_id: groupId }))
    await expectRejected('estimate_items', 400, () => bulk({ items: [items[0], { ...items[1], group_id: groupId }] }))
  })

  it('行がオブジェクトでなければ 400 で、1件も登録しない', async () => {
    await expectRejected('estimate_items', 400, () => bulk({ items: [items[0], 'not-an-item'] }))
    await expectRejected('estimate_items', 400, () => bulk({ items: [items[0], null] }))
  })

  it('PR-1: 他社の案件・削除済み案件へのコピーは引き続き 404', async () => {
    for (const projectId of [PB, PA_DEL]) {
      await expectRejected('estimate_items', 404, () => bulk({ project_id: projectId, target_group_id: null }))
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AI チャット: estimate_items update
// ─────────────────────────────────────────────────────────────────────────────

describe('confirm-change estimate_items update', () => {
  const update = (proposed: Record<string, unknown>) => confirm({ change_type: 'update', proposed: { id: IA1, ...proposed } })

  it('同じ案件の別の工種へ移動・名前の変更ができ、null で未分類に戻せる', async () => {
    let res = await update({ name: '解体工事（改）', group_id: GA1B })
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200)
    expect(await rowOf('estimate_items', IA1)).toMatchObject({ name: '解体工事（改）', group_id: GA1B, project_id: PA1 })

    res = await update({ group_id: null })
    expect(res.status).toBe(200)
    expect((await rowOf('estimate_items', IA1)).group_id).toBeNull()

    res = await update({ group_id: GA1, quantity: 2 })
    expect(res.status).toBe(200)
    const row = await rowOf('estimate_items', IA1)
    expect(row).toMatchObject({ group_id: GA1 })
    // amount は生成列（quantity × selling_price）。売価は変えない（従来どおり）
    expect(Number(row.selling_price)).toBe(150000)
    expect(Number(row.amount)).toBe(300000)
  })

  it('工種を変えない更新はそのまま成功する', async () => {
    const res = await update({ memo: 'メモ' })
    expect(res.status).toBe(200)
    expect(await rowOf('estimate_items', IA1)).toMatchObject({ memo: 'メモ', group_id: GA1 })
  })

  it.each(FOREIGN_GROUPS)('移動先が %s なら 404 で、項目は変わらない', async (_l, groupId) => {
    await expectRejected('estimate_items', 404, () => update({ name: '書き換え', group_id: groupId }))
  })

  it.each(MALFORMED_GROUPS)('移動先の工種 ID が %s なら 400 で、項目は変わらない', async (_l, groupId) => {
    await expectRejected('estimate_items', 400, () => update({ name: '書き換え', group_id: groupId }))
  })

  it('他社の見積項目は 404 で、変わらない（工種を指定しなくても）', async () => {
    await expectRejected('estimate_items', 404, () => update({ id: IB, name: '乗っ取り' }))
    await expectRejected('estimate_items', 404, () => update({ id: IB, name: '乗っ取り', group_id: GB }))
  })

  it('削除済み案件の見積項目・存在しない項目は 404', async () => {
    await expectRejected('estimate_items', 404, () => update({ id: IA_DEL_PROJECT, name: '書き換え' }))
    await expectRejected('estimate_items', 404, () => update({ id: randomUUID(), name: '書き換え' }))
  })

  it('項目 ID が UUID でなければ 400', async () => {
    await expectRejected('estimate_items', 400, () => update({ id: 'not-a-uuid', name: '書き換え' }))
  })

  it('proposed の project_id / company_id は使わない（更新先・所属は DB の行のまま）', async () => {
    const res = await update({ name: '解体工事', project_id: PB, company_id: COMPANY_B })
    expect(res.status).toBe(200)
    expect(await rowOf('estimate_items', IA1)).toMatchObject({ name: '解体工事', project_id: PA1, company_id: COMPANY_A })
    // 案件・会社を他社のものと偽っても、他社の工種へは移せない
    await expectRejected('estimate_items', 404, () => update({ project_id: PB, company_id: COMPANY_B, group_id: GB }))
  })

  it('数量に数値でない値を入れると 400 で、DB のエラー文を返さない', async () => {
    await expectRejected('estimate_items', 400, () => update({ quantity: 'たくさん' }))
  })
})

describe('confirm-change のリクエスト形式', () => {
  it('JSON でない・change / proposed がオブジェクトでない場合は 400 で、何も書き込まない', async () => {
    const { POST } = await import('@/app/api/ai/chat/confirm-change/route')
    const raw = (body: string) => POST(new NextRequest('http://localhost/api/ai/chat/confirm-change', { method: 'POST', body, headers: { 'content-type': 'application/json' } }))
    await expectRejected('estimate_items', 400, () => raw('{not json'))
    await expectRejected('estimate_items', 400, () => raw('null'))
    await expectRejected('estimate_items', 400, () => raw(JSON.stringify({ change: 'x' })))
    await expectRejected('estimate_items', 400, () => raw(JSON.stringify({ change: { target_table: 'estimate_items', change_type: 'create', proposed: null } })))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 工程管理: POST /api/schedule-items
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /api/schedule-items', () => {
  it('同じ案件の工種・未指定・null は従来どおり登録できる', async () => {
    for (const [body, group] of [[{ estimate_group_id: GA1 }, GA1], [{}, null], [{ estimate_group_id: null }, null]] as const) {
      const res = await createSchedule(body)
      const json = await res.json()
      expect(res.status, JSON.stringify(json)).toBe(201)
      expect(await rowOf('schedule_items', json.id)).toMatchObject({ company_id: COMPANY_A, project_id: PA1, estimate_group_id: group })
    }
  })

  it.each(FOREIGN_GROUPS)('%s は 404 で、何も登録しない', async (_l, groupId) => {
    const body = await expectRejected('schedule_items', 404, () => createSchedule({ estimate_group_id: groupId }))
    expect(body).toEqual({ error: 'Group not found' })
  })

  it.each(MALFORMED_GROUPS)('工種 ID が %s なら 400 で、何も登録しない', async (_l, groupId) => {
    await expectRejected('schedule_items', 400, () => createSchedule({ estimate_group_id: groupId }))
  })

  it('他社の案件・削除済み案件は引き続き 404', async () => {
    await expectRejected('schedule_items', 404, () => createSchedule({ project_id: PB, estimate_group_id: GB }))
    await expectRejected('schedule_items', 404, () => createSchedule({ project_id: PA_DEL }))
  })

  it('日付の形式が不正でも DB のエラー文を返さない', async () => {
    await expectRejected('schedule_items', 500, () => createSchedule({ start_date: 'あした' }))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 工程管理: PATCH /api/schedule-items/[id]
// ─────────────────────────────────────────────────────────────────────────────

describe('PATCH /api/schedule-items/[id]', () => {
  it('同じ案件の別の工種へ変更・null で紐付け解除・工種以外の通常編集ができる', async () => {
    let res = await patchSchedule(SA1, { estimate_group_id: GA1B })
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200)
    expect((await rowOf('schedule_items', SA1)).estimate_group_id).toBe(GA1B)

    res = await patchSchedule(SA1, { estimate_group_id: null })
    expect(res.status).toBe(200)
    expect((await rowOf('schedule_items', SA1)).estimate_group_id).toBeNull()

    res = await patchSchedule(SA1, { estimate_group_id: GA1 })
    expect(res.status).toBe(200)
    res = await patchSchedule(SA1, { name: '解体（変更）', start_date: '2026-11-01', end_date: '2026-11-03', status: 'confirmed' })
    expect(res.status).toBe(200)
    const { rows } = await admin.query(
      `SELECT name, start_date::text AS start_date, end_date::text AS end_date, status, estimate_group_id FROM schedule_items WHERE id = $1`, [SA1],
    )
    expect(rows[0]).toEqual({
      name: '解体（変更）', start_date: '2026-11-01', end_date: '2026-11-03', status: 'confirmed', estimate_group_id: GA1,
    })
  })

  it.each(FOREIGN_GROUPS)('%s へは変更できず 404 で、工程は変わらない', async (_l, groupId) => {
    await expectRejected('schedule_items', 404, () => patchSchedule(SA1, { name: '書き換え', estimate_group_id: groupId }))
  })

  it.each(MALFORMED_GROUPS)('工種 ID が %s なら 400 で、工程は変わらない', async (_l, groupId) => {
    await expectRejected('schedule_items', 400, () => patchSchedule(SA1, { name: '書き換え', estimate_group_id: groupId }))
  })

  it('他社の工程・削除済み案件の工程・存在しない工程は 404 で、変わらない', async () => {
    await expectRejected('schedule_items', 404, () => patchSchedule(SB, { name: '乗っ取り' }))
    await expectRejected('schedule_items', 404, () => patchSchedule(SB, { estimate_group_id: GB }))
    await expectRejected('schedule_items', 404, () => patchSchedule(SA_DEL_PROJECT, { name: '書き換え' }))
    await expectRejected('schedule_items', 404, () => patchSchedule(randomUUID(), { name: '書き換え' }))
    await expectRejected('schedule_items', 404, () => patchSchedule('not-a-uuid', { name: '書き換え' }))
  })

  it('B社の利用者からも A社の工程は 404', async () => {
    currentUser = USER_B
    await expectRejected('schedule_items', 404, () => patchSchedule(SA1, { estimate_group_id: GB }))
  })
})
