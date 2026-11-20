import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 見積エディタ（EstimateTab）への「過去見積から追加」の組み込みが最小限であること。
 * - ボタン・開閉状態・ダイアログの呼び出し・成功時の reload だけ
 * - 成功時は既存の reload（DB から読み直し）を渡す。行を先に足して見せる処理（setItems）を渡さない
 */
const src = readFileSync(path.join(__dirname, '..', 'components/projects/EstimateTab.tsx'), 'utf8')
const block = src.slice(src.indexOf('<PastEstimatePicker'), src.indexOf('/>', src.indexOf('<PastEstimatePicker')))

describe('EstimateTab: 過去見積から追加の組み込み', () => {
  it('「見積書を取り込む」の隣にボタンがあり、並び替え中は押せない', () => {
    const importAt = src.indexOf("'見積書を取り込む'")
    const pastAt = src.indexOf('過去見積から追加\n')
    expect(importAt).toBeGreaterThan(0)
    expect(pastAt).toBeGreaterThan(importAt)
    expect(src.slice(importAt, pastAt)).toContain('onClick={() => setShowPastPicker(true)}')
    expect(src.slice(importAt, pastAt)).toContain('disabled={moving}')
  })

  it('成功時・結果不明時の読み直しは既存の reload。案件が変われば作り直す', () => {
    expect(block).toContain('onReload={reload}')
    expect(block).toContain('key={projectId}')
    expect(block).toContain('projectId={projectId}')
    expect(block).toContain('defaultGroupId={activeGroupTab}')
    expect(block).not.toMatch(/setItems|setGroups/)
  })

  it('開閉状態は 1 つだけ', () => {
    expect(src.match(/useState\(false\)/g)?.length).toBeGreaterThan(0)
    expect(src.match(/const \[showPastPicker, setShowPastPicker\] = useState\(false\)/g)).toHaveLength(1)
  })
})
