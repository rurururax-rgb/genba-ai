/**
 * 過去見積の横断検索（GET /api/estimate-items/search-past）の DB 検証。
 *
 * 実行: npm run test:db
 *   隔離されたローカル PostgreSQL にリポジトリの全 migration を適用し、実際の API ルートを
 *   「ログイン済みユーザー（authenticated + RLS）」として動かす。本番・Preview の DB には接続しない。
 *
 * 確かめること: 他社の明細を返さない／削除済みの明細・案件を除く／見出し・メモ行を除く／
 *   削除済み・別案件の工種名を出さない／開いている案件を除く／LIKE の特殊文字をそのまま探す／
 *   件数の上限／コピー後の売価（copy_preview）／DB を 1 行も書き換えない。
 */

import { randomUUID } from 'node:crypto'
import type { Client } from 'pg'
import { NextRequest } from 'next/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { startLocalPostgres, type LocalPostgres } from './helpers/local-postgres'
import { applyFullSchema } from './helpers/full-schema'
import { pgSupabase } from './helpers/pg-supabase'

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
const USER_NONE = randomUUID()   // どの会社にも属さない

const PA_OPEN = randomUUID()     // A社・開いている案件（掛け率 1.3）
const PA_PAST = randomUUID()     // A社・過去案件
const PA_PAST2 = randomUUID()    // A社・別の過去案件
const PA_DEL = randomUUID()      // A社・削除済み案件
const PB = randomUUID()          // B社の案件

const GA_PAST = randomUUID()     // PA_PAST の工種
const GA_PAST_DEL = randomUUID() // PA_PAST の削除済み工種
const GB = randomUUID()          // B社の工種

const I_PAST_AUTO = randomUUID()
const I_PAST_MANUAL0 = randomUUID()
const I_PAST_NOCOST = randomUUID()
const I_PAST_DELGROUP = randomUUID()
const I_PAST_DELETED = randomUUID()
const I_PAST_HEADER = randomUUID()
const I_PAST_NOTE = randomUUID()
const I_PAST_NULLTYPE = randomUUID()
const I_PAST2 = randomUUID()
const I_OPEN = randomUUID()
const I_DEL_PROJECT = randomUUID()
const I_B = randomUUID()
const I_PERCENT = randomUUID()
const I_PLAIN100 = randomUUID()

const SECRET_B = 'B社の秘密キッチン'

async function snapshotAll(): Promise<string> {
  const out: string[] = []
  for (const t of ['estimate_items', 'estimate_groups', 'projects']) {
    out.push(JSON.stringify((await admin.query(`SELECT * FROM ${t} ORDER BY id`)).rows))
  }
  return out.join('\n')
}

/** user: null = 未ログイン */
async function search(query: Record<string, string>, user: string | null = USER_A) {
  currentUser = user ?? undefined
  const { GET } = await import('@/app/api/estimate-items/search-past/route')
  const res = await GET(new NextRequest(`http://localhost/api/estimate-items/search-past?${new URLSearchParams(query)}`))
  return { status: res.status, body: await res.json() }
}

const ids = (body: { items: Array<{ id: string }> }) => body.items.map(i => i.id).sort()

