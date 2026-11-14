/**
 * 過去見積のコピー（POST /api/estimate-items/copy-from-past）の DB 検証。
 *
 * 実行: npm run test:db
 *   隔離されたローカル PostgreSQL にリポジトリの全 migration を適用し、実際の API ルートを
 *   「ログイン済みユーザー（authenticated + RLS）」として動かす。本番・Preview の DB には接続しない。
 *
 * fingerprint は検索 API（search-past）から受け取り、検索 → コピーの流れで確かめる。
 */

import { randomUUID } from 'node:crypto'
import { types as pgTypes, type Client } from 'pg'
import { NextRequest } from 'next/server'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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

const P_TARGET = randomUUID()   // A社・コピー先（掛け率 1.3）
const P_PAST = randomUUID()     // A社・過去案件
const P_OTHER = randomUUID()    // A社・別案件（工種の検証用）
const P_DEL = randomUUID()      // A社・削除済み案件
const P_B = randomUUID()        // B社の案件

const G_TARGET = randomUUID()     // コピー先の工種
const G_TARGET_DEL = randomUUID() // コピー先の削除済み工種
const G_PAST = randomUUID()       // 過去案件の工種
const G_OTHER = randomUUID()      // 別案件の工種
const G_B = randomUUID()          // B社の工種

const LINE_EVENT = randomUUID()

// コピー元（品名に「コピー元」を含む）
const S_AUTO = randomUUID()      // auto・原価あり・個別掛け率あり・備考・社内メモ・定価・LINE イベントあり
const S_MANUAL0 = randomUUID()   // manual・売価 0 円
const S_NOCOST = randomUUID()    // auto・原価なし
const S_NULLTYPE = randomUUID()  // row_type NULL（明細として扱う）
const S_HEADER = randomUUID()
const S_NOTE = randomUUID()
const S_DELETED = randomUUID()
const S_DELPROJ = randomUUID()
const S_TARGET_OWN = randomUUID() // コピー先案件自身の明細
const S_B = randomUUID()
const S_MISSING = randomUUID()

// コピー先の既存行
const T_1 = randomUUID()
const T_2 = randomUUID()
const T_DELETED = randomUUID()
const T_UNGROUPED = randomUUID()

const SECRET_B = 'B社の秘密コピー元'

type Json = Record<string, unknown>

async function request(body: unknown, user: string | null = USER_A) {
  currentUser = user ?? undefined
  const { POST } = await import('@/app/api/estimate-items/copy-from-past/route')
  const res = await POST(new NextRequest('http://localhost/api/estimate-items/copy-from-past', {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  }))
  return { status: res.status, body: await res.json() as Json }
}

/** 検索 API からコピー先案件向けの fingerprint を受け取る（id → fingerprint） */
async function fingerprints(user: string = USER_A, projectId: string = P_TARGET): Promise<Map<string, string>> {
  currentUser = user
  const { GET } = await import('@/app/api/estimate-items/search-past/route')
  const res = await GET(new NextRequest(`http://localhost/api/estimate-items/search-past?${new URLSearchParams({ q: 'コピー元', project_id: projectId, limit: '30' })}`))
  if (res.status !== 200) return new Map() // コピー先が他社・削除済みなど（検索も 404）
  const body = await res.json() as { items: Array<{ id: string; copy_preview: { fingerprint: string } }> }
  return new Map(body.items.map(i => [i.id, i.copy_preview.fingerprint]))
}

/** 検索に出ない（コピーできない）明細には、形式だけ正しいダミーの fingerprint を使う */
const DUMMY_FP = 'v1-00000000000000'

async function copy(ids: string[], extra: Json = {}, user: string = USER_A) {
  const fps = await fingerprints(user, (extra.project_id as string | undefined) ?? P_TARGET)
  return request({
    project_id: P_TARGET,
    group_id: G_TARGET,
    items: ids.map(id => ({ source_item_id: id, fingerprint: fps.get(id) ?? DUMMY_FP })),
    ...extra,
  }, user)
}

/** numeric は数値で読む（pg の既定は文字列） */
const NUMERIC_AS_NUMBER = {
  getTypeParser: (oid: number, format?: string) =>
    oid === 1700 ? (v: string) => Number(v) : pgTypes.getTypeParser(oid, format as 'text'),
}

