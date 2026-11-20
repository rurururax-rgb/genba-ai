/**
 * 「過去見積から追加」の通信・表示の関数（lib/estimate/past-copy-client.ts）。fetch は模擬する。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  copyFromPast,
  describeCopyPrice,
  formatDate,
  formatSignedYen,
  formatYen,
  searchPastEstimates,
  UNKNOWN_RESULT_MESSAGE,
} from '@/lib/estimate/past-copy-client'
import type { PastCopyPricePreview } from '@/lib/estimate/past-copy'

const P = '00000000-0000-4000-8000-000000000011'
const S1 = '00000000-0000-4000-8000-000000000101'
const body = { project_id: P, group_id: null, items: [{ source_item_id: S1, fingerprint: 'v1-00000000000001' }] }
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const fn = vi.fn(impl)
  vi.stubGlobal('fetch', fn)
  return fn
}

describe('copyFromPast', () => {
  it('備考・社内メモは常に false で送る', async () => {
    const f = stubFetch(async () => json({ inserted_count: 1 }, 201))
    await copyFromPast(body)
    const sent = JSON.parse(f.mock.calls[0][1]!.body as string)
    expect(sent).toEqual({ ...body, include_memo: false, include_internal_memo: false })
    expect(f.mock.calls[0][0]).toBe('/api/estimate-items/copy-from-past')
  })

  it('201 → success', async () => {
    stubFetch(async () => json({ inserted_count: 3 }, 201))
    expect(await copyFromPast(body)).toEqual({ kind: 'success', count: 3 })
  })

  it('409（changed あり）→ changed', async () => {
    const changed = [{ source_item_id: S1, copy_preview: { fingerprint: 'v1-2' } }]
    stubFetch(async () => json({ error: 'x', changed }, 409))
    expect(await copyFromPast(body)).toEqual({ kind: 'changed', changed })
  })

  it('409（並び順の空きなし）→ rejected でサーバーの文言', async () => {
    stubFetch(async () => json({ error: '並び順に空きがありません' }, 409))
    expect(await copyFromPast(body)).toEqual({ kind: 'rejected', status: 409, message: '並び順に空きがありません' })
  })

  it('404（コピー元）→ missing、404（コピー先）→ rejected', async () => {
    stubFetch(async () => json({ missing_source_item_ids: [S1] }, 404))
    expect(await copyFromPast(body)).toEqual({ kind: 'missing', ids: [S1] })
    stubFetch(async () => json({ error: 'Group not found' }, 404))
    expect(await copyFromPast(body)).toMatchObject({ kind: 'rejected', status: 404, message: expect.stringContaining('コピー先') })
  })

  it('401 / 403 / 400 は rejected（登録していない）', async () => {
    stubFetch(async () => json({ error: 'Unauthorized' }, 401))
    expect(await copyFromPast(body)).toMatchObject({ kind: 'rejected', status: 401, message: expect.stringContaining('ログイン') })
    stubFetch(async () => json({ error: 'No company' }, 403))
    expect(await copyFromPast(body)).toMatchObject({ kind: 'rejected', status: 403, message: expect.stringContaining('権限') })
    stubFetch(async () => json({ error: '同じ明細が重複して指定されています' }, 400))
    expect(await copyFromPast(body)).toMatchObject({ kind: 'rejected', status: 400, message: '同じ明細が重複して指定されています' })
  })

  it('通信エラー・5xx・本文が壊れた 5xx は unknown（登録できたか不明）', async () => {
    stubFetch(async () => { throw new TypeError('Failed to fetch') })
    expect(await copyFromPast(body)).toEqual({ kind: 'unknown', message: UNKNOWN_RESULT_MESSAGE })
    stubFetch(async () => json({ error: 'x' }, 500))
    expect((await copyFromPast(body)).kind).toBe('unknown')
    stubFetch(async () => new Response('<html>Gateway Timeout</html>', { status: 504 }))
    expect((await copyFromPast(body)).kind).toBe('unknown')
  })

  it('タイムアウトしたら中断して unknown。再送しない', async () => {
    const f = stubFetch((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    }))
    const outcome = await copyFromPast(body, 20)
    expect(outcome.kind).toBe('unknown')
    expect(f).toHaveBeenCalledTimes(1)
  })
})

describe('searchPastEstimates', () => {
  it('検索語・案件・件数をクエリで送る', async () => {
    const f = stubFetch(async () => json({ items: [], has_more: false }))
    await searchPastEstimates('キッチン 交換', P)
    const url = new URL(f.mock.calls[0][0], 'http://x')
    expect(url.pathname).toBe('/api/estimate-items/search-past')
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: 'キッチン 交換', project_id: P, limit: '30' })
  })

  it('中断は aborted、エラーは error（401 はログインの案内）', async () => {
    stubFetch(async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }) })
    expect(await searchPastEstimates('a', P)).toEqual({ kind: 'aborted' })
    stubFetch(async () => json({ error: 'Unauthorized' }, 401))
    expect(await searchPastEstimates('a', P)).toMatchObject({ kind: 'error', status: 401, message: expect.stringContaining('ログイン') })
    stubFetch(async () => json({ error: '検索語は50文字以内で入力してください' }, 400))
    expect(await searchPastEstimates('a', P)).toMatchObject({ kind: 'error', message: '検索語は50文字以内で入力してください' })
  })
})

describe('describeCopyPrice', () => {
  const base: PastCopyPricePreview = {
    basis: 'auto_recalculated', selling_price_mode: 'auto', past_selling_price: 145000, new_selling_price: 130000,
    difference: -15000, changed: true, applied_markup_rate: 1.3,
  }
  it('auto で変わる → 差額', () => {
    expect(describeCopyPrice(base)).toMatchObject({ tone: 'changed', badge: '過去より −¥15,000' })
    expect(describeCopyPrice({ ...base, new_selling_price: 150000, difference: 5000 }).badge).toBe('過去より +¥5,000')
  })
  it('auto で同じ → 過去と同じ', () => {
    expect(describeCopyPrice({ ...base, new_selling_price: 145000, difference: 0, changed: false })).toMatchObject({ tone: 'same', badge: '過去と同じ' })
  })
  it('auto で過去の売価なし → 原価から計算', () => {
    expect(describeCopyPrice({ ...base, past_selling_price: null, difference: null })).toMatchObject({ tone: 'changed', badge: '原価から計算' })
  })
  it('manual → 固定（0 円は「0円で固定」）', () => {
    expect(describeCopyPrice({ ...base, basis: 'manual_kept', selling_price_mode: 'manual', new_selling_price: 98000, changed: false })).toMatchObject({ tone: 'fixed', badge: '手入力の売価で固定' })
    expect(describeCopyPrice({ ...base, basis: 'manual_kept', selling_price_mode: 'manual', past_selling_price: 0, new_selling_price: 0, difference: 0, changed: false })).toMatchObject({ tone: 'fixed', badge: '0円で固定' })
  })
  it('原価なし → 売価なし', () => {
    expect(describeCopyPrice({ ...base, basis: 'no_cost', new_selling_price: null, difference: null })).toMatchObject({ tone: 'unset', badge: '売価なし' })
  })
})

describe('表示の整形', () => {
  it('金額', () => {
    expect(formatYen(1234567)).toBe('¥1,234,567')
    expect(formatYen(0)).toBe('¥0')
    expect(formatYen(null)).toBe('—')
    expect(formatSignedYen(0)).toBe('±¥0')
  })
  it('日付は日本時間', () => {
    expect(formatDate('2026-02-28T16:00:00Z')).toBe('2026/03/01')
    expect(formatDate('x')).toBe('')
    expect(formatDate(null)).toBe('')
  })
})
