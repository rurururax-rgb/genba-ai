import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { NextRequest } from 'next/server'
import { mapUpdatePasswordError, parsePasswordChangeRequest } from '@/lib/auth/password-change'

/**
 * POST /api/account/password・POST /api/account/password/reauthenticate（ログイン中の利用者のパスワード変更）。
 * 本物の @supabase/ssr・supabase-js を使い、Auth サーバー（GoTrue）だけを偽の HTTP サーバーで置き換える。
 * どの利用者のトークンで updateUser が呼ばれるか、照合用・他端末のセッションがどう終わるかを、
 * 偽サーバーが受けたリクエストと状態で確かめる。
 */

type User = { id: string; email: string; password: string }
type Session = { id: string; userId: string; createdAt: number; revoked: boolean }

const USER_A = '00000000-0000-4000-8000-0000000000a1'
const USER_B = '00000000-0000-4000-8000-0000000000b1'

let users: Map<string, User>
let sessions: Map<string, Session> // access_token → セッション
let requests: Array<{ method: string; path: string; token: string | null; body: Record<string, unknown> | null }>
let secureChange: boolean // Supabase の「Secure password change」相当（24 時間以内のログインでなければ nonce が必要）
let sentNonces: Map<string, string> // userId → nonce
let tokenSeq: number

let server: Server
let baseUrl: string

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'x-supabase-api-version': '2024-01-01' })
  res.end(JSON.stringify(body))
}
const fail = (res: ServerResponse, status: number, code: string) => send(res, status, { code, msg: code })

function publicUser(u: User) {
  return { id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' }
}

function issueSession(userId: string, createdAt = Date.now()) {
  const token = `tok-${++tokenSeq}`
  sessions.set(token, { id: `sess-${tokenSeq}`, userId, createdAt, revoked: false })
  return token
}

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  const raw = Buffer.concat(chunks).toString()
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', baseUrl)
  const token = req.headers.authorization?.replace(/^Bearer /, '') ?? null
  const body = await readBody(req)
  requests.push({ method: req.method ?? '', path: url.pathname + url.search, token, body })

  const session = token ? sessions.get(token) : undefined
  const live = session && !session.revoked ? session : undefined
  const path = url.pathname.replace(/^\/auth\/v1/, '')

  if (req.method === 'POST' && path === '/token' && url.searchParams.get('grant_type') === 'password') {
    const u = [...users.values()].find(x => x.email === body?.email)
    if (!u || u.password !== body?.password) return fail(res, 400, 'invalid_credentials')
    const t = issueSession(u.id)
    return send(res, 200, {
      access_token: t, refresh_token: `r-${t}`, token_type: 'bearer', expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600, user: publicUser(u),
    })
  }
  // 以下はログイン済みのリクエスト。セッションが終了していれば session_not_found（GoTrue と同じ）
  if (!live) return fail(res, 403, 'session_not_found')
  const me = users.get(live.userId)!

  if (req.method === 'GET' && path === '/user') return send(res, 200, publicUser(me))

  if (req.method === 'PUT' && path === '/user') {
    if (typeof body?.password === 'string') {
      if (body.password === me.password) return fail(res, 422, 'same_password')
      if (!/\d/.test(body.password)) return send(res, 422, { code: 'weak_password', msg: 'weak', weak_password: { reasons: ['length'] } })
      if (secureChange && Date.now() - live.createdAt > 24 * 3600 * 1000) {
        if (!body.nonce) return fail(res, 400, 'reauthentication_needed')
        if (body.nonce !== sentNonces.get(me.id)) return fail(res, 400, 'reauthentication_not_valid')
      }
      me.password = body.password
    }
    return send(res, 200, publicUser(me))
  }

  if (req.method === 'GET' && path === '/reauthenticate') {
    sentNonces.set(me.id, '246810')
    return send(res, 200, {})
  }

  if (req.method === 'POST' && path === '/logout') {
    const scope = url.searchParams.get('scope') ?? 'global'
    for (const s of sessions.values()) {
      if (s.userId !== me.id) continue
      if (scope === 'local' && s !== live) continue
      if (scope === 'others' && s === live) continue
      s.revoked = true
    }
    res.writeHead(204).end()
    return
  }

  return fail(res, 404, 'not_found')
}

