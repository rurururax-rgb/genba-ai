import { describe, it, expect } from 'vitest'
import { classifyImportResponse, findSavedImport } from '@/lib/estimate/import-result'

/** 取り込み API の結果の見分け方（lib/estimate/import-result.ts）。すべて架空の明細 */

const json = (b: unknown, status: number) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })

describe('結果の見分け方', () => {
  it('2xx は保存済み（本文を返す）', async () => {
    expect(await classifyImportResponse(json({ created: 1 }, 200))).toEqual({ kind: 'saved', body: { created: 1 } })
  })
  it('応答が届かない（通信が途切れた）は「分からない」。失敗とは扱わない', async () => {
    expect(await classifyImportResponse(null)).toEqual({ kind: 'unknown' })
  })
  it('4xx はサーバーが断った（登録されていない）', async () => {
    expect(await classifyImportResponse(json({ error: 'Project not found' }, 404))).toMatchObject({ kind: 'rejected', error: 'Project not found' })
    expect(await classifyImportResponse(new Response('x', { status: 401 }), '既定')).toMatchObject({ kind: 'rejected', error: '既定' })
  })
  it('5xx は API が not_saved: true を付けたときだけ断った（1 件も入っていない）', async () => {
    expect(await classifyImportResponse(json({ error: 'insert failed', not_saved: true }, 500))).toEqual({ kind: 'rejected', error: 'insert failed' })
  })
  it('エラー本文つきの 500 でも not_saved が無い・false なら「分からない」（API と Supabase の間の通信断はコミット済みのことがある）', async () => {
    expect(await classifyImportResponse(json({ error: 'TypeError: fetch failed' }, 500))).toEqual({ kind: 'unknown' })
    expect(await classifyImportResponse(json({ error: '通信が途切れました', not_saved: false }, 503))).toEqual({ kind: 'unknown' })
  })
  it('409（同じ登録 ID が登録済み）は断った。コードと競合した登録 ID を返す', async () => {
    const r = await classifyImportResponse(json({ error: '登録済み', code: 'import_request_conflict', not_saved: true, import_request_id: 'abc' }, 409))
    expect(r).toEqual({ kind: 'rejected', error: '登録済み', code: 'import_request_conflict', conflictRequestId: 'abc' })
  })
  it('本文のない 5xx（ゲートウェイ・タイムアウト）や 502/503/504 は「分からない」', async () => {
    expect(await classifyImportResponse(new Response('An error occurred', { status: 504 }))).toEqual({ kind: 'unknown' })
    expect(await classifyImportResponse(new Response('', { status: 500 }))).toEqual({ kind: 'unknown' })
    expect(await classifyImportResponse(json({ error: 'bad gateway' }, 502))).toEqual({ kind: 'unknown' })
  })
})

describe('結果の分からなかった登録の照合', () => {
  const base = { group_id: 'g1', name: '架空 給湯器', quantity: 1, unit: '台', cost_price: 100000, sort_order: 1002, source: 'import' }
  const sig = { groupId: 'g1', name: ' 架空 給湯器 ', quantity: 1, unit: '台', cost_price: 100000, sortOrder: 1002 }

  it('送る前に無かった・同じ中身の取り込み明細を見つける（品名の前後の空白はサーバーと同じく除く）', () => {
    expect(findSavedImport([{ id: 'old', ...base }, { id: 'new', ...base }], new Set(['old']), new Set(), sig)?.id).toBe('new')
  })
  it('送る前からあった明細・ほかの登録の結果の明細は、同じ中身でも取り違えない', () => {
    expect(findSavedImport([{ id: 'old', ...base }], new Set(['old']), new Set(), sig)).toBeNull()
    expect(findSavedImport([{ id: 'other', ...base }], new Set(), new Set(['other']), sig)).toBeNull()
  })
  it('工種・数量・単位・原価・並び順・取り込み以外の明細は一致としない', () => {
    for (const p of [{ group_id: 'g2' }, { quantity: 2 }, { unit: '式' }, { cost_price: null }, { sort_order: 1003 }, { source: 'manual' }]) {
      expect(findSavedImport([{ id: 'x', ...base, ...p }], new Set(), new Set(), sig)).toBeNull()
    }
  })
  it('数量・単位が空なら、サーバーと同じく 1・式 として照合する。並び順を指定しなかったときは並び順を見ない', () => {
    const r = { id: 'x', ...base, quantity: 1, unit: '式', sort_order: 77 }
    expect(findSavedImport([r], new Set(), new Set(), { groupId: 'g1', name: '架空 給湯器', quantity: null, unit: null, cost_price: 100000 })?.id).toBe('x')
  })
})
