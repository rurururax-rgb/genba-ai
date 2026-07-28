import crypto from 'crypto'

export function verifyLineSignature(body: Buffer, signature: string): boolean {
  const secret = process.env.LINE_CHANNEL_SECRET
  if (!secret) return false
  const hash = crypto.createHmac('sha256', secret).update(body).digest('base64')
  try {
    return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(signature))
  } catch {
    return false
  }
}

export async function fetchLineContent(
  messageId: string
): Promise<{ data: Buffer; contentType: string }> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN
  const res = await fetch(
    `https://api-data.line.me/v2/bot/message/${messageId}/content`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  if (!res.ok) {
    throw new Error(`LINE content API error: ${res.status} ${res.statusText}`)
  }
  const data = Buffer.from(await res.arrayBuffer())
  const contentType = res.headers.get('content-type') ?? 'application/octet-stream'
  return { data, contentType }
}
