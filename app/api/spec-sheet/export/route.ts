import { NextRequest, NextResponse } from 'next/server'
import { getServerClient } from '@/lib/supabase/server'
import { fillSpecSheet } from '@/lib/excel/fill-spec-sheet'
import type { SpecDetailResult } from '@/app/api/ai/extract-spec-detail/route'
import type { SheetType } from '@/lib/excel/fill-spec-sheet'

export const maxDuration = 30

export async function POST(request: NextRequest) {
  const supabase = await getServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json() as {
    data:       SpecDetailResult
    sheet_type: SheetType
  }

  if (!body.data || !body.sheet_type) {
    return NextResponse.json({ error: 'data and sheet_type are required' }, { status: 400 })
  }
  if (body.sheet_type !== '大' && body.sheet_type !== '中') {
    return NextResponse.json({ error: 'sheet_type must be 大 or 中' }, { status: 400 })
  }

  try {
    const buf = await fillSpecSheet(body.data, body.sheet_type)

    return new NextResponse(buf as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename*=UTF-8''%E4%BB%95%E6%A7%98%E6%9B%B8${encodeURIComponent(body.sheet_type)}.xlsx`,
      },
    })
  } catch (err) {
    console.error('[spec-sheet/export]', err)
    return NextResponse.json({ error: 'Excel生成に失敗しました' }, { status: 500 })
  }
}
