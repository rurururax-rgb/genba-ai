/**
 * 新ツール（copy_items_from_project / insert_catalog_item）の
 * バックエンドロジック統合テスト
 *
 * ※ テスト専用 — admin client を使用（本番コードでは service_role は不使用）
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import {
  executeCopyItemsFromProject,
  executeInsertCatalogItem,
  executeSearchCatalog,
} from '../lib/ai/chat/tool-executor'

const env = readFileSync(resolve(process.cwd(), '.env.local'), 'utf-8')
const get = (key: string) => env.split('\n').find(l => l.startsWith(key))?.split('=').slice(1).join('=').trim() ?? ''
const URL  = get('NEXT_PUBLIC_SUPABASE_URL')
const KEY  = get('SUPABASE_SERVICE_ROLE_KEY')
const admin = createClient(URL, KEY)

const PROJECT_ID = 'fb1d785d-e4de-4841-9dec-56255647894c'

function section(title: string) {
  console.log(`\n${'─'.repeat(60)}`)
  console.log(`▶ ${title}`)
  console.log('─'.repeat(60))
}
function print(result: unknown) {
  console.log(JSON.stringify(result, null, 2))
}

async function main() {
  const { data: proj } = await admin
    .from('projects').select('id, name, company_id').eq('id', PROJECT_ID).single()
  if (!proj?.company_id) { console.error('project not found'); process.exit(1) }

  const COMPANY_ID = proj.company_id
  const ctx = { projectId: PROJECT_ID, companyId: COMPANY_ID, supabase: admin }
  // 現在の案件とは別の案件から参照するシナリオを擬似的に作る
  const ctxAlt = { ...ctx, projectId: '00000000-0000-0000-0000-000000000000' }

  // ── 1. 存在しないキーワード ──────────────────────────────
  section('copy_items_from_project: "大阪市"（なし）')
  print(await executeCopyItemsFromProject({ project_keyword: '大阪市' }, ctx))

  // ── 2. 自案件のみ → not_found ────────────────────────────
  section('copy_items_from_project: "犬山"（自案件除外 → not_found）')
  print(await executeCopyItemsFromProject({ project_keyword: '犬山' }, ctx))

  // ── 3. 別 ctx から "犬山" + group_keyword なし → グループ候補 ──
  section('copy_items_from_project: 別ctx "犬山" グループ未指定 → 候補一覧')
  print(await executeCopyItemsFromProject({ project_keyword: '犬山' }, ctxAlt))

  // ── 4. 別 ctx から "犬山" + "水回り" → pending_change ────
  section('copy_items_from_project: 別ctx "犬山" + group_keyword:"水回り" → pending_change')
  print(await executeCopyItemsFromProject(
    { project_keyword: '犬山', group_keyword: '水回り' },
    ctxAlt,
  ))

  // ── 5. カタログ → "システムバス" ─────────────────────────
  section('insert_catalog_item: "システムバス" → pending_change')
  print(await executeInsertCatalogItem(
    { catalog_query: 'システムバス', target_group_id: '9fdf3a7a-88ee-45e8-a52e-d753c34b89d6', quantity: 1 },
    ctx,
  ))

  // ── 6. カタログ → "洗面" ─────────────────────────────────
  section('insert_catalog_item: "洗面"')
  print(await executeInsertCatalogItem(
    { catalog_query: '洗面', target_group_id: '9fdf3a7a-88ee-45e8-a52e-d753c34b89d6' },
    ctx,
  ))

  // ── 7. カタログにない品目 ─────────────────────────────────
  section('insert_catalog_item: "太陽光パネル"（not_found）')
  print(await executeInsertCatalogItem({ catalog_query: '太陽光パネル', target_group_id: null }, ctx))

  // ── 8. 既存ツール確認 ─────────────────────────────────────
  section('search_catalog: "仮設トイレ"')
  print(await executeSearchCatalog({ query: '仮設トイレ', limit: 5 }, ctx))

  console.log('\n✅ テスト完了')
}

main().catch(console.error)
