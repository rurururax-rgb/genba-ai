import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * POST /api/estimate-items/reorder の所有確認と「全件検証してから書き込む」動作。
 * Supabase はメモリ上の偽クライアントで置き換え、RLS（自社 company_id の行だけ見える・見えない行の UPDATE は
 * エラーにならず 0 件）を再現する。外部キー検査は RLS を通らないため group_id の更新も検査しない（実 DB と同じ）。
 */

type Row = Record<string, unknown>

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const ME = 'user-me'
const NO_CO_USER = 'user-without-company'
const CO_A = id(1)
const CO_B = id(2)
const P_A1 = id(11)
const P_A2 = id(12)
const P_A_DELETED = id(13)
const P_B1 = id(14)
const G_A1 = id(21)
const G_A1B = id(22)
const G_A2 = id(23)
const G_A1_DELETED = id(24)
const G_B1 = id(25)
const G_ON_DELETED_P = id(26)
const G_MISSING = id(29)
const I_A1 = id(31)
const I_A1B = id(32)
const I_A1_NULL = id(33)
const I_A2 = id(34)
const I_A1_DELETED = id(35)
const I_B1 = id(36)
const I_ON_DELETED_P = id(37)
const I_MISSING = id(39)

let currentUser: string | null
let tables: Record<string, Row[]>
let updateCalls: Array<{ table: string; values: Row }>
/** 各 UPDATE の直前に呼ばれる（検証後・書き込み中の変化を再現する） */
let beforeUpdate: ((table: string, n: number) => void) | null
let updateError: { table: string; n: number } | null

function seed() {
  tables = {
    company_members: [{ user_id: ME, company_id: CO_A }],
    projects: [
      { id: P_A1, company_id: CO_A, deleted_at: null },
      { id: P_A2, company_id: CO_A, deleted_at: null },
      { id: P_A_DELETED, company_id: CO_A, deleted_at: '2026-10-01T00:00:00Z' },
      { id: P_B1, company_id: CO_B, deleted_at: null },
    ],
    estimate_groups: [
      { id: G_A1, project_id: P_A1, company_id: CO_A, sort_order: 0, deleted_at: null },
      { id: G_A1B, project_id: P_A1, company_id: CO_A, sort_order: 1000, deleted_at: null },
      { id: G_A2, project_id: P_A2, company_id: CO_A, sort_order: 0, deleted_at: null },
      { id: G_A1_DELETED, project_id: P_A1, company_id: CO_A, sort_order: 2000, deleted_at: '2026-10-01T00:00:00Z' },
      { id: G_B1, project_id: P_B1, company_id: CO_B, sort_order: 0, deleted_at: null },
      { id: G_ON_DELETED_P, project_id: P_A_DELETED, company_id: CO_A, sort_order: 0, deleted_at: null },
    ],
    estimate_items: [
      { id: I_A1, project_id: P_A1, company_id: CO_A, group_id: G_A1, sort_order: 0, deleted_at: null },
      { id: I_A1B, project_id: P_A1, company_id: CO_A, group_id: G_A1, sort_order: 1000, deleted_at: null },
      { id: I_A1_NULL, project_id: P_A1, company_id: CO_A, group_id: null, sort_order: 0, deleted_at: null },
      { id: I_A2, project_id: P_A2, company_id: CO_A, group_id: G_A2, sort_order: 0, deleted_at: null },
      { id: I_A1_DELETED, project_id: P_A1, company_id: CO_A, group_id: G_A1, sort_order: 2000, deleted_at: '2026-10-01T00:00:00Z' },
      { id: I_B1, project_id: P_B1, company_id: CO_B, group_id: G_B1, sort_order: 0, deleted_at: null },
      { id: I_ON_DELETED_P, project_id: P_A_DELETED, company_id: CO_A, group_id: G_ON_DELETED_P, sort_order: 0, deleted_at: null },
    ],
  }
}

