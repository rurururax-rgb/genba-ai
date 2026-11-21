/**
 * 資材マスターから見積へ追加（GET /api/estimate-items/search-master・POST /api/estimate-items/add-from-master）の DB 検証。
 *
 * 実行: npm run test:db
 *   隔離されたローカル PostgreSQL にリポジトリの全 migration を適用し、実際の API ルートを
 *   「ログイン済みユーザー（authenticated + RLS）」として動かす。本番・Preview の DB には接続しない。データはすべて架空。
 *
 * fingerprint は検索 API から受け取り、検索 → 追加の流れで確かめる。
 */

import { randomUUID } from 'node:crypto'
import { types as pgTypes, type Client } from 'pg'
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
const USER_NONE = randomUUID()

const P_TARGET = randomUUID()   // A社・追加先（掛け率 1.3）
const P_OTHER = randomUUID()    // A社・別案件
const P_DEL = randomUUID()      // A社・削除済み案件
const P_B = randomUUID()        // B社の案件

const G_TARGET = randomUUID()
const G_TARGET_DEL = randomUUID()
const G_OTHER = randomUUID()
const G_B = randomUUID()

const M_PRICED = randomUUID()   // 原価・売価あり → manual
const M_COSTONLY = randomUUID() // 原価のみ → auto
const M_ZERO = randomUUID()     // 売価 0・原価あり → auto（取込と同じ）
const M_NONE = randomUUID()     // 原価・売価なし
const M_PCT = randomUUID()      // 品名に % を含む（エスケープ確認）
const M_B = randomUUID()        // B社の資材（品名は A社と同じ語を含む）

const T_1 = randomUUID()        // 追加先の工種の既存行（sort_order 5000）
const T_DEL = randomUUID()      // 削除済み（sort_order 99000。末尾の計算に含めない）
const T_UNGROUPED = randomUUID()

const SECRET_B = 'B社の秘密ユニットバス'

type Json = Record<string, unknown>

const NUMERIC_AS_NUMBER = {
  getTypeParser: (oid: number, format?: string) =>
    oid === 1700 ? (v: string) => Number(v) : pgTypes.getTypeParser(oid, format as 'text'),
}
async function rows(sql: string, params: unknown[] = []) {
  return (await admin.query({ text: sql, values: params, types: NUMERIC_AS_NUMBER })).rows
}
async function snapshot(): Promise<string> {
  return JSON.stringify(await rows('SELECT * FROM estimate_items ORDER BY id'))
    + JSON.stringify(await rows('SELECT * FROM company_estimate_items ORDER BY id'))
}
async function added(projectId = P_TARGET) {
  return rows(`SELECT * FROM estimate_items WHERE project_id = $1 AND source = 'master' ORDER BY sort_order, created_at`, [projectId])
}

async function search(params: Record<string, string>, user: string | null = USER_A) {
  currentUser = user ?? undefined
  const { GET } = await import('@/app/api/estimate-items/search-master/route')
  const res = await GET(new NextRequest(`http://localhost/api/estimate-items/search-master?${new URLSearchParams(params)}`))
  return { status: res.status, body: await res.json() as Json }
}

async function post(body: unknown, user: string | null = USER_A) {
  currentUser = user ?? undefined
  const { POST } = await import('@/app/api/estimate-items/add-from-master/route')
  const res = await POST(new NextRequest('http://localhost/api/estimate-items/add-from-master', {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  }))
  return { status: res.status, body: await res.json() as Json }
}

type Hit = { id: string; name: string; preview: { fingerprint: string; selling_price_mode: string; selling_price: number | null; cost_price: number | null; markup_rate: number } }

async function hit(id: string, projectId: string = P_TARGET, user: string = USER_A): Promise<Hit | undefined> {
  const r = await search({ project_id: projectId, q: '', limit: '50' }, user)
  return (r.body.items as Hit[] | undefined)?.find(h => h.id === id)
}

const DUMMY_FP = 'm1-00000000000000'

async function add(id: string, extra: Json = {}, user: string = USER_A) {
  const h = await hit(id, (extra.project_id as string | undefined) ?? P_TARGET, user)
  return post({
    project_id: P_TARGET,
    group_id: G_TARGET,
    master_item_id: id,
    fingerprint: h?.preview.fingerprint ?? DUMMY_FP,
    quantity: 2,
    cost_price: h?.preview.cost_price ?? null,
    selling_price_mode: h?.preview.selling_price_mode ?? 'auto',
    ...(h?.preview.selling_price_mode === 'manual' ? { selling_price: h.preview.selling_price } : {}),
    ...extra,
  }, user)
}

