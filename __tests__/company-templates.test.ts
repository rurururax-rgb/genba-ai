import { describe, it, expect } from 'vitest'
import { supportsLegacyRugsDocuments, RUGS_TEMPLATE_ID } from '@/lib/company/templates'

describe('supportsLegacyRugsDocuments（legacy ラグズ帳票の Compatibility Gate）', () => {
  it("template_id = 'rugs' の会社だけ true", () => {
    expect(supportsLegacyRugsDocuments({ template_id: RUGS_TEMPLATE_ID })).toBe(true)
    expect(supportsLegacyRugsDocuments({ template_id: 'rugs' })).toBe(true)
  })

  it.each([
    ['modern（既定値）', { template_id: 'modern' }],
    ['null', { template_id: null }],
    ['未設定', {}],
    ['会社情報なし(null)', null],
    ['会社情報なし(undefined)', undefined],
    ['大文字違い', { template_id: 'RUGS' }],
    ['前後に空白', { template_id: ' rugs ' }],
    ['空文字', { template_id: '' }],
  ])('%s → false（Fail Closed）', (_label, company) => {
    expect(supportsLegacyRugsDocuments(company as { template_id?: string | null } | null | undefined)).toBe(false)
  })
})