// next/headers の cookies() を、テストごとに差し替える Cookie 入れ物で置き換える
let cookieJar: Map<string, string>
vi.mock('next/headers', () => ({
  cookies: async () => ({
    getAll: () => [...cookieJar.entries()].map(([name, value]) => ({ name, value })),
    set: (name: string, value: string) => { if (value) cookieJar.set(name, value); else cookieJar.delete(name) },
  }),
}))

// @supabase/ssr がブラウザに保存する形（base64- + JSON）でログイン中のセッションを Cookie に入れる
function signInCookie(userId: string, createdAt?: number) {
  const token = issueSession(userId, createdAt)
  const u = users.get(userId)!
  const session = {
    access_token: token, refresh_token: `r-${token}`, token_type: 'bearer', expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600, user: publicUser(u),
  }
  cookieJar.set('sb-127-auth-token', 'base64-' + Buffer.from(JSON.stringify(session)).toString('base64url'))
  return token
}

let POST: (req: NextRequest) => Promise<Response>
let REAUTH: () => Promise<Response>

beforeAll(async () => {
  server = createServer((req, res) => { handle(req, res).catch(() => fail(res, 500, 'test_server_error')) })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', baseUrl)
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'test-anon-key')
  POST = (await import('@/app/api/account/password/route')).POST
  REAUTH = (await import('@/app/api/account/password/reauthenticate/route')).POST
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await new Promise(r => server.close(r))
})

