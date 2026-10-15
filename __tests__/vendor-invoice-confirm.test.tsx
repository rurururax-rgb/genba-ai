// @vitest-environment jsdom
/**
 * 業者請求書 OCR 取り込み（VendorInvoiceImportTab）の「登録金額を原本で確認しました」チェック。
 * 原本の金額（税抜・消費税・税込・税区分）や登録金額を直したら、確認はやり直す（登録ボタンも押せなくなる）。
 * 画面を実際に描画し、入力・チェック・登録ボタンの状態遷移を確かめる（fetch は模擬。本番 DB には接続しない）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { VendorInvoiceImportTab } from '@/components/projects/VendorInvoiceImportTab'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ITEM_ID = 'item-1'

/** 架空の請求書の読み取り結果（外税：税抜 100,000 / 税 10,000 / 税込 110,000） */
function extraction(sha: string) {
  return {
    vendor_name: '架空設備テスト',
    invoice_number: 'TEST-0001',
    invoice_date: '2026-09-30',
    payment_due_date: '2026-10-31',
    amounts: { subtotal_excl_tax: 100000, tax_amount: 10000, total_incl_tax: 110000, tax_treatment: 'exclusive', tax_breakdown: [] },
    review: { suggested_excl_tax: 100000, suggested_from: 'printed_subtotal', status: 'ok', messages: [] },
    items: [],
    warnings: [],
    document_sha256: sha,
  }
}

let container: HTMLDivElement
let root: Root
let posted: Array<Record<string, unknown>>
let extractCount: number

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

beforeEach(() => {
  posted = []
  extractCount = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/cost-ledger?')) {
      return json({ items: [{ id: ITEM_ID, name: '設備工事', vendor_name: '架空設備テスト', estimate_cost: 200000, actual_cost: null }] })
    }
    if (url === '/api/ai/extract-vendor-invoice') {
      extractCount += 1
      return json(extraction(`sha-${extractCount}`))
    }
    if (url === `/api/cost-ledger/${ITEM_ID}/invoices`) {
      posted.push(JSON.parse(String(init?.body)))
      return json({ invoice: { id: 'inv-1' }, newActualCost: 100000, invoiceCount: 1, synced: true })
    }
    throw new Error(`unexpected fetch ${url}`)
  }))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

// ── 画面操作 ───────────────────────────────────────────────

const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })

/** ラベル（Field）の下にある入力欄 */
function field<T extends HTMLElement>(label: string, selector = 'input'): T {
  const labelEl = [...container.querySelectorAll('label')].find(l => l.textContent === label)
  const el = labelEl?.parentElement?.querySelector(selector)
  if (!el) throw new Error(`field not found: ${label}`)
  return el as T
}

function button(text: string): HTMLButtonElement {
  const b = [...container.querySelectorAll('button')].find(x => x.textContent?.includes(text))
  if (!b) throw new Error(`button not found: ${text}`)
  return b as HTMLButtonElement
}

const checkbox = () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!
const registerButton = () => button('原価台帳に登録')

async function type(el: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function choose(el: HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

async function click(el: HTMLElement) {
  await act(async () => { el.click() })
  await flush()
}

/** 画像を選んで読み取る */
async function loadInvoice(name = 'invoice.png') {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!
  const file = new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' })
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
  await flush()
  await click(button('請求書を読み取る'))
  await flush()
}

async function mountAndConfirm() {
  await act(async () => { root.render(<VendorInvoiceImportTab projectId="p1" />) })
  await flush()
  await loadInvoice()
  expect(field<HTMLInputElement>('登録金額（税抜）').value).toBe('100000')
  expect(checkbox().checked).toBe(false)
  expect(registerButton().disabled).toBe(true)
  await click(checkbox())
  expect(checkbox().checked).toBe(true)
  expect(registerButton().disabled).toBe(false)
}

// ── テスト ─────────────────────────────────────────────────

describe('VendorInvoiceImportTab：原本の金額を直したら確認をやり直す', () => {
  const printedFields: Array<[string, string]> = [
    ['税抜金額', '90000'],
    ['消費税額', '9000'],
    ['税込合計', '99000'],
  ]

  for (const [label, value] of printedFields) {
    it(`確認済み → ${label}を編集 → チェックが外れ、登録できない。登録金額は変わらない`, async () => {
      await mountAndConfirm()
      await type(field<HTMLInputElement>(label), value)
      expect(checkbox().checked).toBe(false)
      expect(registerButton().disabled).toBe(true)
      expect(field<HTMLInputElement>('登録金額（税抜）').value).toBe('100000')
    })
  }

  it('確認済み → 税区分を変更 → チェックが外れ、登録できない。登録金額は変わらない', async () => {
    await mountAndConfirm()
    await choose(field<HTMLSelectElement>('税区分', 'select'), 'inclusive')
    expect(checkbox().checked).toBe(false)
    expect(registerButton().disabled).toBe(true)
    expect(field<HTMLInputElement>('登録金額（税抜）').value).toBe('100000')
  })

  it('確認済み → 登録金額を変更 → 従来どおりチェックが外れる', async () => {
    await mountAndConfirm()
    await type(field<HTMLInputElement>('登録金額（税抜）'), '95000')
    expect(checkbox().checked).toBe(false)
    expect(registerButton().disabled).toBe(true)
  })

  it('確認が外れた状態では登録できず、再チェック後は直した原本の値のまま登録金額で登録できる', async () => {
    await mountAndConfirm()
    await type(field<HTMLInputElement>('税抜金額'), '90000')
    // 登録ボタンは無効。押しても送信しない
    await click(registerButton())
    expect(posted).toHaveLength(0)

    // 原本の税抜を使う（照合の再計算は直した値で行われる）→ 確認はまだ外れたまま
    await click(button('原本の税抜 ¥90,000 を使う'))
    expect(field<HTMLInputElement>('登録金額（税抜）').value).toBe('90000')
    expect(checkbox().checked).toBe(false)
    expect(registerButton().disabled).toBe(true)

    await click(checkbox())
    expect(registerButton().disabled).toBe(false)
    await click(registerButton())
    expect(posted).toHaveLength(1)
    expect(posted[0].amount).toBe(90000)
  })

  it('新しい請求書を読み取ると未確認に戻る', async () => {
    await mountAndConfirm()
    await loadInvoice('invoice-2.png')
    expect(extractCount).toBe(2)
    expect(checkbox().checked).toBe(false)
    expect(registerButton().disabled).toBe(true)
  })
})
