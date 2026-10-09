import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * POST /api/estimate-items/manual の保存先所有確認。
 * Supabase はメモリ上の偽クライアントで置き換え、RLS（自社 company_id の行だけ見える）を再現する。
 * 外部キー検査は RLS を通らないため、偽クライアントの insert も project_id / group_id を検査しない（実 DB と同じ）。
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
const P_MISSING = id(19)
const G_A1 = id(21)
const G_A2 = id(22)
const G_A1_DELETED = id(23)
const G_B1 = id(24)
const G_MISSING = id(29)

let currentUser: string | null
let tables: Record<string, Row[]>
let queriedTables: string[]

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
      { id: G_A1, project_id: P_A1, company_id: CO_A, deleted_at: null },
      { id: G_A2, project_id: P_A2, company_id: CO_A, deleted_at: null },
      { id: G_A1_DELETED, project_id: P_A1, company_id: CO_A, deleted_at: '2026-10-01T00:00:00Z' },
      { id: G_B1, project_id: P_B1, company_id: CO_B, deleted_at: null },
    ],
    estimate_items: [
      { id: id(31), project_id: P_A1, company_id: CO_A, group_id: G_A1, sort_order: 0, deleted_at: null },
      { id: id(32), project_id: P_B1, company_id: CO_B, group_id: G_B1, sort_order: 0, deleted_at: null },
    ],
    company_estimate_items: [
      { company_id: CO_A, name: 'システムバス交換', selling_price: 850000, unit: '台', usage_count: 3 },
      { company_id: CO_B, name: '他社の外壁塗装', selling_price: 1, unit: 'm2', usage_count: 99 },
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
  queriedTables.push(table)
  const filters: Array<(r: Row) => boolean> = []
  let orderCol: string | null = null
  let ascending = true
  let lim: number | null = null
  let inserted: Row | null = null
  let insertError: { code: string; message: string } | null = null
  const run = () => {
    if (inserted) return [inserted]
    let rows = visible(table).filter(r => filters.every(f => f(r)))
    if (orderCol) {
      const c = orderCol
      rows = [...rows].sort((a, b) => (Number(a[c]) - Number(b[c])) * (ascending ? 1 : -1))
    }
    return lim == null ? rows : rows.slice(0, lim)
  }
  const one = (strict: boolean) => {
    if (insertError) return Promise.resolve({ data: null, error: insertError })
    const rows = run()
    if (rows.length === 1) return Promise.resolve({ data: rows[0], error: null })
    if (rows.length === 0 && !strict) return Promise.resolve({ data: null, error: null })
    return Promise.resolve({ data: null, error: { message: 'not exactly one row' } })
  }
  const q = {
    select: () => q,
    eq: (col: string, v: unknown) => { filters.push(r => r[col] === v); return q },
    is: (col: string, v: unknown) => { filters.push(r => (r[col] ?? null) === v); return q },
    not: (col: string, op: string, v: unknown) => { filters.push(r => !(op === 'is' && (r[col] ?? null) === v)); return q },
    ilike: (col: string, pattern: string) => {
      const needle = pattern.replace(/^%|%$/g, '').toLowerCase()
      filters.push(r => String(r[col] ?? '').toLowerCase().includes(needle))
      return q
    },
    order: (col: string, opts?: { ascending?: boolean }) => { orderCol = col; ascending = opts?.ascending ?? true; return q },
    limit: (n: number) => { lim = n; return q },
    single: () => one(true),
    maybeSingle: () => one(false),
    then: (resolve: (v: { data: Row[]; error: null }) => unknown) => resolve({ data: run(), error: null }),
    insert: (row: Row) => {
      const mine = new Set(visible('company_members').map(r => r.company_id))
      // RLS（WITH CHECK = USING）は company_id だけを見る
      if (!mine.has(row.company_id)) {
        insertError = { code: '42501', message: 'new row violates row-level security policy' }
      } else {
        inserted = { id: id(900 + tables[table].length), ...row }
        tables[table].push(inserted)
      }
      return q
    },
  }
  return q
}

vi.mock('@/lib/supabase/server', () => ({
  getServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: currentUser ? { id: currentUser } : null } }) },
    from,
  }),
}))

const { POST } = await import('@/app/api/estimate-items/manual/route')

