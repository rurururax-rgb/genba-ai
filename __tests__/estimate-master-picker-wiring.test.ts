import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 見積エディタ（EstimateTab）への「資材マスターから追加」の組み込みが最小限であること。
 * - 「過去見積から追加」の隣のボタン・開閉状態・ダイアログの呼び出し・成功時の reload だけ
 * - 成功時は既存の reload（DB から読み直し）を渡す。行を先に足して見せる処理（setItems）を渡さない
 */
const src = readFileSync(path.join(__dirname, '..', 'components/projects/EstimateTab.tsx'), 'utf8')
const block = src.slice(src.indexOf('<MaterialMasterPicker'), src.indexOf('/>', src.indexOf('<MaterialMasterPicker')))

describe('EstimateTab: 資材マスターから追加の組み込み', () => {
  it('「過去見積から追加」の直後にボタンがあり、並び替え中は押せない', () => {
    const pastAt = src.indexOf('過去見積から追加\n')
    const masterAt = src.indexOf('資材マスターから追加\n')
    expect(pastAt).toBeGreaterThan(0)
    expect(masterAt).toBeGreaterThan(pastAt)
    const between = src.slice(pastAt, masterAt)
    expect(between).toContain('onClick={() => setShowMasterPicker(true)}')
    expect(between).toContain('disabled={moving}')
    // 2 つのボタンの間にほかのボタンを挟まない
    expect(between.match(/<button/g)).toHaveLength(1)
  })

  it('成功時・結果不明時の読み直しは既存の reload。案件が変われば作り直す', () => {
    expect(block).toContain('onReload={reload}')
    expect(block).toContain('key={projectId}')
    expect(block).toContain('projectId={projectId}')
    expect(block).toContain('defaultGroupId={activeGroupTab}')
    expect(block).not.toMatch(/setItems|setGroups/)
  })

  it('開閉状態は 1 つだけ', () => {
    expect(src.match(/const \[showMasterPicker, setShowMasterPicker\] = useState\(false\)/g)).toHaveLength(1)
  })
})
