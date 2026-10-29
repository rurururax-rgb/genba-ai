import { createClient } from '@supabase/supabase-js'
import { PASSWORD_MAX_BYTES, PASSWORD_MIN_LENGTH } from '@/lib/auth/password-policy'

// ログイン中の利用者が自分のパスワードを変更する（/settings/password・POST /api/account/password）。
//   ・変更は Supabase Auth の updateUser() をログイン中のセッションで呼ぶ。対象はそのセッションの利用者だけで、
//     リクエストから利用者 ID やメールアドレスは受け取らない（他人のパスワードは変更できない）。
//   ・現在のパスワードは、サーバーで確かめたログイン中の利用者のメールアドレスで照合する。
//   ・Supabase の「Secure password change」が有効で、ログインから時間がたっている場合は
//     reauthenticate() でメールに届く確認コード（nonce）が必要になる。

export type PasswordChangeRequest = {
  current_password: string
  new_password: string
  nonce: string | null
}

export type PasswordChangeFailure = {
  status: number
  body: { error: string; code: string }
}

export function parsePasswordChangeRequest(body: unknown): PasswordChangeRequest | PasswordChangeFailure {
  if (!body || typeof body !== 'object') return invalid('入力が正しくありません')
  const { current_password, new_password, nonce } = body as Record<string, unknown>

  if (typeof current_password !== 'string' || current_password === '') {
    return invalid('現在のパスワードを入力してください')
  }
  if (typeof new_password !== 'string' || new_password.length < PASSWORD_MIN_LENGTH) {
    return invalid(`新しいパスワードは${PASSWORD_MIN_LENGTH}文字以上で設定してください`)
  }
  if (new TextEncoder().encode(new_password).length > PASSWORD_MAX_BYTES) {
    return invalid('新しいパスワードが長すぎます（半角72文字まで）')
  }
  if (new_password === current_password) {
    return { status: 400, body: { error: '新しいパスワードが現在のパスワードと同じです', code: 'same_password' } }
  }
  if (nonce !== undefined && nonce !== null && (typeof nonce !== 'string' || !/^\d{6,10}$/.test(nonce.trim()))) {
    return { status: 400, body: { error: '確認コードは数字で入力してください', code: 'reauthentication_not_valid' } }
  }

  return {
    current_password,
    new_password,
    nonce: typeof nonce === 'string' && nonce.trim() !== '' ? nonce.trim() : null,
  }
}

export function isPasswordChangeFailure(v: PasswordChangeRequest | PasswordChangeFailure): v is PasswordChangeFailure {
  return 'status' in v
}

function invalid(error: string): PasswordChangeFailure {
  return { status: 400, body: { error, code: 'validation_failed' } }
}

type AuthErrorLike = { code?: string; status?: number; name?: string } | null | undefined

// updateUser() のエラーを画面向けの応答に変換する。Supabase の文言はそのまま返さない
export function mapUpdatePasswordError(error: AuthErrorLike): PasswordChangeFailure {
  // セッションが Auth サーバーで終了している（別の端末でのパスワード変更・ログアウトなど）
  if (error?.name === 'AuthSessionMissingError') {
    return { status: 401, body: { error: 'ログインし直してください', code: 'unauthorized' } }
  }
  switch (error?.code) {
    case 'reauthentication_needed':
    case 'reauth_nonce_missing':
      return {
        status: 403,
        body: { error: '本人確認のため、メールに届く確認コードを入力してください', code: 'reauthentication_needed' },
      }
    case 'reauthentication_not_valid':
      return {
        status: 400,
        body: { error: '確認コードが正しくないか、有効期限が切れています', code: 'reauthentication_not_valid' },
      }
    case 'same_password':
      return { status: 400, body: { error: '新しいパスワードが現在のパスワードと同じです', code: 'same_password' } }
    case 'weak_password':
      return {
        status: 400,
        body: { error: 'パスワードが簡単すぎます。英字・数字・記号を組み合わせてください', code: 'weak_password' },
      }
    case 'insufficient_aal':
      return {
        status: 403,
        body: { error: '二段階認証を済ませてから変更してください', code: 'insufficient_aal' },
      }
    case 'session_not_found':
    case 'session_expired':
    case 'bad_jwt':
    case 'user_not_found':
      return { status: 401, body: { error: 'ログインし直してください', code: 'unauthorized' } }
    case 'over_request_rate_limit':
    case 'over_email_send_rate_limit':
      return rateLimited()
  }
  if (error?.status === 429) return rateLimited()
  return { status: 500, body: { error: 'パスワードの変更に失敗しました。時間をおいてもう一度お試しください', code: 'unexpected_failure' } }
}

function rateLimited(): PasswordChangeFailure {
  return { status: 429, body: { error: '試行回数が多すぎます。しばらく待ってからもう一度お試しください', code: 'rate_limited' } }
}

export type CurrentPasswordCheck = 'ok' | 'invalid' | 'rate_limited' | 'error'

// 現在のパスワードを照合する。ログイン中のセッション（Cookie）には触れないよう、保存しない別クライアントで
// サインインし、照合のために作られたセッションはすぐに終了する（scope: 'local' = そのセッションだけ）。
export async function verifyCurrentPassword(
  userId: string,
  email: string,
  password: string,
): Promise<CurrentPasswordCheck> {
  const verifier = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
  const { data, error } = await verifier.auth.signInWithPassword({ email, password })
  if (error) {
    // 古い Auth サーバーはコードを付けずに 400 を返す
    if (error.code === 'invalid_credentials' || (error.status === 400 && !error.code)) return 'invalid'
    if (error.status === 429 || error.code === 'over_request_rate_limit') return 'rate_limited'
    return 'error'
  }

  // 照合用のセッションは残さない。失敗しても照合結果は変わらない（期限で失効する）
  await verifier.auth.signOut({ scope: 'local' }).catch(() => undefined)

  // 同じメールアドレスで別の利用者になることは無い想定だが、念のためログイン中の利用者と一致を確かめる
  return data.user?.id === userId ? 'ok' : 'invalid'
}
