'use client'

import { useRef, useState, useCallback } from 'react'
import type { ExtractedItem } from '@/app/api/catalog/import-ai/route'

// ─────────────────────────────────────────────────────────
// デザイントークン
// ─────────────────────────────────────────────────────────

const C = {
  navy:      '#1E3A5F',
  navyLight: '#EFF6FF',
  accent:    '#1D4ED8',
  border:    '#D8E0EE',
  muted:     '#8A96A8',
  bg:        '#F7F9FC',
  white:     '#FFFFFF',
  danger:    '#B91C1C',
  dangerBg:  '#FEF2F2',
  success:   '#166534',
  successBg: '#DCFCE7',
  aiAccent:  '#EFF6FF',
}
const FONT = "'Inter','Hiragino Kaku Gothic ProN','Meiryo UI',Meiryo,sans-serif"

const CATEGORIES = [
  '内装工事','大工工事','電気工事','水道工事','設備工事',
  '外壁工事','屋根工事','左官工事','塗装工事','建具工事',
  '基礎工事','解体工事','諸経費','その他',
]

// ─────────────────────────────────────────────────────────
// 型
// ─────────────────────────────────────────────────────────

type PreviewItem = ExtractedItem & {
  _selected: boolean
  _key: string // ローカル識別子
}

type Phase = 'idle' | 'uploading' | 'preview' | 'saving' | 'done'

type Props = {
  onClose: () => void
  onImportDone: () => void // カタログ再読み込みを親に通知
}

// ─────────────────────────────────────────────────────────
// ユーティリティ
// ─────────────────────────────────────────────────────────

const fmt = (v: number | null) =>
  v != null ? `¥${v.toLocaleString('ja-JP')}` : ''

function parsePrice(s: string): number | null {
  const n = Number(s.replace(/[¥,\s]/g, ''))
  return isNaN(n) || s.trim() === '' ? null : n
}

// ─────────────────────────────────────────────────────────
// メインコンポーネント
// ─────────────────────────────────────────────────────────

