import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * KI-002 PR-1: 案件 ID を受け取って書き込む API が、書き込みの前に所属確認（isActiveProject）を行うこと。
 * CI 用の軽い検証。isActiveProject を「自社の有効な案件ではない」と答えさせ、DB・Storage への書き込みが
 * 1件も起きずに 404 になることを確かめる。実 DB（RLS 付き）での検証は __tests__/db/company-isolation-api.db.test.ts。
 */

const CO_A = '00000000-0000-4000-8000-000000000001'
const CO_B = '00000000-0000-4000-8000-000000000002'
const P_B = '00000000-0000-4000-8000-000000000014'
const EVENT_A = '00000000-0000-4000-8000-000000000031'

let writes: string[]
const ownership = vi.hoisted(() => ({ activeProject: false, ownLineEvent: true }))

vi.mock('@/lib/estimate/ownership', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/estimate/ownership')>()),
  isActiveProject: vi.fn(async () => ownership.activeProject),
  isOwnLineEvent: vi.fn(async () => ownership.ownLineEvent),
}))

/** どの表を読んでも「自社メンバー」以外は空。書き込み系の呼び出しは writes に記録する */
function fakeClient() {
  const from = (table: string) => {
    const q: Record<string, unknown> = {}
    const chain = () => q
    for (const m of ['select', 'eq', 'neq', 'is', 'in', 'not', 'lt', 'lte', 'gt', 'gte', 'order', 'limit', 'range', 'match', 'filter', 'or']) q[m] = chain
    for (const m of ['insert', 'update', 'upsert', 'delete']) q[m] = () => { writes.push(`${m}:${table}`); return q }
    const result = () => ({
      data: table === 'company_members' ? { company_id: CO_A, role: 'owner' } : null,
      error: null,
      count: 0,
    })
    q.single = async () => result()
    q.maybeSingle = async () => result()
    q.then = (ok: (v: unknown) => unknown, ng?: (e: unknown) => unknown) =>
      Promise.resolve({ ...result(), data: table === 'company_members' ? [{ company_id: CO_A, role: 'owner' }] : [] }).then(ok, ng)
    return q
  }
  return {
    from,
    rpc: async (name: string) => { writes.push(`rpc:${name}`); return { data: null, error: null } },
    auth: { getUser: async () => ({ data: { user: { id: 'user-a' } }, error: null }) },
    storage: { from: () => ({ upload: async () => { writes.push('storage:upload'); return { data: null, error: null } } }) },
  }
}

vi.mock('@/lib/supabase/server', () => ({ getServerClient: async () => fakeClient() }))

beforeEach(() => {
  writes = []
  ownership.activeProject = false
  ownership.ownLineEvent = true
})

const json = (url: string, body: unknown) =>
  new NextRequest(`http://localhost${url}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })

function noteReq(projectId: string) {
  const fd = new FormData()
  fd.append('note_type', 'text')
  fd.append('content', '追記')
  fd.append('project_id', projectId)
  return new NextRequest('http://localhost/api/line-events/x/notes', { method: 'POST', body: fd })
}

const routes: Array<[string, () => Promise<Response>]> = [
  ['POST /api/cost-ledger', async () => (await import('@/app/api/cost-ledger/route')).POST(json('/api/cost-ledger', { project_id: P_B }))],
  ['POST /api/cost-ledger/init', async () => (await import('@/app/api/cost-ledger/init/route')).POST(json('/api/cost-ledger/init', { project_id: P_B }))],
  ['POST /api/cost-ledger/sync', async () => (await import('@/app/api/cost-ledger/sync/route')).POST(json('/api/cost-ledger/sync', { project_id: P_B }))],
  ['POST /api/estimate-groups', async () => (await import('@/app/api/estimate-groups/route')).POST(json('/api/estimate-groups', { project_id: P_B, label: '工種' }))],
  ['POST /api/estimate-revisions', async () => (await import('@/app/api/estimate-revisions/route')).POST(json('/api/estimate-revisions', { project_id: P_B, subtotal: 0, misc_expense: 0, rounding_discount: 0, tax_amount: 0, total: 0 }))],
  ['POST /api/invoices', async () => (await import('@/app/api/invoices/route')).POST(json('/api/invoices', { project_id: P_B }))],
  ['POST /api/project-notes', async () => (await import('@/app/api/project-notes/route')).POST(json('/api/project-notes', { project_id: P_B, content: 'メモ' }))],
  ['GET /api/project-billing', async () => (await import('@/app/api/project-billing/route')).GET(new NextRequest(`http://localhost/api/project-billing?project_id=${P_B}`))],
  ['POST /api/line-events/[id]/notes', async () => (await import('@/app/api/line-events/[id]/notes/route')).POST(noteReq(P_B), { params: Promise.resolve({ id: EVENT_A }) })],
  ['POST /api/ai/chat/confirm-change（create）', async () => (await import('@/app/api/ai/chat/confirm-change/route')).POST(json('/api/ai/chat/confirm-change', {
    change: { id: 'c1', target_table: 'estimate_items', change_type: 'create', proposed: { project_id: P_B, name: '項目', quantity: 1, unit: '式' } },
  }))],
  ['POST /api/ai/chat/confirm-change（bulk_create）', async () => (await import('@/app/api/ai/chat/confirm-change/route')).POST(json('/api/ai/chat/confirm-change', {
    change: { id: 'c2', target_table: 'estimate_items', change_type: 'bulk_create', proposed: { project_id: P_B, items: [{ name: '項目', quantity: 1, unit: '式' }] } },
  }))],
]