async function rows(sql: string, params: unknown[] = []) {
  return (await admin.query({ text: sql, values: params, types: NUMERIC_AS_NUMBER })).rows
}

async function snapshot(): Promise<string> {
  return JSON.stringify(await rows('SELECT * FROM estimate_items ORDER BY id'))
}

/** コピー先に追加された行（past_item）を並び順で */
async function copiedRows(projectId = P_TARGET) {
  return rows(`SELECT * FROM estimate_items WHERE project_id = $1 AND source = 'past_item' ORDER BY sort_order, created_at`, [projectId])
}

const LEAK = new RegExp(`violates|constraint|relation|syntax|column|B社|${COMPANY_B}|${P_B}|${G_B}`)

beforeAll(async () => {
  server = await startLocalPostgres()
  admin = await server.connect()
  await applyFullSchema(admin)
  await admin.query('INSERT INTO auth.users (id) VALUES ($1), ($2), ($3)', [USER_A, USER_B, USER_NONE])
  await admin.query('INSERT INTO companies (id, name) VALUES ($1, $2), ($3, $4)', [COMPANY_A, 'A社', COMPANY_B, 'B社'])
  await admin.query('INSERT INTO company_members (company_id, user_id, role) VALUES ($1, $2, $3), ($4, $5, $3)', [COMPANY_A, USER_A, 'owner', COMPANY_B, USER_B])
  await admin.query(
    `INSERT INTO projects (id, company_id, name, status, markup_rate, deleted_at) VALUES
       ($1, $6, 'コピー先の案件', 'estimating', 1.3, NULL),
       ($2, $6, '過去案件', 'done', 1.45, NULL),
       ($3, $6, '別案件', 'done', 1.45, NULL),
       ($4, $6, '削除済み案件', 'done', 1.45, now()),
       ($5, $7, $8, 'done', 1.45, NULL)`,
    [P_TARGET, P_PAST, P_OTHER, P_DEL, P_B, COMPANY_A, COMPANY_B, SECRET_B],
  )
  await admin.query(
    `INSERT INTO estimate_groups (id, company_id, project_id, label, sort_order, deleted_at) VALUES
       ($1, $6, $7, 'コピー先の工種', 0, NULL),
       ($2, $6, $7, 'コピー先の削除済み工種', 1, now()),
       ($3, $6, $8, '過去案件の工種', 0, NULL),
       ($4, $6, $9, '別案件の工種', 0, NULL),
       ($5, $10, $11, 'B社の工種', 0, NULL)`,
    [G_TARGET, G_TARGET_DEL, G_PAST, G_OTHER, G_B, COMPANY_A, P_TARGET, P_PAST, P_OTHER, COMPANY_B, P_B],
  )
  await admin.query(
    `INSERT INTO line_events (id, company_id, line_user_id, line_event_id, project_id) VALUES ($1, $2, 'U1', 'E1', $3)`,
    [LINE_EVENT, COMPANY_A, P_PAST],
  )

  const src = (
    id: string, company: string, project: string, group: string | null, name: string,
    o: Partial<{ cost: number | null; selling: number | null; mode: string; rowType: string | null; deleted: boolean; sort: number }> = {},
  ) => admin.query(
    `INSERT INTO estimate_items (id, company_id, project_id, group_id, name, quantity, unit, cost_price, selling_price, selling_price_mode,
                                 markup_rate_override, vendor_name, category, row_type, memo, internal_memo, retail_price, line_event_id, sort_order, deleted_at)
     VALUES ($1, $2, $3, $4, $5, 2, '台', $6, $7, $8, 2.0, '〇〇設備', '住宅設備', $9, '他のお客様向け備考', '仕入見積 No.123', 200000, $10, $11, $12)`,
    [id, company, project, group, name,
      o.cost === undefined ? 100000 : o.cost, o.selling === undefined ? 145000 : o.selling, o.mode ?? 'auto',
      o.rowType === undefined ? 'item' : o.rowType, company === COMPANY_A && project === P_PAST ? LINE_EVENT : null,
      o.sort ?? 0, o.deleted ? new Date() : null],
  )
  await src(S_AUTO, COMPANY_A, P_PAST, G_PAST, 'コピー元 システムキッチン', { sort: 0 })
  await src(S_MANUAL0, COMPANY_A, P_PAST, G_PAST, 'コピー元 撤去サービス', { mode: 'manual', selling: 0, cost: 20000, sort: 1000 })
  await src(S_NOCOST, COMPANY_A, P_PAST, G_PAST, 'コピー元 キッチンパネル', { cost: null, selling: 50000, sort: 2000 })
  await src(S_NULLTYPE, COMPANY_A, P_PAST, null, 'コピー元 換気扇', { rowType: null, sort: 3000 })
  await src(S_HEADER, COMPANY_A, P_PAST, G_PAST, '【コピー元 見出し】', { rowType: 'header', cost: null, selling: null })
  await src(S_NOTE, COMPANY_A, P_PAST, G_PAST, 'コピー元 メモ行', { rowType: 'note', cost: null, selling: null })
  await src(S_DELETED, COMPANY_A, P_PAST, G_PAST, 'コピー元 削除済み明細', { deleted: true })
  await src(S_DELPROJ, COMPANY_A, P_DEL, null, 'コピー元 削除済み案件の明細')
  await src(S_TARGET_OWN, COMPANY_A, P_TARGET, G_TARGET, 'コピー元 コピー先自身の明細', { sort: 1000 })
  await src(S_B, COMPANY_B, P_B, G_B, SECRET_B)

  // コピー先の既存行（工種 G_TARGET の最大は 5000。削除済みの 99000 は数えない）
  await admin.query(
    `INSERT INTO estimate_items (id, company_id, project_id, group_id, name, sort_order, deleted_at) VALUES
       ($1, $5, $6, $7, '既存1', 0, NULL),
       ($2, $5, $6, $7, '既存2', 5000, NULL),
       ($3, $5, $6, $7, '削除済み既存', 99000, now()),
       ($4, $5, $6, NULL, '未分類の既存', 200, NULL)`,
    [T_1, T_2, T_DELETED, T_UNGROUPED, COMPANY_A, P_TARGET, G_TARGET],
  )
})

