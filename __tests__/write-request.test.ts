import { describe, it, expect, vi, afterEach } from 'vitest'
import { writeRequest, jsonInit, NETWORK_ERROR_MESSAGE } from '@/lib/api/write-request'

afterEach(() => { vi.unstubAllGlobals() })

const stubFetch = (impl: () => Promise<Response>) => vi.stubGlobal('fetch', vi.fn(impl))

describe('writeRequest', () => {
  it('成功: サーバーが返した値を data として返す', async () => {
    stubFetch(async () => new Response(JSON.stringify({ id: 'a', selling_price: 145000 }), { status: 200 }))
    const r = await writeRequest<{ selling_price: number }>('/api/x', jsonInit('PATCH', { selling_price: 145000 }), '保存に失敗しました')
    expect(r).toEqual({ ok: true, data: { id: 'a', selling_price: 145000 } })
  })

  it('HTTP エラー: サーバーの error メッセージを返す（成功扱いしない）', async () => {
    stubFetch(async () => new Response(JSON.stringify({ error: '権限がありません' }), { status: 403 }))
    const r = await writeRequest('/api/x', jsonInit('PATCH', {}), '保存に失敗しました')
    expect(r).toEqual({ ok: false, message: '権限がありません', status: 403 })
  })

  it('HTTP エラー: 本文が JSON でない場合は既定文言 + ステータス', async () => {
    stubFetch(async () => new Response('<html>Internal Server Error</html>', { status: 500 }))
    const r = await writeRequest('/api/x', jsonInit('DELETE'), '削除に失敗しました')
    expect(r).toEqual({ ok: false, message: '削除に失敗しました（500）', status: 500 })
  })

  it('通信例外（オフライン等で fetch が throw）: 例外を外へ漏らさず失敗として返す', async () => {
    stubFetch(async () => { throw new TypeError('Failed to fetch') })
    const r = await writeRequest('/api/x', jsonInit('PATCH', {}), '保存に失敗しました')
    expect(r).toEqual({ ok: false, message: NETWORK_ERROR_MESSAGE, status: null })
  })

  it('成功で本文が空でも ok（DELETE 等）', async () => {
    stubFetch(async () => new Response(null, { status: 204 }))
    const r = await writeRequest('/api/x', jsonInit('DELETE'), '削除に失敗しました')
    expect(r).toEqual({ ok: true, data: null })
  })
})

describe('jsonInit', () => {
  it('body ありは JSON ヘッダーと文字列化した本文', () => {
    expect(jsonInit('PATCH', { a: 1 })).toEqual({ method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"a":1}' })
  })
  it('body なしは method のみ', () => {
    expect(jsonInit('DELETE')).toEqual({ method: 'DELETE' })
  })
})
