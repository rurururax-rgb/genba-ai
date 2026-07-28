// ⚠️ デモ用簡易版ミドルウェア
// 本来の Step 3 実装（サインアップ・会社作成・ロール管理）に置き換えること
// 現在はセッション有無のみで /projects・/settings を保護する

import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
  // Supabase SSR はレスポンスオブジェクトを差し替えながらクッキーを更新する
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          // リクエスト側とレスポンス側の両方にクッキーを書く（SSR の必須パターン）
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          )
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  // getUser() がセッションをリフレッシュしてクッキーを更新する
  // getSession() ではなく getUser() を使う（公式推奨: サーバー側での確実な検証）
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const { pathname } = request.nextUrl

  // 未ログインで保護ルートにアクセス → /login へ
  if (!user && (pathname.startsWith('/projects') || pathname.startsWith('/settings'))) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }

  // ログイン済みで /login にアクセス → /projects へ
  if (user && pathname === '/login') {
    const url = request.nextUrl.clone()
    url.pathname = '/projects'
    return NextResponse.redirect(url)
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    // 静的ファイル・画像最適化・faviconを除く全パス
    // /api/webhook/line は LINE からの受信のため認証不要 → 除外
    '/((?!_next/static|_next/image|favicon.ico|api/webhook).*)',
  ],
}
