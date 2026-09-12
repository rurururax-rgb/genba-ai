/**
 * scripts/test-line-push.ts
 *
 * LINE Push Message 単体テスト。
 * 実行1回につき push 1通のみ送信する。
 *
 * 使い方:
 *   npx tsx scripts/test-line-push.ts
 *
 * 前提:
 *   .env.local に以下が設定されていること
 *     LINE_CHANNEL_ACCESS_TOKEN=...
 *     LINE_BRIEFING_USER_ID=U...
 */

import dotenv from 'dotenv'
import { sendLinePushMessage, maskUserId } from '@/lib/line/push'

dotenv.config({ path: '.env.local' })

const TEST_MESSAGE = `【現場AI テスト】
LINE通知の接続テストです。
このメッセージが届けば送信連携は正常です。`

async function main() {
  console.log('\n=== LINE Push 単体テスト ===\n')

  // ── 環境変数チェック ─────────────────────────────────────────────

  const token  = process.env.LINE_CHANNEL_ACCESS_TOKEN
  const userId = process.env.LINE_BRIEFING_USER_ID

  if (!token) {
    console.error('❌ LINE_CHANNEL_ACCESS_TOKEN が .env.local に設定されていません')
    process.exit(1)
  }
  if (!userId) {
    console.error('❌ LINE_BRIEFING_USER_ID が .env.local に設定されていません')
    console.error('   .env.local に以下を追加してください:')
    console.error('   LINE_BRIEFING_USER_ID=Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')
    process.exit(1)
  }

  // 安全なマスク表示（token は表示しない）
  console.log(`  LINE_CHANNEL_ACCESS_TOKEN: 設定済み（表示しない）`)
  console.log(`  LINE_BRIEFING_USER_ID:     ${maskUserId(userId)}`)
  console.log(`  送信先 userId 先頭文字:     ${userId.charAt(0)}（"U" であれば正常）\n`)

  if (!userId.startsWith('U')) {
    console.error('❌ LINE_BRIEFING_USER_ID が "U" で始まっていません（フォーマットを確認してください）')
    process.exit(1)
  }

  // ── 送信（1回のみ）────────────────────────────────────────────────

  console.log('テストメッセージを送信します...')
  console.log('---')
  console.log(TEST_MESSAGE)
  console.log('---\n')

  const result = await sendLinePushMessage({ to: userId, text: TEST_MESSAGE })

  // ── 結果 ─────────────────────────────────────────────────────────

  if (result.ok) {
    console.log('✅ 送信成功')
    console.log('\n確認事項:')
    console.log('  1. LINE アプリに「現場AI テスト」メッセージが1通届いていること')
    console.log('  2. 同じメッセージが複数届いていないこと（重複なし）')
    console.log('\nStep 2 完了。Step 3（Cron + 二重送信防止）へ進めます。')
  } else {
    console.error(`❌ 送信失敗: ${result.reason}`)
    if ('httpStatus' in result) {
      console.error(`   HTTP ステータス: ${result.httpStatus}`)
    }
    console.error('\n確認事項:')
    console.error('  - LINE_CHANNEL_ACCESS_TOKEN が有効か（LINE Developers > Channel access token）')
    console.error('  - LINE_BRIEFING_USER_ID が正しいか（"U" + 32文字）')
    console.error('  - Messaging API チャネルが有効か')
    process.exit(1)
  }
}

main().catch(e => {
  console.error('予期しないエラー:', e instanceof Error ? e.message : String(e))
  process.exit(1)
})