beforeAll(async () => {
  server = await startLocalPostgres()
  admin = await server.connect()
  await applyFullSchema(admin)
  await admin.query('INSERT INTO auth.users (id) VALUES ($1), ($2), ($3)', [USER_A, USER_B, USER_NONE])
  await admin.query('INSERT INTO companies (id, name) VALUES ($1, $2), ($3, $4)', [COMPANY_A, 'A社', COMPANY_B, 'B社'])
  await admin.query('INSERT INTO company_members (company_id, user_id, role) VALUES ($1, $2, $3), ($4, $5, $3)', [COMPANY_A, USER_A, 'owner', COMPANY_B, USER_B])
  await admin.query(
    `INSERT INTO projects (id, company_id, name, status, markup_rate, deleted_at) VALUES
       ($1, $6, 'A社の開いている案件', 'estimating', 1.3, NULL),
       ($2, $6, 'A社の過去案件', 'done', 1.45, NULL),
       ($3, $6, 'A社の別の過去案件', 'done', 1.45, NULL),
       ($4, $6, 'A社の削除済み案件', 'done', 1.45, now()),
       ($5, $7, $8, 'done', 1.45, NULL)`,
    [PA_OPEN, PA_PAST, PA_PAST2, PA_DEL, PB, COMPANY_A, COMPANY_B, SECRET_B],
  )
  await admin.query(
    `INSERT INTO estimate_groups (id, company_id, project_id, label, sort_order, deleted_at) VALUES
       ($1, $4, $5, '住宅設備', 0, NULL),
       ($2, $4, $5, '削除済みの工種', 1, now()),
       ($3, $6, $7, 'B社の工種', 0, NULL)`,
    [GA_PAST, GA_PAST_DEL, GB, COMPANY_A, PA_PAST, COMPANY_B, PB],
  )
  const item = (
    id: string, company: string, project: string, group: string | null, name: string,
    extra: Partial<{ cost: number | null; selling: number | null; mode: string; rowType: string | null; deleted: boolean; createdAt: string }> = {},
  ) => admin.query(
    `INSERT INTO estimate_items (id, company_id, project_id, group_id, name, quantity, unit, cost_price, selling_price,
                                 selling_price_mode, row_type, memo, internal_memo, deleted_at, created_at)
     VALUES ($1, $2, $3, $4, $5, 1, '式', $6, $7, $8, $9, '他のお客様の備考', '社内メモ', $10, $11)`,
    [id, company, project, group, name, extra.cost === undefined ? 100000 : extra.cost, extra.selling === undefined ? 145000 : extra.selling,
      extra.mode ?? 'auto', extra.rowType === undefined ? 'item' : extra.rowType, extra.deleted ? new Date() : null,
      extra.createdAt ?? '2026-01-01T00:00:00Z'],
  )
  await item(I_PAST_AUTO, COMPANY_A, PA_PAST, GA_PAST, 'システムキッチン交換', { createdAt: '2026-03-01T00:00:00Z' })
  await item(I_PAST_MANUAL0, COMPANY_A, PA_PAST, GA_PAST, 'キッチン撤去（サービス）', { mode: 'manual', selling: 0, cost: 20000, createdAt: '2026-02-01T00:00:00Z' })
  await item(I_PAST_NOCOST, COMPANY_A, PA_PAST, null, 'キッチンパネル', { cost: null, selling: 50000 })
  await item(I_PAST_DELGROUP, COMPANY_A, PA_PAST, GA_PAST_DEL, 'キッチン水栓')
  await item(I_PAST_DELETED, COMPANY_A, PA_PAST, GA_PAST, 'キッチン削除済み明細', { deleted: true })
  await item(I_PAST_HEADER, COMPANY_A, PA_PAST, GA_PAST, '【キッチン工事】', { rowType: 'header', cost: null, selling: null })
  await item(I_PAST_NOTE, COMPANY_A, PA_PAST, GA_PAST, 'キッチンは既存撤去後に採寸', { rowType: 'note', cost: null, selling: null })
  await item(I_PAST_NULLTYPE, COMPANY_A, PA_PAST, GA_PAST, 'キッチン換気扇', { rowType: null })
  await item(I_PAST2, COMPANY_A, PA_PAST2, null, 'キッチン床補修')
  await item(I_OPEN, COMPANY_A, PA_OPEN, null, 'キッチン開いている案件の明細')
  await item(I_DEL_PROJECT, COMPANY_A, PA_DEL, null, 'キッチン削除済み案件の明細')
  await item(I_B, COMPANY_B, PB, GB, SECRET_B)
  await item(I_PERCENT, COMPANY_A, PA_PAST, null, '値引き10%_特別')
  await item(I_PLAIN100, COMPANY_A, PA_PAST, null, '値引き10x特別')
})

afterAll(async () => {
  await admin?.end()
  await server?.stop()
})

const A_KITCHEN_VISIBLE = [I_PAST_AUTO, I_PAST_MANUAL0, I_PAST_NOCOST, I_PAST_DELGROUP, I_PAST_NULLTYPE, I_PAST2, I_OPEN].sort()