afterAll(async () => {
  await admin?.end()
  await server?.stop()
})

beforeEach(async () => {
  // 各テストはコピー先に追加された行が無い状態から始める（コピー元・既存行はそのまま）
  await admin.query(`DELETE FROM estimate_items WHERE source = 'past_item'`)
  await admin.query(`UPDATE projects SET markup_rate = 1.3 WHERE id = $1`, [P_TARGET])
  await admin.query(`UPDATE estimate_items SET cost_price = 100000 WHERE id = $1`, [S_AUTO])
})

describe('POST /api/estimate-items/copy-from-past：登録内容', () => {
  it('指定した順で工種の末尾に 1 回で登録し、売価は manual 保持・auto 再計算・原価なしは null', async () => {
    const { status, body } = await copy([S_NOCOST, S_AUTO, S_MANUAL0, S_NULLTYPE])
    expect(status, JSON.stringify(body)).toBe(201)
    expect(body.inserted_count).toBe(4)
    expect((body.items as Json[]).map(i => [i.source_item_id, i.price_basis, i.sort_order])).toEqual([
      [S_NOCOST, 'no_cost', 6000],
      [S_AUTO, 'auto_recalculated', 7000],
      [S_MANUAL0, 'manual_kept', 8000],
      [S_NULLTYPE, 'auto_recalculated', 9000],
    ])

    const copied = await copiedRows()
    expect(copied.map(r => [r.name, r.sort_order, r.group_id])).toEqual([
      ['コピー元 キッチンパネル', 6000, G_TARGET],
      ['コピー元 システムキッチン', 7000, G_TARGET],
      ['コピー元 撤去サービス', 8000, G_TARGET],
      ['コピー元 換気扇', 9000, G_TARGET],
    ])
    const [noCost, auto, manual0, nullType] = copied
    // 原価なしの auto: 売価を作らない（過去の売価 50,000 は使わない）
    expect(noCost).toMatchObject({ cost_price: null, selling_price: null, selling_price_mode: 'auto', amount: null })
    // auto: 100,000 × コピー先の掛け率 1.3。過去の個別掛け率 2.0 は引き継がない
    expect(auto).toMatchObject({ cost_price: 100000, selling_price: 130000, selling_price_mode: 'auto', markup_rate_override: null, quantity: 2, unit: '台', amount: 260000 })
    // manual 0 円は 0 円のまま
    expect(manual0).toMatchObject({ selling_price: 0, selling_price_mode: 'manual', amount: 0 })
    expect(nullType).toMatchObject({ row_type: 'item', selling_price: 130000 })
    for (const r of copied) {
      expect(r).toMatchObject({
        project_id: P_TARGET, company_id: COMPANY_A, source: 'past_item', row_type: 'item',
        memo: null, internal_memo: null, retail_price: null, line_event_id: null,
        vendor_name: '〇〇設備', category: '住宅設備', deleted_at: null,
      })
    }
  })

  it('コピー元の明細・既存行を変更しない', async () => {
    const before = JSON.stringify(await rows(`SELECT * FROM estimate_items WHERE source IS DISTINCT FROM 'past_item' ORDER BY id`))
    expect((await copy([S_AUTO, S_MANUAL0], { include_memo: true, include_internal_memo: true })).status).toBe(201)
    expect(JSON.stringify(await rows(`SELECT * FROM estimate_items WHERE source IS DISTINCT FROM 'past_item' ORDER BY id`))).toBe(before)
  })

  it('備考・社内メモは指定したものだけコピーする', async () => {
    await copy([S_AUTO], { include_memo: true })
    expect((await copiedRows())[0]).toMatchObject({ memo: '他のお客様向け備考', internal_memo: null })
    await admin.query(`DELETE FROM estimate_items WHERE source = 'past_item'`)
    await copy([S_AUTO], { include_internal_memo: true })
    expect((await copiedRows())[0]).toMatchObject({ memo: null, internal_memo: '仕入見積 No.123' })
  })

  it('group_id = null は未分類の末尾（未分類の最大 200 → 1200）', async () => {
    const { status } = await copy([S_AUTO, S_MANUAL0], { group_id: null })
    expect(status).toBe(201)
    expect((await copiedRows()).map(r => [r.group_id, r.sort_order])).toEqual([[null, 1200], [null, 2200]])
  })

  it('空の工種には 0 から追加する', async () => {
    const G_EMPTY = randomUUID()
    await admin.query(`INSERT INTO estimate_groups (id, company_id, project_id, label) VALUES ($1, $2, $3, '空の工種')`, [G_EMPTY, COMPANY_A, P_TARGET])
    await copy([S_AUTO, S_MANUAL0], { group_id: G_EMPTY })
    expect((await copiedRows()).map(r => r.sort_order)).toEqual([0, 1000])
  })
})

