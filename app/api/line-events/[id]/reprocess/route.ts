import { NextRequest, NextResponse } from 'next/server'
import { getServerClient } from '@/lib/supabase/server'
import { extractSearchTerms } from '@/lib/ai/extract-search-terms'

type Candidate = {
  id: string; category: string; name: string; unit: string
  cost_price: number | null; selling_price: number | null
  memo: string | null; usage_count: number; last_used_at: string; similarity: number
}

type MatchedItem = {
  term:      string
  quantity:  number | null
  unit:      string | null
  detail:    string | null
  candidates: Candidate[]
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: eventId } = await params
  const { raw_content } = (await request.json()) as { raw_content: string }

  if (!raw_content?.trim()) {
    return NextResponse.json({ error: 'テキストが空です' }, { status: 400 })
  }

  const supabase = await getServerClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: membership } = await supabase
    .from('company_members').select('company_id').eq('user_id', user.id).single()
  if (!membership) return NextResponse.json({ error: 'No company' }, { status: 403 })

  // ── Step 1: Claude でキーワード抽出 ──
  const { terms } = await extractSearchTerms(raw_content)

  // ── Step 2: pg_trgm でマッチング ──
  const matchedItems: MatchedItem[] = []
  for (const st of terms) {
    const { data } = await supabase.rpc('match_estimate_items', {
      p_company_id: membership.company_id,
      p_query:      st.term,
      p_limit:      5,
      p_threshold:  0.1,
    })
    matchedItems.push({
      term:      st.term,
      quantity:  st.quantity,
      unit:      st.unit,
      detail:    st.detail,
      candidates: (data ?? []) as Candidate[],
    })
  }

  // ── Step 3: line_events を上書き（is_processed は true のまま） ──
  const { error } = await supabase
    .from('line_events')
    .update({ raw_content, extracted_terms: terms, matched_items: matchedItems })
    .eq('id', eventId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ terms, matched_items: matchedItems })
}