const LEAK = new RegExp(`violates|constraint|relation|syntax|column|B社|${COMPANY_B}|${P_B}|${G_B}|${M_B}`)

beforeAll(async () => {
  server = await startLocalPostgres()
  admin = await server.connect()
  await applyFullSchema(admin)
  await admin.query('INSERT INTO auth.users (id) VALUES ($1), ($2), ($3)', [USER_A, USER_B, USER_NONE])
  await admin.query('INSERT INTO companies (id, name) VALUES ($1, $2), ($3, $4)', [COMPANY_A, 'A社', COMPANY_B, 'B社'])
  await admin.query('INSERT INTO company_members (company_id, user_id, role) VALUES ($1, $2, $3), ($4, $5, $3)', [COMPANY_A, USER_A, 'owner', COMPANY_B, USER_B])
  await admin.query(
    `INSERT INTO projects (id, company_id, name, status, markup_rate, deleted_at) VALUES
       ($1, $5, '追加先の案件', 'estimating', 1.3, NULL),
       ($2, $5, '別案件', 'estimating', 1.5, NULL),
       ($3, $5, '削除済み案件', 'estimating', 1.45, now()),
       ($4, $6, 'B社の案件', 'estimating', 1.45, NULL)`,
    [P_TARGET, P_OTHER, P_DEL, P_B, COMPANY_A, COMPANY_B],
  )
  await admin.query(
    `INSERT INTO estimate_groups (id, company_id, project_id, label, sort_order, deleted_at) VALUES
       ($1, $5, $6, '設備', 0, NULL),
       ($2, $5, $6, '削除済みの工種', 1, now()),
       ($3, $5, $7, '別案件の工種', 0, NULL),
       ($4, $8, $9, 'B社の工種', 0, NULL)`,
    [G_TARGET, G_TARGET_DEL, G_OTHER, G_B, COMPANY_A, P_TARGET, P_OTHER, COMPANY_B, P_B],
  )
  await admin.query(
    `INSERT INTO estimate_items (id, project_id, company_id, group_id, name, sort_order, deleted_at) VALUES
       ($1, $4, $5, $6, '既存行', 5000, NULL),
       ($2, $4, $5, $6, '削除済みの行', 99000, now()),
       ($3, $4, $5, NULL, '未分類の既存行', 7, NULL)`,
    [T_1, T_DEL, T_UNGROUPED, P_TARGET, COMPANY_A, G_TARGET],
  )
  await admin.query(
    `INSERT INTO company_estimate_items (id, company_id, name, spec, unit, cost_price, selling_price, category, usage_count, memo, url) VALUES
       ($1, $7, 'ユニットバス 1616', 'TOTO サザナ HTV1616', '台', 600000, 900000, '設備', 10, '社内メモ', 'https://example.test/a'),
       ($2, $7, 'ユニットバス 1620（原価のみ）', NULL, '台', 650000, NULL, '設備', 5, NULL, NULL),
       ($3, $7, 'クロス張替', NULL, '㎡', 1000, 0, '内装', 3, NULL, NULL),
       ($4, $7, '諸経費', NULL, '式', NULL, NULL, NULL, 1, NULL, NULL),
       ($5, $7, '100%防水テープ', NULL, '巻', 500, NULL, NULL, 1, NULL, NULL),
       ($6, $8, $9, 'B社仕様', '台', 1, 2, '設備', 99, NULL, NULL)`,
    [M_PRICED, M_COSTONLY, M_ZERO, M_NONE, M_PCT, M_B, COMPANY_A, COMPANY_B, SECRET_B],
  )
}, 120_000)

afterAll(async () => {
  await server?.stop()
})

