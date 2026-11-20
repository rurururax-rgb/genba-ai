/**
 * 見積書 OCR の取り込み候補を、見積エディタへドラッグで渡す仕組み（1 画面・別ウィンドウ共通）。
 *
 * - ドラッグのデータ（dataTransfer）には一時トークンだけを入れる。品名・金額はブラウザのドラッグデータに出さない
 *   （他のアプリ・他のタブへ落とされても中身が渡らない）。
 * - 別ウィンドウ（#58）は同じ画面の React が描画しているので、ドラッグ開始とドロップは同じ JavaScript の
 *   実行環境で動く。トークンに対応する明細はこのモジュールの中だけに持つ。
 * - トークンだけでは登録させない。ドロップ時に次をすべて確かめる:
 *   今のドラッグのトークンか・一度だけか・期限内か・同じ案件か・取り込み候補が今も有効か（確認済み・追加中でない）。
 * - 別のタブ・別の案件の画面からのドラッグは、トークンがこの実行環境に無いので受け付けない。
 */

export const IMPORT_DRAG_TYPE = 'application/genba-import-item'

/** ドラッグ開始から、これを過ぎたトークンは受け付けない */
const TOKEN_TTL_MS = 5 * 60 * 1000

/** 見積エディタの登録（handleDropImportItem）に渡す値。登録 API の保存仕様は変えない */
export type ImportDragItem = {
  _importId: string
  name: string
  quantity: number
  unit: string
  cost_price: number | null
  vendor_name: string
  memo: string
}

type Session = {
  token: string
  projectId: string
  item: ImportDragItem
  startedAt: number
  /** ドロップ時に、取り込み候補が今も追加できるかを確かめる。追加できなければ理由を返す */
  check: () => string | null
}

export type ImportDropResult =
  | { ok: true; item: ImportDragItem }
  | { ok: false; reason: string; importId?: string }

let current: Session | null = null
const endListeners = new Set<() => void>()

function newToken(): string {
  const c = globalThis.crypto
  if (c?.randomUUID) return c.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
}

/** ドラッグ開始。dataTransfer に入れるトークンを返す（前のドラッグは無効にする） */
export function startImportDrag(input: { projectId: string; item: ImportDragItem; check: () => string | null; now?: number }): string {
  const token = newToken()
  current = { token, projectId: input.projectId, item: { ...input.item }, startedAt: input.now ?? Date.now(), check: input.check }
  return token
}

/** ドラッグ終了（ドロップ・キャンセル）。token を渡したときは、そのドラッグのときだけ終える */
export function endImportDrag(token?: string) {
  if (token && current?.token !== token) return
  if (!current) return
  current = null
  endListeners.forEach(l => l())
}

/** ドラッグの終了を知らせる（別ウィンドウで始めたドラッグの終了は、見積エディタのウィンドウに dragend が届かないため） */
export function onImportDragEnd(listener: () => void): () => void {
  endListeners.add(listener)
  return () => { endListeners.delete(listener) }
}

/** 取り込み候補のドラッグか（dragover 中は値を読めないので、種類だけで判断する） */
export function isImportDrag(dt: Pick<DataTransfer, 'types'> | null | undefined): boolean {
  return !!dt && Array.from(dt.types ?? []).includes(IMPORT_DRAG_TYPE)
}

/**
 * ドロップを受け付けてよいか確かめ、登録する値を返す。受け付けたトークンは使い切る（同じドラッグで二度登録しない）。
 * projectId は、ドロップされた見積エディタの案件。
 */
export function resolveImportDrop(dt: Pick<DataTransfer, 'getData'> | null | undefined, projectId: string, now = Date.now()): ImportDropResult {
  const token = dt?.getData(IMPORT_DRAG_TYPE) ?? ''
  const s = current
  if (!token || !s || s.token !== token) {
    return { ok: false, reason: 'この明細は追加できません。取り込みパネルの明細を、もう一度ドラッグしてください（別のタブ・別の画面の明細は追加できません）' }
  }
  const importId = s.item._importId
  if (now - s.startedAt > TOKEN_TTL_MS) {
    endImportDrag(token)
    return { ok: false, reason: 'ドラッグの有効期限が切れました。もう一度ドラッグしてください', importId }
  }
  if (s.projectId !== projectId) {
    endImportDrag(token)
    return { ok: false, reason: '別の案件の取り込み明細です。この案件の見積には追加できません', importId }
  }
  const reason = s.check()
  if (reason) {
    endImportDrag(token)
    return { ok: false, reason, importId }
  }
  const item = { ...s.item }
  endImportDrag(token)
  return { ok: true, item }
}

/** テスト用: ドラッグの状態を消す */
export function resetImportDragForTest() {
  current = null
  endListeners.clear()
}
