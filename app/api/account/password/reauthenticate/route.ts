import { NextResponse } from 'next/server'
import { getServerClient } from '@/lib/supabase/server'
import { mapUpdatePasswordError } from '@/lib/auth/password-change'

// POST: パスワード変更の本人確認コードを、ログイン中の利用者のメールアドレスへ送る（Supabase Auth の reauthenticate()）。
//   Supabase の「Secure password change」が有効で、ログインから時間がたっているときだけ画面から呼ばれる。
//   送り先はセッションの利用者に限られ、リクエストから宛先は受け取らない。
export async function POST() {
  try {
    const supabase = await getServerClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'ログインし直してください', code: 'unauthorized' }, { status: 401 })
    }

    const { error } = await supabase.auth.reauthenticate()
    if (error) {
      console.error('[account/password/reauthenticate] error:', error.code ?? error.status)
      const mapped = mapUpdatePasswordError(error)
      return NextResponse.json(mapped.body, { status: mapped.status })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[account/password/reauthenticate] unexpected error:', err instanceof Error ? err.name : 'unknown')
    return NextResponse.json(
      { error: '確認コードを送れませんでした。時間をおいてもう一度お試しください', code: 'unexpected_failure' },
      { status: 500 },
    )
  }
}