describe('検索（search-master）', () => {
  it('自社の資材だけを、よく使う順に返す。他社の資材は出ない（空の検索語は一覧）', async () => {
    const r = await search({ project_id: P_TARGET })
    expect(r.status).toBe(200)
    const items = r.body.items as Array<Json>
    // 使用回数の多い順。同じ回数は品名順
    expect(items.map(i => i.id)).toEqual([M_PRICED, M_COSTONLY, M_ZERO, M_PCT, M_NONE])
    expect(items).toHaveLength(5)
    expect(JSON.stringify(r.body)).not.toMatch(LEAK)
    // URL・メモは返さない
    expect(items[0]).not.toHaveProperty('url')
    expect(items[0]).not.toHaveProperty('memo')
    expect(r.body.markup_rate).toBe(1.3)
  })

  it('品名で絞り込む（空白区切りの AND）。B社の同じ語の資材は出ない', async () => {
    const r = await search({ project_id: P_TARGET, q: 'ユニットバス　1616' })
    expect((r.body.items as Json[]).map(i => i.id)).toEqual([M_PRICED])
    const b = await search({ project_id: P_TARGET, q: '秘密' })
    expect(b.body.items).toEqual([])
  })

  it('% はそのままの文字として検索する（ILIKE のワイルドカードにしない）', async () => {
    const r = await search({ project_id: P_TARGET, q: '%' })
    expect((r.body.items as Json[]).map(i => i.id)).toEqual([M_PCT])
  })

  it('初期値: 売価ありは manual（マスターの売価）、原価のみ・売価 0 は auto（原価 × 案件の掛け率 1.3）、両方なしは売価なし', async () => {
    const r = await search({ project_id: P_TARGET })
    const byId = new Map((r.body.items as Hit[]).map(h => [h.id, h.preview]))
    expect(byId.get(M_PRICED)).toMatchObject({ selling_price_mode: 'manual', cost_price: 600000, selling_price: 900000, markup_rate: 1.3 })
    expect(byId.get(M_COSTONLY)).toMatchObject({ selling_price_mode: 'auto', cost_price: 650000, selling_price: 845000 })
    expect(byId.get(M_ZERO)).toMatchObject({ selling_price_mode: 'auto', cost_price: 1000, selling_price: 1300 })
    expect(byId.get(M_NONE)).toMatchObject({ selling_price_mode: 'auto', cost_price: null, selling_price: null })
  })

  it('件数の上限と has_more', async () => {
    const r = await search({ project_id: P_TARGET, limit: '2' })
    expect(r.body.items).toHaveLength(2)
    expect(r.body.has_more).toBe(true)
  })

  it('案件: 他社・削除済み・存在しないは区別せず 404、不正な形式・未指定は 400。未ログイン 401・所属なし 403', async () => {
    for (const p of [P_B, P_DEL, randomUUID()]) {
      const r = await search({ project_id: p })
      expect(r.status).toBe(404)
      expect(JSON.stringify(r.body)).not.toMatch(LEAK)
    }
    expect((await search({ project_id: 'x' })).status).toBe(400)
    expect((await search({})).status).toBe(400)
    expect((await search({ project_id: P_TARGET, limit: '51' })).status).toBe(400)
    expect((await search({ project_id: P_TARGET, q: 'あ'.repeat(51) })).status).toBe(400)
    expect((await search({ project_id: P_TARGET }, null)).status).toBe(401)
    expect((await search({ project_id: P_TARGET }, USER_NONE)).status).toBe(403)
  })

  it('B社の利用者からは B社の資材だけが見える（A社の資材は出ない）', async () => {
    const r = await search({ project_id: P_B }, USER_B)
    expect((r.body.items as Json[]).map(i => i.id)).toEqual([M_B])
  })
})

