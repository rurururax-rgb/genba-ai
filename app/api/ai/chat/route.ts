import { NextRequest } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { randomUUID } from 'crypto'
import { getServerClient } from '@/lib/supabase/server'
import { chatTools, companyTools } from '@/lib/ai/chat/tool-schemas'
import { dispatchTool, type ExecutorContext } from '@/lib/ai/chat/tool-executor'
import type { ConfirmableChange, QuickReply } from '@/lib/ai/chat/types'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const MAX_ITERATIONS = 6

// ──────────────────────────────────────────────────────────────────────────────
// POST /api/ai/chat  →  SSE ストリーミングレスポンス
//
// Body:
//   { project_id: string, messages: ... }   ← 案件詳細（project-scoped）
//   { messages: ... }                        ← 会社全体（company-scoped）
//
// project_id を省略すると会社全体モードになる。
// 会社全体モードでは project-scoped ツールは使用不可（dispatchTool 内で拒否）。
// ──────────────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const supabase = await getServerClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })

  const { data: membership } = await supabase
    .from('company_members')
    .select('company_id')
    .eq('user_id', user.id)
    .single()
  if (!membership) return new Response(JSON.stringify({ error: 'No company' }), { status: 403 })

  const body = await req.json() as {
    project_id?: string
    messages: Anthropic.MessageParam[]
  }

  const projectId = body.project_id ?? null
  const companyId = membership.company_id
  const isCompanyMode = projectId === null

  // project-scoped モード: 案件の存在・自社所属を確認
  let project: { name: string; customer_name: string | null; site_address: string | null; status: string } | null = null
  if (!isCompanyMode) {
    const { data } = await supabase
      .from('projects')
      .select('name, customer_name, site_address, status')
      .eq('id', projectId!)
      .is('deleted_at', null)
      .single()
    if (!data) return new Response(JSON.stringify({ error: 'Project not found' }), { status: 404 })
    project = data
  }

  const ctx: ExecutorContext = { projectId, companyId, supabase }

  // 使用するツールセットをモードで切り替え（スキーマレベルでスコープを分離）
  const tools = isCompanyMode ? companyTools : chatTools

  const { data: catalogItems } = await supabase
    .from('company_estimate_items')
    .select('name, category, unit, selling_price, usage_count')
    .eq('company_id', companyId)
    .not('selling_price', 'is', null)
    .order('usage_count', { ascending: false })
    .limit(200)

  const systemPrompt = isCompanyMode
    ? buildCompanySystemPrompt(catalogItems ?? [])
    : buildSystemPrompt(project!, catalogItems ?? [])
  const encoder = new TextEncoder()

  const readable = new ReadableStream({
    async start(controller) {
      function send(data: object) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
      }

      try {
        let currentMessages: Anthropic.MessageParam[] = body.messages
        const allPendingChanges: ConfirmableChange[] = []
        const allSuggestions: QuickReply[] = []

        for (let i = 0; i < MAX_ITERATIONS; i++) {
          const stream = anthropic.messages.stream({
            model:      'claude-sonnet-4-6',
            max_tokens: 2048,
            system:     systemPrompt,
            tools:      tools,
            messages:   currentMessages,
          })

          // テキストデルタをリアルタイムに送信
          for await (const event of stream) {
            if (
              event.type === 'content_block_delta' &&
              event.delta.type === 'text_delta' &&
              event.delta.text
            ) {
              send({ type: 'text', delta: event.delta.text })
            }
          }

          const finalMsg = await stream.finalMessage()

          if (finalMsg.stop_reason === 'end_turn') {
            const text = finalMsg.content
              .filter((b): b is Anthropic.TextBlock => b.type === 'text')
              .map(b => b.text)
              .join('')
            if (allSuggestions.length === 0 && detectYesNoQuestion(text)) {
              allSuggestions.push(
                { label: 'はい', message: 'はい', variant: 'primary' },
                { label: 'いいえ', message: 'いいえ' },
              )
            }
            send({ type: 'done', pending_changes: allPendingChanges, suggestions: allSuggestions })
            controller.close()
            return
          }

          if (finalMsg.stop_reason !== 'tool_use') {
            send({ type: 'done', pending_changes: allPendingChanges, suggestions: allSuggestions })
            controller.close()
            return
          }

          // ── ツール実行 ─────────────────────────────────────────
          send({ type: 'status', text: '確認中…' })

          const toolUseBlocks = finalMsg.content.filter(
            (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
          )

          const toolResults = await Promise.all(
            toolUseBlocks.map(async (block) => {
              const { serialized, pending, suggestions } = await dispatchTool(block.name, block.input, ctx)
              if (pending) allPendingChanges.push({ id: randomUUID(), ...pending })
              if (suggestions) {
                for (const s of suggestions) {
                  if (!allSuggestions.some(x => x.label === s.label)) allSuggestions.push(s)
                }
              }
              return { type: 'tool_result' as const, tool_use_id: block.id, content: serialized }
            }),
          )

          // ツール結果を次のターンへ
          currentMessages = [
            ...currentMessages,
            { role: 'assistant', content: finalMsg.content },
            { role: 'user',      content: toolResults },
          ]
        }

        send({ type: 'done', pending_changes: allPendingChanges, suggestions: allSuggestions })
        controller.close()
      } catch (err) {
        send({ type: 'error', message: String(err) })
        controller.close()
      }
    },
  })

  return new Response(readable, {
    headers: {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      'Connection':    'keep-alive',
    },
  })
}

