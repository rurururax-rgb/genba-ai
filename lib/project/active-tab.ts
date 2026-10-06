/**
 * 案件画面で「いま表示している」タブ ID。
 * ProjectTabs が実際に描画したタブだけを publish し、サイドバーはそれを表示するだけ（Single Source of Truth）。
 * サイドバーは layout に常駐して案件をまたいで残るため、独自の選択 state を持つと表示とずれる。
 * publish は ProjectTabs の effect からのみ行うため、サーバー上では常に null（hydration と一致する）。
 */
type Listener = () => void

let current: string | null = null
const listeners = new Set<Listener>()

export function publishActiveProjectTab(tab: string | null) {
  if (current === tab) return
  current = tab
  for (const l of listeners) l()
}

export function getActiveProjectTab(): string | null {
  return current
}

export function subscribeActiveProjectTab(listener: Listener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
