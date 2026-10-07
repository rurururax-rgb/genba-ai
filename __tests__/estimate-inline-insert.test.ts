import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const src = readFileSync(path.join(root, 'components/projects/EstimateTab.tsx'), 'utf8')
const css = readFileSync(path.join(root, 'app/globals.css'), 'utf8')

/** `<Draggable key={item.id} ...>` から対応する `</Draggable>` までのブロック（行の Draggable）をすべて返す */
function itemDraggableBlocks(): string[] {
  const blocks: string[] = []
  let from = 0
  for (;;) {
    const at = src.indexOf('<Draggable key={item.id}', from)
    if (at < 0) break
    const end = src.indexOf('</Draggable>', at)
    blocks.push(src.slice(at, end))
    from = end
  }
  return blocks
}

describe('見積エディタ：ツールバーのドラッグ作成を削除', () => {
  it('startDragCreate / findTarget / visibleTableBox / dragCreate state がない', () => {
    for (const s of ['startDragCreate', 'findTarget', 'visibleTableBox', 'dragCreate', 'setDragCreate', 'tableScrollRef', 'stickyToolbarRef']) {
      expect(src, s).not.toContain(s)
    }
  })

  it('ツールバー用の window mouseup リスナー・body の cursor/userSelect 変更がない', () => {
    expect(src).not.toMatch(/addEventListener\('mouseup'/)
    expect(src).not.toContain('document.body.style.cursor')
    expect(src).not.toContain('document.body.style.userSelect')
    // ツールバーの 3 ボタン（onMouseDown でドラッグ開始）がない
    expect(src).not.toMatch(/onMouseDown=\{e => startDragCreate/)
    expect(src).not.toContain('est-tb-btn-header')
    expect(src).not.toContain('est-tb-btn-note')
    expect(css).not.toContain('est-tb-btn-header')
    expect(css).not.toContain('est-tb-btn-note')
  })

  it('緑の挿入ライン（estimate-insertion-line）と insertion-line モジュールがない', () => {
    expect(src).not.toContain('estimate-insertion-line')
    expect(src).not.toContain('clipInsertionLine')
    expect(src).not.toContain('@/lib/estimate/insertion-line')
    expect(existsSync(path.join(root, 'lib/estimate/insertion-line.ts'))).toBe(false)
  })

  it('上部に汎用の「行を追加」ボタンを新設していない（行追加は行間 ＋ と空グループのみ）', () => {
    expect(src).not.toMatch(/>\s*行を追加\s*<\/button>/)
    expect(src).not.toContain('handleAddRow(')
  })
})

describe('見積エディタ：行間 ＋（InsertGap）', () => {
  it('InsertGap は各行の Draggable の内側にある（Droppable 直下の兄弟にしない）', () => {
    const blocks = itemDraggableBlocks()
    expect(blocks.length).toBe(2) // 工種グループ内 + 未分類「その他」
    for (const b of blocks) {
      expect(b).toContain('<InsertGap edge="top"')
      expect(b).toContain('<InsertGap edge="bottom"')
    }
    // Draggable の外（Droppable 直下）には置かない
    const outside = src.split('<Draggable key={item.id}').map((part, i) => i === 0 ? part : part.slice(part.indexOf('</Draggable>')))
    expect(outside.join('')).not.toContain('<InsertGap ')
  })

  it('挿入位置は groupId と index で渡す（上端 = idx、末尾 = 件数）。最終行だけ下端 ＋ を持つので重複しない', () => {
    expect(src).toContain('onPick={t => handleAddRowAt(group.id, idx, t)}')
    expect(src).toContain('onPick={t => handleAddRowAt(group.id, gItems.length, t)}')
    expect(src).toContain('idx === gItems.length - 1 && (')
    expect(src).toContain('onPick={t => handleAddRowAt(null, idx, t)}')
    expect(src).toContain('onPick={t => handleAddRowAt(null, ungroupedItems.length, t)}')
    expect(src).toContain('idx === ungroupedItems.length - 1 && (')
  })

  it('行の高さを変えない：absolute・高さ 0 で重ねる', () => {
    const at = src.indexOf('function InsertGap(')
    const body = src.slice(at, src.indexOf('// ── EmptyGroupAdd', at))
    expect(body).toMatch(/position: 'absolute', left: 0, right: 0, top: edge === 'top' \? 0 : '100%', height: 0/)
  })

  it('ドラッグ並び替え中は ＋ を隠す', () => {
    expect(src).toContain('setDndDragging(true)')
    expect(src).toContain('setDndDragging(false)')
    expect(src.match(/!dndDragging && !is\.isDragging && /g)?.length).toBe(4)
  })

  it('行種別メニューは 明細行 / 中見出し / メモ行', () => {
    expect(src).toContain("{ type: 'item',   label: '明細行'")
    expect(src).toContain("{ type: 'header', label: '中見出し'")
    expect(src).toContain("{ type: 'note',   label: 'メモ行'")
  })

  it('空グループは同じメニューで先頭（index 0）に追加', () => {
    expect(src).toContain('<EmptyGroupAdd disabled={addingRow} onPick={t => handleAddRowAt(group.id, 0, t)} />')
  })

  it('タッチ端末（hover: none）では ＋ を常に薄く表示し、押せる大きさにする', () => {
    expect(css).toMatch(/@media \(hover: none\) \{\s*\.est-row-wrap \.est-insert-gap-btn \{ opacity: 0\.45; width: 28px/)
  })

  it('振り直しは既存の /reorder を先に保存し、失敗したら行を追加しない', () => {
    const at = src.indexOf('async function handleAddRowAt(')
    const body = src.slice(at, src.indexOf('async function persistReorder(', at))
    expect(body).toContain('planInsert(scope, insertIndex)')
    const reorderAt = body.indexOf('await persistReorder(')
    const manualAt  = body.indexOf("'/api/estimate-items/manual'")
    expect(reorderAt).toBeGreaterThan(0)
    expect(manualAt).toBeGreaterThan(reorderAt)
    expect(body.slice(reorderAt, manualAt)).toMatch(/catch[\s\S]*alert\([\s\S]*行は追加されていません[\s\S]*return/)
    // 追加失敗も成功に見せない（writeRequest パターン）
    expect(body).toContain('writeRequest<EstimateItem>(')
    expect(body.slice(manualAt)).toContain('行は追加されていません')
  })
})

describe('見積エディタ：並び替え（@hello-pangea/dnd）は残す', () => {
  it('行・グループ・複数選択の並び替えコードが残っている', () => {
    for (const s of [
      'async function persistReorder(', "'/api/estimate-items/reorder'", 'stableRenderClone',
      'draggingIdRef', 'selectedIdsRef', 'dndMouseYRef', 'function handleDragEnd(',
      'droppableId="group-list" type="GROUP"', 'data-row-id={item.id}', 'application/genba-import-item',
    ]) {
      expect(src, s).toContain(s)
    }
  })
})

describe('見積エディタ：工種タブ切替で行選択をクリア', () => {
  it('activeGroupTab が変わったら selectedIds を空にする（別タブで見えない行を一括削除しない）', () => {
    const m = src.match(/useEffect\(\(\) => \{([\s\S]*?)\}, \[activeGroupTab\]\)/)
    expect(m).not.toBeNull()
    expect(m![1]).toContain('setSelectedIds(new Set())')
  })

  it('工種追加後はそのタブへ移動し、上部の合計は案件全体の合計と明示する', () => {
    const at = src.indexOf('async function handleCreateGroup(')
    expect(src.slice(at, at + 1200)).toContain('setActiveGroupTab(group.id)')
    expect(src).toContain('label="案件合計（税込）"')
  })
})
