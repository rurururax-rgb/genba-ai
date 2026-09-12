import { createClient } from '@supabase/supabase-js'
import { getDailyBriefingItems } from '@/lib/services/daily-briefing'
import dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })

async function main() {
  const adminUrl   = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
  const admin = createClient(adminUrl, serviceKey, { auth: { persistSession: false } })

  console.log('\n=== getDailyBriefingItems ===')
  const items = await getDailyBriefingItems(admin)
  console.log('Total items:', items.length)

  for (const item of items) {
    console.log(`\n  [P${item.priority}] ${item.type}`)
    console.log(`    案件: ${item.projectName}`)
    console.log(`    title: ${item.title}`)
    console.log(`    reason: ${item.reason}`)
    console.log(`    action: ${item.recommendedAction}`)
    console.log(`    url: ${item.actionUrl}`)
  }

  if (items.length === 0) {
    console.log('  (0件 — 現在の検出なし)')
  }
}
main().catch(e => { console.error(e); process.exit(1) })
