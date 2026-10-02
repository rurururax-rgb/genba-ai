import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * daily briefing（LINE 朝の通知）の対象会社の決定
 *
 * LINE チャネルと通知先（LINE_BRIEFING_USER_ID）は 1 社のものなので、
 * 対象は LINE_COMPANY_ID に明示された 1 社だけとする。
 *
 * Fail Closed:
 *   - LINE_COMPANY_ID 未設定 / 空 / UUID として不正 → 対象なし（DB も読まない）
 *   - 該当する会社が存在しない / 取得エラー           → 対象なし
 *   - 全社取得へのフォールバックは行わない（他社の案件情報を送らないため）
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function parseLineCompanyId(raw: string | null | undefined): string | null {
  const id = (raw ?? '').trim()
  return UUID_PATTERN.test(id) ? id.toLowerCase() : null
}

export type BriefingTargetCompany = { id: string; name: string }

export async function getBriefingTargetCompany(
  supabaseAdmin: SupabaseClient,
  rawLineCompanyId: string | null | undefined,
): Promise<BriefingTargetCompany | null> {
  const id = parseLineCompanyId(rawLineCompanyId)
  if (!id) return null

  const { data, error } = await supabaseAdmin
    .from('companies')
    .select('id, name')
    .eq('id', id)
    .maybeSingle()

  if (error || !data) return null
  return data as BriefingTargetCompany
}
