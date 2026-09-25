'use client'

import { useEffect, useRef, useState } from 'react'

// ── 型定義 ────────────────────────────────────────────────

type ExtractedItem = {
  name: string
  quantity: number | null
  unit: string | null
  cost_price: number | null
  vendor_name: string | null
  note: string | null
}

type FileResult = {
  fileName: string
  supplier: string
  document_type: string
  items: ExtractedItem[]
  subtotal: number | null
  raw_warning: string | null
}

type CandidateRow = {
  id: string
  name: string
  quantity: number
  unit: string
  cost_price: number | null
  vendor_name: string
  memo: string
}

function uid() { return Math.random().toString(36).slice(2) }
function fmt(v: number) { return v.toLocaleString('ja-JP') }

// ── デザイントークン ──────────────────────────────────────

const G = {
  dark:        '#2B5E40',
  med:         '#3D7A55',
  light:       '#E3EFE7',
  hover:       '#EDF5EF',
  cardBg:      '#FFFFFF',
  border:      '#BDD1C3',
  borderLight: '#DFF0E4',
  textPri:     '#192C1F',
  textSec:     '#4E6557',
  textTer:     '#8AA491',
} as const

type Props = { projectId: string }

export function EstimateImportTab({ projectId }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  const MAX_FILES = 10

  const [files,        setFiles]       = useState<File[]>([])
  const [previews,     setPreviews]    = useState<string[]>([])
  const [loading,      setLoading]     = useState(false)
  const [rows,         setRows]        = useState<CandidateRow[]>([])
  const [removingIds,  setRemovingIds] = useState<Set<string>>(new Set())
  const [addingIds,    setAddingIds]   = useState<Set<string>>(new Set())
  const [error,        setError]       = useState<string | null>(null)
  const [overLimitMsg, setOverLimit]   = useState<string | null>(null)
  const [dragging,     setDragging]    = useState(false)
  const [addedCount,   setAddedCount]  = useState(0)

  function fadeRemove(id: string) {
    setRemovingIds(prev => new Set([...prev, id]))
    setTimeout(() => {
      setRows(prev => prev.filter(r => r.id !== id))
      setRemovingIds(prev => { const n = new Set(prev); n.delete(id); return n })
      setAddedCount(c => c + 1)
    }, 280)
  }

  // ドラッグ成功通知を受けて該当カードを消す
  useEffect(() => {
    const handler = (e: Event) => {
      const { importId } = (e as CustomEvent<{ importId: string }>).detail
      fadeRemove(importId)
    }
    window.addEventListener('genba:import-item-moved', handler)
    return () => window.removeEventListener('genba:import-item-moved', handler)
  }, [])

  function addFiles(newFiles: FileList | File[]) {
    const arr = Array.from(newFiles).filter(f =>
      (f.type === 'image/jpeg' || f.type === 'image/png') && f.size <= 8 * 1024 * 1024
    )
    if (!arr.length) return
    const combined = [...files, ...arr]
    setRows([]); setError(null); setAddedCount(0)
    if (combined.length > MAX_FILES) {
      const over = combined.length - MAX_FILES
      setOverLimit(`最大${MAX_FILES}枚までです。${over}枚を超えた分は選択されませんでした。`)
      const trimmed = combined.slice(0, MAX_FILES)
      setFiles(trimmed)
      setPreviews(trimmed.map(f => URL.createObjectURL(f)))
    } else {
      setOverLimit(null)
      setFiles(combined)
      setPreviews(combined.map(f => URL.createObjectURL(f)))
    }
  }

  function removeFile(i: number) {
    setFiles(files.filter((_, idx) => idx !== i))
    setPreviews(previews.filter((_, idx) => idx !== i))
    setRows([]); setOverLimit(null)
  }

  function reset() {
    setFiles([]); setPreviews([]); setRows([])
    setError(null); setOverLimit(null); setAddedCount(0)
  }

  async function extract() {
    if (!files.length) return
    const ac = new AbortController()
    abortRef.current = ac
    setLoading(true); setError(null)
    try {
      const fd = new FormData()
      files.forEach(f => fd.append('files', f))
      const res = await fetch('/api/ai/extract-estimate', { method: 'POST', body: fd, signal: ac.signal })
      if (!res.ok) { const d = await res.json(); throw new Error(d.error) }
      const data: { files: FileResult[]; items: ExtractedItem[] } = await res.json()
      setRows(data.items.map(item => ({
        id: uid(),
        name: item.name,
        quantity: item.quantity ?? 1,
        unit: item.unit ?? '式',
        cost_price: item.cost_price,
        vendor_name: item.vendor_name ?? '',
        memo: item.note ?? '',
      })))
      setAddedCount(0)
    } catch (e) {
      if ((e as Error).name !== 'AbortError')
        setError(e instanceof Error ? e.message : '読み取りに失敗しました')
    } finally {
      setLoading(false); abortRef.current = null
    }
  }

  function cancelExtract() { abortRef.current?.abort(); setLoading(false) }

  // 1件だけ追加（カードの「→ 追加」ボタン用）
  async function quickAdd(row: CandidateRow) {
    setAddingIds(prev => new Set([...prev, row.id]))
    try {
      const res = await fetch('/api/estimate-items/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: projectId,
          items: [{ name: row.name, quantity: row.quantity, unit: row.unit, cost_price: row.cost_price, vendor_name: row.vendor_name || null, memo: row.memo || null }],
        }),
      })
      if (res.ok) {
        window.dispatchEvent(new CustomEvent('genba:data-changed', { detail: { target_table: 'estimate_items' } }))
        fadeRemove(row.id)
      } else {
        const d = await res.json()
        setError(d.error ?? '追加に失敗しました')
      }
    } finally {
      setAddingIds(prev => { const n = new Set(prev); n.delete(row.id); return n })
    }
  }

  // 残り全件追加
  async function addAll() {
    if (!rows.length) return
    const ids = rows.map(r => r.id)
    ids.forEach(id => setAddingIds(prev => new Set([...prev, id])))
    try {
      const res = await fetch('/api/estimate-items/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: projectId,
          items: rows.map(r => ({ name: r.name, quantity: r.quantity, unit: r.unit, cost_price: r.cost_price, vendor_name: r.vendor_name || null, memo: r.memo || null })),
        }),
      })
      if (res.ok) {
        window.dispatchEvent(new CustomEvent('genba:data-changed', { detail: { target_table: 'estimate_items' } }))
        ids.forEach(id => fadeRemove(id))
      } else {
        const d = await res.json()
        setError(d.error ?? '追加に失敗しました')
      }
    } finally {
      ids.forEach(id => setAddingIds(prev => { const n = new Set(prev); n.delete(id); return n }))
    }
  }

  // removingIds.size > 0 を含めることで、最後の1件が消えるアニメーション中に
  // アップロード画面に戻ってしまうフラッシュを防ぐ
  const showResults = rows.length > 0 || addedCount > 0 || removingIds.size > 0

  return (
    <div style={s.root}>
      <style>{`
        @keyframes ei-spin { to { transform: rotate(360deg); } }
        .ei-spin { animation: ei-spin 1s linear infinite; }
        @keyframes ei-progress {
          0%   { transform: translateX(-100%); }
          50%  { transform: translateX(0%); }
          100% { transform: translateX(100%); }
        }
        .ei-progress { animation: ei-progress 1.4s ease-in-out infinite; }
        @keyframes ei-fadeout {
          from { opacity: 1; transform: translateX(0); max-height: 80px; margin-bottom: 8px; }
          to   { opacity: 0; transform: translateX(32px); max-height: 0;  margin-bottom: 0; }
        }
        .ei-removing {
          animation: ei-fadeout 0.28s ease-out forwards;
          overflow: hidden;
          pointer-events: none;
        }
        @keyframes ei-fadein {
          from { opacity: 0; transform: translateY(-6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .ei-card { animation: ei-fadein 0.18s ease-out; }
      `}</style>

      {/* ── タイトル ── */}
      <div style={s.titleWrap}>
        <div style={s.titleIcon}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
            stroke={G.dark} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
            <line x1="16" y1="13" x2="8" y2="13"/>
            <line x1="16" y1="17" x2="8" y2="17"/>
          </svg>
        </div>
        <div>
          <h2 style={s.title}>見積書の取り込み（画像AI解析）</h2>
          <p style={s.subtitle}>取引先から受領した見積書の画像をアップロードすると、資材データを自動で読み取ります。</p>
        </div>
      </div>

      {/* ── アップロードエリア ── */}
      {!showResults && (
        <>
          <div
            style={{ ...s.dropZone, ...(dragging ? s.dropActive : {}) }}
            onDragOver={e => { e.preventDefault(); setDragging(true) }}
            onDragLeave={() => setDragging(false)}
            onDrop={e => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files) }}
          >
            <input ref={inputRef} type="file" multiple accept="image/jpeg,image/png"
              style={{ display: 'none' }}
              onChange={e => e.target.files && addFiles(e.target.files)}
            />
            <div style={s.dropIconCircle}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none"
                stroke={G.med} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 16V8m0 0l-3 3m3-3l3 3"/>
                <path d="M20.39 18.39A5 5 0 0018 9h-1.26A8 8 0 103 16.3"/>
              </svg>
            </div>
            <p style={s.dropTitle}>ドラッグ＆ドロップ、またはクリックして選択</p>
            <p style={s.dropSub}>JPEG・PNG • 最大{MAX_FILES}枚 • 1枚8MBまで</p>
            <button style={s.browseBtn} onClick={e => { e.stopPropagation(); inputRef.current?.click() }}>
              ファイルを選択
            </button>
          </div>

          {files.length > 0 && (
            <div style={s.fileCardList}>
              {files.map((file, i) => (
                <div key={i} style={s.fileCard}>
                  <div style={s.fileThumbWrap}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={previews[i]} alt="" style={s.fileThumb} />
                  </div>
                  <div style={s.fileCardInfo}>
                    <span style={s.fileCardName}>{file.name}</span>
                    <div style={s.fileCardMeta}>
                      <span style={s.fileCardSize}>{(file.size / 1024).toFixed(0)} KB</span>
                      {loading ? (
                        <>
                          <span style={s.fileCardDot}>•</span>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                            stroke={G.med} strokeWidth="2.5" strokeLinecap="round" className="ei-spin">
                            <path d="M21 12a9 9 0 11-6.219-8.56"/>
                          </svg>
                          <span style={s.fileCardStatus}>解析中</span>
                        </>
                      ) : (
                        <>
                          <span style={s.fileCardDot}>•</span>
                          <span style={{ ...s.fileCardStatus, color: G.med }}>選択済み</span>
                        </>
                      )}
                    </div>
                    {loading && (
                      <div style={s.progressTrack}>
                        <div style={s.progressFill} className="ei-progress" />
                      </div>
                    )}
                  </div>
                  {!loading && (
                    <button style={s.fileCardRemove} onClick={() => removeFile(i)} aria-label="削除">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                        stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <circle cx="12" cy="12" r="10"/>
                        <line x1="15" y1="9" x2="9" y2="15"/>
                        <line x1="9" y1="9" x2="15" y2="15"/>
                      </svg>
                    </button>
                  )}
                </div>
              ))}
              {files.length < MAX_FILES && !loading && (
                <button style={s.addMoreCard} onClick={() => inputRef.current?.click()}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                    stroke={G.textTer} strokeWidth="2" strokeLinecap="round">
                    <line x1="12" y1="5" x2="12" y2="19"/>
                    <line x1="5" y1="12" x2="19" y2="12"/>
                  </svg>
                  <span>ファイルを追加</span>
                </button>
              )}
            </div>
          )}

          <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
            {loading ? (
              <button style={{ ...s.actionBtn, ...s.btnOutline }} onClick={cancelExtract}>
                解析処理をキャンセル
              </button>
            ) : (
              <button
                style={{ ...s.actionBtn, ...(files.length ? s.btnPrimary : s.btnDisabled) }}
                onClick={extract} disabled={!files.length}
              >
                AIで読み取る
              </button>
            )}
          </div>
        </>
      )}

      {overLimitMsg && (
        <div style={s.warnBox}><span style={{ fontWeight: 700 }}>⚠</span> {overLimitMsg}</div>
      )}
      {error && <div style={s.errorBox}>{error}</div>}

      {/* ── 抽出結果（カード一覧）── */}
      {showResults && (
        <>
          {/* ヘッダー */}
          <div style={s.fileHeader}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' as const }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: G.textPri }}>取り込み画像:</span>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' as const }}>
                {files.map((f, i) => (
                  <div key={i} style={s.chip}>
                    <div style={s.chipIcon} />
                    <span style={{ fontSize: 12, color: G.textPri }}>{f.name}</span>
                  </div>
                ))}
              </div>
            </div>
            <button style={s.changeBtn} onClick={reset}>画像を変更</button>
          </div>

          {/* インフォバナー */}
          {rows.length > 0 && (
            <div style={s.infoBanner}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' as const }}>
                <span>
                  <strong>{rows.length}件</strong> の明細が読み取れました。
                  <span style={{ color: G.textSec, marginLeft: 6 }}>
                    カードを左の見積エディタにドラッグ、または「→ 追加」で1件ずつ追加できます。
                  </span>
                </span>
                <button
                  style={s.addAllBtn}
                  onClick={addAll}
                >
                  残り全件を追加（{rows.length}件）
                </button>
              </div>
            </div>
          )}

          {/* 全件追加済み */}
          {rows.length === 0 && addedCount > 0 && (
            <div style={s.allDoneMsg}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={G.dark} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
              {addedCount}件すべてを見積に追加しました
            </div>
          )}

          {/* カードリスト */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            {rows.map(row => (
              <ItemCard
                key={row.id}
                row={row}
                removing={removingIds.has(row.id)}
                adding={addingIds.has(row.id)}
                onAdd={() => quickAdd(row)}
              />
            ))}
          </div>

          {rows.length > 0 && (
            <div style={{ fontSize: 11, color: G.textTer, textAlign: 'center' }}>
              ドラッグして左の見積エディタのグループに直接入れることもできます
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ── ItemCard ──────────────────────────────────────────────

function ItemCard({ row, removing, adding, onAdd }: {
  row: CandidateRow
  removing: boolean
  adding: boolean
  onAdd: () => void
}) {
  const [dragOver, setDragOver] = useState(false)

  return (
    <div
      className={removing ? 'ei-removing' : 'ei-card'}
      style={{
        marginBottom: 8,
        background: dragOver ? '#E8F5EC' : G.cardBg,
        borderTop: `1px solid ${dragOver ? G.dark : G.borderLight}`,
        borderRight: `1px solid ${dragOver ? G.dark : G.borderLight}`,
        borderBottom: `1px solid ${dragOver ? G.dark : G.borderLight}`,
        borderLeft: `4px solid ${G.med}`,
        borderRadius: 10,
        display: 'flex',
        alignItems: 'stretch',
        gap: 0,
        overflow: 'hidden',
        opacity: adding ? 0.5 : 1,
      }}
    >
      {/* ドラッグハンドル */}
      <div
        draggable={!adding}
        onDragStart={e => {
          e.dataTransfer.effectAllowed = 'copy'
          e.dataTransfer.setData('application/genba-import-item', JSON.stringify({
            _importId: row.id,
            name: row.name, quantity: row.quantity, unit: row.unit,
            cost_price: row.cost_price, vendor_name: row.vendor_name, memo: row.memo,
          }))
        }}
        onDragEnd={() => setDragOver(false)}
        style={{
          width: 32, flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: adding ? 'not-allowed' : 'grab',
          color: G.textTer,
          userSelect: 'none',
        }}
        title="ドラッグして左の見積エディタに追加"
      >
        <svg width="10" height="14" viewBox="0 0 10 14" fill="none">
          <circle cx="2.5" cy="2.5" r="1.5" fill="currentColor" />
          <circle cx="2.5" cy="7"   r="1.5" fill="currentColor" />
          <circle cx="2.5" cy="11.5" r="1.5" fill="currentColor" />
          <circle cx="7.5" cy="2.5" r="1.5" fill="currentColor" />
          <circle cx="7.5" cy="7"   r="1.5" fill="currentColor" />
          <circle cx="7.5" cy="11.5" r="1.5" fill="currentColor" />
        </svg>
      </div>

      {/* メイン情報 */}
      <div style={{ flex: 1, padding: '10px 12px', minWidth: 0 }}>
        {/* 名称 */}
        <div style={{
          fontSize: 14, fontWeight: 700, color: G.textPri,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          marginBottom: 5,
        }}>
          {row.name}
        </div>

        {/* メタ行 */}
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' as const, alignItems: 'center' }}>
          {/* 数量・単位 */}
          <MetaChip
            icon={
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/>
              </svg>
            }
            label={`${row.quantity} ${row.unit}`}
            color={G.textSec}
          />

          {/* 仕入原価 */}
          {row.cost_price != null && (
            <MetaChip
              icon={
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/>
                </svg>
              }
              label={`原価 ¥${fmt(row.cost_price)}`}
              color="#1E5C3A"
              bg="#E3F4EA"
            />
          )}

          {/* 業者名 */}
          {row.vendor_name && (
            <MetaChip
              icon={
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>
                </svg>
              }
              label={row.vendor_name}
              color="#92400E"
              bg="#FEF3C7"
            />
          )}

          {/* 備考 */}
          {row.memo && (
            <MetaChip
              icon={
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
                  <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
                </svg>
              }
              label={row.memo}
              color={G.textSec}
            />
          )}
        </div>
      </div>

      {/* 追加ボタン（常時表示・固定幅） */}
      <button
        onClick={onAdd}
        disabled={adding}
        style={{
          width: 60,
          flexShrink: 0,
          background: adding ? G.border : G.dark,
          color: '#fff',
          border: 'none',
          cursor: adding ? 'not-allowed' : 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'column',
          gap: 2,
          fontSize: 11,
          fontWeight: 700,
        }}
        title="見積に追加"
      >
        {adding ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="ei-spin">
            <path d="M21 12a9 9 0 11-6.219-8.56"/>
          </svg>
        ) : (
          <>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="5" y1="12" x2="19" y2="12"/>
              <polyline points="12 5 19 12 12 19"/>
            </svg>
            追加
          </>
        )}
      </button>
    </div>
  )
}

function MetaChip({ icon, label, color, bg }: {
  icon: React.ReactNode; label: string; color: string; bg?: string
}) {
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: bg ? '2px 7px' : '0',
      borderRadius: bg ? 20 : 0,
      background: bg ?? 'transparent',
      color,
      fontSize: 11, fontWeight: bg ? 600 : 400,
      whiteSpace: 'nowrap' as const,
      maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis',
    }}>
      <span style={{ color, flexShrink: 0, display: 'flex', alignItems: 'center' }}>{icon}</span>
      {label}
    </div>
  )
}