// ──────────────────────────────────────────────────────────────────────────────
// yes/no 確認質問の検出
// ──────────────────────────────────────────────────────────────────────────────

function detectYesNoQuestion(text: string): boolean {
  return /よろしいですか[？?]|よろしいでしょうか[？?]/.test(text)
}

// ──────────────────────────────────────────────────────────────────────────────
// システムプロンプト
// ──────────────────────────────────────────────────────────────────────────────

type CatalogItem = {
  name: string
  category: string | null
  unit: string | null
  selling_price: number | null
  usage_count: number | null
}

function buildCatalogContext(items: CatalogItem[]): string {
  if (!items.length) return ''

  const byCategory = new Map<string, CatalogItem[]>()
  for (const item of items) {
    const cat = item.category ?? 'その他'
    if (!byCategory.has(cat)) byCategory.set(cat, [])
    byCategory.get(cat)!.push(item)
  }

  const fmt = (n: number) => n.toLocaleString('ja-JP')

  const categorySummary = Array.from(byCategory.entries())
    .map(([cat, catItems]) => {
      const prices   = catItems.map(i => i.selling_price!).filter(Boolean)
      const avg      = prices.length ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length) : null
      const totalUse = catItems.reduce((s, i) => s + (i.usage_count ?? 0), 0)
      return `- ${cat}: 平均単価 ¥${avg != null ? fmt(avg) : '─'} ／ ${catItems.length}品目 ／ 延べ使用${totalUse}回`
    })
    .join('\n')

  const topItems = items
    .slice(0, 150)
    .map(i => `  ${i.category ?? 'その他'} | ${i.name} | ${i.unit ?? '式'} | ¥${fmt(i.selling_price!)} | ${i.usage_count ?? 0}回`)
    .join('\n')

  const totalUse = items.reduce((s, i) => s + (i.usage_count ?? 0), 0)

  return `
## 自社過去実績データ（参照専用）
実績品目数: ${items.length}件 ／ 延べ使用回数: ${totalUse}回
※ 単価の目安・相場感を答える際はこのデータを根拠として「過去実績では〜」と必ず出典を示すこと。
※ このデータはAIによる整理です。最終判断は担当者が行ってください。

### カテゴリ別サマリー
${categorySummary}

### 使用頻度上位品目（カテゴリ | 品名 | 単位 | 実績単価 | 使用回数）
${topItems}`.trim()
}

