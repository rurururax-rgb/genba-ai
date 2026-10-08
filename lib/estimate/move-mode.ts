/**
 * 見積エディタの「移動」状態（選択 → 移動 → 移動先の行間をクリック）。
 *
 * moveIds は selectedIds とは別に持つ。工種タブを切り替えると selectedIds は空になるが、
 * 移動中は moveIds を残して別の工種の行間へ移せるようにするため。
 * null = 移動していない。
 */

export type MoveModeState = { moveIds: ReadonlySet<string> | null }

export type MoveModeAction =
  /** 「移動」ボタン：その時点の選択行を移動対象として確定する */
  | { type: 'start'; selectedIds: Iterable<string> }
  /** キャンセル・Esc：何も保存せずに終える */
  | { type: 'cancel' }
  /** 移動先を選んだ（保存の成否にかかわらず移動は終える） */
  | { type: 'finish' }

export const initialMoveMode: MoveModeState = { moveIds: null }

export function moveModeReducer(state: MoveModeState, action: MoveModeAction): MoveModeState {
  switch (action.type) {
    case 'start': {
      const ids = new Set(action.selectedIds)
      return ids.size > 0 ? { moveIds: ids } : state
    }
    case 'cancel':
    case 'finish':
      return state.moveIds === null ? state : initialMoveMode
  }
}