// ── スタイル ──────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
    padding: '24px 20px 40px',
    background: G.hover,
    minHeight: 400,
  },
  titleWrap: { display: 'flex', alignItems: 'flex-start', gap: 12 },
  titleIcon: {
    width: 40, height: 40, borderRadius: 10,
    background: G.light, border: `1px solid ${G.border}`,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0, marginTop: 2,
  },
  title: { margin: '0 0 4px', fontSize: 17, fontWeight: 800, color: G.textPri, letterSpacing: '-0.3px' },
  subtitle: { margin: 0, fontSize: 13, color: G.textSec, lineHeight: 1.6 },

  dropZone: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    minHeight: 220, background: G.cardBg, border: `2px dashed ${G.border}`,
    borderRadius: 16, cursor: 'pointer', gap: 10, padding: '32px 24px',
    transition: 'border-color 0.15s, background 0.15s',
  },
  dropActive: { borderColor: G.dark, background: G.light },
  dropIconCircle: {
    width: 64, height: 64, borderRadius: '50%',
    background: G.light, border: `1.5px solid ${G.border}`,
    display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 4,
  },
  dropTitle: { margin: 0, fontSize: 15, fontWeight: 700, color: G.textPri, textAlign: 'center' as const },
  dropSub: { margin: 0, fontSize: 12, color: G.textTer, textAlign: 'center' as const },
  browseBtn: {
    marginTop: 6, padding: '9px 24px',
    background: G.cardBg, border: `1.5px solid ${G.border}`,
    borderRadius: 8, fontSize: 13, fontWeight: 600,
    color: G.textSec, cursor: 'pointer',
  },

  fileCardList: { display: 'flex', flexDirection: 'column' as const, gap: 8 },
  fileCard: {
    display: 'flex', alignItems: 'center', gap: 12,
    padding: '12px 16px', background: '#EEF3F0', borderRadius: 12,
  },
  fileThumbWrap: {
    width: 48, height: 60, borderRadius: 6, overflow: 'hidden',
    flexShrink: 0, border: `1px solid ${G.border}`, background: G.light,
  },
  fileThumb: { width: '100%', height: '100%', objectFit: 'cover' as const },
  fileCardInfo: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' as const, gap: 4 },
  fileCardName: { fontSize: 13, fontWeight: 600, color: G.textPri, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  fileCardMeta: { display: 'flex', alignItems: 'center', gap: 5, fontSize: 12 },
  fileCardSize: { color: G.textTer },
  fileCardDot: { color: G.textTer },
  fileCardStatus: { color: G.textTer, fontWeight: 500 },
  progressTrack: { height: 4, background: G.borderLight, borderRadius: 2, overflow: 'hidden', marginTop: 4 },
  progressFill: { height: '100%', width: '60%', background: G.dark, borderRadius: 2 },
  fileCardRemove: {
    width: 32, height: 32, borderRadius: '50%',
    background: 'transparent', border: 'none', cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: G.textTer, flexShrink: 0,
  },
  addMoreCard: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '10px 16px', background: 'none',
    border: `1.5px dashed ${G.border}`, borderRadius: 12,
    fontSize: 13, fontWeight: 600, color: G.textTer,
    cursor: 'pointer', width: '100%',
  },

  actionBtn: {
    width: 220, height: 44,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    borderRadius: 8, fontSize: 15, fontWeight: 700, border: 'none', cursor: 'pointer',
  },
  btnPrimary:  { background: G.dark, color: '#FFFFFF' },
  btnOutline:  { background: G.light, color: G.dark, border: `1px solid ${G.border}` },
  btnDisabled: { background: '#D8E8DC', color: '#9BBFA7', cursor: 'not-allowed' },

  warnBox: { padding: '10px 14px', background: '#FFFBEB', border: '1px solid #FCD34D', borderRadius: 8, fontSize: 13, color: '#92400E' },
  errorBox: { padding: '10px 14px', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 8, fontSize: 13, color: '#991B1B' },

  fileHeader: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '12px 16px', background: G.cardBg,
    border: `1px solid ${G.border}`, borderRadius: 8,
    flexWrap: 'wrap', gap: 10,
  },
  chip: { display: 'flex', alignItems: 'center', gap: 6, padding: '3px 8px', background: G.light, borderRadius: 6 },
  chipIcon: { width: 18, height: 22, background: G.border, borderRadius: 2, flexShrink: 0 },
  changeBtn: { background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 700, color: G.med, textDecoration: 'underline', padding: 0, whiteSpace: 'nowrap' },

  infoBanner: {
    padding: '10px 14px',
    background: G.light,
    border: `1px solid ${G.border}`,
    borderLeft: `4px solid ${G.dark}`,
    borderRadius: 6,
    fontSize: 13,
    color: G.dark,
    lineHeight: 1.6,
  },

  addAllBtn: {
    padding: '6px 14px',
    background: G.dark,
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    fontSize: 12,
    fontWeight: 700,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },

  allDoneMsg: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '14px 18px',
    background: G.light,
    border: `1px solid ${G.border}`,
    borderLeft: `4px solid ${G.dark}`,
    borderRadius: 8,
    fontSize: 14, fontWeight: 700, color: G.dark,
    justifyContent: 'center',
  },
}
