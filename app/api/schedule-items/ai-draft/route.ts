import { NextRequest, NextResponse } from 'next/server'
import { getServerClient } from '@/lib/supabase/server'
import { generateScheduleDraft } from '@/lib/ai/schedule/generate-schedule'

// POST /api/schedule-items/ai-draft
// 見積データをもとに AI が工程案（ドラフト）を生成する。DB 書き込みは行わない。
export async function POST(request: NextRequest) {
  const supabase = await getServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: membership } = await supabase
    .from('company_members')
    .select('company_id')
    .eq('user_id', user.id)
    .single()
  if (!membership) return NextResponse.json({ error: 'No company membership' }, { status: 403 })

  const body = await request.json() as {
    project_id?:           string
    start_date?:           string
    conditions?:           string
    workOnSaturday?:       boolean
    workOnSunday?:         boolean
    nonWorkingWeekdays?:   number[]
    nonWorkingDates?:      string[]
  }

  if (!body.project_id || !body.start_date) {
    return NextResponse.json({ error: 'project_id and start_date are required' }, { status: 400 })
  }

  // YYYY-MM-DD 形式チェック
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.start_date)) {
    return NextResponse.json({ error: 'start_date must be YYYY-MM-DD' }, { status: 400 })
  }

  // 案件の存在・自社所属確認（IDOR 防止）
  const { data: project } = await supabase
    .from('projects')
    .select('id, name')
    .eq('id', body.project_id)
    .eq('company_id', membership.company_id)
    .is('deleted_at', null)
    .single()
  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  // 見積グループ取得
  const { data: groups } = await supabase
    .from('estimate_groups')
    .select('id, label, sort_order')
    .eq('project_id', body.project_id)
    .is('deleted_at', null)
    .order('sort_order')

  // グループごとに見積明細を取得（金額・原価は取得しない）
  const estimateGroups: Array<{
    id: string; label: string
    items: Array<{ name: string; quantity: number; unit: string }>
  }> = []

  for (const group of groups ?? []) {
    const { data: items } = await supabase
      .from('estimate_items')
      .select('name, quantity, unit')
      .eq('project_id', body.project_id)
      .eq('group_id', group.id)
      .is('deleted_at', null)
      .order('sort_order')

    if (items && items.length > 0) {
      estimateGroups.push({
        id: group.id,
        label: group.label,
        items: items.map(i => ({
          name: i.name,
          quantity: typeof i.quantity === 'number' ? i.quantity : 1,
          unit: i.unit ?? '式',
        })),
      })
    }
  }

  // グループなしの場合はグループなし明細も取得
  if (estimateGroups.length === 0) {
    const { data: items } = await supabase
      .from('estimate_items')
      .select('name, quantity, unit')
      .eq('project_id', body.project_id)
      .is('group_id', null)
      .is('deleted_at', null)
      .order('sort_order')

    if (items && items.length > 0) {
      estimateGroups.push({
        id: '',
        label: '工事内容',
        items: items.map(i => ({
          name: i.name,
          quantity: typeof i.quantity === 'number' ? i.quantity : 1,
          unit: i.unit ?? '式',
        })),
      })
    }
  }

  try {
    // nonWorkingWeekdays を優先、なければ旧 workOnSaturday/workOnSunday から変換
    const nonWorkingWeekdays: number[] = body.nonWorkingWeekdays ?? (() => {
      const nw = [0] // 日曜はデフォルト休業
      if (body.workOnSaturday === false) nw.push(6)
      if (body.workOnSunday   === true)  nw.splice(nw.indexOf(0), 1)
      return nw
    })()

    const draftItems = await generateScheduleDraft({
      projectName: project.name,
      estimateGroups,
      startDate: body.start_date,
      conditions: body.conditions,
      calendarOptions: {
        nonWorkingWeekdays,
        nonWorkingDates: body.nonWorkingDates ?? [],
      },
    })

    return NextResponse.json({ items: draftItems })
  } catch (err) {
    console.error('[ai-draft]', err instanceof Error ? err.message : err)
    const msg = err instanceof Error ? err.message : 'AI処理に失敗しました'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
