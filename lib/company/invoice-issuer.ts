/**
 * 請求書の発行者情報（会社の振込先・登録番号・住所など）の型。
 * 型だけを置く。実データはサーバー専用ファイル（rugs-invoice-issuer.server.ts）にあり、
 * クライアント用コードからは import しないこと。
 */
export type InvoiceIssuerProfile = {
  /** 会社名（ロゴの代替テキスト） */
  companyName: string
  bank: {
    /** 銀行名 / 支店名 */
    branch:        string
    accountType:   string
    accountNumber: string
    /** 口座名義 */
    holder:        string
    holderKana:    string
  }
  registrationNumber: string
  postalCode: string
  address:    string
  tel:        string
  email:      string
  /** 建設業許可番号 */
  license:    string
  /** ロゴ画像（public 配下の公開ファイル。公開して問題ないブランド画像） */
  logoPath:   string
}
