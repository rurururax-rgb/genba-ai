import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { createRegisterAttempt, postInvoice, UNKNOWN_RESULT_MESSAGE } from '@/lib/cost-ledger/invoice-client'
import {
  actualCostMatchesInvoices, sameInvoiceContent,
  findSimilarInvoices, isIsoDate, isSha256, normalizeInvoiceNumber, normalizeVendorName, parseInvoiceRequest,
  type ExistingInvoice,
} from '@/lib/cost-ledger/invoice-dedupe'

/**
 * 業者請求書の登録（P1-1 / PR #30）: ブラウザ側の送信制御と、似ている請求書の判定。
 * fetch はスタブ。DB・RLS には触れない。
 */

const ITEM = '00000000-0000-4000-8000-000000000021'
const payload = { source: 'manual' as const, amount: 1000, invoice_date: null, payment_date: null, note: null }
const res = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('createRegisterAttempt（連打・再試行）', () => {
  it('5. 送信中の2回目は送らない（useRef 相当の同期ロック）', async () => {
    const attempt = createRegisterAttempt(() => 'k1')
    let release!: () => void
    const send = vi.fn(() => new Promise<string>(r => { release = () => r('done') }))
    const first = attempt.submit(send)
    const second = await attempt.submit(send)
    expect(second).toBeNull()
    expect(send).toHaveBeenCalledTimes(1)
    release()
    expect(await first).toBe('done')
    expect(attempt.busy).toBe(false)
  })

  it('8. 結果が分からない後の再試行は同じキー、reset 後（新しい登録操作）は新しいキー', async () => {
    let n = 0
    const attempt = createRegisterAttempt(() => `k${++n}`)
    const keys: string[] = []
    await attempt.submit(async k => { keys.push(k) })
    await attempt.submit(async k => { keys.push(k) })
    attempt.reset()
    await attempt.submit(async k => { keys.push(k) })
    expect(keys).toEqual(['k1', 'k1', 'k2'])
  })

  it('送信が throw してもロックは外れる', async () => {
    const attempt = createRegisterAttempt(() => 'k')
    await expect(attempt.submit(async () => { throw new Error('x') })).rejects.toThrow()
    expect(attempt.busy).toBe(false)
  })
})

describe('postInvoice（結果の分類）', () => {
  it('idempotency_key を本文に入れて送る', async () => {
    const f = vi.fn(async () => res(200, { invoice: { id: 'i' }, newActualCost: 1000, synced: true, replayed: false }))
    await postInvoice(ITEM, payload, 'key-1', f as unknown as typeof fetch)
    const body = JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    expect(body).toEqual(expect.objectContaining({ idempotency_key: 'key-1', amount: 1000, source: 'manual' }))
  })

  it('保存できた・再送で保存済みだった', async () => {
    const saved = await postInvoice(ITEM, payload, 'k', async () => res(200, { invoice: { id: 'i' }, newActualCost: 1000, synced: true, replayed: true }))
    expect(saved).toEqual(expect.objectContaining({ kind: 'saved', replayed: true, newActualCost: 1000, synced: true }))
  })

  it('16. 保存後の再集計失敗は「保存できた（synced: false）」で、失敗にはしない', async () => {
    const r = await postInvoice(ITEM, payload, 'k', async () => res(200, { invoice: { id: 'i' }, newActualCost: null, synced: false }))
    expect(r).toEqual(expect.objectContaining({ kind: 'saved', synced: false, newActualCost: null }))
  })

  it('通信エラー・5xx は「保存されたか分からない」（同じキーで再送してよい）', async () => {
    const net = await postInvoice(ITEM, payload, 'k', async () => { throw new TypeError('Failed to fetch') })
    expect(net.kind).toBe('unknown')
    expect((net as { message: string }).message).toContain(UNKNOWN_RESULT_MESSAGE)
    expect((await postInvoice(ITEM, payload, 'k', async () => res(500, { error: 'x' }))).kind).toBe('unknown')
    expect((await postInvoice(ITEM, payload, 'k', async () => new Response('<html>', { status: 502 }))).kind).toBe('unknown')
    // 200 でも本文が読めなければ保存の確認ができない
    expect((await postInvoice(ITEM, payload, 'k', async () => new Response('', { status: 200 }))).kind).toBe('unknown')
  })

  it('2. 同じ画像は duplicate_document、10. 似ている請求書は similar', async () => {
    const dup = await postInvoice(ITEM, payload, 'k', async () => res(409, { error: 'この請求書は登録済みです', code: 'duplicate_document', existing: { item_name: 'A' } }))
    expect(dup).toEqual(expect.objectContaining({ kind: 'duplicate_document', message: 'この請求書は登録済みです' }))
    const sim = await postInvoice(ITEM, payload, 'k', async () => res(409, { error: '以前の請求書と似ています', code: 'similar_invoice', similar: [{ id: 'x' }] }))
    expect(sim).toEqual(expect.objectContaining({ kind: 'similar', similar: [{ id: 'x' }] }))
  })

  it('入力不備・キーの食い違いは rejected（保存されていない）', async () => {
    expect(await postInvoice(ITEM, payload, 'k', async () => res(400, { error: '金額を正しく入力してください' })))
      .toEqual({ kind: 'rejected', message: '金額を正しく入力してください', status: 400 })
    expect((await postInvoice(ITEM, payload, 'k', async () => res(409, { error: 'x', code: 'idempotency_conflict' }))).kind).toBe('rejected')
  })
})

