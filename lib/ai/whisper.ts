// OpenAI Whisper API ラッパー
// openai パッケージを追加せず Node.js 標準の FormData / fetch で呼び出す

export async function transcribeAudio(
  audioBuffer: Buffer,
  filename: string = 'audio.m4a'
): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY が設定されていません')

  const formData = new FormData()
  // Node.js 18+ の組み込み Blob / FormData を使用
  // Buffer → Uint8Array に変換してから Blob に渡す（TypeScript の型制約回避）
  const blob = new Blob([new Uint8Array(audioBuffer)], { type: 'audio/m4a' })
  formData.append('file', blob, filename)
  formData.append('model', 'whisper-1')
  formData.append('language', 'ja')
  formData.append('response_format', 'text')   // プレーンテキストで受け取る

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '(no detail)')
    throw new Error(`Whisper API ${res.status}: ${detail}`)
  }

  return (await res.text()).trim()
}
