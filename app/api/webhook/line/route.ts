import { NextRequest, NextResponse } from 'next/server'
import { getAdminClient } from '@/lib/supabase/admin'
import { verifyLineSignature, fetchLineContent } from '@/lib/line/webhook'
import { transcribeAudio } from '@/lib/ai/whisper'
import { extractSearchTerms, type SearchTerm } from '@/lib/ai/extract-search-terms'

// ──────────────────────────────────────────────────────────
// LINE Messaging API の型定義
// ──────────────────────────────────────────────────────────

type LineSource = { type: string; userId?: string }

type LineTextMessage  = { id: string; type: 'text';  text: string }
type LineImageMessage = { id: string; type: 'image' }
type LineAudioMessage = { id: string; type: 'audio'; duration?: number }
type LineMessage      = LineTextMessage | LineImageMessage | LineAudioMessage

type LineMessageEvent = {
  type: 'message'
  webhookEventId: string
  timestamp: number
  source: LineSource
  message: LineMessage
  replyToken?: string
}

type LineWebhookBody = {
  destination: string
  events: ({ type: string; webhookEventId: string } | LineMessageEvent)[]
}

// ──────────────────────────────────────────────────────────
// 音声パイプラインの結果型
// CLAUDE.md AI JSON仕様 candidates に準拠
// ──────────────────────────────────────────────────────────

type Candidate = {
  id: string
  category: string
  name: string
  unit: string
  cost_price: number | null
  selling_price: number | null
  memo: string | null
  usage_count: number
  last_used_at: string
  similarity: number
}

type MatchedItem = {
  term:      string
  quantity:  number | null
  unit:      string | null
  detail:    string | null
  candidates: Candidate[]
}

// ──────────────────────────────────────────────────────────
// POST ハンドラ（LINEからのWebhook受信）
// ──────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const rawBody = Buffer.from(await request.arrayBuffer())
  const signature = request.headers.get('x-line-signature') ?? ''

  if (!verifyLineSignature(rawBody, signature)) {
    console.warn('[LINE Webhook] Invalid signature rejected')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  const payload = JSON.parse(rawBody.toString()) as LineWebhookBody

  // 即座に200を返してLINEのタイムアウトを回避。重い処理はバックグラウンドへ
  void processEvents(payload.events).catch((err: unknown) => {
    console.error('[LINE Webhook] Background processing error:', err)
  })

  return NextResponse.json({ status: 'ok' })
}

// ──────────────────────────────────────────────────────────
// イベント処理（テキスト・画像・音声）
// ──────────────────────────────────────────────────────────

async function processEvents(events: LineWebhookBody['events']) {
  const supabaseAdmin = getAdminClient()
  const companyId = process.env.LINE_COMPANY_ID ?? null

  for (const event of events) {
    if (event.type !== 'message') continue

    const msgEvent = event as LineMessageEvent
    const lineUserId = msgEvent.source.userId
    if (!lineUserId) continue

    const { message, webhookEventId, timestamp } = msgEvent
    if (!['text', 'image', 'audio'].includes(message.type)) continue

    let rawContent: string | null = null
    let storagePath: string | null = null
    let audioBuffer: Buffer | null = null   // audio パイプライン用（再ダウンロード不要）

    if (message.type === 'text') {
      rawContent = (message as LineTextMessage).text
    } else {
      const isImage = message.type === 'image'
      const ext    = isImage ? 'jpg' : 'm4a'
      const folder = isImage ? 'photos' : 'audio'
      const path   = `${companyId}/inbox/${folder}/${message.id}.${ext}`

      try {
        const { data, contentType } = await fetchLineContent(message.id)

        if (!isImage) audioBuffer = data   // audio は後続パイプラインで使う

        const { error: uploadErr } = await supabaseAdmin.storage
          .from('genba-ai')
          .upload(path, data, { contentType, upsert: false })

        if (!uploadErr) {
          storagePath = path
        } else if (uploadErr.message?.includes('already exists')) {
          storagePath = path   // 再送による重複アップロードは既存パスをそのまま使う
        } else {
          console.error('[LINE] Storage upload error:', uploadErr.message)
        }
      } catch (err) {
        console.error('[LINE] Content fetch/upload error:', err)
      }
    }

    // INSERT。select('id') で採番されたUUIDを取得し、後続のUPDATEに使う
    const { data: inserted, error: dbErr } = await supabaseAdmin
      .from('line_events')
      .insert({
        company_id:    companyId,
        line_user_id:  lineUserId,
        line_event_id: webhookEventId,
        event_type:    message.type,
        raw_content:   rawContent,    // audio は null。文字起こし後にUPDATEで更新
        storage_path:  storagePath,
        project_id:    null,
        is_processed:  false,
        received_at:   new Date(timestamp).toISOString(),
      })
      .select('id')
      .single()

    if (dbErr) {
      if (dbErr.code === '23505') {
        console.log(`[LINE] Duplicate event skipped: ${webhookEventId}`)
      } else {
        console.error('[LINE] DB insert error:', dbErr.message)
      }
      continue   // 重複・エラー時は音声パイプラインも実行しない
    }

    console.log(`[LINE] Saved: type=${message.type} event=${webhookEventId}`)

    // 音声イベントのみ: Whisper → Claude → match のパイプラインを非同期で起動
    if (message.type === 'audio' && audioBuffer && companyId) {
      void processAudioEvent(inserted.id, companyId, audioBuffer, message.id)
        .catch((err: unknown) => {
          console.error(`[LINE] Audio pipeline error (event=${inserted.id}):`, err)
        })
    }
  }
}

