import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * AI チャット経由の実績原価（actual_cost）変更の保護（P1-3 / PR #32）。
 *   - executeUpdateCostLedger … 請求書がある項目には actual_cost の変更案を作らない
 *   - POST /api/ai/chat/confirm-change … 確定時にも請求書の件数を確かめ、あれば 409 actual_cost_locked
 * Supabase はメモリ上の偽クライアント（RLS・制約の再現はしない。件数と更新だけ）。
 */

type Row = Record<string, unknown>

const PROJECT = 'project-1'
const ITEM = '00000000-0000-4000-8000-000000000021'

let items: Row[]
let invoices: Row[]
let failCount: boolean
let updates: Row[]

function from(table: string) {
  const filters: Array<(r: Row) => boolean> = []
  let head = false
  let payload: Row | null = null
  const rows = () => (table === 'cost_ledger_items' ? items : table === 'cost_ledger_invoices' ? invoices : [{ company_id: 'co' }])
  const run = () => {
    if (head) {
      if (failCount) return { data: null, count: null, error: { code: '57014', message: 'timeout' } }
      return { data: null, count: rows().filter(r => filters.every(f => f(r))).length, error: null }
    }
    const hit = rows().filter(r => filters.every(f => f(r)))
    if (payload) {
      updates.push(payload)
      for (const r of hit) Object.assign(r, payload)
    }
    return { data: hit, error: null }
  }
  const one = () => {
    const { data, error } = run()
    if (error) return Promise.resolve({ data: null, error })
    return Promise.resolve({ data: data && data.length === 1 ? data[0] : null, error: null })
  }
  const q = {
    select: (_c?: string, opts?: { head?: boolean }) => { if (opts?.head && !payload) head = true; return q },
    eq: (col: string, v: unknown) => { filters.push(r => col === 'user_id' || r[col] === v); return q },
    is: (col: string, v: unknown) => { filters.push(r => (r[col] ?? null) === v); return q },
    update: (p: Row) => { payload = p; return q },
    single: one,
    maybeSingle: one,
    then: (resolve: (v: unknown) => unknown) => resolve(run()),
  }
  return q
}

const supabase = {
  auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) },
  from,
}

vi.mock('@/lib/supabase/server', () => ({ getServerClient: async () => supabase }))

const { executeUpdateCostLedger } = await import('@/lib/ai/chat/tool-executor')
const { POST: confirmChange } = await import('@/app/api/ai/chat/confirm-change/route')

const ctx = { projectId: PROJECT, companyId: 'co', supabase: supabase as unknown as SupabaseClient }

async function confirm(proposed: Row) {
  const req = new NextRequest('http://localhost/api/ai/chat/confirm-change', {
    method: 'POST',
    body: JSON.stringify({ change: { id: 'c1', target_table: 'cost_ledger_items', change_type: 'update', proposed, original: {} } }),
  })
  const res = await confirmChange(req)
  return { status: res.status, json: await res.json() as Record<string, unknown> }
}

beforeEach(() => {
  items = [{ id: ITEM, project_id: PROJECT, name: 'システムバス', budget_cost: 100000, actual_cost: 30000, vendor_name: null, note: null, deleted_at: null }]
  invoices = []
  failCount = false
  updates = []
})

describe('AI の変更案（executeUpdateCostLedger）', () => {
  it('請求書が0件なら actual_cost の変更案を作る（従来どおり）', async () => {
    const r = await executeUpdateCostLedger({ item_id: ITEM, actual_cost: 42000 }, ctx)
    expect(r.status).toBe('pending_change')
  })

  it('請求書がある項目には actual_cost の変更案を作らず、理由を返す', async () => {
    invoices = [{ id: 'inv-1', cost_ledger_item_id: ITEM, amount: 30000 }]
    const r = await executeUpdateCostLedger({ item_id: ITEM, actual_cost: 42000 }, ctx)
    expect(r.status).toBe('not_found')
    expect((r as { hint: string }).hint).toContain('業者請求書が登録されているため')
  })

  it('請求書の件数を確認できなければ変更案を作らない', async () => {
    failCount = true
    const r = await executeUpdateCostLedger({ item_id: ITEM, actual_cost: 42000 }, ctx)
    expect(r.status).toBe('not_found')
  })

  it('請求書がある項目でも、actual_cost 以外（予算など）の変更案は作れる', async () => {
    invoices = [{ id: 'inv-1', cost_ledger_item_id: ITEM, amount: 30000 }]
    const r = await executeUpdateCostLedger({ item_id: ITEM, budget_cost: 90000 }, ctx)
    expect(r.status).toBe('pending_change')
  })
})

describe('AI の変更確定（POST /api/ai/chat/confirm-change）', () => {
  it('請求書が0件なら actual_cost を書き込む', async () => {
    const r = await confirm({ id: ITEM, actual_cost: 42000 })
    expect(r.status).toBe(200)
    expect(items[0].actual_cost).toBe(42000)
  })

  it('提案後に請求書が登録された項目は、確定時に 409 actual_cost_locked で拒否する', async () => {
    invoices = [{ id: 'inv-1', cost_ledger_item_id: ITEM, amount: 30000 }]
    const r = await confirm({ id: ITEM, actual_cost: 42000, budget_cost: 1 })
    expect(r.status).toBe(409)
    expect(r.json.code).toBe('actual_cost_locked')
    expect(updates).toEqual([])
    expect(items[0]).toEqual(expect.objectContaining({ actual_cost: 30000, budget_cost: 100000 }))
  })

  it('件数を確認できなければ書き込まない（500）', async () => {
    failCount = true
    const r = await confirm({ id: ITEM, actual_cost: 42000 })
    expect(r.status).toBe(500)
    expect(updates).toEqual([])
    expect(JSON.stringify(r.json)).not.toContain('timeout')
  })

  it('請求書がある項目でも actual_cost を含まない変更は確定できる', async () => {
    invoices = [{ id: 'inv-1', cost_ledger_item_id: ITEM, amount: 30000 }]
    const r = await confirm({ id: ITEM, budget_cost: 90000 })
    expect(r.status).toBe(200)
    expect(items[0]).toEqual(expect.objectContaining({ budget_cost: 90000, actual_cost: 30000 }))
  })
})
