import { NextRequest, NextResponse } from 'next/server'
import { getServerClient } from '@/lib/supabase/server'

// POST: 案件標準掛け率を変更し、AUTO明細の selling_price を一括再計算する
// apply_markup_rate_change() RPC（SECURITY INVOKER）に委任するため、
// projects と estimate_items 両方の UPDATE が1トランザクションで完了する。
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await params
  const body = (await req.json()) as { new_rate: unknown }
  const supabase = await getServerClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const newRate = typeof body.new_rate === 'number' ? body.new_rate : Number(body.new_rate)
  if (!Number.isFinite(newRate) || newRate < 0.01 || newRate > 9.99) {
    return NextResponse.json(
      { error: '掛け率は 0.01〜9.99 の範囲で入力してください。' },
      { status: 400 },
    )
  }

  const { error } = await supabase.rpc('apply_markup_rate_change', {
    p_project_id: projectId,
    p_new_rate:   newRate,
  })

  if (error) {
    return NextResponse.json(
      { error: error.message ?? '掛け率の変更に失敗しました。' },
      { status: 500 },
    )
  }

  return NextResponse.json({ ok: true })
}