describe('GET /api/estimate-items/search-past', () => {
  it('自社の未削除案件・未削除明細だけを返す（他社・削除済み・見出し・メモ行は除く）', async () => {
    const { status, body } = await search({ q: 'キッチン' })
    expect(status).toBe(200)
    expect(ids(body)).toEqual(A_KITCHEN_VISIBLE)
    expect(JSON.stringify(body)).not.toMatch(new RegExp(`B社|${COMPANY_B}|${PB}|${GB}|${I_B}`))
  })

  it('B社の利用者は A社の明細を取得できない（逆方向）', async () => {
    const { status, body } = await search({ q: 'キッチン' }, USER_B)
    expect(status).toBe(200)
    expect(ids(body)).toEqual([I_B])
  })

  it('B社の利用者が A社の案件を project_id に指定すると 404（存在を漏らさない）', async () => {
    const { status, body } = await search({ q: 'キッチン', project_id: PA_OPEN }, USER_B)
    expect(status).toBe(404)
    expect(body.items).toBeUndefined()
  })

  it('削除済み・存在しない案件を project_id に指定すると 404', async () => {
    expect((await search({ q: 'キッチン', project_id: PA_DEL })).status).toBe(404)
    expect((await search({ q: 'キッチン', project_id: randomUUID() })).status).toBe(404)
  })

  it('project_id を渡すとその案件の明細を除き、copy_preview を付ける', async () => {
    const { status, body } = await search({ q: 'キッチン', project_id: PA_OPEN })
    expect(status).toBe(200)
    expect(ids(body)).toEqual(A_KITCHEN_VISIBLE.filter(id => id !== I_OPEN))
    const byId = new Map(body.items.map((i: { id: string }) => [i.id, i]))
    // auto: 原価 100,000 × 開いている案件の掛け率 1.3
    expect(byId.get(I_PAST_AUTO)).toMatchObject({
      copy_preview: { basis: 'auto_recalculated', past_selling_price: 145000, new_selling_price: 130000, difference: -15000, applied_markup_rate: 1.3 },
    })
    // manual 0 円はそのまま
    expect(byId.get(I_PAST_MANUAL0)).toMatchObject({
      selling_price_mode: 'manual',
      copy_preview: { basis: 'manual_kept', past_selling_price: 0, new_selling_price: 0, changed: false },
    })
    // 原価なしの auto は売価を作らない
    expect(byId.get(I_PAST_NOCOST)).toMatchObject({ copy_preview: { basis: 'no_cost', new_selling_price: null, past_selling_price: 50000 } })
  })

  it('project_id なしでは copy_preview を付けない', async () => {
    const { body } = await search({ q: 'システムキッチン' })
    expect(body.items).toHaveLength(1)
    expect(body.items[0].copy_preview).toBeUndefined()
  })

  it('案件名・工種名を返す。削除済みの工種名は出さず未分類にする', async () => {
    const { body } = await search({ q: 'キッチン' })
    const byId = new Map(body.items.map((i: { id: string }) => [i.id, i]))
    expect(byId.get(I_PAST_AUTO)).toMatchObject({ project: { id: PA_PAST, name: 'A社の過去案件', status: 'done' }, group: { id: GA_PAST, label: '住宅設備' } })
    expect(byId.get(I_PAST_DELGROUP)).toMatchObject({ group: null })
    expect(JSON.stringify(body)).not.toContain('削除済みの工種')
  })

  it('お客様向け備考・社内メモを返さない', async () => {
    const { body } = await search({ q: 'キッチン' })
    const text = JSON.stringify(body)
    expect(text).not.toContain('他のお客様の備考')
    expect(text).not.toContain('社内メモ')
    for (const i of body.items) {
      expect(i).not.toHaveProperty('memo')
      expect(i).not.toHaveProperty('internal_memo')
    }
  })

  it('空白区切りの語はすべて含むものだけ（AND）', async () => {
    const { body } = await search({ q: 'キッチン　交換' })
    expect(ids(body)).toEqual([I_PAST_AUTO])
  })

  it('% や _ はワイルドカードではなく文字として探す', async () => {
    const { body } = await search({ q: '10%_' })
    expect(ids(body)).toEqual([I_PERCENT])
    const { body: underscore } = await search({ q: '_' })
    expect(ids(underscore)).toEqual([I_PERCENT])
  })

  it('新しい順に並べ、limit 件で打ち切って has_more を返す', async () => {
    const { body } = await search({ q: 'キッチン', limit: '2' })
    expect(body.items.map((i: { id: string }) => i.id)).toEqual([I_PAST_AUTO, I_PAST_MANUAL0])
    expect(body.has_more).toBe(true)
  })

  it('一致なしは空配列', async () => {
    const { status, body } = await search({ q: '該当しない品名' })
    expect(status).toBe(200)
    expect(body).toEqual({ items: [], has_more: false })
  })

  it('入力の不正は 400（空・51 文字・6 語・limit 範囲外・project_id 形式違い）', async () => {
    const invalid: Array<Record<string, string>> = [{ q: '' }, { q: 'あ'.repeat(51) }, { q: 'a b c d e f' }, { q: '床', limit: '31' }, { q: '床', limit: '0' }, { q: '床', project_id: 'not-a-uuid' }]
    for (const q of invalid) {
      const { status } = await search(q)
      expect(status, JSON.stringify(q)).toBe(400)
    }
  })

  it('未ログインは 401、会社に属さない利用者は 403', async () => {
    expect((await search({ q: 'キッチン' }, null)).status).toBe(401)
    expect((await search({ q: 'キッチン' }, USER_NONE)).status).toBe(403)
  })

  it('検索しても DB を 1 行も書き換えない', async () => {
    const before = await snapshotAll()
    await search({ q: 'キッチン', project_id: PA_OPEN })
    await search({ q: 'キッチン' }, USER_B)
    expect(await snapshotAll()).toBe(before)
  })
})