export function CatalogImportModal({ onClose, onImportDone }: Props) {
  const [phase,        setPhase]       = useState<Phase>('idle')
  const [error,        setError]       = useState<string | null>(null)
  const [items,        setItems]       = useState<PreviewItem[]>([])
  const [doneResult,   setDoneResult]  = useState<{ inserted: number; updated: number } | null>(null)
  const [dragOver,     setDragOver]    = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // ── ファイル処理 ─────────────────────────────────────

  const handleFile = useCallback(async (file: File) => {
    const name = file.name.toLowerCase()
    if (!name.endsWith('.xlsx') && !name.endsWith('.xls') && !name.endsWith('.pdf')) {
      setError('.xlsx / .xls / .pdf ファイルのみ対応しています')
      return
    }
    if (file.size > 20 * 1024 * 1024) {
      setError('ファイルサイズは20MB以下にしてください')
      return
    }

    setError(null)
    setPhase('uploading')

    const fd = new FormData()
    fd.append('file', file)

    try {
      const res = await fetch('/api/catalog/import-ai', { method: 'POST', body: fd })
      const json = await res.json() as { items?: ExtractedItem[]; error?: string }

      if (!res.ok || json.error) {
        setError(json.error ?? '抽出に失敗しました')
        setPhase('idle')
        return
      }

      const preview: PreviewItem[] = (json.items ?? []).map((it, i) => ({
        ...it,
        _selected: true,
        _key: `${i}-${it.name}`,
      }))
      setItems(preview)
      setPhase('preview')
    } catch (e) {
      setError(e instanceof Error ? e.message : '通信エラーが発生しました')
      setPhase('idle')
    }
  }, [])

  const onFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) handleFile(file)
    e.target.value = ''
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }

  // ── プレビュー編集 ───────────────────────────────────

  const toggle = (key: string) => {
    setItems(prev => prev.map(it => it._key === key ? { ...it, _selected: !it._selected } : it))
  }

  const toggleAll = () => {
    const allSelected = items.every(it => it._selected)
    setItems(prev => prev.map(it => ({ ...it, _selected: !allSelected })))
  }

  const updateField = (key: string, field: keyof ExtractedItem, value: string | number | null) => {
    setItems(prev => prev.map(it => it._key === key ? { ...it, [field]: value } : it))
  }

  // ── カタログ登録 ─────────────────────────────────────

  const handleSave = async () => {
    const selected = items.filter(it => it._selected)
    if (selected.length === 0) {
      setError('1件以上選択してください')
      return
    }

    setError(null)
    setPhase('saving')

    try {
      const res = await fetch('/api/catalog/bulk-upsert', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          items: selected.map(({ _selected: _, _key: __, ...rest }) => rest),
        }),
      })
      const json = await res.json() as { inserted?: number; updated?: number; error?: string }

      if (!res.ok || json.error) {
        setError(json.error ?? '登録に失敗しました')
        setPhase('preview')
        return
      }

      setDoneResult({ inserted: json.inserted ?? 0, updated: json.updated ?? 0 })
      setPhase('done')
      onImportDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : '通信エラーが発生しました')
      setPhase('preview')
    }
  }

  // ── レンダリング ─────────────────────────────────────

  const selectedCount = items.filter(it => it._selected).length

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(15,23,42,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16,
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        background: C.white,
        borderRadius: 14,
        boxShadow: '0 20px 60px rgba(0,0,0,0.18)',
        width: '100%',
        maxWidth: phase === 'preview' ? 900 : 560,
        maxHeight: '92vh',
        display: 'flex', flexDirection: 'column',
        fontFamily: FONT,
        overflow: 'hidden',
      }}>

        {/* ── ヘッダー ── */}
        <div style={{
          padding: '18px 24px',
          borderBottom: `1px solid ${C.border}`,
          display: 'flex', alignItems: 'center', gap: 12,
          flexShrink: 0,
        }}>
          <div style={{
            width: 32, height: 32, borderRadius: 8,
            background: C.navyLight,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
          }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={C.accent} strokeWidth="2" strokeLinecap="round">
              <path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2V9M9 21H5a2 2 0 0 1-2-2V9m0 0h18"/>
            </svg>
          </div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: C.navy }}>
              過去見積書をAI取込
            </div>
            <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
              Excel / PDF から品目を自動抽出してカタログに登録します
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              marginLeft: 'auto', background: 'none', border: 'none',
              cursor: 'pointer', padding: 4, color: C.muted,
              display: 'flex', alignItems: 'center',
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12"/>
            </svg>
          </button>
        </div>

        {/* ── コンテンツ ── */}
        <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>

          {/* ─ アップロードエリア ─ */}
          {(phase === 'idle' || phase === 'uploading') && (
            <div style={{ padding: 32 }}>
              <div
                onDragOver={e => { e.preventDefault(); setDragOver(true) }}
                onDragLeave={() => setDragOver(false)}
                onDrop={onDrop}
                onClick={() => fileInputRef.current?.click()}
                style={{
                  border: `2px dashed ${dragOver ? C.accent : C.border}`,
                  borderRadius: 12,
                  background: dragOver ? C.navyLight : C.bg,
                  padding: '48px 24px',
                  textAlign: 'center',
                  cursor: phase === 'uploading' ? 'wait' : 'pointer',
                  transition: 'all 0.15s',
                }}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".xlsx,.xls,.pdf"
                  onChange={onFileInput}
                  style={{ display: 'none' }}
                />
                {phase === 'uploading' ? (
                  <>
                    <div style={{ fontSize: 32, marginBottom: 16 }}>⏳</div>
                    <div style={{ fontSize: 15, fontWeight: 600, color: C.navy, marginBottom: 8 }}>
                      AIが品目を抽出中...
                    </div>
                    <div style={{ fontSize: 13, color: C.muted }}>
                      ファイルの内容によって10〜30秒かかります
                    </div>
                  </>
                ) : (
                  <>
                    <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'center' }}>
                      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke={C.muted} strokeWidth="1.5" strokeLinecap="round">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                        <polyline points="17 8 12 3 7 8"/>
                        <line x1="12" y1="3" x2="12" y2="15"/>
                      </svg>
                    </div>
                    <div style={{ fontSize: 15, fontWeight: 600, color: C.navy, marginBottom: 8 }}>
                      ファイルをここにドロップ
                    </div>
                    <div style={{ fontSize: 13, color: C.muted, marginBottom: 20 }}>
                      または クリックして選択
                    </div>
                    <div style={{ fontSize: 12, color: C.muted }}>
                      対応形式: Excel (.xlsx / .xls) · PDF　最大 20MB
                    </div>
                  </>
                )}
              </div>

              {error && (
                <div style={{
                  marginTop: 12, padding: '10px 14px',
                  background: C.dangerBg, border: `1px solid #FCA5A5`,
                  borderRadius: 8, fontSize: 13, color: C.danger,
                }}>
                  {error}
                </div>
              )}

              <div style={{
                marginTop: 20, padding: '12px 16px',
                background: C.aiAccent, borderRadius: 8,
                fontSize: 12, color: '#1D4ED8',
                lineHeight: 1.7,
              }}>
                <strong>AIによる整理結果です。</strong>最終確認はプレビュー画面で行ってください。<br/>
                金額・品名は必ず確認してから登録してください。
              </div>
            </div>
          )}

          {/* ─ プレビューテーブル ─ */}
          {phase === 'preview' && (
            <div>
              {/* ヘッダーバー */}
              <div style={{
                padding: '12px 20px',
                background: C.aiAccent,
                borderBottom: `1px solid #BFDBFE`,
                display: 'flex', alignItems: 'center', gap: 12,
                flexWrap: 'wrap',
              }}>
                <div style={{ fontSize: 13, color: '#1D4ED8', fontWeight: 600 }}>
                  {items.length}件 抽出 — {selectedCount}件 選択中
                </div>
                <div style={{ fontSize: 12, color: '#3B82F6' }}>
                  チェックを外した行は登録されません。品名・単価は編集できます。
                </div>
                {error && (
                  <div style={{ fontSize: 12, color: C.danger, marginLeft: 'auto' }}>{error}</div>
                )}
              </div>

              {/* テーブル */}
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: '#F8FAFC', borderBottom: `2px solid ${C.border}` }}>
                      <th style={{ width: 40, padding: '8px 12px', textAlign: 'center' }}>
                        <input
                          type="checkbox"
                          checked={items.length > 0 && items.every(it => it._selected)}
                          onChange={toggleAll}
                          style={{ cursor: 'pointer', width: 15, height: 15 }}
                        />
                      </th>
                      <th style={thStyle}>品名</th>
                      <th style={{ ...thStyle, width: 70 }}>単位</th>
                      <th style={{ ...thStyle, width: 110 }}>売価（単価）</th>
                      <th style={{ ...thStyle, width: 110 }}>原価</th>
                      <th style={{ ...thStyle, width: 120 }}>カテゴリ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item, idx) => (
                      <tr
                        key={item._key}
                        style={{
                          background: item._selected
                            ? (idx % 2 === 0 ? C.white : '#FAFBFD')
                            : '#F1F5F9',
                          borderBottom: `1px solid ${C.border}`,
                          opacity: item._selected ? 1 : 0.45,
                          transition: 'opacity 0.1s',
                        }}
                      >
                        <td style={{ padding: '6px 12px', textAlign: 'center' }}>
                          <input
                            type="checkbox"
                            checked={item._selected}
                            onChange={() => toggle(item._key)}
                            style={{ cursor: 'pointer', width: 15, height: 15 }}
                          />
                        </td>
                        <td style={{ padding: '4px 8px' }}>
                          <input
                            value={item.name}
                            onChange={e => updateField(item._key, 'name', e.target.value)}
                            style={cellInput}
                          />
                        </td>
                        <td style={{ padding: '4px 8px' }}>
                          <input
                            value={item.unit}
                            onChange={e => updateField(item._key, 'unit', e.target.value)}
                            style={{ ...cellInput, textAlign: 'center' }}
                          />
                        </td>
                        <td style={{ padding: '4px 8px' }}>
                          <input
                            value={item.selling_price != null ? String(item.selling_price) : ''}
                            placeholder="—"
                            onChange={e => updateField(item._key, 'selling_price', parsePrice(e.target.value))}
                            style={{ ...cellInput, textAlign: 'right' }}
                          />
                        </td>
                        <td style={{ padding: '4px 8px' }}>
                          <input
                            value={item.cost_price != null ? String(item.cost_price) : ''}
                            placeholder="—"
                            onChange={e => updateField(item._key, 'cost_price', parsePrice(e.target.value))}
                            style={{ ...cellInput, textAlign: 'right' }}
                          />
                        </td>
                        <td style={{ padding: '4px 8px' }}>
                          <select
                            value={item.category}
                            onChange={e => updateField(item._key, 'category', e.target.value)}
                            style={{
                              ...cellInput,
                              background: 'none',
                              cursor: 'pointer',
                              paddingRight: 4,
                            }}
                          >
                            {CATEGORIES.map(c => (
                              <option key={c} value={c}>{c}</option>
                            ))}
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ─ 完了画面 ─ */}
          {phase === 'done' && doneResult && (
            <div style={{ padding: 40, textAlign: 'center' }}>
              <div style={{
                width: 56, height: 56, borderRadius: '50%',
                background: C.successBg,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                margin: '0 auto 20px',
              }}>
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={C.success} strokeWidth="2.5" strokeLinecap="round">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              </div>
              <div style={{ fontSize: 17, fontWeight: 700, color: C.navy, marginBottom: 8 }}>
                カタログへの登録が完了しました
              </div>
              <div style={{ fontSize: 14, color: C.muted, lineHeight: 1.8 }}>
                新規登録: <strong style={{ color: C.navy }}>{doneResult.inserted}件</strong>
                　更新: <strong style={{ color: C.navy }}>{doneResult.updated}件</strong>
              </div>
            </div>
          )}
        </div>

        {/* ── フッター ── */}
        <div style={{
          padding: '14px 24px',
          borderTop: `1px solid ${C.border}`,
          display: 'flex', gap: 10, justifyContent: 'flex-end',
          flexShrink: 0,
          background: C.white,
        }}>
          {phase === 'done' ? (
            <button onClick={onClose} style={btnPrimary}>閉じる</button>
          ) : phase === 'preview' ? (
            <>
              <button
                onClick={() => { setPhase('idle'); setItems([]) }}
                style={btnSecondary}
                disabled={false}
              >
                別のファイルを選択
              </button>
              <button
                onClick={handleSave}
                style={{ ...btnPrimary, opacity: selectedCount === 0 ? 0.5 : 1 }}
                disabled={selectedCount === 0}
              >
                {selectedCount}件をカタログに登録
              </button>
            </>
          ) : (
            <button onClick={onClose} style={btnSecondary}>キャンセル</button>
          )}
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────
// スタイル定数
// ─────────────────────────────────────────────────────────

