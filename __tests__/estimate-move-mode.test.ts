import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { initialMoveMode, moveModeReducer, type MoveModeState } from '@/lib/estimate/move-mode'
import { moveTargetLabel } from '@/components/projects/EstimateMoveMode'

const root = process.cwd()
const src = readFileSync(path.join(root, 'components/projects/EstimateTab.tsx'), 'utf8')
const parts = readFileSync(path.join(root, 'components/projects/EstimateMoveMode.tsx'), 'utf8')
const css = readFileSync(path.join(root, 'app/globals.css'), 'utf8')

function body(start: string, end: string, from = src) {
  const at = from.indexOf(start)
  expect(at, start).toBeGreaterThan(0)
  return from.slice(at, from.indexOf(end, at))
}

describe('移動の状態（moveModeReducer）', () => {
  const selected = new Set(['a', 'b', 'c'])
  const started = moveModeReducer(initialMoveMode, { type: 'start', selectedIds: selected })

  it('3 件選択して「移動」→ moveIds = 3（selectedIds のコピー）', () => {
    expect(started.moveIds?.size).toBe(3)
    expect(started.moveIds).not.toBe(selected)
    selected.clear()  // タブ切替で selectedIds が空になっても
    expect(started.moveIds?.size).toBe(3)  // moveIds は残る
  })

  it('選択なしで「移動」→ 移動しない', () => {
    expect(moveModeReducer(initialMoveMode, { type: 'start', selectedIds: [] }).moveIds).toBeNull()
  })

  it('キャンセル（Esc）・移動先の決定で moveIds = null', () => {
    expect(moveModeReducer(started, { type: 'cancel' }).moveIds).toBeNull()
    expect(moveModeReducer(started, { type: 'finish' }).moveIds).toBeNull()
    const idle: MoveModeState = initialMoveMode
    expect(moveModeReducer(idle, { type: 'cancel' })).toBe(idle)
  })
})

