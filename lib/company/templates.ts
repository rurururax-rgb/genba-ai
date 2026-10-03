/**
 * 帳票テンプレート識別子（companies.template_id）
 *
 * v1.0 では template_id を「どの帳票セットを使う会社か」の識別子として使う。
 *   'rugs'   … ラグズ建築専用の既存帳票（ロゴ・請求書・挨拶状・Excel テンプレート）
 *   'modern' … 汎用 RAGZ 帳票（既定値）
 *
 * これは権限システムではない。ラグズ建築の固有情報（ロゴ・住所・電話・登録番号・振込先口座など）が
 * 埋め込まれた legacy 帳票を、別会社へ表示・出力しないための Compatibility Gate としてのみ使う。
 *
 * 判定はこのファイルの関数に一本化する。各コンポーネントで template_id を直接比較しないこと。
 */

export const RUGS_TEMPLATE_ID = 'rugs'

export type CompanyTemplateInfo = { template_id?: string | null } | null | undefined

/**
 * ラグズ建築専用の legacy 帳票（表紙ロゴ・請求書・挨拶状・Excel）を使ってよい会社か。
 * 会社情報が取得できない・template_id が未設定・別の値 → false（Fail Closed）。
 */
export function supportsLegacyRugsDocuments(company: CompanyTemplateInfo): boolean {
  return company?.template_id === RUGS_TEMPLATE_ID
}
