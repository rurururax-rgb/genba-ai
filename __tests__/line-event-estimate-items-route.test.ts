import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { mapAddEstimateItemsError, parseAddRequest } from '@/lib/line-events/add-estimate-items'

/**
 * POST /api/estimate-items（AI整理タブの「見積に追加」・KI-001）。
 * Supabase は偽クライアントで置き換え、API が RPC add_line_event_estimate_items だけを呼ぶこと
 * （テーブルへ直接書き込まない）と、入力検証・エラー変換を確かめる。
 * RPC そのもの（会社の一致・紐付け・同時実行・RLS）は __tests__/db の隔離 DB 検証で行う。
 */

const PROJECT = '00000000-0000-4000-8000-000000000011'
const EVENT   = '00000000-0000-4000-8000-000000000021'

let currentUser: { id: string } | null
let rpcResult: { data: unknown; error: { code: string; message: string } | null }
const rpc  = vi.fn()
const from = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  getServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: currentUser } }) },
    rpc:  (...args: unknown[]) => { rpc(...args); return Promise.resolve(rpcResult) },
    from: (...args: unknown[]) => { from(...args); throw new Error('direct table access is not expected') },
  }),
}))

const { POST } = await import('@/app/api/estimate-items/route')

const post = (body: unknown) =>
  POST(new NextRequest('http://localhost/api/estimate-items', { method: 'POST', body: JSON.stringify(body) }))

const ITEM = { name: 'システムバス', unit: '式', selling_price: 850000, category: '設備', quantity: null, memo: null }

beforeEach(() => {
  currentUser = { id: 'user-a' }
  rpcResult = { data: { created: 1, project_id: PROJECT, line_event_id: EVENT, linked: true }, error: null }
  rpc.mockClear()
  from.mockClear()
})

describe('POST /api/estimate-items', () => {
  it('RPC を 1 回だけ呼び、追加件数と紐付け結果を返す（テーブルへの直接書き込みはしない）', async () => {
    const res = await post({ project_id: PROJECT, line_event_id: EVENT, items: [ITEM] })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ created: 1, project_id: PROJECT, linked: true })
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('add_line_event_estimate_items', {
      p_project_id: PROJECT, p_line_event_id: EVENT, p_items: [ITEM],
    })
    expect(from).not.toHaveBeenCalled()
  })

  it('company_id など余計なキーは RPC に渡さない', async () => {
    await post({ project_id: PROJECT, line_event_id: EVENT, company_id: 'x', items: [{ ...ITEM, company_id: 'x', project_id: 'y' }] })
    const args = rpc.mock.calls[0][1] as { p_items: Record<string, unknown>[] }
    expect(Object.keys(args)).toEqual(['p_project_id', 'p_line_event_id', 'p_items'])
    expect(Object.keys(args.p_items[0]).sort()).toEqual(['category', 'memo', 'name', 'quantity', 'selling_price', 'unit'])
  })

  it('未認証は 401（RPC を呼ばない）', async () => {
    currentUser = null
    const res = await post({ project_id: PROJECT, line_event_id: EVENT, items: [ITEM] })
    expect(res.status).toBe(401)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('入力が不正なら 400（RPC を呼ばない）', async () => {
    for (const body of [
      null,
      { line_event_id: EVENT, items: [ITEM] },
      { project_id: 'not-a-uuid', line_event_id: EVENT, items: [ITEM] },
      { project_id: PROJECT, line_event_id: EVENT, items: [] },
      { project_id: PROJECT, line_event_id: EVENT, items: [{ ...ITEM, name: ' ' }] },
      { project_id: PROJECT, line_event_id: EVENT, items: [{ ...ITEM, selling_price: '1000' }] },
    ]) {
      const res = await post(body)
      expect(res.status).toBe(400)
    }
    expect(rpc).not.toHaveBeenCalled()
  })

  it.each([
    ['LE404', 'not_found', 404, 'not_found'],
    ['LE403', 'company_mismatch', 403, 'company_mismatch'],
    ['LE409', 'linked_to_other_project', 409, 'linked_to_other_project'],
    ['LE409', 'already_reflected', 409, 'already_reflected'],
    ['55P03', 'lock timeout', 503, 'busy'],
  ])('RPC のエラー %s %s → %i（DB のエラー文は返さない）', async (code, message, status, outCode) => {
    rpcResult = { data: null, error: { code, message } }
    const res = await post({ project_id: PROJECT, line_event_id: EVENT, items: [ITEM] })
    expect(res.status).toBe(status)
    const body = await res.json() as { error: string; code: string }
    expect(body.code).toBe(outCode)
    expect(body.error).not.toContain(message)
  })
})

describe('parseAddRequest / mapAddEstimateItemsError', () => {
  it('省略された任意項目は null に揃える', () => {
    expect(parseAddRequest({ project_id: PROJECT, line_event_id: EVENT, items: [{ name: 'a', unit: '式', selling_price: null }] }))
      .toEqual({ project_id: PROJECT, line_event_id: EVENT, items: [{ name: 'a', unit: '式', selling_price: null, category: null, quantity: null, memo: null }] })
  })

  it('101 件以上・数値でない数量は拒否', () => {
    const many = Array.from({ length: 101 }, () => ({ name: 'a', unit: '式', selling_price: 1 }))
    expect(parseAddRequest({ project_id: PROJECT, line_event_id: EVENT, items: many })).toBeNull()
    expect(parseAddRequest({ project_id: PROJECT, line_event_id: EVENT, items: [{ ...ITEM, quantity: Number.NaN }] })).toBeNull()
  })

  it('未知のエラー（関数が無い PGRST202 等）は 500、変換エラー 22xxx は 400', () => {
    expect(mapAddEstimateItemsError({ code: 'PGRST202' }).status).toBe(500)
    expect(mapAddEstimateItemsError({ code: '22P02' }).status).toBe(400)
    expect(mapAddEstimateItemsError({ code: 'LE401' }).status).toBe(401)
    expect(mapAddEstimateItemsError({ code: 'LE409', message: 'event_not_updated' }).body.code).toBe('conflict')
  })
})
