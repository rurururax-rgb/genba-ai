import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { getInvoiceIssuerProfile } from '@/lib/company/rugs-invoice-issuer.server'

// 請求書の発行者情報（振込先口座・登録番号・住所・電話・メール・許可番号）
const ISSUER_SECRETS = ['十六銀行', '鏡島支店', '1326345', 'ラグズケンチク', 'T2200001044783', '500-8388', '今嶺', '058-374-5318', 'rugs_reform', '103774']

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}
const SOURCES = ['app', 'components', 'lib'].flatMap(d => walk(d))
const SERVER_FILE = 'lib/company/rugs-invoice-issuer.server.ts'

describe('getInvoiceIssuerProfile（サーバー専用）', () => {
  it("template_id = 'rugs' の会社にだけ発行者情報を返す", () => {
    const p = getInvoiceIssuerProfile({ template_id: 'rugs' })
    expect(p?.bank.accountNumber).toBe('1326345')
    expect(p?.registrationNumber).toBe('T2200001044783')
  })

  it.each([
    ['modern', { template_id: 'modern' }], ['null', { template_id: null }], ['未設定', {}],
    ['会社情報なし', null], ['undefined', undefined], ['表記違い', { template_id: 'RUGS' }],
  ])('%s → null（情報そのものを渡さない）', (_l, company) => {
    expect(getInvoiceIssuerProfile(company as { template_id?: string | null } | null | undefined)).toBeNull()
  })
})

describe('発行者情報がクライアント用コードへ混入しない', () => {
  it('固定の発行者情報を含むソースは、サーバー専用ファイルだけ', () => {
    const pattern = new RegExp(ISSUER_SECRETS.join('|'))
    const holders = SOURCES.filter(f => pattern.test(readFileSync(f, 'utf8')))
      // 挨拶回り文書は別の legacy 帳票（住所・電話のみ。rugs 以外は notFound）
      .filter(f => f !== 'app/(dashboard)/projects/[id]/greeting/GreetingDocument.tsx')
    expect(holders).toEqual([SERVER_FILE])
  })

  it('サーバー専用ファイルを import するのは案件ページ（Server Component）だけ', () => {
    const importers = SOURCES.filter(f => f !== SERVER_FILE && /from\s+['"][^'"]*rugs-invoice-issuer/.test(readFileSync(f, 'utf8')))
    expect(importers).toEqual(['app/(dashboard)/projects/[id]/page.tsx'])
    // その案件ページはクライアントコンポーネントではない
    expect(readFileSync(importers[0], 'utf8')).not.toMatch(/^\s*['"]use client['"]/m)
  })

  it("'use client' のファイルはサーバー専用ファイルを import していない", () => {
    const clientFiles = SOURCES.filter(f => /^\s*['"]use client['"]/m.test(readFileSync(f, 'utf8')))
    expect(clientFiles.length).toBeGreaterThan(10)
    for (const f of clientFiles) expect(readFileSync(f, 'utf8'), f).not.toMatch(/from\s+['"][^'"]*rugs-invoice-issuer/)
  })
})

describe('printInvoice（請求書の印刷 HTML）', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  const invoice = { customer_name: '山田 太郎', construction_name: 'キッチン改修工事', issued_at: '2026-10-01', payment_due_at: null, items: [{ id: 'a', name: '工事一式', quantity: 1, unit: '式', amount: 100000, memo: '' }], adjustment: 0 }

  async function print(issuer: ReturnType<typeof getInvoiceIssuerProfile>) {
    let html: string | null = null
    const open = vi.fn(() => ({ document: { write: (h: string) => { html = h }, close: () => {} } }))
    vi.stubGlobal('window', { location: { origin: 'https://example.test' }, open })
    vi.stubGlobal('alert', vi.fn())
    const { printInvoice } = await import('@/components/projects/InvoiceTab')
    printInvoice(invoice as never, 100000, 10000, 110000, issuer)
    return { html: html as string | null, open }
  }

  it('rugs の発行者情報を渡すと、従来と同じ振込先・登録番号・住所が出力される', async () => {
    const { html } = await print(getInvoiceIssuerProfile({ template_id: 'rugs' }))
    expect(html).not.toBeNull()
    // 変更前のテンプレートに直書きされていた行と同一の文字列
    for (const line of [
      '<div>　十六銀行　/　鏡島支店</div>',
      '<div>　【普通】　1326345</div>',
      '<div>　株式会社　ラグズ建築</div>',
      '<div>　カ）　ラグズケンチク</div>',
      '<div class="reg-no">登録番号　T2200001044783</div>',
      '<img src="https://example.test/excel-images/image7.png" class="company-logo" alt="株式会社ラグズ建築" />',
      '〒500-8388<br>',
      '岐阜県岐阜市今嶺４丁目5-20<br>',
      'TEL　058-374-5318<br>',
      'E-mail　info@rugs_reform.jp<br>',
      '<span style="font-size:6.5pt;">岐阜県知事許可（般－8）第103774号</span>',
    ]) expect(html, line).toContain(line)
    expect(html).toContain('山田 太郎')
    expect(html).toContain('110,000')
  })

  it('発行者情報が無い（null）場合は何も出力しない（ウィンドウも開かない）', async () => {
    const { html, open } = await print(null)
    expect(html).toBeNull()
    expect(open).not.toHaveBeenCalled()
  })
})
