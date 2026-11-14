import { describe, expect, it } from 'vitest'
import {
  buildPastItemCopy,
  escapeLikePattern,
  parsePastSearchInput,
  planPastItemPrice,
  resolveTargetMarkupRate,
  PAST_SEARCH_MAX_LIMIT,
  type PastItemSource,
  type PastCopyTarget,
} from '@/lib/estimate/past-copy'
import { DEFAULT_MARKUP_RATE } from '@/lib/estimate/pricing'

const P = '00000000-0000-4000-8000-000000000011'
const C = '00000000-0000-4000-8000-000000000001'
const G = '00000000-0000-4000-8000-000000000021'

const base: PastItemSource = {
  name: 'システムキッチン交換',
  quantity: 2,
  unit: '台',
  cost_price: 100000,
  selling_price: 150000,
  selling_price_mode: 'auto',
  markup_rate_override: 1.5,
  vendor_name: '〇〇設備',
  category: '住宅設備',
  row_type: 'item',
  memo: '山田様邸：駐車場あり',
  internal_memo: '仕入見積 No.123',
}

const target: PastCopyTarget = { projectId: P, companyId: C, groupId: G, sortOrder: 3000, projectMarkupRate: 1.3 }

describe('planPastItemPrice：コピー後の売価', () => {
  it('auto はコピー先の標準掛け率で計算し直し、過去の個別掛け率は使わない', () => {
    const p = planPastItemPrice(base, 1.3)
    expect(p).toEqual({
      basis: 'auto_recalculated',
      selling_price_mode: 'auto',
      past_selling_price: 150000,
      new_selling_price: 130000,
      difference: -20000,
      changed: true,
      applied_markup_rate: 1.3,
    })
  })

  it('auto で過去と同じ売価になれば changed=false・差額 0', () => {
    const p = planPastItemPrice({ ...base, selling_price: 130000 }, 1.3)
    expect(p.changed).toBe(false)
    expect(p.difference).toBe(0)
  })

  it('auto で 1 円未満は既存と同じく四捨五入（calculateSellingPrice）', () => {
    expect(planPastItemPrice({ ...base, cost_price: 1001 }, 1.45).new_selling_price).toBe(1451)
  })

  it('manual は元の売価をそのまま使う（掛け率が変わっても）', () => {
    const p = planPastItemPrice({ ...base, selling_price_mode: 'manual', selling_price: 98000 }, 2.0)
    expect(p).toMatchObject({ basis: 'manual_kept', selling_price_mode: 'manual', new_selling_price: 98000, changed: false, applied_markup_rate: null })
  })

  it('manual の 0 円は有効な売価として保つ（null にしない）', () => {
    const p = planPastItemPrice({ ...base, selling_price_mode: 'manual', selling_price: 0 }, 1.3)
    expect(p.new_selling_price).toBe(0)
    expect(p.past_selling_price).toBe(0)
    expect(p.changed).toBe(false)
  })

  it('manual で売価が未登録なら null のまま（勝手に作らない）', () => {
    const p = planPastItemPrice({ ...base, selling_price_mode: 'manual', selling_price: null }, 1.3)
    expect(p.new_selling_price).toBeNull()
    expect(p.basis).toBe('manual_kept')
  })

  it('auto で原価が未登録なら売価を作らない。過去の売価は比較用に返す', () => {
    const p = planPastItemPrice({ ...base, cost_price: null, selling_price: 50000 }, 1.3)
    expect(p).toMatchObject({ basis: 'no_cost', new_selling_price: null, past_selling_price: 50000, difference: null, changed: true })
  })

  it('auto で原価 0 円は 0 円の売価（0 円工事は有効）', () => {
    const p = planPastItemPrice({ ...base, cost_price: 0, selling_price: 0 }, 1.3)
    expect(p).toMatchObject({ basis: 'auto_recalculated', new_selling_price: 0, changed: false })
  })

  it('selling_price_mode が null の行は auto として扱う', () => {
    expect(planPastItemPrice({ ...base, selling_price_mode: null }, 1.3).basis).toBe('auto_recalculated')
  })

  it('コピー先の掛け率が未設定・0 以下・非数なら DEFAULT_MARKUP_RATE', () => {
    for (const rate of [null, undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(planPastItemPrice(base, rate).applied_markup_rate).toBe(DEFAULT_MARKUP_RATE)
      expect(resolveTargetMarkupRate(rate)).toBe(DEFAULT_MARKUP_RATE)
    }
  })

  it('原価・売価が非数なら未登録として扱う', () => {
    const p = planPastItemPrice({ ...base, cost_price: Number.NaN, selling_price: Number.NaN }, 1.3)
    expect(p).toMatchObject({ basis: 'no_cost', past_selling_price: null, new_selling_price: null, changed: false })
  })

  it('見出し・メモ行は金額を持たない', () => {
    for (const row_type of ['header', 'note'] as const) {
      expect(planPastItemPrice({ ...base, row_type }, 1.3)).toMatchObject({ basis: 'not_priced', new_selling_price: null })
    }
  })
})

describe('buildPastItemCopy：引き継ぎルール', () => {
  it('品名・数量・単位・原価・業者名・分類を引き継ぎ、コピー先の案件・会社・工種・並び順を使う', () => {
    const { row } = buildPastItemCopy(base, target)
    expect(row).toEqual({
      project_id: P,
      company_id: C,
      group_id: G,
      sort_order: 3000,
      name: 'システムキッチン交換',
      quantity: 2,
      unit: '台',
      cost_price: 100000,
      selling_price: 130000,
      selling_price_mode: 'auto',
      markup_rate_override: null,
      vendor_name: '〇〇設備',
      category: '住宅設備',
      row_type: 'item',
      memo: null,
      internal_memo: null,
      source: 'past_item',
    })
  })

  it('お客様向け備考・社内メモは初期設定でコピーしない', () => {
    const { row } = buildPastItemCopy(base, target)
    expect(row.memo).toBeNull()
    expect(row.internal_memo).toBeNull()
  })

  it('備考・社内メモは指定したものだけコピーし、互いに混ざらない', () => {
    expect(buildPastItemCopy(base, target, { includeMemo: true }).row).toMatchObject({ memo: '山田様邸：駐車場あり', internal_memo: null })
    expect(buildPastItemCopy(base, target, { includeInternalMemo: true }).row).toMatchObject({ memo: null, internal_memo: '仕入見積 No.123' })
  })

  it('コピー元の id・案件・会社・工種・並び順・LINE イベント・作成日時を引き継がない', () => {
    const src = {
      ...base,
      id: 'src-id', project_id: 'src-project', company_id: 'src-company', group_id: 'src-group',
      sort_order: 7, line_event_id: 'src-event', created_at: '2020-01-01', retail_price: 1, amount: 999,
    } as PastItemSource
    const { row } = buildPastItemCopy(src, { ...target, groupId: null })
    const keys = Object.keys(row)
    for (const k of ['id', 'line_event_id', 'created_at', 'updated_at', 'deleted_at', 'retail_price', 'amount']) {
      expect(keys).not.toContain(k)
    }
    expect(row).toMatchObject({ project_id: P, company_id: C, group_id: null, sort_order: 3000 })
  })

  it('コピー元の明細オブジェクトを書き換えない', () => {
    const src = { ...base }
    const frozen = JSON.stringify(src)
    buildPastItemCopy(Object.freeze(src), target, { includeMemo: true, includeInternalMemo: true })
    expect(JSON.stringify(src)).toBe(frozen)
  })

  it('数量・単位が未登録なら既存と同じく 1・式', () => {
    const { row } = buildPastItemCopy({ ...base, quantity: null, unit: null }, target)
    expect(row.quantity).toBe(1)
    expect(row.unit).toBe('式')
    expect(buildPastItemCopy({ ...base, unit: '  ' }, target).row.unit).toBe('式')
  })

  it('数量 0 はそのまま保つ', () => {
    expect(buildPastItemCopy({ ...base, quantity: 0 }, target).row.quantity).toBe(0)
  })

  it('見出し行は原価・売価・業者名を持たない', () => {
    const { row } = buildPastItemCopy({ ...base, row_type: 'header', name: '【解体工事】' }, target)
    expect(row).toMatchObject({ row_type: 'header', name: '【解体工事】', cost_price: null, selling_price: null, vendor_name: null })
  })

  it('未知の row_type は item として扱う', () => {
    expect(buildPastItemCopy({ ...base, row_type: 'weird' as never }, target).row.row_type).toBe('item')
  })

  it('price と row の売価・売価モードが一致する', () => {
    for (const src of [base, { ...base, selling_price_mode: 'manual' as const }, { ...base, cost_price: null }]) {
      const { row, price } = buildPastItemCopy(src, target)
      expect(row.selling_price).toBe(price.new_selling_price)
      expect(row.selling_price_mode).toBe(price.selling_price_mode)
    }
  })
})

describe('parsePastSearchInput：検索入力の制限', () => {
  it('前後の空白を除き、半角・全角スペースで区切る（重複はまとめる）', () => {
    expect(parsePastSearchInput('  キッチン　交換 キッチン ', null)).toEqual({ ok: true, terms: ['キッチン', '交換'], limit: 20 })
  })

  it('全角英数字は変換しない（DB の品名と一致させるため）', () => {
    expect(parsePastSearchInput('ＬＤＫ', null)).toMatchObject({ ok: true, terms: ['ＬＤＫ'] })
  })

  it('空・空白のみは拒否', () => {
    for (const q of [null, '', '   ', '　']) expect(parsePastSearchInput(q, null).ok).toBe(false)
  })

  it('50 文字まで可、51 文字は拒否', () => {
    expect(parsePastSearchInput('あ'.repeat(50), null).ok).toBe(true)
    expect(parsePastSearchInput('あ'.repeat(51), null).ok).toBe(false)
  })

  it('5 語まで可、6 語は拒否', () => {
    expect(parsePastSearchInput('a b c d e', null).ok).toBe(true)
    expect(parsePastSearchInput('a b c d e f', null).ok).toBe(false)
  })

  it('limit は 1〜30 の整数のみ', () => {
    expect(parsePastSearchInput('床', '1')).toMatchObject({ ok: true, limit: 1 })
    expect(parsePastSearchInput('床', String(PAST_SEARCH_MAX_LIMIT))).toMatchObject({ ok: true, limit: 30 })
    for (const l of ['0', '31', '-1', '1.5', 'abc', '1e2', ' 5']) expect(parsePastSearchInput('床', l).ok).toBe(false)
    expect(parsePastSearchInput('床', '')).toMatchObject({ ok: true, limit: 20 })
  })
})

describe('escapeLikePattern', () => {
  it('% _ \\ をエスケープし、それ以外は変えない', () => {
    expect(escapeLikePattern('100%_a\\b')).toBe('100\\%\\_a\\\\b')
    expect(escapeLikePattern('キッチン')).toBe('キッチン')
  })
})
