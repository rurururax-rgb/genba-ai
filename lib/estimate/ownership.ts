/**
 * 見積 API の保存先の所有確認。
 *
 * estimate_items / estimate_groups の RLS は company_id しか見ず、project_id / group_id の外部キー検査は
 * RLS を通らない。確認しないと他社・別案件の案件や工種を参照する行を作れてしまうため、書き込み前に呼ぶ。
 * 存在しない・他社・削除済みは区別せず false を返す（他社データの存在を漏らさない）。
 */

import type { getServerClient } from '@/lib/supabase/server'

type ServerClient = Awaited<ReturnType<typeof getServerClient>>

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v)
}

/** sort_order は INT 列。有限の整数で、PostgreSQL の integer の範囲内か */
export function isSortOrder(v: unknown): v is number {
  return Number.isInteger(v) && (v as number) >= -2147483648 && (v as number) <= 2147483647
}

/** 案件が存在し、削除されておらず、companyId のものか */
export async function isActiveProject(supabase: ServerClient, projectId: string, companyId: string): Promise<boolean> {
  const { data } = await supabase
    .from('projects')
    .select('id, company_id')
    .eq('id', projectId)
    .is('deleted_at', null)
    .maybeSingle()
  return data != null && data.company_id === companyId
}

/** 工種が projectId のもので、削除されておらず、companyId のものか */
export async function isActiveGroupInProject(
  supabase: ServerClient, groupId: string, projectId: string, companyId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from('estimate_groups')
    .select('id')
    .eq('id', groupId)
    .eq('project_id', projectId)
    .eq('company_id', companyId)
    .is('deleted_at', null)
    .maybeSingle()
  return data != null
}

/**
 * 省略可能な工種 ID の確認。undefined / null（未分類・紐付け解除）は 'ok'。
 * UUID でない値は 'invalid'（400）、他社・別案件・削除済み・存在しない工種は区別せず 'not_found'（404）。
 */
export async function checkOptionalGroup(
  supabase: ServerClient, groupId: unknown, projectId: string, companyId: string,
): Promise<'ok' | 'invalid' | 'not_found'> {
  if (groupId == null) return 'ok'
  if (!isUuid(groupId)) return 'invalid'
  return (await isActiveGroupInProject(supabase, groupId, projectId, companyId)) ? 'ok' : 'not_found'
}

/** LINE イベントが存在し、companyId のものか（line_event_notes の起点に使う。他社・存在しないは区別しない） */
export async function isOwnLineEvent(supabase: ServerClient, eventId: string, companyId: string): Promise<boolean> {
  if (!isUuid(eventId)) return false
  const { data } = await supabase
    .from('line_events')
    .select('id, company_id')
    .eq('id', eventId)
    .maybeSingle()
  return data != null && data.company_id === companyId
}
