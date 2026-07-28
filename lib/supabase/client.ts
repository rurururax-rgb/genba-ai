'use client'

import { createBrowserClient } from '@supabase/ssr'

// RLS有効なブラウザ用クライアント（Client Component専用）
export function getClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
}
