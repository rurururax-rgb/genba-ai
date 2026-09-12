import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { executeInsertCatalogItem } from '../lib/ai/chat/tool-executor'

const env = readFileSync('.env.local', 'utf-8')
const get = (k: string) => env.split('\n').find(l => l.startsWith(k))?.split('=').slice(1).join('=').trim() ?? ''
const db = createClient(get('NEXT_PUBLIC_SUPABASE_URL'), get('SUPABASE_SERVICE_ROLE_KEY'))

async function main() {
  const PROJECT_ID = 'fb1d785d-e4de-4841-9dec-56255647894c'
  const { data: proj } = await db.from('projects').select('company_id').eq('id', PROJECT_ID).single()
  const ctx = { projectId: PROJECT_ID, companyId: proj!.company_id, supabase: db }

  console.log('=== insert_catalog_item バグ修正確認 ===\n')

  // ── 修正前の失敗パターン（target_group_keyword なし、group_id なし）
  console.log('① 旧動作（group 未指定）:')
  const r1 = await executeInsertCatalogItem(
    { catalog_query: 'システムバス' },
    ctx,
  )
  console.log(JSON.stringify(r1, null, 2))

  // ── 修正後：target_group_keyword:"水回り" を渡す
  console.log('\n② target_group_keyword:"水回り" → グループ解決 → pending_change:')
  const r2 = await executeInsertCatalogItem(
    { catalog_query: 'システムバス', target_group_keyword: '水回り' },
    ctx,
  )
  console.log(JSON.stringify(r2, null, 2))

  // ── 表記ゆれ：前後スペース
  console.log('\n③ target_group_keyword:" 水回り " （前後スペース）:')
  const r3 = await executeInsertCatalogItem(
    { catalog_query: 'システムバス', target_group_keyword: ' 水回り ' },
    ctx,
  )
  console.log(JSON.stringify(r3, null, 2))

  // ── 存在しないグループ名 → 全グループリストを提示
  console.log('\n④ target_group_keyword:"01 水回り"（実際には "水回り" が正式名）:')
  const r4 = await executeInsertCatalogItem(
    { catalog_query: 'システムバス', target_group_keyword: '01 水回り' },
    ctx,
  )
  console.log(JSON.stringify(r4, null, 2))

  // ── 部分一致でも見つかるか
  console.log('\n⑤ target_group_keyword:"水" （部分一致）:')
  const r5 = await executeInsertCatalogItem(
    { catalog_query: 'システムバス', target_group_keyword: '水' },
    ctx,
  )
  console.log(JSON.stringify(r5, null, 2))
}

main().catch(console.error)
