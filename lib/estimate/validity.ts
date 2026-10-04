/**
 * 見積書の「見積有効期間」表示。
 *
 * 起算日は基本情報で担当者が入力した estimate_valid_from だけを使う。
 * 未設定のときに表示日（new Date()）で補うと、開くたび・印刷するたびに日付が変わるため、
 * 推測せず null を返す（画面では「—」）。
 */
export function formatEstimateValidity(
  validFrom: string | null | undefined,
  validMonths: number | null | undefined,
): string | null {
  if (!validMonths || !validFrom) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(validFrom)
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  // 日付文字列をそのまま暦日として扱う（タイムゾーンで日がずれないよう UTC で計算）
  const exp = new Date(Date.UTC(y, mo - 1, d))
  exp.setUTCMonth(exp.getUTCMonth() + validMonths)
  return `${y}年${mo}月${d}日 〜 ${exp.getUTCFullYear()}年${exp.getUTCMonth() + 1}月${exp.getUTCDate()}日（${validMonths}ヶ月）`
}
