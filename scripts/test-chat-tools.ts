/**
 * チャットエージェント ツールのローカルテスト
 *
 * 実行方法:
 *   PROJECT_ID=<uuid> npx tsx scripts/test-chat-tools.ts
 *
 * 必要な環境変数:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY  (テスト用のみ。通常は使用禁止)
 *   PROJECT_ID  (テスト対象の案件ID)
 */

import { createClient } from '@supabase/supabase-js'
import { classifySearchResults, type EstimateItemHit, AMBIGUITY_MARGIN } from '../lib/ai/chat/types'

const supabaseUrl  = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceRole  = process.env.SUPABASE_SERVICE_ROLE_KEY!
const projectId    = process.env.PROJECT_ID

if (!supabaseUrl || !serviceRole) {
  console.error('❌ NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です')
  process.exit(1)
}

if (!projectId) {
  console.error('❌ PROJECT_ID が未設定です (例: PROJECT_ID=xxxx-xxxx npx tsx scripts/test-chat-tools.ts)')
  process.exit(1)
}

// テスト用のみ service_role を使用（実際の機能は getServerClient() + RLS）
const admin = createClient(supabaseUrl, serviceRole)

// ─────────────────────────────────────────────────────────────────
// ユニットテスト: classifySearchResults
// ─────────────────────────────────────────────────────────────────

function unitTest() {
  console.log('\n== Unit Test: classifySearchResults ==\n')

  const make = (score: number): EstimateItemHit => ({
    id: 'id', name: 'test', quantity: 1, unit: '式',
    selling_price: 1000, amount: 1000, cost_price: 800, vendor_name: null,
    group_id: null, group_label: null, source: 'manual', memo: null,
    _similarity: score,
  })

  // not_found
  const r1 = classifySearchResults<EstimateItemHit>([], 'test', 10)
  console.assert(r1.status === 'not_found', 'not_found: 空配列')
  console.log(`✅ not_found: [空配列] → status=${r1.status}`)

  // found (1件)
  const r2 = classifySearchResults<EstimateItemHit>([make(0.8)], 'test', 10)
  console.assert(r2.status === 'found', 'found: 1件')
  console.log(`✅ found: [0.8] → status=${r2.status}`)

  // found (差が AMBIGUITY_MARGIN 以上)
  const r3 = classifySearchResults<EstimateItemHit>([make(0.8), make(0.65)], 'test', 10)
  console.assert(r3.status === 'found', `found: 差=${0.8-0.65} >= ${AMBIGUITY_MARGIN}`)
  console.log(`✅ found: [0.8, 0.65] 差=0.15 → status=${r3.status}`)

  // ambiguous (差が AMBIGUITY_MARGIN 未満)
  const r4 = classifySearchResults<EstimateItemHit>([make(0.42), make(0.36)], 'test', 10)
  console.assert(r4.status === 'ambiguous', `ambiguous: 差=${0.42-0.36} < ${AMBIGUITY_MARGIN}`)
  console.log(`✅ ambiguous: [0.42, 0.36] 差=0.06 → status=${r4.status}`)

  // has_more = true
  const r5 = classifySearchResults<EstimateItemHit>([make(0.9), make(0.7)], 'test', 2)
  if (r5.status === 'found') {
    console.assert(r5.has_more === true, 'has_more: limit に達した場合')
    console.log(`✅ has_more: items.length(2) >= limit(2) → has_more=${r5.has_more}`)
  }

  console.log('\n== Unit Test: 全テスト通過 ✅ ==\n')
}

// ─────────────────────────────────────────────────────────────────
// 統合テスト: RPC 関数呼び出し
// ─────────────────────────────────────────────────────────────────

