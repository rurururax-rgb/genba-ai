import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

// RLS有効なサーバーサイドクライアント（API Route・Server Component用）
export async function getServerClient() {
  const cookieStore = await cookies()
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // Server Componentからの呼び出し時はcookie書き込み不可のため無視
          }
        },
      },
    }
  )
}
