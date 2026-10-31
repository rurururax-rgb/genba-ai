import { describeReasons, type ProtectionReason } from './ledger-protection'

/** POST /api/cost-ledger/sync の応答 */
export type SyncResult = {
  added: number
  updated: number
  removed: number
  /** 見積から削除されたが、請求・実績・予算があるため残した項目（reasons が空 = 確かめた直後に値が入った） */
  kept?: Array<{ id: string; name: string; reasons: ProtectionReason[] }>
  deduplicated?: number
}

/** 同期の結果を、現場の人に分かる文で返す */
export function syncResultMessage(r: SyncResult): string {
  const parts: string[] = []
  if (r.added)   parts.push(`追加 ${r.added}件`)
  if (r.updated) parts.push(`更新 ${r.updated}件`)
  if (r.removed) parts.push(`削除 ${r.removed}件`)
  const lines = [parts.length ? `同期完了：${parts.join('・')}` : '差分なし（変更はありませんでした）']
  const kept = r.kept ?? []
  if (kept.length > 0) {
    lines.push('')
    lines.push(`見積から削除された ${kept.length}件 は、原価台帳に残しました（案件の合計から外さないため）。`)
    for (const k of kept.slice(0, 10)) {
      lines.push(`・${k.name}（${k.reasons.length ? describeReasons(k.reasons) + 'あり' : '同期中に値が入力されたため'}）`)
    }
    if (kept.length > 10) lines.push(`・ほか ${kept.length - 10}件`)
    lines.push('一覧では「見積から削除済み」と表示されます。不要なら請求書を削除してから、行を削除してください。')
  }
  return lines.join('\n')
}