describe('全件成功か全件失敗（1 件でも無効なら 1 行も登録しない）', () => {
  const INVALID: Array<[string, string]> = [
    ['他社の明細', S_B],
    ['削除済みの明細', S_DELETED],
    ['削除済み案件の明細', S_DELPROJ],
    ['見出し行', S_HEADER],
    ['メモ行', S_NOTE],
    ['コピー先案件自身の明細', S_TARGET_OWN],
    ['存在しない明細', S_MISSING],
  ]
  it.each(INVALID)('%s が 1 件混ざると 404・登録 0 件', async (_label, invalidId) => {
    const before = await snapshot()
    const { status, body } = await copy([S_AUTO, invalidId, S_MANUAL0])
    expect(status).toBe(404)
    expect(body.missing_source_item_ids).toEqual([invalidId])
    expect(JSON.stringify(body)).not.toMatch(LEAK)
    expect(await snapshot()).toBe(before)
  })
})

describe('コピー先の案件・工種の確認', () => {
  it.each([
    ['他社の案件', P_B],
    ['削除済みの案件', P_DEL],
    ['存在しない案件', randomUUID()],
  ])('コピー先が%sなら 404・登録 0 件', async (_label, projectId) => {
    const before = await snapshot()
    const { status, body } = await copy([S_AUTO], { project_id: projectId, group_id: null })
    expect(status).toBe(404)
    expect(JSON.stringify(body)).not.toMatch(LEAK)
    expect(await snapshot()).toBe(before)
  })

  it.each([
    ['別案件の工種', G_OTHER],
    ['過去案件（コピー元）の工種', G_PAST],
    ['削除済みの工種', G_TARGET_DEL],
    ['他社の工種', G_B],
    ['存在しない工種', randomUUID()],
  ])('コピー先の工種が%sなら 404・登録 0 件', async (_label, groupId) => {
    const before = await snapshot()
    const { status } = await copy([S_AUTO], { group_id: groupId })
    expect(status).toBe(404)
    expect(await snapshot()).toBe(before)
  })

  it('B社の利用者は A社の明細を自社の案件へコピーできない', async () => {
    const before = await snapshot()
    const { status, body } = await request({
      project_id: P_B, group_id: null, items: [{ source_item_id: S_AUTO, fingerprint: DUMMY_FP }],
    }, USER_B)
    expect(status).toBe(404)
    expect(body.missing_source_item_ids).toEqual([S_AUTO])
    expect(await snapshot()).toBe(before)
  })
})

