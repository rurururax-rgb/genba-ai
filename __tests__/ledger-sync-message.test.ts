import { describe, it, expect, vi, afterEach } from 'vitest'
import { syncResultMessage } from '@/lib/cost-ledger/sync-message'
import { protectionReasons } from '@/lib/cost-ledger/ledger-protection'
import { writeRequest } from '@/lib/api/write-request'

/** KI-005: 見積同期で残した項目の案内・保護の理由・API のエラーコードの受け渡し */

afterEach(() => vi.unstubAllGlobals())

describe('protectionReasons', () => {
  it('請求書・実績原価・実行予算・完工予算のどれかがあれば守る。すべて空なら守らない（0 円も値として守る）', () => {
    const empty = { actual_cost: null, budget_cost: null, completion_cost: null }
    expect(protectionReasons(empty, 0)).toEqual([])
    expect(protectionReasons(empty, 2)).toEqual(['invoices'])
    expect(protectionReasons({ ...empty, actual_cost: 0 }, 0)).toEqual(['actual_cost'])
    expect(protectionReasons({ actual_cost: 1, budget_cost: 2, completion_cost: 3 }, 1))
      .toEqual(['invoices', 'actual_cost', 'budget_cost', 'completion_cost'])
  })
})

describe('syncResultMessage', () => {
  it('残した項目を、理由とともに知らせる', () => {
    const msg = syncResultMessage({
      added: 1, updated: 0, removed: 2,
      kept: [
        { id: 'a', name: '給湯器交換', reasons: ['invoices', 'actual_cost'] },
        { id: 'b', name: '外構', reasons: ['budget_cost'] },
        { id: 'c', name: '内装', reasons: [] },
      ],
    })
    expect(msg).toContain('同期完了：追加 1件・削除 2件')
    expect(msg).toContain('見積から削除された 3件 は、原価台帳に残しました')
    expect(msg).toContain('・給湯器交換（業者請求書・実績原価あり）')
    expect(msg).toContain('・外構（実行予算あり）')
    expect(msg).toContain('・内装（同期中に値が入力されたため）')
    expect(msg).toContain('「見積から削除済み」')
  })

  it('残した項目がなければ従来どおり。11 件以上は「ほか N件」', () => {
    expect(syncResultMessage({ added: 0, updated: 0, removed: 0 })).toBe('差分なし（変更はありませんでした）')
    const kept = Array.from({ length: 12 }, (_, i) => ({ id: `${i}`, name: `項目${i}`, reasons: ['budget_cost' as const] }))
    expect(syncResultMessage({ added: 0, updated: 0, removed: 0, kept })).toContain('・ほか 2件')
  })
})

describe('writeRequest：サーバーのエラーコードを返す', () => {
  it('409 の code（needs_confirm）を呼び出し側に渡す。code が無ければ付けない', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: '確認してください', code: 'needs_confirm' }), { status: 409 })))
    expect(await writeRequest('/x', { method: 'DELETE' }, '失敗')).toEqual({ ok: false, message: '確認してください', status: 409, code: 'needs_confirm' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'だめ' }), { status: 500 })))
    expect(await writeRequest('/x', { method: 'DELETE' }, '失敗')).toEqual({ ok: false, message: 'だめ', status: 500 })
  })
})
