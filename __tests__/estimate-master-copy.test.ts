import { describe, expect, it } from 'vitest'
import {
  buildMasterItemRow,
  masterItemFingerprint,
  masterLineAmount,
  parseMasterAddRequest,
  parseMasterSearchInput,
  planMasterItemPrice,
  resolveMasterSellingPrice,
  type MasterItemSource,
} from '@/lib/estimate/master-copy'
import { calculateSellingPrice, DEFAULT_MARKUP_RATE } from '@/lib/estimate/pricing'

const M: MasterItemSource = { name: 'ユニットバス 1616', spec: 'HTV1616', unit: '台', cost_price: 600000, selling_price: 900000, category: '設備' }
const P = '00000000-0000-4000-8000-000000000001'
const G = '00000000-0000-4000-8000-000000000002'
const MID = '00000000-0000-4000-8000-000000000003'

describe('planMasterItemPrice（追加画面の初期値）', () => {
  it('マスターに売価があれば manual（マスターの売価）', () => {
    expect(planMasterItemPrice(M, 1.3)).toEqual({ selling_price_mode: 'manual', cost_price: 600000, selling_price: 900000, markup_rate: 1.3 })
  })
  it('売価なし・売価 0 は auto（原価 × 案件の掛け率。既存の pricing と同じ計算）', () => {
    expect(planMasterItemPrice({ cost_price: 650000, selling_price: null }, 1.3)).toMatchObject({ selling_price_mode: 'auto', selling_price: 845000 })
    expect(planMasterItemPrice({ cost_price: 1234, selling_price: 0 }, 1.45)).toMatchObject({ selling_price_mode: 'auto', selling_price: calculateSellingPrice(1234, 1.45) })
  })
  it('原価も売価もなければ売価なし。掛け率が未設定・0 以下なら既定の掛け率', () => {
    expect(planMasterItemPrice({ cost_price: null, selling_price: null }, 1.3)).toMatchObject({ selling_price_mode: 'auto', selling_price: null })
    expect(planMasterItemPrice({ cost_price: 1000, selling_price: null }, null).markup_rate).toBe(DEFAULT_MARKUP_RATE)
    expect(planMasterItemPrice({ cost_price: 1000, selling_price: null }, 0).selling_price).toBe(1450)
  })
})

describe('resolveMasterSellingPrice・masterLineAmount', () => {
  it('auto は原価 × 掛け率（四捨五入）、manual は入力した売価（0 円も有効）', () => {
    expect(resolveMasterSellingPrice('auto', 333, 999, 1.45)).toBe(483)
    expect(resolveMasterSellingPrice('auto', null, 999, 1.45)).toBeNull()
    expect(resolveMasterSellingPrice('manual', 333, 0, 1.45)).toBe(0)
  })
  it('金額は数量 × 売価。売価なしは null', () => {
    expect(masterLineAmount(2.5, 1001)).toBe(2503)
    expect(masterLineAmount(2, null)).toBeNull()
  })
})

describe('masterItemFingerprint', () => {
  it('同じ内容・同じ掛け率なら同じ。品名・仕様・単位・原価・売価・分類・掛け率のどれが変わっても変わる', () => {
    const base = masterItemFingerprint(M, 1.3)
    expect(base).toMatch(/^m1-[0-9a-f]+$/)
    expect(masterItemFingerprint({ ...M }, 1.3)).toBe(base)
    for (const changed of [
      { ...M, name: 'x' }, { ...M, spec: null }, { ...M, unit: '式' }, { ...M, cost_price: 600001 },
      { ...M, selling_price: null }, { ...M, category: null },
    ]) expect(masterItemFingerprint(changed, 1.3)).not.toBe(base)
    expect(masterItemFingerprint(M, 1.31)).not.toBe(base)
    // 掛け率の未設定は既定値と同じ扱い
    expect(masterItemFingerprint(M, null)).toBe(masterItemFingerprint(M, DEFAULT_MARKUP_RATE))
  })
})

