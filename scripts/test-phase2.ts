/**
 * Phase 2 品質検証スクリプト
 *
 * 実行: npx tsx scripts/test-phase2.ts
 *
 * 検証項目:
 *   1. /api/projects/summary — 今日の要対応の数値
 *   2. CompanyChat 3プロンプト
 *   3. create_invoice_draft (existing issued → 拒否)
 *   4. create_invoice_draft (no invoice project → PendingChange)
 *   5. confirm-change → draft 1件作成
 *   6. 再confirm → 409
 *   7. 他社 project_id → 拒否
 *   8. 案件詳細 ChatPanel (project-scoped)
 */

import * as dotenv from 'dotenv'
import { resolve } from 'path'
import { createClient } from '@supabase/supabase-js'

dotenv.config({ path: resolve(process.cwd(), '.env.local') })

const BASE_URL = 'http://localhost:3000'
const SUPABASE_URL  = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY!
const USER_EMAIL    = 'ru.ru.ru.rax@gmail.com'

// ── ユーティリティ ─────────────────────────────────────────────
const pass = (msg: string) => console.log('  ✅', msg)
const fail = (msg: string) => console.error('  ❌', msg)
const info = (msg: string) => console.log('  ℹ️ ', msg)
const sep  = (title: string) => console.log(`\n${'─'.repeat(55)}\n${title}`)

// ── Admin クライアント（サービスロール）────────────────────────
const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

// @supabase/ssr のデフォルト cookie 名
// プロジェクト ref は URL ホスト名の第1セグメント
const PROJECT_REF = new URL(SUPABASE_URL).hostname.split('.')[0]
const COOKIE_NAME = `sb-${PROJECT_REF}-auth-token`