describe('プレビュー後の変更（fingerprint）', () => {
  it('コピー元の原価がプレビュー後に変わったら 409・登録 0 件。最新の売価を返し、送り直せば登録できる', async () => {
    const fps = await fingerprints()
    await admin.query(`UPDATE estimate_items SET cost_price = 120000 WHERE id = $1`, [S_AUTO])
    const before = await snapshot()
    const body = { project_id: P_TARGET, group_id: G_TARGET, items: [S_MANUAL0, S_AUTO].map(id => ({ source_item_id: id, fingerprint: fps.get(id)! })) }
    const res = await request(body)
    expect(res.status).toBe(409)
    const changed = res.body.changed as Array<{ source_item_id: string; copy_preview: Json; item: Json }>
    expect(changed.map(c => c.source_item_id)).toEqual([S_AUTO])
    expect(changed[0].copy_preview).toMatchObject({ basis: 'auto_recalculated', new_selling_price: 156000 })
    // 確認画面用に、いまのコピー元の値を返す（備考・社内メモは含めない）
    expect(changed[0].item).toEqual({
      name: 'コピー元 システムキッチン', quantity: 2, unit: '台', cost_price: 120000, selling_price: 145000, selling_price_mode: 'auto',
      vendor_name: '〇〇設備', category: '住宅設備',
    })
    expect(JSON.stringify(res.body)).not.toMatch(/他のお客様向け備考|仕入見積/)
    expect(await snapshot()).toBe(before)

    // 利用者が新しい金額を確認した → 新しい fingerprint で送り直す
    const retry = await request({ ...body, items: [{ source_item_id: S_MANUAL0, fingerprint: fps.get(S_MANUAL0)! }, { source_item_id: S_AUTO, fingerprint: changed[0].copy_preview.fingerprint as string }] })
    expect(retry.status).toBe(201)
    expect((await copiedRows()).map(r => r.selling_price)).toEqual([0, 156000])
  })

  it('業者名・分類だけが変わっても 409 で、最新の業者名・分類を返す（備考・社内メモは返さない）', async () => {
    const fps = await fingerprints()
    await admin.query(`UPDATE estimate_items SET vendor_name = '別の業者', category = '内装' WHERE id = $1`, [S_MANUAL0])
    try {
      const before = await snapshot()
      const res = await request({ project_id: P_TARGET, group_id: G_TARGET, items: [{ source_item_id: S_MANUAL0, fingerprint: fps.get(S_MANUAL0)! }] })
      expect(res.status).toBe(409)
      const changed = res.body.changed as Array<{ item: Json; copy_preview: Json }>
      expect(changed[0].item).toMatchObject({ vendor_name: '別の業者', category: '内装' })
      expect(changed[0].copy_preview).toMatchObject({ basis: 'manual_kept', new_selling_price: 0 })   // 金額は変わらない
      expect(changed[0].item).not.toHaveProperty('memo')
      expect(changed[0].item).not.toHaveProperty('internal_memo')
      expect(await snapshot()).toBe(before)
    } finally {
      await admin.query(`UPDATE estimate_items SET vendor_name = '〇〇設備', category = '住宅設備' WHERE id = $1`, [S_MANUAL0])
    }
  })

  it('コピー先の掛け率がプレビュー後に変わったら 409（auto 行の売価が変わるため）', async () => {
    const fps = await fingerprints()
    await admin.query(`UPDATE projects SET markup_rate = 1.5 WHERE id = $1`, [P_TARGET])
    const before = await snapshot()
    const res = await request({ project_id: P_TARGET, group_id: G_TARGET, items: [{ source_item_id: S_AUTO, fingerprint: fps.get(S_AUTO)! }] })
    expect(res.status).toBe(409)
    expect((res.body.changed as Array<{ copy_preview: Json }>)[0].copy_preview).toMatchObject({ new_selling_price: 150000, applied_markup_rate: 1.5 })
    expect(await snapshot()).toBe(before)
  })

  it('別の案件向けに取得した fingerprint は、掛け率が違えば 409', async () => {
    const fpsForOther = await fingerprints(USER_A, P_OTHER) // 別案件（掛け率 1.45）向け
    const res = await request({ project_id: P_TARGET, group_id: G_TARGET, items: [{ source_item_id: S_AUTO, fingerprint: fpsForOther.get(S_AUTO)! }] })
    expect(res.status).toBe(409)
  })
})

