import { NextRequest, NextResponse } from 'next/server'
import { getServerClient } from '@/lib/supabase/server'

// GET /api/projects/[id]/schedule-settings
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const supabase = await getServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data, error } = await supabase
    .from('projects')
    .select('schedule_non_working_weekdays, schedule_non_working_dates')
    .eq('id', id)
    .single()

  if (error || !data) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  return NextResponse.json({
    nonWorkingWeekdays: (data.schedule_non_working_weekdays as number[]) ?? [0],
    nonWorkingDates:    (data.schedule_non_working_dates    as string[]) ?? [],
  })
}

// PATCH /api/projects/[id]/schedule-settings
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const supabase = await getServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json() as {
    nonWorkingWeekdays?: number[]
    nonWorkingDates?:    string[]
  }

  const patch: Record<string, unknown> = {}
  if (Array.isArray(body.nonWorkingWeekdays)) {
    patch.schedule_non_working_weekdays = body.nonWorkingWeekdays.filter(
      (n): n is number => typeof n === 'number' && n >= 0 && n <= 6,
    )
  }
  if (Array.isArray(body.nonWorkingDates)) {
    patch.schedule_non_working_dates = body.nonWorkingDates.filter(
      (d): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d),
    )
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'no valid fields' }, { status: 400 })
  }

  const { error } = await supabase
    .from('projects')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}