beforeEach(() => {
  users = new Map([
    [USER_A, { id: USER_A, email: 'a@example.com', password: 'old-pass-A1' }],
    [USER_B, { id: USER_B, email: 'b@example.com', password: 'old-pass-B1' }],
  ])
  sessions = new Map()
  requests = []
  secureChange = false
  sentNonces = new Map()
  tokenSeq = 0
  cookieJar = new Map()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

const post = (body: unknown) =>
  POST(new NextRequest('http://localhost/api/account/password', { method: 'POST', body: JSON.stringify(body) }))
const updates = () => requests.filter(r => r.method === 'PUT' && r.path.endsWith('/user'))
const signIns = () => requests.filter(r => r.path.includes('/token'))
const logouts = () => requests.filter(r => r.path.includes('/logout'))

describe('POST /api/account/password', () => {
  it('ログイン中の利用者のトークンで updateUser を呼び、その利用者のパスワードだけを変える', async () => {
    const cookieToken = signInCookie(USER_A)
    const res = await post({ current_password: 'old-pass-A1', new_password: 'new-pass-A2' })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, other_sessions_signed_out: true })
    expect(users.get(USER_A)!.password).toBe('new-pass-A2')
    expect(users.get(USER_B)!.password).toBe('old-pass-B1')

    expect(updates()).toHaveLength(1)
    expect(updates()[0].token).toBe(cookieToken)
    expect(updates()[0].body).toMatchObject({ password: 'new-pass-A2', current_password: 'old-pass-A1' })
  })

  it('リクエストに他人の利用者 ID・メールアドレスを入れても無視し、他人のパスワードは変わらない', async () => {
    const cookieToken = signInCookie(USER_A)
    const res = await post({
      current_password: 'old-pass-A1', new_password: 'new-pass-A2',
      user_id: USER_B, id: USER_B, email: 'b@example.com',
    })

    expect(res.status).toBe(200)
    expect(users.get(USER_B)!.password).toBe('old-pass-B1')
    // 照合はセッションの利用者のメールアドレスで行い、変更もそのトークンで行う
    expect(signIns().map(r => r.body?.email)).toEqual(['a@example.com'])
    expect(updates()[0].token).toBe(cookieToken)
    expect(Object.keys(updates()[0].body ?? {})).not.toContain('email')
    expect(Object.keys(updates()[0].body ?? {})).not.toContain('user_id')
  })

  it('他人の現在のパスワードを知っていても、自分のセッションでは他人のパスワードを変えられない', async () => {
    signInCookie(USER_A)
    const res = await post({ current_password: 'old-pass-B1', new_password: 'new-pass-X9', email: 'b@example.com' })

    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('invalid_current_password')
    expect(updates()).toHaveLength(0)
    expect(users.get(USER_A)!.password).toBe('old-pass-A1')
    expect(users.get(USER_B)!.password).toBe('old-pass-B1')
  })

  it('現在のパスワードが違えば 400（updateUser を呼ばない）', async () => {
    signInCookie(USER_A)
    const res = await post({ current_password: 'wrong-pass', new_password: 'new-pass-A2' })

    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('invalid_current_password')
    expect(updates()).toHaveLength(0)
    expect(users.get(USER_A)!.password).toBe('old-pass-A1')
  })

  it('未ログインは 401（照合も変更もしない）', async () => {
    const res = await post({ current_password: 'old-pass-A1', new_password: 'new-pass-A2' })
    expect(res.status).toBe(401)
    expect(signIns()).toHaveLength(0)
    expect(updates()).toHaveLength(0)
  })

  it('Cookie はあってもセッションが Auth サーバーで終了していれば 401（変更しない）', async () => {
    const cookieToken = signInCookie(USER_A)
    sessions.get(cookieToken)!.revoked = true

    const res = await post({ current_password: 'old-pass-A1', new_password: 'new-pass-A2' })
    expect(res.status).toBe(401)
    expect(signIns()).toHaveLength(0)
    expect(updates()).toHaveLength(0)
    expect(users.get(USER_A)!.password).toBe('old-pass-A1')
  })

  it('この端末のセッションは続き、照合用と他の端末のセッションは終了する。他人のセッションには触れない', async () => {
    const otherDevice = issueSession(USER_A)
    const userBSession = issueSession(USER_B)
    const cookieToken = signInCookie(USER_A)

    const res = await post({ current_password: 'old-pass-A1', new_password: 'new-pass-A2' })
    expect(res.status).toBe(200)

    expect(sessions.get(cookieToken)!.revoked).toBe(false)
    expect(sessions.get(otherDevice)!.revoked).toBe(true)
    expect(sessions.get(userBSession)!.revoked).toBe(false)
    // 照合で作られたセッションは scope=local で終了している
    const verifierTokens = [...sessions.entries()]
      .filter(([t, s]) => s.userId === USER_A && ![cookieToken, otherDevice].includes(t))
    expect(verifierTokens).toHaveLength(1)
    expect(verifierTokens[0][1].revoked).toBe(true)

    expect(logouts().map(r => [r.path.split('?')[1], r.token === cookieToken ? 'cookie' : 'verifier'])).toEqual([
      ['scope=local', 'verifier'],
      ['scope=others', 'cookie'],
    ])
    // Cookie のセッションは消えず、変更後もログインしたまま使える
    expect(cookieJar.has('sb-127-auth-token')).toBe(true)
    const again = await post({ current_password: 'new-pass-A2', new_password: 'new-pass-A3' })
    expect(again.status).toBe(200)
    expect(users.get(USER_A)!.password).toBe('new-pass-A3')
  })

  it('再認証が必要なら 403 reauthentication_needed。確認コードを送り、コード付きで再送すると変更できる', async () => {
    secureChange = true
    const cookieToken = signInCookie(USER_A, Date.now() - 25 * 3600 * 1000) // 25 時間前のログイン

    const first = await post({ current_password: 'old-pass-A1', new_password: 'new-pass-A2' })
    expect(first.status).toBe(403)
    expect((await first.json()).code).toBe('reauthentication_needed')
    expect(users.get(USER_A)!.password).toBe('old-pass-A1')

    // 確認コードはセッションの利用者（A）にだけ送られる
    const sent = await REAUTH()
    expect(sent.status).toBe(200)
    expect(requests.filter(r => r.path.endsWith('/reauthenticate')).map(r => r.token)).toEqual([cookieToken])
    expect([...sentNonces.keys()]).toEqual([USER_A])

    const wrong = await post({ current_password: 'old-pass-A1', new_password: 'new-pass-A2', nonce: '111111' })
    expect(wrong.status).toBe(400)
    expect((await wrong.json()).code).toBe('reauthentication_not_valid')
    expect(users.get(USER_A)!.password).toBe('old-pass-A1')

    const ok = await post({ current_password: 'old-pass-A1', new_password: 'new-pass-A2', nonce: '246810' })
    expect(ok.status).toBe(200)
    expect(updates().at(-1)!.body).toMatchObject({ nonce: '246810' })
    expect(users.get(USER_A)!.password).toBe('new-pass-A2')
  })

  it('24 時間以内のログインなら、Secure password change が有効でも確認コードなしで変更できる', async () => {
    secureChange = true
    signInCookie(USER_A)
    const res = await post({ current_password: 'old-pass-A1', new_password: 'new-pass-A2' })
    expect(res.status).toBe(200)
    expect(requests.some(r => r.path.endsWith('/reauthenticate'))).toBe(false)
  })

  it('Supabase のパスワード条件に合わなければ 400 weak_password（変更しない）', async () => {
    signInCookie(USER_A)
    const res = await post({ current_password: 'old-pass-A1', new_password: 'no-digits-here' })
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('weak_password')
    expect(users.get(USER_A)!.password).toBe('old-pass-A1')
  })

  it('入力が不正なら 400（Auth サーバーに問い合わせない）', async () => {
    signInCookie(USER_A)
    for (const body of [
      null,
      {},
      { new_password: 'new-pass-A2' },
      { current_password: 'old-pass-A1' },
      { current_password: 'old-pass-A1', new_password: 'short' },
      { current_password: 'old-pass-A1', new_password: 'あ'.repeat(25) }, // 75 バイト
      { current_password: 'old-pass-A1', new_password: 'old-pass-A1' },
      { current_password: 'old-pass-A1', new_password: 'new-pass-A2', nonce: 'abc' },
    ]) {
      const res = await post(body)
      expect(res.status).toBe(400)
    }
    expect(requests).toHaveLength(0)
  })
})