// ── ユーザーセッションを取得し、SSR Cookie 文字列として返す ──
// トークン値は変数のみで保持し console には出力しない
async function getAuthCookieString(): Promise<string> {
  // generate_link を使い exchange_token で JWT を取得
  const linkRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ type: 'magiclink', email: USER_EMAIL }),
  })
  const linkData = await linkRes.json() as {
    action_link?: string
    hashed_token?: string
    error?: string
    message?: string
  }
  if (linkData.error || !linkData.action_link) {
    throw new Error(`generate_link failed: ${linkData.error} ${linkData.message}`)
  }

  // email_otp + type="email" で verify（email は変数のみで保持・出力しない）
  const emailOtp: string = (linkData as { email_otp?: string }).email_otp ?? ''
  const hashedToken: string = linkData.hashed_token ?? ''

  if (!emailOtp && !hashedToken) throw new Error('email_otp and hashed_token not found')

  // まず token_hash（新 API）で試みる。失敗したら email+otp（旧 API）で再試行
  let session: { access_token?: string; error?: string; message?: string } = {}

  if (hashedToken) {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/verify`, {
      method: 'POST',
      headers: { apikey: SERVICE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token_hash: hashedToken, type: 'email' }),
    })
    session = await r.json()
  }

  if (!session.access_token && emailOtp) {
    // フォールバック: email + otp
    const r = await fetch(`${SUPABASE_URL}/auth/v1/verify`, {
      method: 'POST',
      headers: { apikey: SERVICE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'email', token: emailOtp, email: USER_EMAIL }),
    })
    session = await r.json()
  }

  const fullSession = session as {
    access_token?: string
    refresh_token?: string
    token_type?: string
    expires_in?: number
    expires_at?: number
    user?: unknown
    error?: string
    message?: string
  }

  if (!fullSession.access_token) {
    throw new Error(`No access_token: ${JSON.stringify({ error: fullSession.error, message: fullSession.message })}`)
  }

  // @supabase/ssr が期待するセッション JSON を Cookie 値にエンコード
  const sessionJson = JSON.stringify({
    access_token:  fullSession.access_token,
    refresh_token: fullSession.refresh_token ?? '',
    token_type:    fullSession.token_type ?? 'bearer',
    expires_in:    fullSession.expires_in ?? 3600,
    expires_at:    fullSession.expires_at ?? Math.floor(Date.now() / 1000) + 3600,
    user:          fullSession.user,
  })
  // @supabase/ssr はデフォルトで base64url encode せず JSON 文字列をそのまま使う
  // ただし 3180 bytes を超える場合はチャンク分割される。ここでは単一 cookie として渡す
  return `${COOKIE_NAME}=${encodeURIComponent(sessionJson)}`
}

// ── HTTP ヘルパー（認証ヘッダー付き）────────────────────────────
// token は "CookieName=value" 形式の文字列
async function apiGet(path: string, token: string) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { Cookie: token },
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

async function apiPost(path: string, body: unknown, token: string) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: token,
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json: unknown
  try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, body: json }
}

// ── SSE チャット結果 ───────────────────────────────────────────
// route.ts が出すイベント型（コードより確認済み）:
//   { type: 'text',   delta: string }         テキストデルタ
//   { type: 'status', text: string }           ツール実行中（例: '確認中…'）
//   { type: 'done',   pending_changes: [...], suggestions: [...] }  完了
//   { type: 'error',  message: string }        エラー
// ※ tool_use 名は SSE に含まれない（status イベントで「ツール使用中」のみ検知可）
type ChatSSEResult = {
  fullText:         string
  pendingChanges:   unknown[]
  suggestions:      unknown[]
  statusEvents:     string[]     // ツール実行中メッセージ（使用を示す）
  errorMessage:     string | null
  rawChunks:        unknown[]
}

async function chatSSE(
  body: unknown,
  token: string,
  timeoutMs = 60_000,
): Promise<ChatSSEResult> {
  const res = await fetch(`${BASE_URL}/api/ai/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: token,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })

  if (!res.ok) {
    const text = await res.text()
    return {
      fullText: '', pendingChanges: [], suggestions: [],
      statusEvents: [], errorMessage: `HTTP ${res.status}: ${text}`,
      rawChunks: [],
    }
  }

  const rawChunks: unknown[] = []
  let fullText = ''
  let pendingChanges: unknown[] = []
  let suggestions: unknown[] = []
  const statusEvents: string[] = []
  let errorMessage: string | null = null

  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const json = line.slice(6).trim()
      if (!json) continue
      let ev: Record<string, unknown>
      try { ev = JSON.parse(json) } catch { continue }

      rawChunks.push(ev)

      switch (ev.type) {
        case 'text':
          fullText += (ev.delta as string) ?? ''
          break
        case 'status':
          statusEvents.push((ev.text as string) ?? '')
          break
        case 'done':
          pendingChanges = (ev.pending_changes as unknown[]) ?? []
          suggestions    = (ev.suggestions    as unknown[]) ?? []
          reader.cancel()
          return { fullText, pendingChanges, suggestions, statusEvents, errorMessage, rawChunks }
        case 'error':
          errorMessage = (ev.message as string) ?? JSON.stringify(ev)
          reader.cancel()
          return { fullText, pendingChanges, suggestions, statusEvents, errorMessage, rawChunks }
      }
    }
  }
  reader.cancel()
  return { fullText, pendingChanges, suggestions, statusEvents, errorMessage, rawChunks }
}

// ── プロジェクト一覧取得（admin で直接DB）──────────────────────
async function getProjects() {
  const COMPANY_ID = 'b0aa6eed-faec-4698-ac87-9d9e2d350280'
  const { data } = await admin
    .from('projects')
    .select('id, name, status')
    .eq('company_id', COMPANY_ID)
    .is('deleted_at', null)
  return data ?? []
}