const thStyle: React.CSSProperties = {
  padding: '8px 8px',
  textAlign: 'left',
  fontSize: 11,
  fontWeight: 700,
  color: '#8A96A8',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  whiteSpace: 'nowrap',
}

const cellInput: React.CSSProperties = {
  width: '100%',
  border: '1px solid transparent',
  borderRadius: 4,
  padding: '4px 6px',
  fontSize: 13,
  fontFamily: "'Inter','Hiragino Kaku Gothic ProN','Meiryo UI',Meiryo,sans-serif",
  background: 'transparent',
  outline: 'none',
  color: '#1E3A5F',
  boxSizing: 'border-box',
}

const btnPrimary: React.CSSProperties = {
  padding: '0 20px',
  height: 40,
  background: '#1E3A5F',
  color: '#fff',
  border: 'none',
  borderRadius: 8,
  fontSize: 14,
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: "'Inter','Hiragino Kaku Gothic ProN','Meiryo UI',Meiryo,sans-serif",
  whiteSpace: 'nowrap',
}

const btnSecondary: React.CSSProperties = {
  padding: '0 16px',
  height: 40,
  background: 'none',
  color: '#1E3A5F',
  border: '1px solid #D8E0EE',
  borderRadius: 8,
  fontSize: 14,
  fontWeight: 500,
  cursor: 'pointer',
  fontFamily: "'Inter','Hiragino Kaku Gothic ProN','Meiryo UI',Meiryo,sans-serif",
  whiteSpace: 'nowrap',
}
