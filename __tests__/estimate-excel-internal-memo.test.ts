import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { toCustomerEstimateItems } from '@/lib/estimate/customer-output'
import { buildEstimateExcelInput } from '@/lib/excel/estimate-excel-input'
import { fillTemplateV2 } from '@/lib/excel/fill-template-v2'

// Excel（お客様向け内訳明細書）の実ファイルに社内メモが一切含まれないことを確認する。
// ルート（/api/projects/[id]/estimate/excel）と同じ変換経路：DB行 → toCustomerEstimateItems → buildEstimateExcelInput → fillTemplateV2

async function allXml(buf: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buf)
  const texts = await Promise.all(
    Object.values(zip.files).filter(f => !f.dir && f.name.endsWith('.xml')).map(f => f.async('string')),
  )
  return texts.join('\n')
}

const GROUP = { id: 'g1', label: '外装', display_mode: 'detailed', sort_order: 0 }

// DB から select('*') 相当で取れてしまった場合も想定し、社内向けの列を含めた行を入力にする
const dbRows = [
  { id: 'n1', name: '外壁塗装', quantity: 1, unit: '式', selling_price: 435000, amount: 435000, group_id: 'g1', sort_order: 0, row_type: 'item',
    memo: '工事期間中は駐車スペースをお借りします', internal_memo: '見積No. ABC-123', cost_price: 300000, vendor_name: 'QA塗装' },
  { id: 'n3', name: '足場', quantity: 1, unit: '式', selling_price: 174000, amount: 174000, group_id: 'g1', sort_order: 1, row_type: 'item',
    memo: null, internal_memo: '仕入先管理番号 SK-0912', cost_price: 120000, vendor_name: 'QA足場' },
]

describe('Excel 出力と社内メモ', () => {
  it('お客様向け備考は出力され、社内メモ・業者名は出力されない', async () => {
    const input = buildEstimateExcelInput([GROUP], toCustomerEstimateItems(dbRows), 0.10)
    const { buffer } = await fillTemplateV2(input)
    const xml = await allXml(buffer)

    expect(xml).toContain('工事期間中は駐車スペースをお借りします')
    expect(xml).not.toContain('ABC-123')
    expect(xml).not.toContain('SK-0912')
    expect(xml).not.toContain('QA塗装')
    expect(xml).not.toContain('QA足場')
  })

  it('組み立てた入力にも社内向けの項目が存在しない', () => {
    const input = buildEstimateExcelInput([GROUP], toCustomerEstimateItems(dbRows), 0.10)
    const json = JSON.stringify(input)
    expect(json).not.toMatch(/internal_memo|cost_price|vendor_name|ABC-123|SK-0912/)
  })
})