// ══════════════════════════════════════════════════════════
// メイン
// ══════════════════════════════════════════════════════════
async function main() {
  console.log('Phase 2 品質検証スクリプト起動')
  console.log('BASE_URL:', BASE_URL)

  // ── 認証トークン取得 ──────────────────────────────────
  sep('認証トークン取得')
  let token: string
  try {
    token = await getAuthCookieString()
    pass('ユーザーセッション取得成功（トークン非公開）')
  } catch (e) {
    fail(`JWT 取得失敗: ${e}`)
    console.log('\n⚠️  ブラウザで認証後、Cookie から sb-access-token を取得してください')
    process.exit(1)
  }

  // ── TEST 1: /api/projects/summary ────────────────────
  sep('TEST 1: /api/projects/summary')
  const summaryRes = await apiGet('/api/projects/summary', token)
  if (summaryRes.status === 200) {
    const s = summaryRes.body as {
      active_projects: number
      total_unpaid_amount: number
      overdue_only_amount: number
      unpaid_milestones: unknown[]
      draft_invoices: unknown[]
      issued_unpaid_invoices: { project_id: string; project_name: string }[]
    }
    pass(`ステータス 200`)
    info(`active_projects: ${s.active_projects}`)
    info(`total_unpaid_amount: ¥${s.total_unpaid_amount?.toLocaleString('ja-JP') ?? 0}`)
    info(`overdue_only_amount: ¥${s.overdue_only_amount?.toLocaleString('ja-JP') ?? 0}`)
    info(`unpaid_milestones: ${s.unpaid_milestones?.length ?? 0}件`)
    info(`draft_invoices: ${s.draft_invoices?.length ?? 0}件`)
    info(`issued_unpaid_invoices: ${s.issued_unpaid_invoices?.length ?? 0}件`)

    // DB実データとの整合チェック
    // 本番DB: milestones は全件 invoice_date=null → 0件が正解
    if (s.unpaid_milestones?.length === 0) {
      pass('未入金 milestone = 0件（DB実数値と一致）')
    } else {
      fail(`未入金 milestone = ${s.unpaid_milestones?.length}件（0件が期待値）`)
    }
    // issued invoice が 1件あるはず
    if (s.issued_unpaid_invoices?.length === 1) {
      pass('issued_unpaid_invoices = 1件（DB実数値と一致）')
      info(`  → ${s.issued_unpaid_invoices[0].project_name}`)
    } else {
      fail(`issued_unpaid_invoices = ${s.issued_unpaid_invoices?.length}件（1件が期待値）`)
    }
  } else {
    fail(`ステータス ${summaryRes.status}: ${JSON.stringify(summaryRes.body)}`)
  }

  // ── TEST 2: CompanyChat 3プロンプト ──────────────────────
  sep('TEST 2: CompanyChat — 3プロンプト')

  // DB実データ（検証の基準値）
  const DB_FACTS = {
    unpaid_milestones:       0,
    issued_unpaid_count:     1,
    issued_project_name:     '犬山市古民家減築プラン',
    draft_count:             0,
  } as const

  let companyChatAvailable = true  // Anthropic クレジット切れで false になる

  const chatPrompts = [
    {
      label: 'A. 未入金の案件を教えて',
      message: '未入金の案件を教えて',
      // DB整合チェック：unpaid_milestones=0 なので「未入金なし」or 「発行済み1件」が正解
      // 存在しない金額・案件名・請求日を言っていないかチェック
      checkFn: (text: string) => {
        const issues: string[] = []
        // 支払いスケジュール上の未入金は 0 件 → 架空の円金額を言っていたら NG
        const amountMatch = text.match(/[¥￥]\s*[\d,]+|[\d,]+\s*円/)
        if (amountMatch) {
          issues.push(`架空の金額を含む可能性: "${amountMatch[0]}"（DB: milestone未入金=¥0）`)
        }
        // 「犬山市古民家減築プラン」以外の案件名が含まれていたら NG
        if (text.includes('櫻庭') && !text.includes('issued') && !text.includes('発行済み')) {
          // 櫻庭案件は issued 請求書なし → 未入金として挙げるのは不正確
          issues.push('未入金として「櫻庭様邸」を挙げている（該当なし）')
        }
        return issues
      },
    },
    {
      label: 'B. 今月請求すべき案件は？',
      message: '今月請求すべき案件は？',
      checkFn: (text: string) => {
        const issues: string[] = []
        // milestone invoice_date がすべて null → 請求スケジュール未設定
        // ¥0 はDBと一致するので正しい。正の金額を「今月請求」として言及していたらNG
        const positiveAmount = text.match(/[¥￥]\s*([1-9][\d,]*)\b|([1-9][\d,]*)\s*円/)
        if (positiveAmount) {
          // ただし「既に発行済み」の文脈での金額言及は許容
          if (!text.includes('発行済み') && !text.includes('issued')) {
            issues.push(`未設定の請求スケジュールに対し金額を言及: "${positiveAmount[0]}"`)
          }
        }
        return issues
      },
    },
    {
      label: 'C. 一番優先すべき案件は？',
      message: '一番優先すべき案件は？',
      checkFn: (text: string) => {
        const issues: string[] = []
        // 存在しない案件名を言っていないかチェック
        const knownProjects = ['犬山市', '犬山', '古民家', '櫻庭', '塗装']
        const hasMention = knownProjects.some(n => text.includes(n))
        if (!hasMention && text.length > 50) {
          issues.push(`既知の案件名（犬山市/櫻庭）への言及がない`)
        }
        return issues
      },
    },
  ]

  for (const { label, message, checkFn } of chatPrompts) {
    console.log(`\n  ─ ${label}`)
    const result = await chatSSE(
      { messages: [{ role: 'user', content: message }] },
      token,
    )

    // クレジット不足エラーの検出
    if (result.errorMessage?.includes('credit balance is too low')) {
      info('Anthropic API クレジット不足 → このプロンプトをスキップ')
      companyChatAvailable = false
      continue
    }

    if (result.errorMessage) {
      fail(`エラー: ${result.errorMessage.slice(0, 200)}`)
      continue
    }

    // ツール使用ログ（status イベントで検知）
    if (result.statusEvents.length > 0) {
      info(`ツール使用: status="${result.statusEvents.join(', ')}"（${result.statusEvents.length}回）`)
    } else {
      info('ツール使用: なし（テキスト直接応答）')
    }

    // AI 回答全文
    if (result.fullText.length > 0) {
      pass('AI 回答受信')
      console.log(`  AI回答:\n    ${result.fullText.replace(/\n/g, '\n    ')}`)
    } else {
      fail('AI 回答が空')
    }

    // PendingChange があれば表示
    if (result.pendingChanges.length > 0) {
      info(`PendingChanges: ${result.pendingChanges.length}件`)
    }

    // DB整合チェック
    const dbIssues = checkFn(result.fullText)
    if (dbIssues.length === 0) {
      pass('DB実データとの整合: 問題なし')
    } else {
      for (const issue of dbIssues) {
        fail(`DB整合チェック: ${issue}`)
      }
    }
  }

  if (!companyChatAvailable) {
    info('CompanyChat テストは Anthropic クレジット回復後に再実行してください')
  }

  // ── TEST 3: confirm-change で issued → 拒否（直接テスト）──
  sep('TEST 3: confirm-change — issued 請求書が既存 → 409')
  const ISSUED_PROJECT = 'fb1d785d-e4de-4841-9dec-56255647894c'

  const existingCheck = await apiPost('/api/ai/chat/confirm-change', {
    change: {
      id: 'test-issued-reject',
      target_table: 'invoice_documents',
      change_type: 'create',
      proposed: {
        project_id:   ISSUED_PROJECT,
        project_name: '犬山市古民家減築プラン',
        status:       'draft',
        note:         null,
      },
    },
  }, token)
  if (existingCheck.status === 409) {
    pass(`409 Conflict（既存 issued により二重作成防止）`)
    info(`エラー: ${JSON.stringify(existingCheck.body)}`)
  } else {
    fail(`ステータス ${existingCheck.status}（409 期待）: ${JSON.stringify(existingCheck.body)}`)
  }

  // ── TEST 4 & 5: 別案件で confirm → draft 作成 ────────────
  sep('TEST 4 & 5: 別案件 confirm → draft 1件作成')

  const projects = await getProjects()
  info(`案件一覧: ${projects.map(p => `${p.name}(${p.status})`).join(', ')}`)

  const { data: existingInvoices } = await admin
    .from('invoice_documents')
    .select('project_id')
    .in('status', ['draft', 'issued'])
  const existingPids = new Set((existingInvoices ?? []).map(i => i.project_id))
  const targetProject = projects.find(p => !existingPids.has(p.id))

  if (!targetProject) {
    info('請求書がない案件なし → TEST 4-6 スキップ（全案件に既存請求書）')
  } else {
    info(`対象案件: ${targetProject.name} (${targetProject.id})`)

    const mockChange = {
      id: 'test-create-draft-001',
      target_table: 'invoice_documents',
      change_type: 'create',
      proposed: {
        project_id:   targetProject.id,
        project_name: targetProject.name,
        customer_name: null,
        status:       'draft',
        note:         'Phase2テスト用',
      },
    }

    // 5. 1回目 confirm → draft 作成
    const confirmRes1 = await apiPost('/api/ai/chat/confirm-change', { change: mockChange }, token)
    if (confirmRes1.status === 200) {
      const data = (confirmRes1.body as { ok: boolean; data: { id: string; status: string } }).data
      pass(`confirm 1回目 → 200 OK（draft 作成成功）`)
      info(`作成: id=${data?.id}, status=${data?.status}`)

      // ── TEST 6: 同じ change を再送 → 409 ──────────────────
      sep('TEST 6: 再confirm → 409 Conflict（二重作成防止）')
      const confirmRes2 = await apiPost('/api/ai/chat/confirm-change', { change: mockChange }, token)
      if (confirmRes2.status === 409) {
        pass('再confirm → 409 Conflict')
        info(`エラー: ${JSON.stringify(confirmRes2.body)}`)
      } else {
        fail(`再confirm → ${confirmRes2.status}（409 期待）: ${JSON.stringify(confirmRes2.body)}`)
      }

      // テスト用 draft を削除してDB汚染を防ぐ
      if (data?.id) {
        await admin.from('invoice_documents').delete().eq('id', data.id)
        info('テスト用 draft を削除しました')
      }
    } else {
      fail(`confirm 1回目 → ${confirmRes1.status}: ${JSON.stringify(confirmRes1.body)}`)
    }
  }

  // ── TEST 7: 他社 project_id → confirm-change で拒否 ──────
  sep('TEST 7: 他社 project_id → confirm-change で 404')
  const FAKE_PROJECT_ID = '00000000-0000-0000-0000-000000000001'
  const crossRes = await apiPost('/api/ai/chat/confirm-change', {
    change: {
      id: 'test-cross-company',
      target_table: 'invoice_documents',
      change_type: 'create',
      proposed: {
        project_id: FAKE_PROJECT_ID,
        status: 'draft',
      },
    },
  }, token)
  if (crossRes.status === 404 || crossRes.status === 403) {
    pass(`他社/不正 project_id → ${crossRes.status}（拒否確認）`)
  } else {
    fail(`ステータス ${crossRes.status}（404 または 403 期待）: ${JSON.stringify(crossRes.body)}`)
  }

  // ── TEST 8: 案件詳細 ChatPanel（project-scoped）────────────
  // /api/projects/[id] は PATCH のみ実装（GET は 405）。
  // ChatPanel は /api/ai/chat に project_id を body で渡す。
  sep('TEST 8: 案件詳細 ChatPanel — /api/ai/chat?project_id=...')
  {
    const pid = projects[0]?.id
    if (!pid) {
      info('案件なし → スキップ')
    } else if (!companyChatAvailable) {
      info('Anthropic クレジット不足 → スキップ')
    } else {
      info(`対象案件: ${projects[0].name} (${pid.slice(0,8)}...)`)

      const result = await chatSSE(
        {
          project_id: pid,
          messages: [{ role: 'user', content: 'この案件の見積合計を教えて' }],
        },
        token,
      )

      if (result.errorMessage?.includes('credit balance is too low')) {
        info('Anthropic クレジット不足 → スキップ')
      } else if (result.errorMessage) {
        fail(`エラー: ${result.errorMessage.slice(0, 200)}`)
      } else if (result.fullText.length > 0) {
        pass(`案件詳細 ChatPanel 応答あり（project_id 付き）`)
        if (result.statusEvents.length > 0) {
          info(`ツール使用: status="${result.statusEvents.join(', ')}"`)
        }
        console.log(`  AI回答:\n    ${result.fullText.replace(/\n/g, '\n    ')}`)
      } else {
        fail('案件詳細 ChatPanel の回答が空')
        info(`rawChunks: ${JSON.stringify(result.rawChunks.slice(0, 3))}`)
      }
    }
  }

  // ── TEST 9: billing-status 6ケース（DB直接検証）────────────
  sep('TEST 9: billing-status 状態定義 6ケース（DB直接確認）')
  {
    const COMPANY_ID = 'b0aa6eed-faec-4698-ac87-9d9e2d350280'

    // ケースA: milestone未設定 + issued invoice あり → "発行済み・入金確認必要"
    console.log('\n  ケースA: milestone未設定 + issued invoice あり')
    {
      const { data: milestones } = await admin
        .from('project_billing_milestones')
        .select('id, invoice_date, payment_date')
        .eq('company_id', COMPANY_ID)
        .is('invoice_date', null)
      const { data: issued } = await admin
        .from('invoice_documents')
        .select('id, project_id, status')
        .eq('company_id', COMPANY_ID)
        .eq('status', 'issued')

      const unset = (milestones ?? []).length
      const issuedCount = (issued ?? []).length

      if (unset > 0 && issuedCount > 0) {
        pass(`milestone未設定=${unset}件、issued=${issuedCount}件 → "発行済み・入金確認必要"が正解`)
        info('「未入金なし」や「入金済み」と断定してはいけない状態')
      } else {
        info(`milestone未設定=${unset}件、issued=${issuedCount}件（現在このケースに該当しない）`)
      }
    }

    // ケースB: invoice_date あり + payment_date なし → 未入金
    console.log('\n  ケースB: invoice_date あり + payment_date なし → 未入金')
    {
      const { data } = await admin
        .from('project_billing_milestones')
        .select('id, invoice_date, invoice_amount, payment_date')
        .eq('company_id', COMPANY_ID)
        .not('invoice_date', 'is', null)
        .not('invoice_amount', 'is', null)
        .is('payment_date', null)
      const count = (data ?? []).length
      if (count === 0) {
        pass(`現在 invoice_date 設定済み未入金 = 0件（DB一致）`)
      } else {
        pass(`invoice_date 設定済み未入金 = ${count}件（未入金として計上すべき）`)
        for (const m of data ?? []) {
          info(`  → invoice_date=${m.invoice_date}, amount=${m.invoice_amount}`)
        }
      }
    }

    // ケースC: invoice_date あり + payment_date あり → 入金済み
    console.log('\n  ケースC: invoice_date あり + payment_date あり → 入金済み')
    {
      const { data } = await admin
        .from('project_billing_milestones')
        .select('id, invoice_date, payment_date, payment_amount')
        .eq('company_id', COMPANY_ID)
        .not('payment_date', 'is', null)
      const count = (data ?? []).length
      if (count === 0) {
        pass(`現在 payment_date 設定済み = 0件（入金記録なし）`)
      } else {
        pass(`payment_date 設定済み = ${count}件（入金済みとして扱うべき）`)
      }
    }

    // ケースD: draft invoice → 未発行
    console.log('\n  ケースD: draft invoice → 未発行')
    {
      const { data } = await admin
        .from('invoice_documents')
        .select('id, status')
        .eq('company_id', COMPANY_ID)
        .eq('status', 'draft')
      const count = (data ?? []).length
      if (count === 0) {
        pass(`現在 draft invoice = 0件（DB一致）`)
      } else {
        pass(`draft invoice = ${count}件（「未発行」として表示すべき）`)
      }
    }

    // ケースE: 将来の invoice_date → 請求予定
    console.log('\n  ケースE: 将来の invoice_date → 請求予定')
    {
      const today = new Date().toISOString().slice(0, 10)
      const { data } = await admin
        .from('project_billing_milestones')
        .select('id, invoice_date, payment_date')
        .eq('company_id', COMPANY_ID)
        .gt('invoice_date', today)
        .is('payment_date', null)
      const count = (data ?? []).length
      if (count === 0) {
        pass(`現在 将来invoice_date = 0件（請求予定なし）`)
      } else {
        pass(`将来invoice_date 設定済み = ${count}件（「請求予定」として表示すべき）`)
      }
    }

    // ケースF: 期限超過 + payment_date なし → 入金遅延
    console.log('\n  ケースF: 期限超過 + payment_date なし → 入金遅延')
    {
      const today = new Date().toISOString().slice(0, 10)
      const { data } = await admin
        .from('project_billing_milestones')
        .select('id, invoice_date, payment_date')
        .eq('company_id', COMPANY_ID)
        .lt('invoice_date', today)
        .is('payment_date', null)
        .not('invoice_date', 'is', null)
      const count = (data ?? []).length
      if (count === 0) {
        pass(`現在 期限超過未入金 = 0件（遅延なし）`)
      } else {
        pass(`期限超過未入金 = ${count}件（「入金遅延」として扱うべき）`)
        for (const m of data ?? []) {
          const days = Math.floor((new Date(today).getTime() - new Date(m.invoice_date).getTime()) / 86_400_000)
          info(`  → invoice_date=${m.invoice_date}、${days}日超過`)
        }
      }
    }
  }

  // ── TEST 10: CompanyChat 追加プロンプト（billing統合後確認）──
  sep('TEST 10: CompanyChat — billing統合後の4プロンプト')
  if (!companyChatAvailable) {
    info('Anthropic クレジット不足 → スキップ')
  } else {
    const billingPrompts = [
      {
        label: 'A. 未入金の案件を教えて（再テスト）',
        message: '未入金の案件を教えて',
        // issued invoice があるので「発行済み・入金確認必要」を言及すべき
        checkFn: (text: string) => {
          const issues: string[] = []
          if (text.includes('すべて入金済み') || text.includes('入金が確認されている')) {
            issues.push('「すべて入金済み」と断定している（issued invoice が存在するため誤り）')
          }
          if (!text.includes('犬山') && !text.includes('発行済み') && !text.includes('issued') &&
              !text.includes('入金確認') && !text.includes('請求書')) {
            issues.push('発行済み請求書（犬山市）への言及がない')
          }
          return issues
        },
      },
      {
        label: 'B. 発行済みで入金確認が必要な案件は？',
        message: '発行済みで入金確認が必要な案件は？',
        checkFn: (text: string) => {
          const issues: string[] = []
          if (!text.includes('犬山') && !text.includes('古民家')) {
            issues.push('犬山市古民家減築プランへの言及がない（DB:issued=1件）')
          }
          return issues
        },
      },
      {
        label: 'C. 入金済みの案件は？',
        message: '入金済みの案件は？',
        checkFn: (text: string) => {
          const issues: string[] = []
          // 現状: paid invoice = 0件、payment_date = 0件
          // 「入金済みの案件はありません」か「データなし」が正解
          if (text.includes('入金済み') && text.includes('犬山')) {
            // 犬山市は issued であって paid ではない
            issues.push('犬山市を「入金済み」として挙げている（実際は issued = 入金未確認）')
          }
          return issues
        },
      },
      {
        label: 'D. 今月請求すべき案件は？',
        message: '今月請求すべき案件は？',
        checkFn: (text: string) => {
          const issues: string[] = []
          // milestone invoice_date は全件 null → 請求スケジュール未設定
          // 「今月請求すべき milestone がない」は正しい
          // issued invoice があることも言及してよい（既に発行済み）
          const positiveAmount = text.match(/[¥￥]([1-9][\d,]+)/)
          if (positiveAmount && !text.includes('発行済み') && !text.includes('issued')) {
            issues.push(`架空の請求金額を言及: "${positiveAmount[0]}"（スケジュール未設定）`)
          }
          return issues
        },
      },
    ]

    for (const { label, message, checkFn } of billingPrompts) {
      console.log(`\n  ─ ${label}`)
      const result = await chatSSE(
        { messages: [{ role: 'user', content: message }] },
        token,
      )
      if (result.errorMessage?.includes('credit balance is too low')) {
        info('Anthropic クレジット不足 → スキップ')
        break
      }
      if (result.errorMessage) {
        fail(`エラー: ${result.errorMessage.slice(0, 200)}`)
        continue
      }
      if (result.statusEvents.length > 0) {
        info(`ツール使用: status="${result.statusEvents.join(', ')}"（${result.statusEvents.length}回）`)
      }
      if (result.fullText.length > 0) {
        pass('AI 回答受信')
        console.log(`  AI回答:\n    ${result.fullText.replace(/\n/g, '\n    ')}`)
      } else {
        fail('AI 回答が空')
        continue
      }
      const dbIssues = checkFn(result.fullText)
      if (dbIssues.length === 0) {
        pass('DB実データとの整合: 問題なし')
      } else {
        for (const issue of dbIssues) {
          fail(`DB整合チェック: ${issue}`)
        }
      }
    }
  }

  console.log('\n' + '═'.repeat(55))
  console.log('Phase 2.1 検証スクリプト完了')
  console.log('═'.repeat(55) + '\n')
}

main().catch(e => {
  console.error('Fatal:', e)
  process.exit(1)
})