describe('POST /api/account/password/reauthenticate', () => {
  it('未ログインは 401（確認コードを送らない）', async () => {
    const res = await REAUTH()
    expect(res.status).toBe(401)
    expect(requests.some(r => r.path.endsWith('/reauthenticate'))).toBe(false)
  })
})

describe('parsePasswordChangeRequest / mapUpdatePasswordError', () => {
  it('利用者を指定するキーは結果に含めない', () => {
    expect(parsePasswordChangeRequest({
      current_password: 'old-pass-A1', new_password: 'new-pass-A2', nonce: ' 123456 ', user_id: USER_B, email: 'b@example.com',
    })).toEqual({ current_password: 'old-pass-A1', new_password: 'new-pass-A2', nonce: '123456' })
  })

  it('72 バイトちょうどは通り、超えると 400', () => {
    expect('status' in parsePasswordChangeRequest({ current_password: 'x', new_password: 'a'.repeat(72) })).toBe(false)
    expect(parsePasswordChangeRequest({ current_password: 'x', new_password: 'a'.repeat(73) })).toMatchObject({ status: 400 })
  })

  it('Supabase のエラーを画面向けの応答に変換する（Supabase の文言は返さない）', () => {
    expect(mapUpdatePasswordError({ code: 'reauthentication_needed' })).toMatchObject({ status: 403, body: { code: 'reauthentication_needed' } })
    expect(mapUpdatePasswordError({ code: 'reauth_nonce_missing' })).toMatchObject({ status: 403 })
    expect(mapUpdatePasswordError({ code: 'reauthentication_not_valid' })).toMatchObject({ status: 400 })
    expect(mapUpdatePasswordError({ code: 'weak_password' })).toMatchObject({ status: 400, body: { code: 'weak_password' } })
    expect(mapUpdatePasswordError({ code: 'same_password' })).toMatchObject({ status: 400 })
    expect(mapUpdatePasswordError({ code: 'insufficient_aal' })).toMatchObject({ status: 403 })
    expect(mapUpdatePasswordError({ name: 'AuthSessionMissingError' })).toMatchObject({ status: 401 })
    expect(mapUpdatePasswordError({ status: 429 })).toMatchObject({ status: 429 })
    expect(mapUpdatePasswordError({ code: 'something_new', status: 500 })).toMatchObject({ status: 500 })
  })
})
