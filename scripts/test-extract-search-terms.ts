/**
 * extractSearchTerms() 動作確認スクリプト
 *
 * 実行方法:
 *   npm run test:extract
 *
 * または直接:
 *   npx tsx scripts/test-extract-search-terms.ts
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// ── .env.local を手動ロード ───────────────────────────────
// tsx は Next.js と違い .env.local を自動で読まないため、
// Anthropic クライアントの初期化より前に env をセットする。
;(function loadEnvLocal() {
  try {
    const content = readFileSync(resolve(process.cwd(), '.env.local'), 'utf-8')
    for (const line of content.split('\n')) {
      const clean = line.replace(/#.*$/, '').trim()     // インラインコメント除去
      const eqIdx = clean.indexOf('=')
      if (eqIdx === -1) continue
      const key = clean.slice(0, eqIdx).trim()
      const value = clean.slice(eqIdx + 1).trim()
      if (key && !(key in process.env)) process.env[key] = value
    }
  } catch {
    // .env.local が存在しない場合はシステム環境変数をそのまま使用
  }
})()

// env ロード完了後に import する（lazy client 化と組み合わせて確実に動作）
import { extractSearchTerms, type SearchTerm } from '../lib/ai/extract-search-terms.js'

// ── テストケース ──────────────────────────────────────────

const TEST_CASES: readonly string[] = [
  'お風呂交換しといて',
  'バス替えます',
  '浴室のリフォームをお願いします',
  'トイレとお風呂と台所を全部やって',
  '電気周り全部やって',
  // ── 数量・単位抽出のテストケース ──
  '配管は12メートル使って',                   // → quantity:12, unit:"m"
  '壁の材木は8平米くらい',                    // → quantity:8,  unit:"㎡"
  'システムバス交換して',                      // → quantity:null（数量の概念なし）
  // ── detail（メーカー・型番）抽出のテストケース ──
  '配管はTOTOのVP管使って、12メートル',       // → quantity:12, unit:"m", detail:"TOTO VP管"
  'システムバスはLIXILのアライズにします',    // → quantity:null, detail:"LIXIL アライズ"
]

// ── メイン ───────────────────────────────────────────────

async function main(): Promise<void> {
  // 起動時チェック
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('❌ ANTHROPIC_API_KEY が設定されていません。.env.local を確認してください。')
    process.exit(1)
  }
  if (!process.env.ANTHROPIC_MODEL) {
    console.error('❌ ANTHROPIC_MODEL が設定されていません。.env.local を確認してください。')
    process.exit(1)
  }

  console.log('=== extractSearchTerms() テスト ===')
  console.log(`モデル: ${process.env.ANTHROPIC_MODEL}`)
  console.log(`日時:   ${new Date().toLocaleString('ja-JP')}\n`)

  const results: { input: string; terms: SearchTerm[]; ms: number }[] = []

  for (const [i, input] of TEST_CASES.entries()) {
    process.stdout.write(`[${i + 1}/${TEST_CASES.length}] 「${input}」 ... `)

    const t0 = Date.now()
    const result = await extractSearchTerms(input)
    const ms = Date.now() - t0

    results.push({ input, terms: result.terms, ms })
    console.log(`(${ms}ms)`)
  }

  // ── 結果サマリー ──────────────────────────────────────
  console.log('\n─────────────────────────────────────────────')
  console.log('結果サマリー')
  console.log('─────────────────────────────────────────────')

  for (const [i, { input, terms, ms }] of results.entries()) {
    console.log(`\n[${i + 1}] 入力: 「${input}」`)
    for (const st of terms) {
      const qty    = st.quantity != null ? ` quantity:${st.quantity}` : ''
      const unit   = st.unit   != null ? ` unit:"${st.unit}"` : ''
      const detail = st.detail != null ? ` detail:"${st.detail}"` : ''
      console.log(`    → ${st.term}${qty}${unit}${detail}`)
    }
    if (terms.length === 0) console.log('    → （建材・工事なし）')
    console.log(`    所要: ${ms}ms`)
  }

  // ── pg_trgm 検索に渡す想定のキーワード一覧 ──────────
  const allTerms = [...new Set(results.flatMap((r) => r.terms.map((t) => t.term)))]
  console.log('\n─────────────────────────────────────────────')
  console.log('全テストケースから抽出されたユニークなキーワード')
  console.log('(これを match_estimate_items() に渡す)')
  console.log('─────────────────────────────────────────────')
  allTerms.forEach((t, i) => console.log(`  ${i + 1}. ${t}`))
  console.log()
}

main().catch((err: unknown) => {
  console.error('\n❌ 予期しないエラー:')
  console.error(err)
  process.exit(1)
})