function buildSystemPrompt(
  project: {
    name: string
    customer_name: string | null
    site_address:  string | null
    status:        string
  },
  catalogItems: CatalogItem[],
): string {
  const catalogContext = buildCatalogContext(catalogItems)
  return `
あなたは工務店向け業務補助ツール「現場AI」のチャットアシスタントです。
担当者が現在開いている案件の見積・原価・カタログを検索・確認する際のサポートを行います。

## 現在の案件
- 案件名: ${project.name}
- 顧客名: ${project.customer_name ?? '未設定'}
- 現場住所: ${project.site_address ?? '未設定'}
- ステータス: ${project.status}

## あなたの役割
- 見積・カタログ・原価台帳の「検索係・確認係」です
- 見積金額の確定・発注・変更は行いません
- 情報を整理して提示し、最終判断は担当者が行います
- この情報はAIによる整理結果です。最終判断は担当者が行ってください

## 利用可能なツール
- search_estimates: この案件の見積項目（estimate_items）を検索
- search_catalog: 自社カタログ（company_estimate_items）を検索 ※ 見積項目とは別テーブル
- insert_catalog_item: カタログから見積に追加（内部でカタログのみ検索。estimate_items は参照しない）
- search_cost_ledger: この案件の原価台帳を検索
- search_material_web: Web 検索で建材・資材の参考価格・型番・URL を取得（DB に保存しない）
- add_to_material_master: 品目を資材マスターに登録（pending_change → 確定後に保存）

## カタログ vs 見積項目の区別
- カタログ（company_estimate_items）: 会社全体の過去実績品目。insert_catalog_item で見積に追加する
- 見積項目（estimate_items）: この案件に既に追加されている品目。search_estimates で検索する
- カタログに同じ品目が見積にも存在することは正常（過去に使った品目がカタログに登録されているため）
- 「カタログから追加して」の指示では insert_catalog_item のみを使うこと。search_estimates と混在させない

## 内部専用フィールド（顧客向け回答・画面に含めてはいけない）
- cost_price（原価・仕入れ価格）
- vendor_name（業者名）
- search_cost_ledger の結果全般

検索結果にこれらが含まれていても、顧客向けの説明・提案・見積書には転記しないこと。

## 回答スタイル
- 日本語で回答する
- 見つかった場合: 品名・数量・単価・合計を整理して表示（selling_price / amount を使う）
- ambiguous の場合: 候補をリストアップして「どちらですか？」と確認
- not_found の場合: 正直に伝え、別キーワードを提案
- 不明な情報は推測せず「確認できません」と伝える

## テーブル表示のルール
- URLをテーブルセルに直接書かない。必ず [詳細を見る](URL) 形式のリンク記法を使うこと
- 品名・型番列を先に、URLリンク列は末尾に配置する
- セル内に長いURL文字列をそのまま書くと表示が壊れるため厳守すること

## search_material_web（カタラボ検索）の回答ルール
- 検索結果の詳細（型番・仕様・価格の表）をチャット本文に出力しない
- 「〇件見つかりました」の一言と、必要であれば一言コメントだけにする
- 候補は自動的にボタンとして表示されるため、一覧をテキストで書かない
- ボタンをタップすると商品ページが別タブで開くことをユーザーに伝えてよい

## 候補選択時の動作
ユーザーが「「○○」を選択します」のように特定の候補を選んだ場合は、その名前で再度ツールを呼び出し、元の操作（追加・検索など）を続行してください。「はい」と返答された場合は直前の提案を確認と判断し、「いいえ」の場合はキャンセルしてください。

## [catalog_id:XXX] 形式のID指定
ユーザーのメッセージに [catalog_id:UUID] が含まれている場合、insert_catalog_item を呼ぶ際に catalog_item_id パラメータにそのUUIDを渡してください。これにより再検索せず直接その品目を使用します。catalog_query には品名を、catalog_item_id にはUUIDを両方渡すこと。

## 過去実績を使った回答ガイドライン
- 「〇〇はいくらくらい？」→ 過去実績データから該当品目を探し「過去実績では¥XXです（X回使用）」と答える
- 「〇〇工事の相場は？」→ カテゴリサマリーから平均単価を引用して答える
- 「よく使う品目は？」→ 使用回数上位を抜き出して答える
- 「この見積で足りないものは？」→ 現在の案件の見積（search_estimates）と過去実績を比較して抜けを指摘する
- 実績データがない質問は「データが不足しているため、案件を重ねると精度が上がります」と正直に答える
- 坪単価・平米単価を聞かれた場合は、過去実績の合計金額傾向から「参考値として〜万円/坪前後の実績があります」と答えてよい（ただし面積情報がない場合は面積を確認してから）

${catalogContext ? '\n' + catalogContext : ''}
`.trim()
}

// ──────────────────────────────────────────────────────────────────────────────
// 会社全体モード システムプロンプト
// ──────────────────────────────────────────────────────────────────────────────

function buildCompanySystemPrompt(catalogItems: CatalogItem[]): string {
  const catalogContext = buildCatalogContext(catalogItems)
  return `
あなたは工務店向け業務補助ツール「現場AI」の会社全体アシスタントです。
担当者が全案件の状況・請求・入金を横断的に確認する際のサポートを行います。

## あなたの役割
- 全案件のステータス・請求・入金状況の「確認係」です
- 請求書の下書き作成を提案できます（発行・送付は行いません）
- 数字・状況の整理と優先順位の説明を行います
- 見積金額の確定・発注・メール送信・LINE送信は行いません
- 返した情報はAIによる整理結果です。最終判断は担当者が行ってください

## 利用可能なツール
- list_projects_status: 全案件のステータス一覧
- get_project_summary: 特定案件の見積・請求・入金状況
- get_invoice_status: 特定案件の請求書状況
- get_unpaid_milestones: 未入金・遅延マイルストーン一覧
- create_invoice_draft: 請求書下書きの作成提案（Pending Change → ユーザー確認後に保存）

## 重要な制約
- 原価（cost_price）・業者名（vendor_name）は顧客向け回答に含めない
- 請求書の「発行」は行わない（下書き作成の提案のみ）
- 自動送信・自動確定は行わない

## 回答スタイル
- 日本語で簡潔に回答する
- 数字はツールから取得した値をそのまま使い、AIが推測・補正しない
- 不明な情報は「確認できません」と正直に伝える

${catalogContext ? '\n' + catalogContext : ''}
`.trim()
}
