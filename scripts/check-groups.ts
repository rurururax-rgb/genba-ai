import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'

const env = readFileSync('.env.local', 'utf-8')
const get = (k: string) => env.split('\n').find(l => l.startsWith(k))?.split('=').slice(1).join('=').trim() ?? ''
const db = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'))

async function main() {
  const { data: groups, error } = await db
    .from('estimate_groups')
    .select('id, label, project_id, sort_order')
    .is('deleted_at', null)
    .order('sort_order')

  console.log('estimate_groups:', JSON.stringify(groups, null, 2))
  if (error) console.error('error:', error)

  // ILIKE テスト: "水回り" で検索
  const kw = '%水回り%'
  const { data: match1 } = await db
    .from('estimate_groups')
    .select('id, label')
    .is('deleted_at', null)
    .ilike('label', kw)
  console.log('\nilike %水回り%:', JSON.stringify(match1))

  // 部分文字列テスト
  const { data: match2 } = await db
    .from('estimate_groups')
    .select('id, label')
    .is('deleted_at', null)
    .like('label', '%水回り%')
  console.log('like %水回り%:', JSON.stringify(match2))
}
main().catch(console.error)