/** RLS: company_members は自分の行、それ以外は自社 company_id の行だけ見える */
function visible(table: string): Row[] {
  if (!currentUser) return []
  if (table === 'company_members') return tables.company_members.filter(r => r.user_id === currentUser)
  const mine = new Set(tables.company_members.filter(r => r.user_id === currentUser).map(r => r.company_id))
  return tables[table].filter(r => mine.has(r.company_id))
}

function from(table: string) {
  const filters: Array<(r: Row) => boolean> = []
  let updateValues: Row | null = null
  const run = () => {
    if (!updateValues) return Promise.resolve({ data: visible(table).filter(r => filters.every(f => f(r))), error: null })
    const n = updateCalls.filter(c => c.table === table).length
    updateCalls.push({ table, values: updateValues })
    beforeUpdate?.(table, n)
    if (updateError && updateError.table === table && updateError.n === n) {
      return Promise.resolve({ data: null, error: { message: 'connection reset' } })
    }
    // RLS で見えない行・条件に合わない行は更新されない（エラーにはならない）
    const hit = visible(table).filter(r => filters.every(f => f(r)))
    for (const r of hit) Object.assign(r, updateValues)
    return Promise.resolve({ data: hit.map(r => ({ id: r.id })), error: null })
  }
  const one = () => run().then(({ data }) => (data?.length === 1
    ? { data: data[0], error: null }
    : { data: null, error: { message: 'not exactly one row' } }))
  const q = {
    select: () => q,
    eq: (col: string, v: unknown) => { filters.push(r => r[col] === v); return q },
    is: (col: string, v: unknown) => { filters.push(r => (r[col] ?? null) === v); return q },
    in: (col: string, vs: unknown[]) => { filters.push(r => vs.includes(r[col])); return q },
    single: one,
    maybeSingle: () => run().then(({ data }) => ({ data: data?.[0] ?? null, error: null })),
    update: (values: Row) => { updateValues = values; return q },
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => run().then(resolve, reject),
  }
  return q
}

vi.mock('@/lib/supabase/server', () => ({
  getServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: currentUser ? { id: currentUser } : null } }) },
    from,
  }),
}))

const { POST } = await import('@/app/api/estimate-items/reorder/route')