describe.each(routes)('%s', (_name, call) => {
  it('自社の有効な案件でなければ 404 を返し、DB・Storage に書き込まない', async () => {
    const res = await call()
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Project not found' })
    expect(writes).toEqual([])
  })
})

describe('POST /api/line-events/[id]/notes', () => {
  it('起点の LINE イベントが自社のものでなければ 404 を返し、書き込まない', async () => {
    ownership.ownLineEvent = false
    ownership.activeProject = true
    const { POST } = await import('@/app/api/line-events/[id]/notes/route')
    const res = await POST(noteReq(P_B), { params: Promise.resolve({ id: EVENT_A }) })
    expect(res.status).toBe(404)
    expect(writes).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// KI-002 PR-2: 工種（見積グループ）の所属確認。fakeClient は estimate_groups を常に空で返す
// （＝他社・別案件・削除済み・存在しない）。実 DB での検証は __tests__/db/company-isolation-groups.db.test.ts
// ─────────────────────────────────────────────────────────────────────────────

const G_FOREIGN = '00000000-0000-4000-8000-000000000041'

describe('checkOptionalGroup', () => {
  it('null・省略は ok、UUID でない値は invalid、見つからない工種は not_found', async () => {
    const { checkOptionalGroup } = await import('@/lib/estimate/ownership')
    const db = fakeClient() as never
    expect(await checkOptionalGroup(db, undefined, P_B, CO_A)).toBe('ok')
    expect(await checkOptionalGroup(db, null, P_B, CO_A)).toBe('ok')
    expect(await checkOptionalGroup(db, 'not-a-uuid', P_B, CO_A)).toBe('invalid')
    expect(await checkOptionalGroup(db, 123, P_B, CO_A)).toBe('invalid')
    expect(await checkOptionalGroup(db, G_FOREIGN, P_B, CO_A)).toBe('not_found')
  })
})

describe('POST /api/ai/chat/confirm-change の工種', () => {
  const confirm = async (change_type: string, proposed: Record<string, unknown>) =>
    (await import('@/app/api/ai/chat/confirm-change/route')).POST(json('/api/ai/chat/confirm-change', {
      change: { id: 'c', target_table: 'estimate_items', change_type, proposed },
    }))
  const item = { name: '項目', quantity: 1, unit: '式' }

  beforeEach(() => { ownership.activeProject = true })

  it.each<[string, () => Promise<Response>]>([
    ['create の group_id', () => confirm('create', { project_id: P_B, ...item, group_id: G_FOREIGN })],
    ['bulk_create の target_group_id', () => confirm('bulk_create', { project_id: P_B, target_group_id: G_FOREIGN, items: [item] })],
    ['bulk_create の行の group_id', () => confirm('bulk_create', { project_id: P_B, items: [item, { ...item, group_id: G_FOREIGN }] })],
  ])('%s が自社のこの案件の工種でなければ 404 を返し、書き込まない', async (_l, call) => {
    const res = await call()
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Group not found' })
    expect(writes).toEqual([])
  })

  it('工種 ID の形式が不正なら 400 を返し、書き込まない', async () => {
    const res = await confirm('create', { project_id: P_B, ...item, group_id: 'not-a-uuid' })
    expect(res.status).toBe(400)
    expect(writes).toEqual([])
  })

  it('update は DB 上の項目が見つからなければ 404 を返し、書き込まない', async () => {
    const res = await confirm('update', { id: G_FOREIGN, name: '書き換え', project_id: P_B })
    expect(res.status).toBe(404)
    expect(writes).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 朝のブリーフィング・請求状況（admin クライアントは RLS を通らない）
// ─────────────────────────────────────────────────────────────────────────────

describe('isOwnCompanyProjectRow', () => {
  it('行と埋め込み案件の会社が一致し、対象会社のものだけ通す', async () => {
    const { isOwnCompanyProjectRow } = await import('@/lib/services/billing-status')
    const own = { company_id: CO_A, projects: { company_id: CO_A } }
    expect(isOwnCompanyProjectRow(own)).toBe(true)
    expect(isOwnCompanyProjectRow(own, CO_A)).toBe(true)
    expect(isOwnCompanyProjectRow(own, CO_B)).toBe(false)
    expect(isOwnCompanyProjectRow({ company_id: CO_A, projects: { company_id: CO_B } }, CO_A)).toBe(false)
    expect(isOwnCompanyProjectRow({ company_id: CO_A, projects: { company_id: CO_B } })).toBe(false)
    expect(isOwnCompanyProjectRow({ company_id: CO_A, projects: null }, CO_A)).toBe(false)
    expect(isOwnCompanyProjectRow({ company_id: null, projects: { company_id: null } })).toBe(false)
  })
})

/** フィルタを無視して決まった行を返す（DB 側の絞り込みが効かなかった場合を再現） */
function leakyClient(rows: Record<string, unknown[]>) {
  const from = (table: string) => {
    const q: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'neq', 'is', 'in', 'not', 'lt', 'lte', 'gt', 'gte', 'order', 'limit']) q[m] = () => q
    q.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: rows[table] ?? [], error: null, count: 1 }).then(ok)
    return q
  }
  return { from }
}

const OLD = '2026-01-05'
const leakedRows = {
  project_billing_milestones: [
    { id: 'm-ok', project_id: 'p-a', company_id: CO_A, type: '着工金', invoice_date: OLD, invoice_amount: 300000, payment_date: null,
      projects: { id: 'p-a', name: 'A社の案件', status: 'collecting', company_id: CO_A, deleted_at: null } },
    { id: 'm-leak', project_id: P_B, company_id: CO_A, type: '契約金', invoice_date: OLD, invoice_amount: 500000, payment_date: null,
      projects: { id: P_B, name: 'B社の秘密案件', status: 'collecting', company_id: CO_B, deleted_at: null } },
    { id: 'm-other', project_id: P_B, company_id: CO_B, type: '契約金', invoice_date: OLD, invoice_amount: 700000, payment_date: null,
      projects: { id: P_B, name: 'B社の秘密案件', status: 'collecting', company_id: CO_B, deleted_at: null } },
  ],
  invoice_documents: [
    { id: 'i-leak', project_id: P_B, company_id: CO_A, invoice_number: 'INV-X', customer_name: 'B社顧客', status: 'issued', issued_at: OLD, payment_due_at: OLD,
      projects: { id: P_B, name: 'B社の秘密案件', company_id: CO_B, deleted_at: null } },
  ],
}

describe('getCompanyBillingStatus / getDailyBriefingItems', () => {
  it('他社の案件を指す行・他社の行が返ってきても、案件名・ID・金額に含めない', async () => {
    const { getCompanyBillingStatus } = await import('@/lib/services/billing-status')
    const s = await getCompanyBillingStatus(leakyClient(leakedRows) as never, CO_A)
    expect(JSON.stringify(s)).not.toContain('B社の秘密案件')
    expect(JSON.stringify(s)).not.toContain(P_B)
    expect(s.total_unpaid_amount).toBe(300000)
    expect(s.issued_invoices).toEqual([])
  })

  it('朝のブリーフィングと LINE 本文に他社の案件名を出さない', async () => {
    const { getDailyBriefingItems, formatBriefingMessage } = await import('@/lib/services/daily-briefing')
    const items = await getDailyBriefingItems(leakyClient(leakedRows) as never, undefined, CO_A)
    const text = JSON.stringify(items) + formatBriefingMessage(items, '2026-10-11')
    expect(text).not.toContain('B社の秘密案件')
    expect(text).not.toContain(P_B)
    expect(items.some(i => i.projectId === 'p-a')).toBe(true)
  })
})
