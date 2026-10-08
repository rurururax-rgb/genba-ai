import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const src = readFileSync(path.join(root, 'components/projects/EstimateTab.tsx'), 'utf8')
const fixture = readFileSync(path.join(root, 'components/qa/EstimateFixture.tsx'), 'utf8')

function body(start: string, end: string) {
  const at = src.indexOf(start)
  expect(at, start).toBeGreaterThan(0)
  return src.slice(at, src.indexOf(end, at))
}

describe('行ドラッグの自動スクロール', () => {
  it('縦スクロールするのは #dashboard-main（#estimate-table-scroll は内容の高さまで伸びて動かない）', () => {
    const b = body('const startDndAutoScroll = useCallback(', 'const stopDndAutoScroll')
    expect(b).toContain("document.getElementById('dashboard-main')")
    expect(b).not.toContain("document.getElementById('estimate-table-scroll')")
  })

  it('ドラッグ中だけ表の横スクロール枠を overflow: hidden にし、dnd のスクロールコンテナを #dashboard-main 1 つにする', () => {
    const b = body('function setTableScrollForDrag(', '\n  }\n')
    expect(b).toContain("document.getElementById('estimate-table-scroll')")
    expect(b).toContain("dragging ? 'hidden' : 'auto'")
    // 寸法取得前（onBeforeCapture）に切り替え、終了（ドロップ・キャンセル共通の onDragEnd）で戻す
    expect(src).toContain('onBeforeCapture={() => setTableScrollForDrag(true)}')
    expect(src).toMatch(/onDragEnd=\{result => \{[^}]*setTableScrollForDrag\(false\)/)
    // 通常時は従来どおり横スクロールできる
    expect(src).toContain(`<div id="estimate-table-scroll" style={{ overflow: 'auto', flex: 1 }}>`)
  })

  it('dnd 標準の自動スクロールは使わない（独自の rAF のまま）', () => {
    expect(src).toContain('autoScrollerOptions={{ disabled: true }}')
  })

  it('QA Fixture も本番と同じく #dashboard-main が縦スクロールし、EstimateTab は高さ auto の親に置く', () => {
    expect(fixture).toContain('<main id="dashboard-main"')
    expect(fixture).toContain("overflowY: 'auto'")
    expect(fixture).toMatch(/<div>\s*<EstimateTab projectId=\{FIXTURE_PROJECT_ID\} \/>\s*<\/div>/)
  })
})

describe('選択行の移動（並び順）', () => {
  it('複数選択ドラッグも表示順（工種順 → sort_order）で並べる', () => {
    expect(src).toContain('sortByDisplayOrder(items.filter(i => selectedIds.has(i.id)), groups.map(g => g.id))')
  })
})

describe('並び替え保存の失敗', () => {
  it('recoverFromReorderFailure は通知してから reload する', () => {
    const b = body('function recoverFromReorderFailure()', '\n  }\n')
    expect(b).toMatch(/alert\([\s\S]*読み込み直します[\s\S]*void reload\(\)/)
  })

  it('ドラッグの失敗も同じく DB を読み直す（/reorder は途中まで保存されうるのでロールバックしない）', () => {
    const b = body('function handleDragEnd(', '// 行間の ＋ から行を追加する')
    expect(b.match(/\.catch\(recoverFromReorderFailure\)/g)?.length).toBe(3)
    expect(b).not.toContain('setItems(prevItems)')
    expect(b).not.toContain('setGroups(prevGrps)')
  })
})