// ──────────────────────────────────────────────────────────
// 音声パイプライン（INSERT後に非同期実行）
//
// 各ステップは独立してエラーをキャッチする。
// あるステップが失敗しても line_events の行は残り、後続ステップはスキップする。
// ──────────────────────────────────────────────────────────

async function processAudioEvent(
  eventId: string,
  companyId: string,
  audioBuffer: Buffer,
  messageId: string
): Promise<void> {
  const supabaseAdmin = getAdminClient()
  // ── Step 1: Whisper 文字起こし ──────────────────────────
  let transcription: string
  try {
    transcription = await transcribeAudio(audioBuffer, `${messageId}.m4a`)
    // 文字起こし結果を raw_content に保存（この行は独立して成功させる）
    const { error } = await supabaseAdmin
      .from('line_events')
      .update({ raw_content: transcription })
      .eq('id', eventId)
    if (error) console.error('[LINE] raw_content UPDATE error:', error.message)
    else console.log(`[LINE] Transcription saved (event=${eventId}): "${transcription.slice(0, 50)}..."`)
  } catch (err) {
    console.error(`[LINE] Whisper failed (event=${eventId}):`, err)
    return   // Whisper失敗 → 以降スキップ。line_events の行は残る
  }

  // ── Step 2: Claude でキーワード抽出 ─────────────────────
  let terms: SearchTerm[]
  try {
    const result = await extractSearchTerms(transcription)
    terms = result.terms
    console.log(`[LINE] Terms extracted (event=${eventId}): ${JSON.stringify(terms)}`)
  } catch (err) {
    console.error(`[LINE] extractSearchTerms failed (event=${eventId}):`, err)
    return
  }

  if (terms.length === 0) {
    // キーワードなし（建材と無関係な発話）でも is_processed = true にして完了扱い
    await supabaseAdmin
      .from('line_events')
      .update({ extracted_terms: [], matched_items: [], is_processed: true })
      .eq('id', eventId)
    return
  }

  // ── Step 3: pg_trgm で類似マッチング ────────────────────
  const matchedItems: MatchedItem[] = []
  for (const st of terms) {
    try {
      const { data, error } = await supabaseAdmin.rpc('match_estimate_items', {
        p_company_id: companyId,
        p_query:      st.term,
        p_limit:      5,
        p_threshold:  0.1,
      })
      if (error) {
        console.error(`[LINE] match_estimate_items error (term="${st.term}"):`, error.message)
      } else {
        matchedItems.push({
          term:      st.term,
          quantity:  st.quantity,
          unit:      st.unit,
          detail:    st.detail,
          candidates: (data ?? []) as Candidate[],
        })
      }
    } catch (err) {
      console.error(`[LINE] match_estimate_items threw (term="${st.term}"):`, err)
    }
  }

  // ── Step 4: 抽出結果・マッチ結果を保存 ──────────────────
  const { error: updateErr } = await supabaseAdmin
    .from('line_events')
    .update({
      extracted_terms: terms,   // SearchTerm[] として保存（JSONB）
      matched_items:   matchedItems,
      is_processed:    true,
    })
    .eq('id', eventId)

  if (updateErr) {
    console.error(`[LINE] Final UPDATE error (event=${eventId}):`, updateErr.message)
  } else {
    console.log(
      `[LINE] Audio pipeline complete (event=${eventId}): ` +
      `${terms.length} terms, ${matchedItems.length} matches`
    )
  }
}