describe('追加（add-from-master）: 正常系', () => {
  it('manual: マスターの売価で、工種の末尾（既存の最大 5000 + 1000）に 1 行追加。品名・単位・分類はマスターから', async () => {
    const before = await rows('SELECT id, sort_order FROM estimate_items WHERE project_id = $1 ORDER BY id', [P_TARGET])
    const r = await add(M_PRICED)
    expect(r.status).toBe(201)
    const [row] = await added()
    expect(row).toMatchObject({
      company_id: COMPANY_A, group_id: G_TARGET, sort_order: 6000, name: 'ユニットバス 1616', unit: '台', quantity: 2,
      cost_price: 600000, selling_price: 900000, selling_price_mode: 'manual', amount: 1800000, markup_rate_override: null,
      category: '設備', vendor_name: null, memo: null, internal_memo: null, row_type: 'item', source: 'master', line_event_id: null,
    })
    expect((r.body.item as Json).id).toBe(row.id)
    // 既存行の並びは変わらない
    const after = await rows('SELECT id, sort_order FROM estimate_items WHERE project_id = $1 AND id <> $2 ORDER BY id', [P_TARGET, row.id])
    expect(after).toEqual(before)
    await admin.query('DELETE FROM estimate_items WHERE id = $1', [row.id])
  })

  it('auto: 売価はサーバーが原価 × 案件の掛け率（1.3）で計算する。利用者が変えた原価で計算する', async () => {
    const r = await add(M_COSTONLY, { cost_price: 700000 })
    expect(r.status).toBe(201)
    const [row] = await added()
    expect(row).toMatchObject({ cost_price: 700000, selling_price: 910000, selling_price_mode: 'auto', quantity: 2 })
    await admin.query('DELETE FROM estimate_items WHERE id = $1', [row.id])
  })

  it('manual に切り替えて売価を入力（0 円も有効）。原価なしの auto は売価なしで追加される', async () => {
    const r1 = await add(M_COSTONLY, { selling_price_mode: 'manual', selling_price: 0 })
    expect(r1.status).toBe(201)
    const r2 = await add(M_NONE, { group_id: null, quantity: 1.5 })
    expect(r2.status).toBe(201)
    const got = await added()
    expect(got.find(g => g.name.startsWith('ユニットバス'))).toMatchObject({ selling_price: 0, selling_price_mode: 'manual', amount: 0 })
    // 未分類（その他）の末尾: 既存の最大 7 + 1000
    expect(got.find(g => g.name === '諸経費')).toMatchObject({ group_id: null, sort_order: 1007, selling_price: null, selling_price_mode: 'auto', quantity: 1.5 })
    await admin.query(`DELETE FROM estimate_items WHERE source = 'master'`)
  })

  it('資材マスターは更新しない（使用回数・最終使用日も変えない）', async () => {
    const before = JSON.stringify(await rows('SELECT * FROM company_estimate_items ORDER BY id'))
    expect((await add(M_PRICED)).status).toBe(201)
    expect(JSON.stringify(await rows('SELECT * FROM company_estimate_items ORDER BY id'))).toBe(before)
    await admin.query(`DELETE FROM estimate_items WHERE source = 'master'`)
  })
})