async function post(body: unknown) {
  const req = new NextRequest('http://localhost/api/estimate-items/manual', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  const res = await POST(req)
  return { status: res.status, json: await res.json() }
}

const itemCount = () => tables.estimate_items.length
const lastInserted = () => tables.estimate_items[tables.estimate_items.length - 1]

beforeEach(() => {
  currentUser = ME
  queriedTables = []
  seed()
})

describe('手動追加: 正常系（従来どおり保存される）', () => {
  it('1. 自社案件・同じ案件の工種へ明細行を追加できる', async () => {
    const r = await post({ project_id: P_A1, group_id: G_A1, sort_order: 1000, row_type: 'item' })
    expect(r.status).toBe(200)
    expect(r.json).toEqual(expect.objectContaining({ name: '新規項目', group_id: G_A1, sort_order: 1000, source: 'manual', row_type: 'item', quantity: 1, unit: '式', selling_price: null }))
    expect(lastInserted()).toEqual(expect.objectContaining({ project_id: P_A1, company_id: CO_A, group_id: G_A1 }))
  })

  it('2. 見出し行（header）は名前が空で追加される', async () => {
    const r = await post({ project_id: P_A1, group_id: G_A1, sort_order: 500, row_type: 'header' })
    expect(r.status).toBe(200)
    expect(r.json).toEqual(expect.objectContaining({ name: '', row_type: 'header', sort_order: 500 }))
  })

  it('3. 備考行（note）も追加できる', async () => {
    const r = await post({ project_id: P_A1, group_id: G_A1, sort_order: 1500, row_type: 'note' })
    expect(r.status).toBe(200)
    expect(r.json).toEqual(expect.objectContaining({ name: '', row_type: 'note' }))
  })

  it('4. インライン＋の挿入位置（先頭の負数・中間・末尾）の sort_order をそのまま保存する', async () => {
    for (const sort_order of [-1000, 0, 500, 1000000]) {
      const r = await post({ project_id: P_A1, group_id: G_A1, sort_order, row_type: 'item' })
      expect(r.status).toBe(200)
      expect(r.json.sort_order).toBe(sort_order)
    }
  })

  it('5. group_id = null は「その他」（未分類）として追加できる', async () => {
    const r = await post({ project_id: P_A1, group_id: null, sort_order: 0, row_type: 'item' })
    expect(r.status).toBe(200)
    expect(r.json.group_id).toBeNull()
  })

  it('6. group_id・sort_order 省略（仕様書取込の呼び出し）・null も従来どおり', async () => {
    const r = await post({ project_id: P_A1, name: '洗面化粧台' })
    expect(r.status).toBe(200)
    expect(r.json).toEqual(expect.objectContaining({ name: '洗面化粧台', group_id: null, sort_order: 0, source: 'manual' }))
    const n = await post({ project_id: P_A1, group_id: null, sort_order: null })
    expect(n.status).toBe(200)
    expect(n.json).toEqual(expect.objectContaining({ group_id: null, sort_order: 0 }))
  })

  it('7. 過去実績の単価を自動補完する（自社の実績のみ・source = past_item）', async () => {
    const r = await post({ project_id: P_A1, name: 'システムバス' })
    expect(r.status).toBe(200)
    expect(r.json).toEqual(expect.objectContaining({ selling_price: 850000, unit: '台', source: 'past_item' }))
    const other = await post({ project_id: P_A1, name: '外壁塗装' })
    expect(other.json).toEqual(expect.objectContaining({ selling_price: null, source: 'manual' }))
  })
})

describe('手動追加: 権限外・不正な保存先は拒否し、1行も保存しない', () => {
  const reject = async (body: unknown, status: number) => {
    const before = itemCount()
    const r = await post(body)
    expect(r.status).toBe(status)
    expect(itemCount()).toBe(before)
    // 拒否時は過去実績の検索にも進まない
    expect(queriedTables).not.toContain('company_estimate_items')
    return r
  }

  it('8. 未ログイン → 401', async () => {
    currentUser = null
    await reject({ project_id: P_A1, group_id: G_A1 }, 401)
  })

  it('9. 会社に所属していない → 403', async () => {
    currentUser = NO_CO_USER
    await reject({ project_id: P_A1 }, 403)
  })

  it('10. 存在しない・他社・削除済みの案件 → 404（どれも同じ応答で、他社案件の存在を漏らさない）', async () => {
    const missing = await reject({ project_id: P_MISSING, name: 'システムバス' }, 404)
    expect(missing.json).toEqual({ error: 'Project not found' })
    expect((await reject({ project_id: P_B1, name: 'システムバス' }, 404)).json).toEqual(missing.json)
    expect((await reject({ project_id: P_B1, group_id: G_B1 }, 404)).json).toEqual(missing.json)
    expect((await reject({ project_id: P_A_DELETED }, 404)).json).toEqual(missing.json)
  })

  it('11. 同じ会社でも別案件の group_id → 404', async () => {
    const r = await reject({ project_id: P_A1, group_id: G_A2, sort_order: 0 }, 404)
    expect(r.json).toEqual({ error: 'Group not found' })
  })

  it('12. 他社・存在しない・削除済みの group_id → 404（同じ応答）', async () => {
    const other = await reject({ project_id: P_A1, group_id: G_B1 }, 404)
    expect((await reject({ project_id: P_A1, group_id: G_MISSING }, 404)).json).toEqual(other.json)
    expect((await reject({ project_id: P_A1, group_id: G_A1_DELETED }, 404)).json).toEqual(other.json)
  })

  it('13. 不正な入力 → 400（DB に問い合わせる前に弾く）', async () => {
    await reject('not json', 400)
    await reject({}, 400)
    await reject({ project_id: 'project-a1' }, 400)
    await reject({ project_id: P_A1, group_id: 'group-a1' }, 400)
    await reject({ project_id: P_A1, group_id: 123 }, 400)
    await reject({ project_id: P_A1, sort_order: 1.5 }, 400)
    await reject({ project_id: P_A1, sort_order: '100' }, 400)
    await reject({ project_id: P_A1, sort_order: 2147483648 }, 400)
  })
})