describe('入力検証', () => {
  it('ハッシュは小文字16進64文字だけ', () => {
    expect(isSha256('0123456789abcdef'.repeat(4))).toBe(true)
    expect(isSha256('0123456789ABCDEF'.repeat(4))).toBe(false)
    expect(isSha256(' ' + 'a'.repeat(63))).toBe(false)
  })

  it('日付は実在する YYYY-MM-DD だけ', () => {
    expect(isIsoDate('2028-02-29')).toBe(true)
    expect(isIsoDate('2026-02-29')).toBe(false)
    expect(isIsoDate('2026-13-01')).toBe(false)
  })

  it('source 省略は手動登録として扱い、OCR の読み取り情報は持たせない', () => {
    const r = parseInvoiceRequest({ amount: 100, vendor_name: 'x', invoice_number: 'y' })
    expect(r).toEqual({ ok: true, value: expect.objectContaining({ source: 'manual', vendor_name: null, invoice_number: null, document_sha256: null }) })
  })
})

const inv = (p: Partial<ExistingInvoice>): ExistingInvoice => ({
  id: 'x', cost_ledger_item_id: 'i', amount: 33000, invoice_date: '2026-10-01', note: null,
  vendor_name: 'QA設備', invoice_number: null, created_at: '2026-10-01T00:00:00Z', ...p,
})

describe('findSimilarInvoices（以前の請求書と似ている）', () => {
  const cand = { amount: 33000, invoice_date: '2026-10-01', vendor_name: '株式会社 QA設備', invoice_number: 'ＩＮＶ－００１' }

  it('請求書番号は全角・区切り記号・大小の違いを無視して一致', () => {
    expect(normalizeInvoiceNumber('ＩＮＶ－００１')).toBe(normalizeInvoiceNumber('inv 001'))
    expect(findSimilarInvoices(cand, [inv({ invoice_number: 'INV001', amount: 1 })])).toEqual([expect.objectContaining({ reason: 'invoice_number' })])
  })

  it('業者名は法人格・空白を無視', () => {
    expect(normalizeVendorName('(株) QA設備')).toBe(normalizeVendorName('QA設備株式会社'))
  })

  it('請求書番号が同じでも業者名が違えば別の請求書', () => {
    expect(findSimilarInvoices(cand, [inv({ invoice_number: 'INV-001', vendor_name: '別業者' })])).toEqual([])
  })

  it('業者名・金額・請求日がすべて同じなら似ている（番号がない場合）', () => {
    expect(findSimilarInvoices({ ...cand, invoice_number: null }, [inv({})])).toEqual([expect.objectContaining({ reason: 'vendor_amount_date' })])
  })

  it('既存行（vendor_name 列なし）は備考「○○からの請求」の業者名で比べる', () => {
    expect(findSimilarInvoices({ ...cand, invoice_number: null }, [inv({ vendor_name: null, note: 'QA設備からの請求' })])).toHaveLength(1)
  })

  it('9. 金額だけ・業者名と金額だけの一致は似ているとしない（分割請求・定額請求を止めない）', () => {
    const c = { ...cand, invoice_number: null }
    expect(findSimilarInvoices(c, [inv({ vendor_name: null })])).toEqual([])
    expect(findSimilarInvoices(c, [inv({ invoice_date: '2026-11-01' })])).toEqual([])
    expect(findSimilarInvoices({ ...c, invoice_date: null }, [inv({})])).toEqual([])
  })

  it('請求書番号が両方あって違えば、業者名・金額・日付が同じでも別の請求書', () => {
    expect(findSimilarInvoices(cand, [inv({ invoice_number: 'INV-002' })])).toEqual([])
  })
})

