import { describe, it, expect } from 'vitest'
import { checkEstimateImageFile, prepareEstimateImage, UPLOAD_MAX_BYTES, type ImageCodec } from '@/lib/estimate/ocr-image'

/**
 * 見積書 OCR の送信前の画像縮小（lib/estimate/ocr-image.ts）。ブラウザの縮小処理は偽物に置き換える。
 */

const MB = 1024 * 1024
const file = (name: string, size: number, type = 'image/jpeg') => new File([new Uint8Array(size)], name, { type })

/** 長辺・画質に応じた大きさの JPEG を返す偽の縮小処理 */
function codec(sizeFor: (w: number, h: number, q: number) => number, dims = { width: 4032, height: 3024 }) {
  const calls: Array<[number, number, number]> = []
  let closed = false
  const c: ImageCodec = {
    load: async () => ({ ...dims, close: () => { closed = true } }),
    encode: async (_s, w, h, q) => { calls.push([w, h, q]); return new Blob([new Uint8Array(sizeFor(w, h, q))]) },
  }
  return { c, calls, closed: () => closed }
}

describe('送信前の画像縮小', () => {
  it('3.5MB 以下はそのまま送る（再圧縮しない）', async () => {
    const f = file('a.jpg', 2 * MB)
    const { c, calls } = codec(() => 1)
    const r = await prepareEstimateImage(f, c)
    expect(r).toEqual({ ok: true, file: f, resized: false, originalBytes: 2 * MB })
    expect(calls).toHaveLength(0)
  })

  it('スマホの大きな写真は 2400px・画質 0.9 から縮小し、3.5MB 以下の JPEG にする', async () => {
    const { c, calls, closed } = codec((w, _h, q) => (w <= 2400 && q <= 0.82 ? 2 * MB : 5 * MB))
    const r = await prepareEstimateImage(file('IMG_0001.png', 12 * MB, 'image/png'), c)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.resized).toBe(true)
    expect(r.file.type).toBe('image/jpeg')
    expect(r.file.name).toBe('IMG_0001.jpg')
    expect(r.file.size).toBeLessThanOrEqual(UPLOAD_MAX_BYTES)
    expect(calls).toEqual([[2400, 1800, 0.9], [2400, 1800, 0.82]])
    expect(closed()).toBe(true)
  })

  it('長辺 1600px・画質 0.75 まで下げても収まらなければ送らずに案内する', async () => {
    const { c, calls } = codec(() => 5 * MB)
    const r = await prepareEstimateImage(file('a.jpg', 20 * MB), c)
    expect(r.ok).toBe(false)
    expect(calls.at(-1)).toEqual([1600, 1200, 0.75])
    expect(calls).toHaveLength(9)
  })

  it('読み込めない画像は案内する', async () => {
    const c: ImageCodec = { load: async () => null, encode: async () => null }
    expect((await prepareEstimateImage(file('a.jpg', 5 * MB), c)).ok).toBe(false)
  })

  it('HEIC・PDF・対応外・40MB 超は読み込む前に理由を返す', () => {
    expect(checkEstimateImageFile({ name: 'IMG.HEIC', type: '', size: 1 })).toMatchObject({ ok: false, message: expect.stringContaining('HEIC') })
    expect(checkEstimateImageFile({ name: 'q.pdf', type: 'application/pdf', size: 1 })).toMatchObject({ ok: false, message: expect.stringContaining('PDF') })
    expect(checkEstimateImageFile({ name: 'q.gif', type: 'image/gif', size: 1 }).ok).toBe(false)
    expect(checkEstimateImageFile({ name: 'q.jpg', type: 'image/jpeg', size: 41 * MB }).ok).toBe(false)
    expect(checkEstimateImageFile({ name: 'q.webp', type: 'image/webp', size: 1 }).ok).toBe(true)
  })
})