describe('移動の状態：EstimateTab との配線', () => {
  it('moveIds は selectedIds と別の state。工種タブ切替で消えるのは selectedIds だけ', () => {
    expect(src).toContain('useEstimateMoveMode()')
    const tabEffect = body('// グループタブ切替時に合計選択・行選択をクリア', '}, [activeGroupTab])')
    expect(tabEffect).toContain('setSelectedIds(new Set())')
    expect(tabEffect).not.toMatch(/cancelMove|finishMove|moveIds/)
  })

  it('Esc で取り消す（IME 変換中を除く）。document の keydown は移動中だけ登録', () => {
    const hook = body('export function useEstimateMoveMode()', '\n}\n', parts)
    expect(hook).toMatch(/if \(!moveIds\) return/)
    expect(hook).toContain("e.key === 'Escape' && !e.isComposing")
    expect(hook).toContain('cancel()')
  })

  it('移動中は行・工種のドラッグを無効にする', () => {
    expect(src).toContain('<Draggable key={group.id} draggableId={`group-${group.id}`} index={gi} isDragDisabled={moving}>')
    expect(src.match(/<Draggable key=\{item\.id\} draggableId=\{`item-\$\{item\.id\}`\} index=\{idx\} isDragDisabled=\{moving\}>/g)).toHaveLength(2)
  })

  it('移動中は行間 ＋ の代わりに「ここへ移動」（同じ行間・同じ groupId / 行 id を使う）', () => {
    // 工種グループ・その他の両方で moving ? MoveGap : InsertGap
    expect(src.match(/\{moving \? \(\s*<>\s*<MoveGap edge="top"/g)).toHaveLength(2)
    expect(src).toContain('confirmMove({ groupId: group.id, beforeId: item.id })')
    expect(src).toContain('confirmMove({ groupId: group.id, beforeId: null })')
    expect(src).toContain('confirmMove({ groupId: null, beforeId: item.id })')
    expect(src).toContain('confirmMove({ groupId: null, beforeId: null })')
    // 空の工種の「行を追加」も移動先に切り替わる
    expect(src).toMatch(/gItems\.length === 0 && \(moving\s*\? <MoveTargetBlock/)
  })

  it('移動中は「＋ 工種」を押せず、行・工種の選択も変えない', () => {
    expect(src).toContain('onClick={handleCreateGroup} disabled={creating || moving}')
    expect(body('function handleGroupSelect(', '\n  }\n')).toMatch(/^function handleGroupSelect\(gid: string\) \{\s*if \(moving\) return/)
    expect(body('function handleItemSelect(', 'if (shift')).toContain('if (moving) return')
  })

  it('移動する行は薄く表示するだけで、DOM から外さない（isGhost を流用）', () => {
    expect(src.match(/isGhost=\{\(draggingId !== null && selectedIds\.has\(item\.id\) && item\.id !== draggingId\) \|\| !!moveIds\?\.has\(item\.id\)\}/g)).toHaveLength(2)
  })

  it('移動中は選択バーの代わりに「○件を移動中」バー（キャンセルボタンつき）', () => {
    expect(src).toContain('{moving && moveIds && <MoveModeBar count={moveIds.size} onCancel={cancelMove} />}')
    expect(src).toContain('{!moving && selectedIds.size > 0 && (')
    expect(src).toContain('onClick={() => startMove(selectedIds)}')
  })
})

describe('移動先の決定（confirmMove）', () => {
  const b = body('async function confirmMove(', '// ── 安定した renderClone')

  it('planMove で並びを決め、移動と選択を終えてから保存する', () => {
    expect(b).toContain('planMove(items, moveIds, groups.map(g => g.id), dest)')
    expect(b.indexOf('finishMove()')).toBeLessThan(b.indexOf('persistReorder'))
    expect(b.indexOf('setSelectedIds(new Set())')).toBeLessThan(b.indexOf('persistReorder'))
  })

  it('今と同じ位置なら /reorder を呼ばない', () => {
    expect(b.indexOf('if (updates.length === 0) return')).toBeLessThan(b.indexOf('persistReorder'))
  })

  it('成功したら DB を読み直す。失敗したら通知して読み直す（スナップショットに戻さない）', () => {
    expect(b).toMatch(/try \{\s*await persistReorder\(\[\], updates\)\s*\} catch \{\s*recoverFromReorderFailure\(\)\s*return\s*\}\s*void reload\(\)/)
    expect(b).not.toContain('prevItems')
  })
})

describe('旧「移動先：工種を選択」を削除', () => {
  it('ドロップダウンと moveSelectedToGroup / planMoveToGroup がない', () => {
    expect(src).not.toContain('moveSelectedToGroup')
    expect(src).not.toContain('planMoveToGroup')
    expect(src).not.toContain('→ 移動先：')
    expect(src).not.toContain('── グループを選択 ──')
  })
})

describe('移動先の見た目・読み上げ', () => {
  it('aria-label は「工種」の 行名 の前へ / 末尾へ', () => {
    expect(moveTargetLabel('外装工事', 'システムキッチン')).toBe('「外装工事」の システムキッチン の前へ移動')
    expect(moveTargetLabel('外装工事', null)).toBe('「外装工事」の末尾へ移動')
    expect(moveTargetLabel('', '')).toBe('「（無題）」の （名称なし） の前へ移動')
  })

  it('MoveGap は button で、行の内側に absolute（高さを変えない）', () => {
    const gap = body('export function MoveGap(', '\n}\n', parts)
    expect(gap).toContain('<button type="button" className="est-move-gap-btn" aria-label={label}')
    expect(gap).toContain("position: 'absolute'")
    expect(gap).toContain('height: 0')
  })

  it('タッチ（hover: none）では「ここへ移動」を常に表示し、押せるのはラベルだけ', () => {
    const touch = css.slice(css.indexOf('.est-move-gap-line {'), css.indexOf('.est-move-target {'))
    expect(touch).toMatch(/@media \(hover: none\) \{[\s\S]*\.est-move-gap-btn \{ right: auto;[\s\S]*\.est-move-gap-label \{ left: 0; opacity: 0\.92; \}/)
  })
})
