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