describe('再送・連続リクエスト（DB を変えずには防げないことの記録）', () => {
  it('同じリクエストを 2 回送ると 2 回とも登録される（二重登録は API では防げない）。並び順は重ならない', async () => {
    const fps = await fingerprints()
    const body = { project_id: P_TARGET, group_id: G_TARGET, items: [{ source_item_id: S_AUTO, fingerprint: fps.get(S_AUTO)! }] }
    expect((await request(body)).status).toBe(201)
    expect((await request(body)).status).toBe(201)
    const copied = await copiedRows()
    expect(copied).toHaveLength(2)
    expect(copied.map(r => r.sort_order)).toEqual([6000, 7000])
  })
})

describe('入力の不正・認証', () => {
  it('売価・原価・会社 ID などを送ると 400・登録 0 件', async () => {
    const fps = await fingerprints()
    const base = { project_id: P_TARGET, group_id: G_TARGET, items: [{ source_item_id: S_AUTO, fingerprint: fps.get(S_AUTO)! }] }
    const before = await snapshot()
    for (const body of [
      { ...base, company_id: COMPANY_B },
      { ...base, sort_order: 0 },
      { ...base, items: [{ ...base.items[0], selling_price: 1 }] },
      { ...base, items: [{ ...base.items[0], cost_price: 1 }] },
    ]) {
      expect((await request(body)).status, JSON.stringify(body)).toBe(400)
    }
    expect(await snapshot()).toBe(before)
  })

  it('重複 ID・不正な UUID・51 件・不正なオプションは 400', async () => {
    const it1 = { source_item_id: S_AUTO, fingerprint: DUMMY_FP }
    const many = Array.from({ length: 51 }, () => ({ source_item_id: randomUUID(), fingerprint: DUMMY_FP }))
    for (const body of [
      { project_id: P_TARGET, group_id: G_TARGET, items: [it1, it1] },
      { project_id: P_TARGET, group_id: G_TARGET, items: [{ ...it1, source_item_id: 'x' }] },
      { project_id: P_TARGET, group_id: G_TARGET, items: many },
      { project_id: P_TARGET, group_id: G_TARGET, items: [it1], include_memo: 'yes' },
      { project_id: P_TARGET, items: [it1] },
    ]) {
      expect((await request(body)).status).toBe(400)
    }
  })

  it('壊れた JSON は 400、未ログインは 401、会社に属さない利用者は 403', async () => {
    currentUser = USER_A
    const { POST } = await import('@/app/api/estimate-items/copy-from-past/route')
    const res = await POST(new NextRequest('http://localhost/api/estimate-items/copy-from-past', { method: 'POST', body: '{', headers: { 'content-type': 'application/json' } }))
    expect(res.status).toBe(400)
    const body = { project_id: P_TARGET, group_id: null, items: [{ source_item_id: S_AUTO, fingerprint: DUMMY_FP }] }
    expect((await request(body, null)).status).toBe(401)
    expect((await request(body, USER_NONE)).status).toBe(403)
  })
})
