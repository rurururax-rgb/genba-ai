import { NextRequest, NextResponse } from 'next/server'
import { getServerClient } from '@/lib/supabase/server'
import {
  isPasswordChangeFailure,
  mapUpdatePasswordError,
  parsePasswordChangeRequest,
  verifyCurrentPassword,
} from '@/lib/auth/password-change'

// POST: ログイン中の利用者が自分のパスワードを変更する（/settings/password）。
//   body: { current_password, new_password, nonce? }。利用者 ID・メールアドレスは受け取らない。
//   1. Cookie のセッションから getUser() で利用者を確かめる（Auth サーバーで検証）
//   2. 現在のパスワードを照合する（ログイン中のセッションには触れない）
//   3. updateUser() をログイン中のセッションで呼ぶ。対象はそのセッションの利用者だけ
//   4. 他の端末のセッションを終了する（この端末のログインは続く）
export async function POST(request: NextRequest) {
  try {
    const parsed = parsePasswordChangeRequest(await request.json().catch(() => null))
    if (isPasswordChangeFailure(parsed)) {
      return NextResponse.json(parsed.body, { status: parsed.status })
    }

    const supabase = await getServerClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'ログインし直してください', code: 'unauthorized' }, { status: 401 })
    }
    if (!user.email) {
      return NextResponse.json(
        { error: 'このアカウントはメールアドレスでのログインではないため、ここでは変更できません', code: 'no_email' },
        { status: 400 },
      )
    }

    const check = await verifyCurrentPassword(user.id, user.email, parsed.current_password)
    if (check === 'invalid') {
      return NextResponse.json({ error: '現在のパスワードが正しくありません', code: 'invalid_current_password' }, { status: 400 })
    }
    if (check === 'rate_limited') {
      const mapped = mapUpdatePasswordError({ status: 429 })
      return NextResponse.json(mapped.body, { status: mapped.status })
    }
    if (check === 'error') {
      console.error('[account/password] current password check failed')
      return NextResponse.json(
        { error: 'パスワードの変更に失敗しました。時間をおいてもう一度お試しください', code: 'unexpected_failure' },
        { status: 500 },
      )
    }

    const { error } = await supabase.auth.updateUser({
      password: parsed.new_password,
      // Supabase 側で「現在のパスワードを必須」にしている場合にも通るよう渡す（無効なら無視される）
      current_password: parsed.current_password,
      ...(parsed.nonce ? { nonce: parsed.nonce } : {}),
    })
    if (error) {
      console.error('[account/password] updateUser error:', error.code ?? error.status)
      const mapped = mapUpdatePasswordError(error)
      return NextResponse.json(mapped.body, { status: mapped.status })
    }

    // 他の端末のセッションを終了する。失敗してもパスワードは変わっているので成功として返し、画面で知らせる
    const { error: signOutError } = await supabase.auth.signOut({ scope: 'others' })
    if (signOutError) {
      console.error('[account/password] signOut others error:', signOutError.code ?? signOutError.status)
    }

    return NextResponse.json({ ok: true, other_sessions_signed_out: !signOutError })
  } catch (err) {
    console.error('[account/password] unexpected error:', err instanceof Error ? err.name : 'unknown')
    return NextResponse.json(
      { error: 'パスワードの変更に失敗しました。時間をおいてもう一度お試しください', code: 'unexpected_failure' },
      { status: 500 },
    )
  }
}