describe('追加（add-from-master）: 拒否（何も変わらない・他社の情報を返さない）', () => {
  it('他社の資材は 404（存在しない ID と区別しない）', async () => {
    const before = await snapshot()
    const fake = await search({ project_id: P_B, q: '' }, USER_B)
    const bFp = (fake.body.items as Hit[])[0].preview.fingerprint
    for (const id of [M_B, randomUUID()]) {
      const r = await post({ project_id: P_TARGET, group_id: G_TARGET, master_item_id: id, fingerprint: bFp, quantity: 1, cost_price: 1, selling_price_mode: 'auto' })
      expect(r.status).toBe(404)
      expect(r.body.reason).toBe('master_not_found')
      expect(JSON.stringify(r.body)).not.toMatch(LEAK)
    }
    expect(await snapshot()).toBe(before)
  })

  it('他社・削除済み・存在しない案件は 404。別案件・削除済み・他社の工種は 404', async () => {
    const before = await snapshot()
    for (const p of [P_B, P_DEL, randomUUID()]) {
      const r = await add(M_PRICED, { project_id: p, group_id: null })
      expect(r.status).toBe(404)
      expect(JSON.stringify(r.body)).not.toMatch(LEAK)
    }
    for (const g of [G_OTHER, G_TARGET_DEL, G_B, randomUUID()]) {
      const r = await add(M_PRICED, { group_id: g })
      expect(r.status).toBe(404)
      expect(JSON.stringify(r.body)).not.toMatch(LEAK)
    }
    expect(await snapshot()).toBe(before)
  })

  it('B社の利用者が A社の案件・資材を指定しても 404', async () => {
    const before = await snapshot()
    const fp = (await hit(M_PRICED))!.preview.fingerprint
    const r = await post({ project_id: P_TARGET, group_id: null, master_item_id: M_PRICED, fingerprint: fp, quantity: 1, cost_price: 1, selling_price_mode: 'auto' }, USER_B)
    expect(r.status).toBe(404)
    const r2 = await post({ project_id: P_B, group_id: G_B, master_item_id: M_PRICED, fingerprint: fp, quantity: 1, cost_price: 1, selling_price_mode: 'auto' }, USER_B)
    expect(r2.status).toBe(404)
    expect(await snapshot()).toBe(before)
  })

  it('マスターが変わった・案件の掛け率が変わった・別案件の fingerprint は 409 で、いまの内容と初期値を返す', async () => {
    const before = await snapshot()
    const fp = (await hit(M_COSTONLY))!.preview.fingerprint
    const base = { project_id: P_TARGET, group_id: G_TARGET, master_item_id: M_COSTONLY, fingerprint: fp, quantity: 1, cost_price: 650000, selling_price_mode: 'auto' }

    await admin.query('UPDATE company_estimate_items SET cost_price = 680000 WHERE id = $1', [M_COSTONLY])
    const r1 = await post(base)
    expect(r1.status).toBe(409)
    expect(r1.body.item).toMatchObject({ id: M_COSTONLY, cost_price: 680000, preview: { selling_price: 884000, selling_price_mode: 'auto' } })
    await admin.query('UPDATE company_estimate_items SET cost_price = 650000 WHERE id = $1', [M_COSTONLY])

    await admin.query('UPDATE projects SET markup_rate = 1.4 WHERE id = $1', [P_TARGET])
    const r2 = await post(base)
    expect(r2.status).toBe(409)
    expect(r2.body.item).toMatchObject({ preview: { markup_rate: 1.4, selling_price: 910000 } })
    await admin.query('UPDATE projects SET markup_rate = 1.3 WHERE id = $1', [P_TARGET])

    // 別案件（掛け率 1.5）の検索結果の fingerprint では追加できない
    const otherFp = (await hit(M_COSTONLY, P_OTHER))!.preview.fingerprint
    expect((await post({ ...base, fingerprint: otherFp })).status).toBe(409)

    expect((await post(base)).status).toBe(201) // 元に戻れば通る
    await admin.query(`DELETE FROM estimate_items WHERE source = 'master'`)
    expect(await snapshot()).toBe(before)
  })

  it('入力の検証: 想定外のキー（会社・品名・並び順・source など）、数量・金額の範囲、売価の決め方は 400', async () => {
    const before = await snapshot()
    const fp = (await hit(M_PRICED))!.preview.fingerprint
    const base = { project_id: P_TARGET, group_id: G_TARGET, master_item_id: M_PRICED, fingerprint: fp, quantity: 1, cost_price: 1, selling_price_mode: 'manual', selling_price: 2 }
    const cases: unknown[] = [
      { ...base, company_id: COMPANY_B },
      { ...base, name: '改ざん' },
      { ...base, sort_order: 0 },
      { ...base, source: 'manual' },
      { ...base, quantity: 0 },
      { ...base, quantity: -1 },
      { ...base, quantity: '1' },
      { ...base, quantity: 1e7 },
      { ...base, cost_price: -1 },
      { ...base, cost_price: 1e10 },
      { ...base, selling_price: null },
      { ...base, selling_price: -5 },
      { ...base, selling_price_mode: 'auto' },          // auto で売価を送った
      { ...base, selling_price_mode: 'fixed' },
      { ...base, fingerprint: 'v1-0000' },
      { ...base, master_item_id: 'x' },
      Object.fromEntries(Object.entries(base).filter(([k]) => k !== 'group_id')),
      [],
      null,
    ]
    for (const c of cases) {
      const r = await post(c)
      expect(r.status, JSON.stringify(c)).toBe(400)
    }
    expect((await post(base, null)).status).toBe(401)
    expect((await post(base, USER_NONE)).status).toBe(403)
    expect(await snapshot()).toBe(before)
  })
})

describe('既存の機能に影響しない', () => {
  it('資材マスター画面の GET /api/material-master は従来どおり自社の資材を返す', async () => {
    currentUser = USER_A
    const { GET } = await import('@/app/api/material-master/route')
    const res = await GET(new NextRequest('http://localhost/api/material-master'))
    const body = await res.json() as { data: Json[] }
    expect(res.status).toBe(200)
    expect(body.data.map(d => d.id).sort()).toEqual([M_PRICED, M_COSTONLY, M_ZERO, M_NONE, M_PCT].sort())
  })
})
