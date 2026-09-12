/**
 * DB の現在状態を確認するスクリプト
 * - pg_trgm が有効か
 * - estimate_items に cost_price / vendor_name があるか
 * - 案件・グループ・明細のデータ件数
 * - company_estimate_items の件数
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const env = readFileSync(resolve(process.cwd(), '.env.local'), 'utf-8')
const get = (key: string) => env.split('\n').find(l => l.startsWith(key))?.split('=').slice(1).join('=').trim() ?? ''
const URL  = get('NEXT_PUBLIC_SUPABASE_URL')
const KEY  = get('SUPABASE_SERVICE_ROLE_KEY')

const admin = createClient(URL, KEY)

async function main() {
  console.log('=== DB 状態確認 ===\n')

  // ① pg_trgm 拡張チェック（RPC が存在するかで代用）
  const { error: rpcErr } = await admin.rpc('search_estimate_items', {
    p_project_id: '00000000-0000-0000-0000-000000000000',
    p_query: '__ping__',
    p_limit: 1,
    p_threshold: 0.99,
  })
  const rpcExists = !rpcErr || !rpcErr.message.includes('does not exist')
  console.log('search_estimate_items RPC:', rpcExists ? '✅ 存在' : `❌ ${rpcErr?.message}`)

  const { error: catErr } = await admin.rpc('search_catalog_items', {
    p_company_id: '00000000-0000-0000-0000-000000000000',
    p_query: '__ping__',
    p_limit: 1,
    p_threshold: 0.99,
  })
  console.log('search_catalog_items RPC: ', !catErr || !catErr.message.includes('does not exist') ? '✅ 存在' : `❌ ${catErr?.message}`)

  // ② estimate_items カラム確認
  const { data: cols, error: colErr } = await admin
    .from('estimate_items')
    .select('id, cost_price, vendor_name')
    .limit(1)
  console.log('estimate_items.cost_price / vendor_name:', colErr ? `❌ ${colErr.message}` : '✅ カラム存在')

  // ③ 案件一覧
  const { data: projects } = await admin
    .from('projects')
    .select('id, name, customer_name, status')
    .is('deleted_at', null)
    .order('created_at')
  console.log(`\n案件一覧（${projects?.length ?? 0}件）:`)
  projects?.forEach(p => console.log(`  [${p.id}] ${p.name}（${p.customer_name ?? '顧客名なし'}）`))

  // ④ グループ一覧
  const { data: groups } = await admin
    .from('estimate_groups')
    .select('id, project_id, label')
    .is('deleted_at', null)
  console.log(`\nグループ一覧（${groups?.length ?? 0}件）:`)
  groups?.forEach(g => {
    const proj = projects?.find(p => p.id === g.project_id)
    console.log(`  [${g.id}] ${proj?.name ?? g.project_id} > "${g.label}"`)
  })

  // ⑤ 明細件数
  const { count: itemCount } = await admin
    .from('estimate_items')
    .select('*', { count: 'exact', head: true })
    .is('deleted_at', null)
  console.log(`\n見積明細 合計: ${itemCount ?? 0}件`)

  // ⑥ カタログ件数
  const { count: catCount } = await admin
    .from('company_estimate_items')
    .select('*', { count: 'exact', head: true })
  console.log(`カタログ品目 合計: ${catCount ?? 0}件`)

  // ⑦ カタログサンプル
  const { data: catSamples } = await admin
    .from('company_estimate_items')
    .select('name, selling_price, unit, category')
    .order('usage_count', { ascending: false })
    .limit(5)
  console.log('\nカタログ（usage_count順 上位5件）:')
  catSamples?.forEach(c => console.log(`  "${c.name}" ${c.unit} ¥${c.selling_price ?? '—'}`))
}

main().catch(console.error)
