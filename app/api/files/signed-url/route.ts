import { NextRequest, NextResponse } from 'next/server'
import { getServerClient } from '@/lib/supabase/server'

// ストレージの署名付きURL発行（60分有効）
// private バケットのため server.ts (RLS有効) 経由で発行する
export async function POST(request: NextRequest) {
  try {
    const { storage_path } = (await request.json()) as { storage_path: string }
    if (!storage_path) {
      return NextResponse.json({ error: 'storage_path is required' }, { status: 400 })
    }

    const supabase = await getServerClient()
    const { data, error } = await supabase.storage
      .from('genba-ai')
      .createSignedUrl(storage_path, 60 * 60) // 60分

    if (error) {
      console.error('[signed-url] error:', error.message)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ url: data.signedUrl })
  } catch (err) {
    console.error('[signed-url] unexpected error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
