/**
 * 見積書 OCR の明細を見積エディタへドロップしたときの「保存中」の仮の行（EstimateTab）。
 *
 * - 仮の行は items（DB で確定した明細）に入れない。合計・粗利率・並び順の計算には使わない
 * - 保存は 1 件ずつ順に行う（並び順をドロップの順に決めるため。同時に保存すると並び順がぶつかる）
 * - 保存に成功したら、サーバーが返した明細（売価・金額・並び順は DB の値）で置き換える
 */

export type PendingDrop = {
  /** 仮の行の ID（DB の ID ではない） */
  tempId: string
  /** 取り込み候補の ID（取り込みパネルへの通知に使う） */
  importId: string
  groupId: string
  /** この明細の後ろに入れる。null = 工種の先頭、undefined = 工種の末尾 */
  afterItemId: string | null | undefined
  name: string
  quantity: number
  unit: string
  cost_price: number | null
}

export type PendingSlots = {
  /** 工種の先頭（最初の明細の前） */
  head: PendingDrop[]
  /** 明細 ID → その明細の直後に出す仮の行 */
  after: Map<string, PendingDrop[]>
  /** 工種の末尾 */
  end: PendingDrop[]
}

/**
 * 工種の明細（表示順の ID）と仮の行から、仮の行をどこに出すかを決める。
 * 保存が順番どおりに終わったときの並びと同じにする:
 *   - 同じ明細の後ろ・先頭へのドロップは、後からドロップしたものほど前（直後に挿入されるため）
 *   - 末尾へのドロップは、ドロップした順
 *   - 入れる位置の明細が無くなっていたら末尾（保存も末尾になる）
 * pending はドロップした順に並んでいること
 */
export function pendingSlots(groupItemIds: string[], pending: PendingDrop[], groupId: string): PendingSlots {
  const ids = new Set(groupItemIds)
  const slots: PendingSlots = { head: [], after: new Map(), end: [] }
  for (const p of pending) {
    if (p.groupId !== groupId) continue
    if (p.afterItemId === null && groupItemIds.length > 0) slots.head.unshift(p)
    else if (p.afterItemId && ids.has(p.afterItemId)) {
      const list = slots.after.get(p.afterItemId) ?? []
      list.unshift(p)
      slots.after.set(p.afterItemId, list)
    } else slots.end.push(p)
  }
  return slots
}

/** 保存できた明細を、今の明細に反映する（同じ ID は置き換え、新しい ID は追加） */
export function mergeSavedItems<T extends { id: string }>(prev: T[], saved: T[]): T[] {
  const byId = new Map(saved.map(s => [s.id, s]))
  const kept = prev.map(p => byId.get(p.id) ?? p)
  const known = new Set(prev.map(p => p.id))
  return [...kept, ...saved.filter(s => !known.has(s.id))]
}

/** 登録 API の応答から、保存できた明細を取り出す。形が違えば null（呼び出し側は全件を読み直す） */
export function savedItemsFrom<T>(body: unknown, expected: number): T[] | null {
  const items = (body as { items?: unknown } | null)?.items
  if (!Array.isArray(items) || items.length !== expected) return null
  if (!items.every(i => i && typeof i === 'object' && typeof (i as { id?: unknown }).id === 'string' && typeof (i as { sort_order?: unknown }).sort_order === 'number')) return null
  return items as T[]
}
