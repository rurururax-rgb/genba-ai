/**
 * 論理削除から守る台帳項目の判定と表示の文言（KI-005）。ブラウザでも使うので、サーバー専用のものは import しない。
 * サーバー側の処理（件数の読み取り・条件付きの論理削除・削除確認の識別子）は ledger-protection.ts
 */

export type ProtectionReason = 'invoices' | 'actual_cost' | 'budget_cost' | 'completion_cost'

export type LedgerValues = {
  actual_cost: number | null
  budget_cost: number | null
  completion_cost: number | null
}

export const PROTECTION_LABEL: Record<ProtectionReason, string> = {
  invoices:        '業者請求書',
  actual_cost:     '実績原価',
  budget_cost:     '実行予算',
  completion_cost: '完工予算',
}

/** 論理削除すると合計から消えてしまうもの。空なら守る必要がない */
export function protectionReasons(item: LedgerValues, invoiceCount: number): ProtectionReason[] {
  const reasons: ProtectionReason[] = []
  if (invoiceCount > 0) reasons.push('invoices')
  if (item.actual_cost != null) reasons.push('actual_cost')
  if (item.budget_cost != null) reasons.push('budget_cost')
  if (item.completion_cost != null) reasons.push('completion_cost')
  return reasons
}

export const describeReasons = (reasons: ProtectionReason[]) => reasons.map(r => PROTECTION_LABEL[r]).join('・')