describe('parseMasterSearchInput', () => {
  it('空欄は一覧（語なし）。全角スペースで区切り、重複をまとめる', () => {
    expect(parseMasterSearchInput('', null)).toEqual({ ok: true, terms: [], limit: 30 })
    expect(parseMasterSearchInput(' ユニット　バス ユニット ', '10')).toEqual({ ok: true, terms: ['ユニット', 'バス'], limit: 10 })
  })
  it('長すぎる・語が多すぎる・件数が範囲外は拒否', () => {
    expect(parseMasterSearchInput('あ'.repeat(51), null).ok).toBe(false)
    expect(parseMasterSearchInput('a b c d e f', null).ok).toBe(false)
    for (const l of ['0', '51', '1.5', 'x']) expect(parseMasterSearchInput('a', l).ok).toBe(false)
  })
})

describe('parseMasterAddRequest', () => {
  const base = { project_id: P, group_id: G, master_item_id: MID, fingerprint: 'm1-0123abcd', quantity: 2, cost_price: 1000, selling_price_mode: 'auto' }
  it('auto（売価なし）と manual（売価必須・0 円可）を受け付け、ID は小文字にそろえる', () => {
    expect(parseMasterAddRequest(base)).toEqual({ ok: true, value: {
      projectId: P, groupId: G, masterItemId: MID, fingerprint: 'm1-0123abcd', quantity: 2, costPrice: 1000, sellingPriceMode: 'auto', sellingPrice: null,
    } })
    const r = parseMasterAddRequest({ ...base, project_id: P.toUpperCase(), group_id: null, cost_price: null, selling_price_mode: 'manual', selling_price: 0 })
    expect(r).toMatchObject({ ok: true, value: { projectId: P, groupId: null, costPrice: null, sellingPriceMode: 'manual', sellingPrice: 0 } })
  })
  it('会社・品名・並び順・source など想定外のキー、不正な数値・モードは拒否', () => {
    const bad: unknown[] = [
      null, [], 'x',
      { ...base, company_id: P }, { ...base, name: 'x' }, { ...base, sort_order: 1 }, { ...base, source: 'master' },
      { ...base, quantity: 0 }, { ...base, quantity: -1 }, { ...base, quantity: Infinity }, { ...base, quantity: '2' }, { ...base, quantity: 1_000_001 },
      { ...base, cost_price: -1 }, { ...base, cost_price: NaN }, { ...base, cost_price: 1e9 },
      { ...base, selling_price: 100 }, { ...base, selling_price_mode: 'manual' }, { ...base, selling_price_mode: 'manual', selling_price: -1 },
      { ...base, selling_price_mode: 'x' }, { ...base, fingerprint: 'v1-00' }, { ...base, master_item_id: 'x' },
      Object.fromEntries(Object.entries(base).filter(([k]) => k !== 'group_id')),
    ]
    for (const b of bad) expect(parseMasterAddRequest(b).ok, JSON.stringify(b)).toBe(false)
  })
})

describe('buildMasterItemRow', () => {
  const target = { projectId: P, companyId: MID, groupId: G, sortOrder: 3000, projectMarkupRate: 1.3 }
  it('品名・単位・分類はマスター、数量・原価は入力。auto の売価はサーバーで計算。備考・業者・個別掛け率は入れない', () => {
    expect(buildMasterItemRow(M, { quantity: 2, costPrice: 700000, sellingPriceMode: 'auto', sellingPrice: null }, target)).toEqual({
      project_id: P, company_id: MID, group_id: G, sort_order: 3000, name: 'ユニットバス 1616', quantity: 2, unit: '台',
      cost_price: 700000, selling_price: 910000, selling_price_mode: 'auto', markup_rate_override: null, vendor_name: null,
      category: '設備', row_type: 'item', memo: null, internal_memo: null, source: 'master',
    })
  })
  it('manual は入力した売価。単位が空ならマスターの既定と同じ「式」', () => {
    const row = buildMasterItemRow({ ...M, unit: ' ' }, { quantity: 1, costPrice: null, sellingPriceMode: 'manual', sellingPrice: 5000 }, target)
    expect(row).toMatchObject({ unit: '式', selling_price: 5000, selling_price_mode: 'manual', cost_price: null })
  })
})
