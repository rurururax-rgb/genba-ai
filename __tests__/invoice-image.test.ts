import { describe, it, expect, vi } from 'vitest'
import {
  JPEG_QUALITIES, LONG_EDGES, UPLOAD_MAX_BYTES, checkInvoiceImageFile, prepareInvoiceImage, type ImageCodec,
} from '@/lib/cost-ledger/invoice-image'

/**
 * 業者請求書の画像を送信前に整える処理（lib/cost-ledger/invoice-image.ts）。
 * ブラウザの画像処理（createImageBitmap・canvas）は偽物に置き換え、どの大きさ・画質を試すかと結果を確かめる。
 */

const MB = 1024 * 1024
const fileOf = (bytes: number, name = 'invoice.jpg', type = 'image/jpeg') => new File([new Uint8Array(bytes)], name, { type })

/** 偽の画像処理。sizeFor(長辺, 画質) が返す大きさの JPEG を作る */
function codec(width: number, height: number, sizeFor: (longEdge: number, quality: number) => number | null) {
  const calls: Array<{ width: number; height: number; quality: number }> = []
  const close = vi.fn()
  const c: ImageCodec = {
    load: async () => ({ width, height, close }),
    encode: async (_s, w, h, quality) => {
      calls.push({ width: w, height: h, quality })
      const size = sizeFor(Math.max(w, h), quality)
      return size == null ? null : new Blob([new Uint8Array(size)], { type: 'image/jpeg' })
    },
  }
  return { c, calls, close }
}

describe('checkInvoiceImageFile：対応していない形式は理由と対処を案内する', () => {
  it('HEIC / HEIF（type でも拡張子でも）', () => {
    for (const f of [fileOf(10, 'IMG_0001.HEIC', ''), fileOf(10, 'a.heif', 'image/heif'), fileOf(10, 'a.jpg', 'image/heic')]) {
      const r = checkInvoiceImageFile(f)
      expect(r.ok).toBe(false)
      expect(!r.ok && r.message).toContain('HEIC 形式の写真には対応していません')
    }
  })

  it('PDF', () => {
    const r = checkInvoiceImageFile(fileOf(10, 'invoice.pdf', 'application/pdf'))
    expect(!r.ok && r.message).toContain('PDF には対応していません')
  })

  it('その他の形式・40MB 超は断る。JPEG / PNG / WebP は通す', () => {
    expect(checkInvoiceImageFile(fileOf(10, 'a.gif', 'image/gif')).ok).toBe(false)
    expect(checkInvoiceImageFile({ name: 'a.jpg', type: 'image/jpeg', size: 41 * MB }).ok).toBe(false)
    for (const type of ['image/jpeg', 'image/png', 'image/webp']) expect(checkInvoiceImageFile(fileOf(10, 'a', type)).ok).toBe(true)
  })
})

describe('prepareInvoiceImage', () => {
  it('3.5MB 以下はそのまま送る（再圧縮しない。読み込みもしない）', async () => {
    const { c, calls } = codec(4000, 3000, () => 1)
    const load = vi.spyOn(c, 'load')
    const f = fileOf(UPLOAD_MAX_BYTES)
    const r = await prepareInvoiceImage(f, c)
    expect(r).toMatchObject({ ok: true, resized: false })
    expect(r.ok && r.file).toBe(f)
    expect(load).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })

  it('大容量（12MB・4032×3024）→ 長辺 2400px・画質 0.9 の JPEG で 3.5MB 以下にする（Vercel の 4.5MB より余裕あり）', async () => {
    const { c, calls, close } = codec(4032, 3024, () => 2 * MB)
    const r = await prepareInvoiceImage(fileOf(12 * MB, 'IMG_0001.png', 'image/png'), c)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.resized).toBe(true)
    expect(r.file.type).toBe('image/jpeg')
    expect(r.file.name).toBe('IMG_0001.jpg')
    expect(r.file.size).toBeLessThanOrEqual(UPLOAD_MAX_BYTES)
    expect(UPLOAD_MAX_BYTES).toBeLessThan(4.5 * MB)
    expect(calls).toEqual([{ width: 2400, height: 1800, quality: 0.9 }])
    expect(close).toHaveBeenCalled()
  })

  it('収まらなければ画質 → 長辺の順に下げる。長辺 1600px・画質 0.75 より下げない', async () => {
    const { c, calls } = codec(3000, 4000, (edge, q) => (edge === 1600 && q === 0.75 ? 3 * MB : 5 * MB))
    const r = await prepareInvoiceImage(fileOf(10 * MB), c)
    expect(r.ok).toBe(true)
    expect(calls.map(x => [Math.max(x.width, x.height), x.quality])).toEqual(
      LONG_EDGES.flatMap(e => JPEG_QUALITIES.map(q => [e, q])),
    )
    expect(Math.min(...calls.map(x => Math.max(x.width, x.height)))).toBe(1600)
    expect(Math.min(...calls.map(x => x.quality))).toBe(0.75)
  })

  it('圧縮に失敗（どの組み合わせでも 3.5MB を超える）→ 送らずに撮り直しを案内する', async () => {
    const { c, close } = codec(4000, 3000, () => 4 * MB)
    const r = await prepareInvoiceImage(fileOf(20 * MB), c)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.message).toContain('画像を十分に小さくできませんでした')
    expect(close).toHaveBeenCalled()
  })

  it('JPEG を作れない（canvas が使えない等）→ 失敗として案内する', async () => {
    const { c } = codec(4000, 3000, () => null)
    expect((await prepareInvoiceImage(fileOf(20 * MB), c)).ok).toBe(false)
  })

  it('画像を読み込めない（壊れた画像・ブラウザ非対応）→ 案内する', async () => {
    const c: ImageCodec = { load: async () => null, encode: async () => null }
    const r = await prepareInvoiceImage(fileOf(5 * MB), c)
    expect(!r.ok && r.message).toContain('画像を読み込めませんでした')
    const throwing: ImageCodec = { load: async () => { throw new Error('decode') }, encode: async () => null }
    expect((await prepareInvoiceImage(fileOf(5 * MB), throwing)).ok).toBe(false)
  })

  it('小さい画素数の画像は拡大しない（容量だけ大きい 1200×900 の PNG）', async () => {
    const { c, calls } = codec(1200, 900, () => 1 * MB)
    const r = await prepareInvoiceImage(fileOf(5 * MB, 'scan.png', 'image/png'), c)
    expect(r.ok).toBe(true)
    expect(calls[0]).toEqual({ width: 1200, height: 900, quality: 0.9 })
  })

  it('HEIC は読み込む前に断る', async () => {
    const { c } = codec(4000, 3000, () => 1)
    const load = vi.spyOn(c, 'load')
    expect((await prepareInvoiceImage(fileOf(5 * MB, 'IMG.HEIC', 'image/heic'), c)).ok).toBe(false)
    expect(load).not.toHaveBeenCalled()
  })
})