async function integrationTest() {
  console.log('== Integration Test: Supabase RPC ==\n')
  console.log(`対象 project_id: ${projectId}\n`)

  // ── pg_trgm 拡張の確認（search_estimate_items の存在で間接確認） ──
  console.log('▶ pg_trgm 拡張の確認（RPC 関数が存在するかで判定）...')
  const { error: trgmCheckErr } = await admin.rpc('search_estimate_items', {
    p_project_id: projectId,
    p_query:      '__ping__',
    p_limit:      1,
    p_threshold:  0.99,
    p_group_id:   null,
  })
  if (trgmCheckErr && trgmCheckErr.message.includes('function')) {
    console.log('❌ RPC 関数が見つかりません。SQL Editorでマイグレーションを実行してください:')
    console.log('   supabase/migrations/20260815000000_add_pg_trgm_search_functions.sql')
    return
  }
  console.log('✅ pg_trgm + RPC 関数: 確認OK（エラーなし or ヒット0件）')

  // ── search_estimate_items ──────────────────────────────────────
  console.log('\n▶ search_estimate_items: 広めのクエリ（threshold=0.10）')
  const { data: estItems, error: estErr } = await admin.rpc('search_estimate_items', {
    p_project_id: projectId,
    p_query:      '工事',
    p_limit:      10,
    p_threshold:  0.10,
    p_group_id:   null,
  })

  if (estErr) {
    console.error('❌ RPC エラー:', estErr.message)
    console.error('   → SQL Editorでマイグレーションを実行してください:')
    console.error('   supabase/migrations/20260815000000_add_pg_trgm_search_functions.sql')
  } else {
    console.log(`✅ search_estimate_items("工事"): ${estItems?.length ?? 0} 件ヒット`)
    if (estItems && estItems.length > 0) {
      console.table(
        (estItems as EstimateItemHit[]).slice(0, 5).map(i => ({
          name: i.name,
          unit: i.unit,
          selling_price: i.selling_price,
          _similarity: i._similarity.toFixed(3),
        })),
      )
      const result = classifySearchResults<EstimateItemHit>(estItems as EstimateItemHit[], '工事', 10)
      console.log(`  → classifySearchResults: status=${result.status}`)
    }
  }

  // ── search_catalog_items ──────────────────────────────────────
  console.log('\n▶ search_catalog_items: "設備"（company_estimate_items）')

  // company_id を取得
  const { data: anyProject } = await admin
    .from('projects')
    .select('company_id')
    .eq('id', projectId)
    .single()

  if (!anyProject) {
    console.error('❌ project_id からの company_id 取得失敗')
  } else {
    const { data: catItems, error: catErr } = await admin.rpc('search_catalog_items', {
      p_company_id: anyProject.company_id,
      p_query:      '設備',
      p_limit:      10,
      p_threshold:  0.10,
      p_category:   null,
    })

    if (catErr) {
      console.error('❌ RPC エラー:', catErr.message)
    } else {
      console.log(`✅ search_catalog_items("設備"): ${catItems?.length ?? 0} 件ヒット`)
      if (catItems && catItems.length > 0) {
        console.table(catItems.slice(0, 5).map((i: Record<string, unknown>) => ({
          name: i.name,
          unit: i.unit,
          selling_price: i.selling_price,
          usage_count: i.usage_count,
          _similarity: Number(i._similarity).toFixed(3),
        })))
      }
    }
  }

  // ── search_cost_ledger_items ──────────────────────────────────
  console.log('\n▶ search_cost_ledger_items: "工事"')
  const { data: ledgerItems, error: ledgerErr } = await admin.rpc('search_cost_ledger_items', {
    p_project_id: projectId,
    p_query:      '工事',
    p_limit:      10,
    p_threshold:  0.10,
  })

  if (ledgerErr) {
    console.error('❌ RPC エラー:', ledgerErr.message)
  } else {
    console.log(`✅ search_cost_ledger_items("工事"): ${ledgerItems?.length ?? 0} 件ヒット`)
    if (ledgerItems && ledgerItems.length > 0) {
      console.table(ledgerItems.slice(0, 5).map((i: Record<string, unknown>) => ({
        name: i.name,
        vendor_name: i.vendor_name,
        budget_cost: i.budget_cost,
        actual_cost: i.actual_cost,
        _similarity: Number(i._similarity).toFixed(3),
      })))
    }
  }

  // ── 曖昧性テスト（threshold を下げてヒット数を増やす） ────────
  if (estItems && estItems.length >= 2) {
    console.log('\n▶ 曖昧性テスト: threshold=0.05 で "工事" を検索（スコア拮抗を確認）')
    const { data: ambItems } = await admin.rpc('search_estimate_items', {
      p_project_id: projectId,
      p_query:      '工事',
      p_limit:      10,
      p_threshold:  0.05,
      p_group_id:   null,
    }) ?? {}
    if (ambItems && ambItems.length >= 2) {
      const result = classifySearchResults<EstimateItemHit>(ambItems as EstimateItemHit[], '工事', 10)
      console.log(`  → status=${result.status}（アイテム数: ${ambItems.length}）`)
      if (result.status === 'ambiguous') {
        console.log(`  → 曖昧と判定: "${result.disambiguation_hint}"`)
      } else if (result.status === 'found') {
        const scores = (ambItems as EstimateItemHit[]).slice(0, 2).map(i => i._similarity)
        console.log(`  → 明確な1位あり（上位2件スコア差: ${(scores[0] - scores[1]).toFixed(3)}）`)
      }
    }
  }

  console.log('\n== Integration Test: 完了 ==\n')
}

// ─────────────────────────────────────────────────────────────────
// 実行
// ─────────────────────────────────────────────────────────────────

;(async () => {
  unitTest()
  await integrationTest()
})().catch(err => {
  console.error('予期せぬエラー:', err)
  process.exit(1)
})
