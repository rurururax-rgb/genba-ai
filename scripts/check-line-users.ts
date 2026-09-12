import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

async function main() {
  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  )

  const { data, error } = await admin
    .from('line_events')
    .select('line_user_id, event_type, received_at')
    .order('received_at', { ascending: false })
    .limit(100)

  if (error) { console.error('DB error:', error.message); return }
  if (!data || data.length === 0) { console.log('line_events: 0件'); return }

  // userId ごとに集計
  const map = new Map<string, { count: number; types: Set<string>; latest: string }>()
  for (const row of data) {
    const id = row.line_user_id as string
    const entry = map.get(id) ?? { count: 0, types: new Set<string>(), latest: '' }
    entry.count++
    entry.types.add(row.event_type)
    if (!entry.latest || row.received_at > entry.latest) entry.latest = row.received_at
    map.set(id, entry)
  }

  console.log(`\nline_events: ${data.length}件  /  userId ユニーク: ${map.size}件\n`)
  let i = 1
  for (const [id, info] of map) {
    // userId の先頭3文字と末尾3文字のみ表示（中間はマスク）
    const masked = id.length > 8
      ? id.slice(0, 3) + '***' + id.slice(-3)
      : id.slice(0, 2) + '***'
    console.log(`  候補${i}: ${masked}  イベント数=${info.count}  種別=[${[...info.types].join(',')}]  最終=${info.latest.slice(0, 10)}`)
    i++
  }
}
main().catch(e => { console.error(e); process.exit(1) })
