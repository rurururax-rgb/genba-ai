/**
 * POST /api/catalog/bulk-upsert
 *
 * プレビュー確認済みの品目を company_estimate_items に一括登録（UPSERT）。
 * 同名の品目が既にあれば selling_price / cost_price / unit を更新し usage_count をインクリメント。
 * 新規ならそのまま INSERT。
 *
 * セキュリティ: getServerClient()（RLS有効）。admin.ts 不使用。
 */

import { NextRequest, NextResponse } from 'next/server'
import { getServerClient } from '@/lib/supabase/server'
import type { ExtractedItem } from '../import-ai/route'

type RequestBody = {
  items: ExtractedItem[]
}

export async function POST(req: NextRequest) {
  const supabase = await getServerClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: membership } = await supabase
    .from('company_members')
    .select('company_id')
    .eq('user_id', user.id)
    .single()
  if (!membership) return NextResponse.json({ error: 'No company' }, { status: 403 })

  const { company_id } = membership

  let body: RequestBody
  try {
    body = await req.json() as RequestBody
  } catch {
    return NextResponse.json({ error: 'リクエスト形式が不正です' }, { status: 400 })
  }

  const { items } = body
  if (!Array.isArray(items) || items.length === 0) {
    return NextResponse.json({ error: 'items が空です' }, { status: 400 })
  }

  // 上限チェック（一度に送りすぎを防ぐ）
  if (items.length > 500) {
    return NextResponse.json({ error: '一度に登録できるのは500件までです' }, { status: 400 })
  }

  // 既存の品名を一括取得（同名判定用）
  const names = items.map(i => i.name.trim()).filter(Boolean)
  const { data: existingRows } = await supabase
    .from('company_estimate_items')
    .select('id, name, usage_count')
    .eq('company_id', company_id)
    .in('name', names)

  const existingMap = new Map<string, { id: string; usage_count: number }>(
    (existingRows ?? []).map(r => [r.name, { id: r.id, usage_count: r.usage_count ?? 1 }])
  )

  const now = new Date().toISOString()
  let inserted = 0
  let updated  = 0
  const errors: string[] = []

  for (const item of items) {
    const name = item.name.trim()
    if (!name) continue

    const existing = existingMap.get(name)

    if (existing) {
      // 既存行: 単価・原価・単位を更新し usage_count を +1
      const { error } = await supabase
        .from('company_estimate_items')
        .update({
          unit:          item.unit || '式',
          selling_price: item.selling_price,
          cost_price:    item.cost_price,
          category:      item.category || 'その他',
          usage_count:   (existing.usage_count ?? 1) + 1,
          last_used_at:  now,
          updated_at:    now,
        })
        .eq('id', existing.id)

      if (error) errors.push(`${name}: ${error.message}`)
      else updated++
    } else {
      // 新規行: INSERT
      const { error } = await supabase
        .from('company_estimate_items')
        .insert({
          company_id,
          name,
          unit:          item.unit || '式',
          selling_price: item.selling_price,
          cost_price:    item.cost_price,
          category:      item.category || 'その他',
          usage_count:   1,
          last_used_at:  now,
          created_at:    now,
          updated_at:    now,
        })

      if (error) errors.push(`${name}: ${error.message}`)
      else inserted++
    }
  }

  return NextResponse.json({ inserted, updated, errors })
}