describe('sameInvoiceContent（同じキーの再送として扱ってよいか）', () => {
  const req = (over: Record<string, unknown> = {}) => {
    const p = parseInvoiceRequest({
      source: 'ocr', amount: 33000, invoice_date: '2026-10-01', payment_date: '2026-10-31', note: 'メモ',
      vendor_name: 'QA設備', invoice_number: 'INV-001', document_sha256: 'a'.repeat(64),
      idempotency_key: '00000000-0000-4000-8000-000000000101', ...over,
    })
    if (!p.ok) throw new Error(p.error)
    return p.value
  }
  const row = {
    cost_ledger_item_id: ITEM, amount: '33000.00', source: 'ocr', document_sha256: 'a'.repeat(64),
    invoice_date: '2026-10-01', payment_date: '2026-10-31', note: 'メモ', vendor_name: 'QA設備', invoice_number: 'INV-001',
  }

  it('保存する列がすべて同じなら true（numeric の文字列・confirm_similar の違いは無視）', () => {
    expect(sameInvoiceContent(row, ITEM, req())).toBe(true)
    expect(sameInvoiceContent(row, ITEM, req({ confirm_similar: true }))).toBe(true)
  })

  it.each([
    ['台帳項目', () => sameInvoiceContent(row, '00000000-0000-4000-8000-000000000022', req())],
    ['金額', () => sameInvoiceContent(row, ITEM, req({ amount: 33001 }))],
    ['source', () => sameInvoiceContent({ ...row, source: 'manual', document_sha256: null }, ITEM, req())],
    ['ハッシュ', () => sameInvoiceContent(row, ITEM, req({ document_sha256: 'b'.repeat(64) }))],
    ['請求日', () => sameInvoiceContent(row, ITEM, req({ invoice_date: '2026-10-02' }))],
    ['支払日', () => sameInvoiceContent(row, ITEM, req({ payment_date: null }))],
    ['メモ', () => sameInvoiceContent(row, ITEM, req({ note: '別' }))],
    ['業者名', () => sameInvoiceContent(row, ITEM, req({ vendor_name: '別業者' }))],
    ['請求書番号', () => sameInvoiceContent(row, ITEM, req({ invoice_number: 'INV-002' }))],
  ])('%s が違えば false', (_l, f) => {
    expect(f()).toBe(false)
  })

  it('NULL と空文字・空白だけは同じ', () => {
    expect(sameInvoiceContent({ ...row, note: '' }, ITEM, req({ note: null }))).toBe(true)
    expect(sameInvoiceContent({ ...row, note: null }, ITEM, req({ note: '   ' }))).toBe(true)
  })
})

describe('actualCostMatchesInvoices（再送時に原価合計も正常と言えるか）', () => {
  it('内訳合計と一致するときだけ true', () => {
    expect(actualCostMatchesInvoices(30000, [10000, '20000.00'])).toBe(true)
    expect(actualCostMatchesInvoices('30000.00', [10000, 20000])).toBe(true)
    expect(actualCostMatchesInvoices(10000, [10000, 20000])).toBe(false)   // 再集計失敗で古い
    expect(actualCostMatchesInvoices(null, [10000])).toBe(false)           // 未集計
    expect(actualCostMatchesInvoices(0.3, [0.1, 0.2])).toBe(true)          // 小数誤差
  })
})

// ── 画面の配線（DOM テスト環境がないため、ソースの約束を確認する） ──

const importTab = readFileSync(join(__dirname, '../components/projects/VendorInvoiceImportTab.tsx'), 'utf8')
const ledgerTab = readFileSync(join(__dirname, '../components/projects/CostLedgerTab.tsx'), 'utf8')
const extractRoute = readFileSync(join(__dirname, '../app/api/ai/extract-vendor-invoice/route.ts'), 'utf8')

