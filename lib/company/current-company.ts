import type { SupabaseClient } from '@supabase/supabase-js'

export type CurrentCompany = {
  id:           string
  name:         string
  display_name: string | null
  tax_rate:     number | null
  template_id:  string | null
}

/**
 * ログイン中ユーザーの所属会社を取得する（RLS 有効なクライアントで呼ぶこと）。
 * 取得できない場合は null（呼び出し側は「会社情報なし」として安全側に倒す）。
 */
export async function getCurrentCompany(supabase: SupabaseClient, userId: string): Promise<CurrentCompany | null> {
  const { data } = await supabase
    .from('company_members')
    .select('company_id, companies(id, name, display_name, tax_rate, template_id)')
    .eq('user_id', userId)
    .single()
  const company = (data?.companies ?? null) as unknown as CurrentCompany | null
  return company && typeof company === 'object' && 'id' in company ? company : null
}
