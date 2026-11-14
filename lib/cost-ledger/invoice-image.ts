/**
 * 業者請求書 OCR に送る画像を、ブラウザで送信前に整える（VendorInvoiceImportTab）。
 *
 * - Vercel の関数は 4.5MB を超えるリクエストを受け取れない。余裕をみて 3.5MB 以下にして送る（サーバーは 4MB で断る）。
 * - 3.5MB 以下の画像はそのまま送る（再圧縮で文字を劣化させない。同じ画像の重複検出に使うハッシュも変わらない）。
 * - 大きい画像は長辺 2400px → 2000px → 1600px の順に縮小し、JPEG の画質も段階的に下げて 3.5MB 以下にする。
 *   請求書の細かな数字を読めるよう、長辺 1600px・画質 0.75 より下げない。下げても収まらなければ送らずに案内する。
 * - HEIC / HEIF・PDF など対応していない形式は、送る前に理由と対処を案内する。
 */

export const UPLOAD_MAX_BYTES = 3.5 * 1024 * 1024
/** これを超える元画像は読み込まない（端末のメモリを使い切らないため） */
export const SOURCE_MAX_BYTES = 40 * 1024 * 1024
export const LONG_EDGES = [2400, 2000, 1600] as const
export const JPEG_QUALITIES = [0.9, 0.82, 0.75] as const

const SUPPORTED_TYPES = ['image/jpeg', 'image/png', 'image/webp']

export type InvoiceImageCheck = { ok: true } | { ok: false; message: string }

/** 選んだファイルの形式を確かめる（読み込みはしない） */
export function checkInvoiceImageFile(file: { name: string; type: string; size: number }): InvoiceImageCheck {
  const name = file.name.toLowerCase()
  const type = file.type.toLowerCase()
  if (type === 'image/heic' || type === 'image/heif' || /\.(heic|heif)$/.test(name)) {
    return {
      ok: false,
      message: 'HEIC 形式の写真には対応していません。iPhone では「設定 > カメラ > フォーマット」を「互換性優先」にして撮り直すか、写真のスクリーンショットを選んでください',
    }
  }
  if (type === 'application/pdf' || name.endsWith('.pdf')) {
    return { ok: false, message: 'PDF には対応していません。請求書を画像（JPEG / PNG）で保存するか、スクリーンショットを選んでください' }
  }
  if (!SUPPORTED_TYPES.includes(type)) {
    return { ok: false, message: 'JPEG / PNG / WebP の画像ファイルを選択してください' }
  }
  if (file.size > SOURCE_MAX_BYTES) {
    return { ok: false, message: '画像が大きすぎます（40MB まで）。写真アプリで縮小してから選んでください' }
  }
  return { ok: true }
}

/** 縮小に使う処理（ブラウザの実装。テストでは差し替える） */
export type ImageCodec = {
  /** 画像を読み込む。読めなければ null */
  load(file: File): Promise<{ width: number; height: number; close?: () => void } | null>
  /** 指定サイズ・画質の JPEG を作る。作れなければ null */
  encode(source: { width: number; height: number }, width: number, height: number, quality: number): Promise<Blob | null>
}

export type PreparedInvoiceImage =
  | { ok: true; file: File; resized: boolean; originalBytes: number }
  | { ok: false; message: string }

const CANNOT_SHRINK =
  '画像を十分に小さくできませんでした。請求書の部分だけが写るように撮り直すか、スクリーンショットを選んでください'

export async function prepareInvoiceImage(file: File, codec: ImageCodec = browserCodec): Promise<PreparedInvoiceImage> {
  const check = checkInvoiceImageFile(file)
  if (!check.ok) return check
  if (file.size <= UPLOAD_MAX_BYTES) return { ok: true, file, resized: false, originalBytes: file.size }

  const source = await codec.load(file).catch(() => null)
  if (!source || !(source.width > 0) || !(source.height > 0)) {
    return { ok: false, message: '画像を読み込めませんでした。別の画像を選ぶか、撮り直してください' }
  }
  try {
    const long = Math.max(source.width, source.height)
    for (const edge of LONG_EDGES) {
      const scale = Math.min(1, edge / long) // 拡大はしない
      const width = Math.max(1, Math.round(source.width * scale))
      const height = Math.max(1, Math.round(source.height * scale))
      for (const quality of JPEG_QUALITIES) {
        const blob = await codec.encode(source, width, height, quality).catch(() => null)
        if (blob && blob.size > 0 && blob.size <= UPLOAD_MAX_BYTES) {
          const name = file.name.replace(/\.[^.]+$/, '') + '.jpg'
          return { ok: true, file: new File([blob], name, { type: 'image/jpeg' }), resized: true, originalBytes: file.size }
        }
      }
      if (scale === 1) break // これ以上小さい長辺を試しても同じ大きさ
    }
    return { ok: false, message: CANNOT_SHRINK }
  } finally {
    source.close?.()
  }
}

type BitmapSource = { width: number; height: number; close?: () => void; bitmap: ImageBitmap }

/** ブラウザの実装: createImageBitmap（撮影時の向きを反映）→ canvas → JPEG */
export const browserCodec: ImageCodec = {
  async load(file) {
    if (typeof createImageBitmap !== 'function') return null
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
    return { width: bitmap.width, height: bitmap.height, close: () => bitmap.close(), bitmap } as BitmapSource
  },
  async encode(source, width, height, quality) {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    // 透過 PNG の背景を白にする（JPEG では黒くなり文字が読めなくなる）
    ctx.fillStyle = '#FFFFFF'
    ctx.fillRect(0, 0, width, height)
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage((source as BitmapSource).bitmap, 0, 0, width, height)
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', quality))
    canvas.width = 0
    canvas.height = 0
    return blob
  },
}

export const formatMegabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)}MB`
