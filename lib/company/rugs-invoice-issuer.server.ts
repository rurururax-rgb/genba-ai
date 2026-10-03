/**
 * ラグズ建築の請求書発行者情報（サーバー専用）
 *
 * ⚠️ このファイルは Server Component / Route Handler からのみ import すること。
 *    'use client' のファイルから import すると、振込先口座などがクライアント用 JS に含まれ、
 *    未ログインの第三者や別会社の利用者が取得できてしまう。
 *    （__tests__/invoice-issuer-server-only.test.ts と本番ビルドの成果物検査で保証している）
 *
 * 配信経路:
 *   案件ページ（Server Component）が getInvoiceIssuerProfile() を呼び、
 *   template_id = 'rugs' の会社のときだけ props として請求書タブへ渡す。
 *   それ以外の会社・未ログインでは null を返し、情報そのものを送らない。
 */
import { supportsLegacyRugsDocuments, type CompanyTemplateInfo } from '@/lib/company/templates'
import type { InvoiceIssuerProfile } from '@/lib/company/invoice-issuer'

const RUGS_INVOICE_ISSUER: InvoiceIssuerProfile = {
  companyName: '株式会社ラグズ建築',
  bank: {
    branch:        '十六銀行　/　鏡島支店',
    accountType:   '普通',
    accountNumber: '1326345',
    holder:        '株式会社　ラグズ建築',
    holderKana:    'カ）　ラグズケンチク',
  },
  registrationNumber: 'T2200001044783',
  postalCode: '500-8388',
  address:    '岐阜県岐阜市今嶺４丁目5-20',
  tel:        '058-374-5318',
  email:      'info@rugs_reform.jp',
  license:    '岐阜県知事許可（般－8）第103774号',
  logoPath:   '/excel-images/image7.png',
}

/** 請求書の発行者情報。対象会社（template_id = 'rugs'）以外は null（Fail Closed） */
export function getInvoiceIssuerProfile(company: CompanyTemplateInfo): InvoiceIssuerProfile | null {
  return supportsLegacyRugsDocuments(company) ? RUGS_INVOICE_ISSUER : null
}