describe('VendorInvoiceImportTab', () => {
  it('14. 画像を変えると読み取り結果・画像ハッシュ・登録キーを捨て、読み取り中の古い応答は使わない', () => {
    const clear = importTab.slice(importTab.indexOf('const clearDocument'), importTab.indexOf('// ファイルセット'))
    expect(clear).toContain('genRef.current += 1')
    expect(clear).toContain('extractAbortRef.current?.abort()')
    expect(clear).toContain('attempt.reset()')
    expect(clear).toContain('setExtracted(null)')
    const extract = importTab.slice(importTab.indexOf('const extract = async'), importTab.indexOf('// 台帳に登録'))
    expect(extract).toMatch(/if \(genRef\.current !== gen\) return\n\s+if \(!res\.ok\)/)
  })

  it('送信中は画像を変えられない', () => {
    const handle = importTab.slice(importTab.indexOf('const handleFile'), importTab.indexOf('const onDrop'))
    expect(handle).toMatch(/if \(attempt\.busy\) return[\s\S]*clearDocument\(\)/)
  })

  it('画像ハッシュは読み取り API の応答（サーバー計算）をそのまま送る', () => {
    expect(importTab).toContain('document_sha256: extracted.document_sha256')
    expect(importTab).toContain("source:          'ocr'")
  })

  it('保存されたか分からないときは自動で再送しない', () => {
    const reg = importTab.slice(importTab.indexOf('const register = async'), importTab.indexOf('const selectedItem'))
    expect(reg.match(/postInvoice\(/g)).toHaveLength(1)
    expect(reg).toMatch(/case 'unknown':[\s\S]*setBlocker\(\{ kind: 'unknown'/)
  })

  it('成功後は DB の値で台帳を読み直し、登録キーを終える', () => {
    const reg = importTab.slice(importTab.indexOf("case 'saved':"), importTab.indexOf("case 'duplicate_document':"))
    expect(reg).toContain('attempt.reset()')
    expect(reg).toContain('loadLedgerItems()')
    expect(reg).toContain('onRegistered?.(itemId)')
  })

  it('登録後の予測金額（現在の actual_cost＋今回の金額）は表示しない', () => {
    expect(importTab).not.toContain('→ 登録後')
    expect(importTab).not.toMatch(/actual_cost \?\? 0\) \+/)
  })

  it('原価合計を確認できないときは「保存済み」と「原価合計の確認が必要」を分けて表示する', () => {
    expect(importTab).toContain('請求は保存済みです')
    expect(importTab).toContain('実績原価の合計が請求内訳と一致していることを確認できませんでした')
    expect(importTab).toMatch(/saved\.synced && saved\.actualCost != null/)
  })

  it('「この請求書は登録済みです」「以前の請求書と似ています」を表示する', () => {
    expect(importTab).toContain('この請求書は登録済みです')
    expect(importTab).toContain('以前の請求書と似ています')
    expect(importTab).toContain('請求書番号')
  })
})

describe('CostLedgerTab の手動追加', () => {
  const panel = ledgerTab.slice(ledgerTab.indexOf('function InvoicePanel'), ledgerTab.indexOf('// ── パネルスタイル'))

  it('連打・Enter の連続入力を止め、IME 変換中の Enter では送らない', () => {
    expect(panel).toMatch(/async function handleAdd\(\) \{\n\s+if \(attempt\.busy\) return/)
    expect(panel.match(/e\.key === 'Enter' && !e\.nativeEvent\.isComposing\) handleAdd\(\)/g)).toHaveLength(2)
    expect(panel).toContain('disabled={submitting}')
  })

  it('フォームを開くとき・成功後に新しい登録操作にする（失敗時はキーを保つ）', () => {
    expect(panel).toMatch(/function openAddForm\(\) \{[\s\S]*attempt\.reset\(\)/)
    expect(panel).toMatch(/result\.kind === 'saved'\) \{[\s\S]*attempt\.reset\(\)/)
    const unknown = panel.slice(panel.indexOf("result.kind === 'unknown'"))
    expect(unknown.slice(0, unknown.indexOf('return'))).not.toContain('attempt.reset()')
  })

  it('手動追加は source: manual で送り、画像ハッシュを付けない', () => {
    expect(panel).toContain("source: 'manual'")
    expect(panel).not.toContain('document_sha256')
  })

  it('取り込み画面の登録後に台帳を読み直す', () => {
    expect(ledgerTab).toContain('<VendorInvoiceImportTab projectId={projectId} onRegistered={reloadAfterInvoiceWrite} />')
  })
})

describe('読み取り API', () => {
  it('画像の SHA-256 はサーバーが元のバイト列から計算する', () => {
    expect(extractRoute).toContain("createHash('sha256').update(Buffer.from(arrayBuffer)).digest('hex')")
    expect(extractRoute).toMatch(/\.\.\.parsed, invoice_number: num \|\| null, document_sha256 \}/)
  })
})