async function post(body: unknown) {
  const req = new NextRequest('http://localhost/api/estimate-items/reorder', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  const res = await POST(req)
  return { status: res.status, json: await res.json() }
}

const row = (table: string, rowId: string) => tables[table].find(r => r.id === rowId)!
const snapshot = () => JSON.stringify(tables)

beforeEach(() => {
  currentUser = ME
  updateCalls = []
  beforeUpdate = null
  updateError = null
  seed()
})

describe('並び替え: 正常系（従来どおり保存される）', () => {
  it('A. 工種だけの並び替え（工種ドラッグ）', async () => {
    const r = await post({ groups: [{ id: G_A1B, sort_order: 0 }, { id: G_A1, sort_order: 1000 }], items: [] })
    expect(r).toEqual({ status: 200, json: { ok: true } })
    expect(row('estimate_groups', G_A1B).sort_order).toBe(0)
    expect(row('estimate_groups', G_A1).sort_order).toBe(1000)
  })

  it('B. 明細だけの並び替え・同じ案件の別工種への移動（明細ドラッグ・Move Mode）', async () => {
    const r = await post({ items: [
      { id: I_A1B, sort_order: 0, group_id: G_A1B },
      { id: I_A1, sort_order: 1000, group_id: G_A1B },
    ] })
    expect(r).toEqual({ status: 200, json: { ok: true } })
    expect(row('estimate_items', I_A1B)).toEqual(expect.objectContaining({ sort_order: 0, group_id: G_A1B }))
    expect(row('estimate_items', I_A1)).toEqual(expect.objectContaining({ sort_order: 1000, group_id: G_A1B }))
  })

  it('C. 工種と明細を同時に保存できる', async () => {
    const r = await post({
      groups: [{ id: G_A1, sort_order: 1000 }, { id: G_A1B, sort_order: 0 }],
      items: [{ id: I_A1, sort_order: -500, group_id: G_A1 }],
    })
    expect(r.status).toBe(200)
    expect(updateCalls.map(c => c.table)).toEqual(['estimate_groups', 'estimate_groups', 'estimate_items'])
  })

  it('D. 「その他」（group_id = null）への移動・その他からの移動', async () => {
    const r = await post({ items: [
      { id: I_A1, sort_order: 2000, group_id: null },
      { id: I_A1_NULL, sort_order: 0, group_id: G_A1 },
    ] })
    expect(r.status).toBe(200)
    expect(row('estimate_items', I_A1).group_id).toBeNull()
    expect(row('estimate_items', I_A1_NULL).group_id).toBe(G_A1)
  })

  it('E. 空の要求（変更なしのドラッグ）は何も書かずに成功', async () => {
    expect(await post({ groups: [], items: [] })).toEqual({ status: 200, json: { ok: true } })
    expect(await post({ items: [] })).toEqual({ status: 200, json: { ok: true } })
    expect(await post({})).toEqual({ status: 200, json: { ok: true } })
    expect(updateCalls).toEqual([])
  })
})

describe('並び替え: 拒否時は UPDATE を 1 件も始めない', () => {
  const reject = async (body: unknown, status: number) => {
    const before = snapshot()
    const r = await post(body)
    expect(r.status).toBe(status)
    expect(updateCalls).toEqual([])
    expect(snapshot()).toBe(before)
    return r
  }

  it('F. 未ログイン → 401', async () => {
    currentUser = null
    await reject({ items: [{ id: I_A1, sort_order: 0, group_id: G_A1 }] }, 401)
  })

  it('G. 会社に所属していない → 403', async () => {
    currentUser = NO_CO_USER
    await reject({ items: [{ id: I_A1, sort_order: 0, group_id: G_A1 }] }, 403)
  })

  it('H. 他社の明細が 1 件でも混ざっていれば → 404（自社の明細も更新しない）', async () => {
    await reject({ items: [
      { id: I_A1, sort_order: 0, group_id: G_A1 },
      { id: I_B1, sort_order: 1000, group_id: G_B1 },
    ] }, 404)
  })

  it('I. 他社の工種の並び替え → 404', async () => {
    await reject({ groups: [{ id: G_A1, sort_order: 0 }, { id: G_B1, sort_order: 1000 }] }, 404)
  })

  it('J. 明細を他社の工種へ移動 → 404', async () => {
    await reject({ items: [{ id: I_A1, sort_order: 0, group_id: G_B1 }] }, 404)
  })

  it('K. 同じ会社でも別案件の工種へ明細を移動 → 400（案件をまたぐ移動を拒否）', async () => {
    await reject({ items: [{ id: I_A1, sort_order: 0, group_id: G_A2 }] }, 400)
  })

  it('L. 同じ会社の 2 案件の明細・工種を 1 回で並び替え → 400', async () => {
    await reject({ items: [
      { id: I_A1, sort_order: 0, group_id: G_A1 },
      { id: I_A2, sort_order: 1000, group_id: G_A2 },
    ] }, 400)
    await reject({ groups: [{ id: G_A1, sort_order: 0 }, { id: G_A2, sort_order: 1000 }] }, 400)
    await reject({ groups: [{ id: G_A2, sort_order: 0 }], items: [{ id: I_A1, sort_order: 0, group_id: G_A1 }] }, 400)
  })

  it('M. 削除済みの明細・工種・移動先の工種 → 404', async () => {
    await reject({ items: [{ id: I_A1_DELETED, sort_order: 0, group_id: G_A1 }] }, 404)
    await reject({ groups: [{ id: G_A1_DELETED, sort_order: 0 }] }, 404)
    await reject({ items: [{ id: I_A1, sort_order: 0, group_id: G_A1_DELETED }] }, 404)
  })

  it('N. 削除済みの案件の明細・工種 → 404', async () => {
    await reject({ items: [{ id: I_ON_DELETED_P, sort_order: 0, group_id: G_ON_DELETED_P }] }, 404)
    await reject({ groups: [{ id: G_ON_DELETED_P, sort_order: 0 }] }, 404)
  })

  it('O. 存在しない ID は他社の ID と同じ応答（他社データの存在を漏らさない）', async () => {
    const missing = await reject({ items: [{ id: I_MISSING, sort_order: 0, group_id: null }] }, 404)
    const other = await reject({ items: [{ id: I_B1, sort_order: 0, group_id: null }] }, 404)
    expect(other.json).toEqual(missing.json)
    const missingGroup = await reject({ groups: [{ id: G_MISSING, sort_order: 0 }] }, 404)
    const otherGroup = await reject({ groups: [{ id: G_B1, sort_order: 0 }] }, 404)
    expect(otherGroup.json).toEqual(missingGroup.json)
  })

  it('P. 重複 ID → 400', async () => {
    await reject({ items: [{ id: I_A1, sort_order: 0, group_id: G_A1 }, { id: I_A1, sort_order: 1000, group_id: G_A1 }] }, 400)
    await reject({ groups: [{ id: G_A1, sort_order: 0 }, { id: G_A1, sort_order: 1000 }] }, 400)
  })

  it('Q. 不正な入力（sort_order・ID・形式）→ 400', async () => {
    const item = { id: I_A1, sort_order: 0, group_id: G_A1 }
    await reject('not json', 400)
    await reject({ items: 'x' }, 400)
    await reject({ groups: {} }, 400)
    await reject({ items: [null] }, 400)
    await reject({ items: [{ ...item, sort_order: 1.5 }] }, 400)
    await reject({ items: [{ ...item, sort_order: '0' }] }, 400)
    await reject({ items: [{ ...item, sort_order: null }] }, 400)
    await reject({ items: [{ ...item, sort_order: 2147483648 }] }, 400)
    await reject({ items: [{ ...item, sort_order: -2147483649 }] }, 400)
    await reject({ groups: [{ id: G_A1, sort_order: 1e20 }] }, 400)
    await reject({ items: [{ ...item, id: 'item-a1' }] }, 400)
    await reject({ items: [{ ...item, group_id: 'group-a1' }] }, 400)
    await reject({ items: [{ id: I_A1, sort_order: 0 }] }, 400)  // group_id 欠落
  })
})

describe('並び替え: 書き込み中の失敗は成功扱いしない', () => {
  const twoItems = { items: [
    { id: I_A1, sort_order: 1000, group_id: G_A1 },
    { id: I_A1B, sort_order: 0, group_id: G_A1 },
  ] }

  it('R-1. 検証後に行が削除され UPDATE が 0 件（error なし）→ 500・ok を返さない', async () => {
    beforeUpdate = (table, n) => {
      if (table === 'estimate_items' && n === 1) row('estimate_items', I_A1B).deleted_at = '2026-10-10T00:00:00Z'
    }
    const r = await post(twoItems)
    expect(r.status).toBe(500)
    expect(r.json).toEqual({ error: 'Reorder was not fully saved' })
    expect(r.json).not.toHaveProperty('ok')
    // 1 件目は更新済みのまま（ロールバックしたとは主張しない。クライアントが読み直す）
    expect(row('estimate_items', I_A1).sort_order).toBe(1000)
  })

  it('R-2. 検証後に行が別案件へ移り UPDATE が 0 件 → 500', async () => {
    beforeUpdate = (table, n) => {
      if (table === 'estimate_groups' && n === 0) row('estimate_groups', G_A1).project_id = P_A2
    }
    const r = await post({ groups: [{ id: G_A1, sort_order: 5 }] })
    expect(r.status).toBe(500)
    expect(row('estimate_groups', G_A1).sort_order).toBe(0)
  })

  it('R-3. UPDATE がエラー → 500 で以降の UPDATE は行わない', async () => {
    updateError = { table: 'estimate_items', n: 0 }
    const r = await post(twoItems)
    expect(r.status).toBe(500)
    expect(updateCalls).toHaveLength(1)
  })
})
