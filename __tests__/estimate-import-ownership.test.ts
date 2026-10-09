import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * POST /api/estimate-items/import の保存先所有確認。
 * Supabase はメモリ上の偽クライアントで置き換え、RLS（自社 company_id の行だけ見える）を再現する。
 * 外部キー検査は RLS を通らないため、偽クライアントの insert も project_id / group_id を検査しない（実 DB と同じ）。
 */

type Row = Record<string, unknown>

const ME = 'user-me'
const CO_A = 'company-a'
const CO_B = 'company-b'
const P_A1 = 'project-a1'
const P_A2 = 'project-a2'
const P_A_DELETED = 'project-a-deleted'
const P_B1 = 'project-b1'
const G_A1 = 'group-a1'
const G_A2 = 'group-a2'
const G_A1_DELETED = 'group-a1-deleted'
const G_B1 = 'group-b1'

let currentUser: string | null
let tables: Record<string, Row[]>

function seed() {
  tables = {
    company_members: [{ user_id: ME, company_id: CO_A }],
    projects: [
      { id: P_A1, company_id: CO_A, markup_rate: 1.45, deleted_at: null },
      { id: P_A2, company_id: CO_A, markup_rate: 1.3, deleted_at: null },
      { id: P_A_DELETED, company_id: CO_A, markup_rate: 1.45, deleted_at: '2026-10-01T00:00:00Z' },
      { id: P_B1, company_id: CO_B, markup_rate: 1.2, deleted_at: null },
    ],
    estimate_groups: [
      { id: G_A1, project_id: P_A1, company_id: CO_A, deleted_at: null },
      { id: G_A2, project_id: P_A2, company_id: CO_A, deleted_at: null },
      { id: G_A1_DELETED, project_id: P_A1, company_id: CO_A, deleted_at: '2026-10-01T00:00:00Z' },
      { id: G_B1, project_id: P_B1, company_id: CO_B, deleted_at: null },
    ],
    estimate_items: [
      { id: 'i1', project_id: P_A1, company_id: CO_A, group_id: G_A1, sort_order: 4, deleted_at: null },
      { id: 'i2', project_id: P_A1, company_id: CO_A, group_id: null, sort_order: 9, deleted_at: null },
      { id: 'b1', project_id: P_B1, company_id: CO_B, group_id: G_B1, sort_order: 0, deleted_at: null },
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
  let orderCol: string | null = null
  let ascending = true
  let lim: number | null = null
  const run = () => {
    let rows = visible(table).filter(r => filters.every(f => f(r)))
    if (orderCol) {
      const c = orderCol
      rows = [...rows].sort((a, b) => (Number(a[c]) - Number(b[c])) * (ascending ? 1 : -1))
    }
    return lim == null ? rows : rows.slice(0, lim)
  }
  const one = (strict: boolean) => {
    const rows = run()
    if (rows.length === 1) return Promise.resolve({ data: rows[0], error: null })
    if (rows.length === 0 && !strict) return Promise.resolve({ data: null, error: null })
    return Promise.resolve({ data: null, error: { message: 'not exactly one row' } })
  }
  const q = {
    select: () => q,
    eq: (col: string, v: unknown) => { filters.push(r => r[col] === v); return q },
    is: (col: string, v: unknown) => { filters.push(r => (r[col] ?? null) === v); return q },
    order: (col: string, opts?: { ascending?: boolean }) => { orderCol = col; ascending = opts?.ascending ?? true; return q },
    limit: (n: number) => { lim = n; return q },
    single: () => one(true),
    maybeSingle: () => one(false),
    insert: (rows: Row[]) => {
      const mine = new Set(visible('company_members').map(r => r.company_id))
      // RLS（WITH CHECK = USING）は company_id だけを見る
      if (rows.some(r => !mine.has(r.company_id))) {
        return Promise.resolve({ error: { code: '42501', message: 'new row violates row-level security policy' } })
      }
      tables[table].push(...rows)
      return Promise.resolve({ error: null })
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

const { POST } = await import('@/app/api/estimate-items/import/route')

const ITEM = { name: '養生工事', quantity: 1, unit: '式', cost_price: 50000, vendor_name: '東海住建', internal_memo: '共用部・室内養生一式' }

async function post(body: Record<string, unknown>) {
  const req = new NextRequest('http://localhost/api/estimate-items/import', { method: 'POST', body: JSON.stringify(body) })
  const res = await POST(req)
  return { status: res.status, json: await res.json() }
}

const itemCount = () => tables.estimate_items.length
const imported = () => tables.estimate_items.filter(r => r.source === 'import')

beforeEach(() => {
  currentUser = ME
  seed()
})

describe('見積取込: 正常系（従来どおり保存される）', () => {
  it('自社の案件・同じ案件の工種へ取り込める（売価・社内メモ・sort_order も従来どおり）', async () => {
    const r = await post({ project_id: P_A1, group_id: G_A1, items: [ITEM, { ...ITEM, name: '解体工事', cost_price: 180000 }] })
    expect(r).toEqual({ status: 200, json: { created: 2 } })
    expect(imported()).toEqual([
      expect.objectContaining({ project_id: P_A1, company_id: CO_A, group_id: G_A1, name: '養生工事', cost_price: 50000, selling_price: 72500, selling_price_mode: 'auto', internal_memo: '共用部・室内養生一式', sort_order: 5 }),
      expect.objectContaining({ group_id: G_A1, name: '解体工事', sort_order: 6 }),
    ])
    expect(imported()[0]).not.toHaveProperty('memo')
  })

  it('group_id = null は未分類として取り込める', async () => {
    const r = await post({ project_id: P_A1, group_id: null, items: [ITEM] })
    expect(r).toEqual({ status: 200, json: { created: 1 } })
    expect(imported()).toEqual([expect.objectContaining({ project_id: P_A1, group_id: null, sort_order: 10 })])
  })

  it('group_id 省略も未分類として取り込める', async () => {
    const r = await post({ project_id: P_A1, items: [ITEM] })
    expect(r.status).toBe(200)
    expect(imported()).toEqual([expect.objectContaining({ group_id: null })])
  })

  it('ドロップ位置の sort_order 指定はそのまま使う', async () => {
    const r = await post({ project_id: P_A1, group_id: G_A1, sort_order: -499, items: [ITEM] })
    expect(r.status).toBe(200)
    expect(imported()).toEqual([expect.objectContaining({ sort_order: -499 })])
  })
})

describe('見積取込: 権限外・不正な保存先は拒否し、1行も保存しない', () => {
  const reject = async (body: Record<string, unknown>, status: number) => {
    const before = itemCount()
    const r = await post(body)
    expect(r.status).toBe(status)
    expect(itemCount()).toBe(before)
    return r
  }

  it('未ログイン → 401', async () => {
    currentUser = null
    await reject({ project_id: P_A1, group_id: G_A1, items: [ITEM] }, 401)
  })

  it('存在しない project_id → 404', async () => {
    const r = await reject({ project_id: 'project-missing', items: [ITEM, ITEM] }, 404)
    expect(r.json).toEqual({ error: 'Project not found' })
  })

  it('他社の project_id → 404（存在しない場合と同じ応答で、他社案件の存在を漏らさない）', async () => {
    const missing = await post({ project_id: 'project-missing', items: [ITEM] })
    const other = await reject({ project_id: P_B1, items: [ITEM] }, 404)
    expect(other.json).toEqual(missing.json)
  })

  it('他社の project_id に他社の group_id を組み合わせても → 404', async () => {
    await reject({ project_id: P_B1, group_id: G_B1, items: [ITEM] }, 404)
  })

  it('削除済みの案件 → 404', async () => {
    await reject({ project_id: P_A_DELETED, items: [ITEM] }, 404)
  })

  it('同じ会社でも別案件の group_id → 404', async () => {
    const r = await reject({ project_id: P_A1, group_id: G_A2, items: [ITEM] }, 404)
    expect(r.json).toEqual({ error: 'Group not found' })
  })

  it('他社の group_id → 404', async () => {
    await reject({ project_id: P_A1, group_id: G_B1, items: [ITEM] }, 404)
  })

  it('存在しない group_id → 404', async () => {
    await reject({ project_id: P_A1, group_id: 'group-missing', items: [ITEM] }, 404)
  })

  it('削除済みの group_id → 404', async () => {
    await reject({ project_id: P_A1, group_id: G_A1_DELETED, items: [ITEM] }, 404)
  })

  it('複数明細でも検証失敗なら 1 行も保存しない', async () => {
    await reject({ project_id: P_A1, group_id: G_B1, items: [ITEM, ITEM, ITEM] }, 404)
    expect(imported()).toEqual([])
  })
})
