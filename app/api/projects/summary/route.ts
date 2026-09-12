/**
 * GET /api/projects/summary
 *
 * 会社全体の業務サマリーを返す。ダッシュボードと AI Tool から共通利用。
 * 集計ロジックは lib/services/company-summary.ts に集約。
 *
 * セキュリティ: getServerClient()（RLS 有効）。admin.ts 不使用。
 */

import { NextResponse } from 'next/server'
import { getServerClient } from '@/lib/supabase/server'
import { getCompanyProjectSummary } from '@/lib/services/company-summary'

export async function GET() {
  const supabase = await getServerClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: membership } = await supabase
    .from('company_members')
    .select('company_id')
    .eq('user_id', user.id)
    .single()
  if (!membership) return NextResponse.json({ error: 'No company' }, { status: 403 })

  const summary = await getCompanyProjectSummary(supabase)
  return NextResponse.json(summary)
}
