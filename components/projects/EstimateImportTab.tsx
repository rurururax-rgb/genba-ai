'use client'

import { useEffect, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import {
  needsReview, reviewEstimateItem, toOcrNumber,
  type EstimateOcrFile, type EstimateOcrItem, type OcrMessage,
} from '@/lib/estimate/ocr-extraction'
import { checkEstimateImageFile, formatMegabytes, prepareEstimateImage } from '@/lib/estimate/ocr-image'
import { EstimateSourceViewer } from './EstimateSourceViewer'

// ── 型定義 ────────────────────────────────────────────────

/** 取り込み候補 1 行。金額は原本に印字された値（人が直したら直した値） */
type CandidateRow = {
  id: string
  fileName: string
  /** 取り込み元の画像（同じファイル名の別の画像と区別する。画像全体の警告との対応に使う） */
  fileKey: string
  /** 人が「原本と照らして確認した」と押した（数量・単価などを直すと取り消す） */
  acked: boolean
  name: string
  /** 取り込む数量。原本で読めなければ 1 */
  quantity: number
  /** 原本で数量を読めたか（読めなければ「要確認」） */
  quantityRead: boolean
  unit: string
  cost_price: number | null
  cost_from: EstimateOcrItem['cost_from']
  list_price: number | null
  rate: number | null
  amount: number | null
  vendor_name: string
  memo: string
  messages: OcrMessage[]
}

type FileState =
  | { state: 'selected' }
  | { state: 'running'; note?: string }
  | { state: 'done'; note?: string; summary: Pick<EstimateOcrFile, 'supplier' | 'document_type'>; messages: OcrMessage[]; count: number }
  | { state: 'failed'; error: string }

function uid() { return Math.random().toString(36).slice(2) }
function fmt(v: number) { return v.toLocaleString('ja-JP') }
const fileKey = (f: File) => `${f.name}:${f.size}:${f.lastModified}`

/** 同時に送る画像の数（AI のレート制限と端末の通信量を抑える） */
const CONCURRENCY = 2

/** 行の照合をやり直す（人が数量・単価を直したときも同じ規則で検査する） */
function withReview(r: Omit<CandidateRow, 'messages'>): CandidateRow {
  return {
    ...r,
    messages: reviewEstimateItem({
      quantity: r.quantityRead ? r.quantity : null,
      cost_price: r.cost_price, cost_from: r.cost_from,
      list_price: r.list_price, rate: r.rate, amount: r.amount,
    }),
  }
}

function toCandidate(item: Partial<EstimateOcrItem>, file: File): CandidateRow {
  const quantity = toOcrNumber(item.quantity)
  return withReview({
    id: uid(),
    fileName: file.name,
    fileKey: fileKey(file),
    acked: false,
    name: String(item.name ?? ''),
    quantity: quantity ?? 1,
    quantityRead: quantity != null,
    unit: item.unit || '式',
    cost_price: toOcrNumber(item.cost_price),
    cost_from: item.cost_from ?? null,
    list_price: toOcrNumber(item.list_price),
    rate: toOcrNumber(item.rate),
    amount: toOcrNumber(item.amount),
    vendor_name: item.vendor_name ?? '',
    memo: item.note ?? '',
  })
}

/** 追加の前に人が確認すべき内容（行の要確認・取り込み元の画像全体の警告）。どちらも無ければ null */
type PendingReview = { rowWarns: string[]; fileName: string; fileWarns: string[] }
const warnTexts = (m: OcrMessage[]) => m.filter(x => x.level === 'warn').map(x => x.text)

const toImportItem = (r: CandidateRow) => ({
  name: r.name, quantity: r.quantity, unit: r.unit, cost_price: r.cost_price,
  vendor_name: r.vendor_name || null, internal_memo: r.memo || null,
})

/** 応答を JSON として読む（Vercel が 413 などを JSON 以外で返す場合がある） */
async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try { return await res.json() as Record<string, unknown> } catch { return null }
}

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

const WARN = { bg: '#FFFBEB', border: '#FCD34D', text: '#92400E', bar: '#D97706' } as const

type Props = { projectId: string; wide?: boolean }

/** wide は別ウィンドウ時の表示だけを変える。OCR・確認・登録状態は共通。 */
export function EstimateImportTab({ projectId, wide = false }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  /** 画像の選び直し・キャンセルで増やす。古い読み取り結果を画面に入れないため */
  const runRef = useRef(0)
  /** 追加中の行（state の更新を待たずに二重送信を止める） */
  const inFlightRef = useRef<Set<string>>(new Set())
  /** この画面で見積に追加した画像（同じ画像の再取り込みに気づけるように） */
  const importedFilesRef = useRef<Set<string>>(new Set())

  const MAX_FILES = 10

  const [files,        setFiles]       = useState<File[]>([])
  const [previews,     setPreviews]    = useState<string[]>([])
  const [fileStates,   setFileStates]  = useState<FileState[]>([])
  const [loading,      setLoading]     = useState(false)
  const [rows,         setRows]        = useState<CandidateRow[]>([])
  const [removingIds,  setRemovingIds] = useState<Set<string>>(new Set())
  const [addingIds,    setAddingIds]   = useState<Set<string>>(new Set())
  const [error,        setError]       = useState<string | null>(null)
  const [notices,      setNotices]     = useState<string[]>([])
  const [dragging,     setDragging]    = useState(false)
  const [addedCount,   setAddedCount]  = useState(0)
  const [confirmAll,   setConfirmAll]  = useState(false)
  /** 画像全体の警告を確認済みにした画像（fileKey） */
  const [ackedFiles,   setAckedFiles]  = useState<Set<string>>(new Set())
  /** 原本ビューアの表示中画像。明細ごとの登録・確認状態とは独立 */
  const [selectedSourceKey, setSelectedSourceKey] = useState<string | null>(null)
  /** 同じ原本を再選択しても大きく開くため、クリックごとに変更する */
  const [openSourceRequest, setOpenSourceRequest] = useState(0)

  // ドラッグ成功の通知（一度だけ登録するリスナー）から最新の行・画像を参照するため
  const rowsRef = useRef<CandidateRow[]>([])
  const filesRef = useRef<File[]>([])
  useEffect(() => { rowsRef.current = rows; filesRef.current = files }, [rows, files])

  function markAdding(ids: string[], on: boolean) {
    ids.forEach(id => (on ? inFlightRef.current.add(id) : inFlightRef.current.delete(id)))
    setAddingIds(prev => {
      const n = new Set(prev)
      ids.forEach(id => (on ? n.add(id) : n.delete(id)))
      return n
    })
  }

  /** 見積に追加した行の元画像を覚えておく（同じ画像の再取り込みの注意に使う） */
  function rememberImported(ids: string[]) {
    rowsRef.current.filter(r => ids.includes(r.id)).forEach(r => importedFilesRef.current.add(r.fileKey))
  }

  /** 画像ごとの警告（取り込み元の画像の fileKey で引く。ファイル名が同じ別の画像と混ぜない） */
  function fileWarnsOf(key: string): string[] {
    const i = files.findIndex(f => fileKey(f) === key)
    const st = fileStates[i]
    return st?.state === 'done' ? warnTexts(st.messages) : []
  }

  function pendingOf(r: CandidateRow): PendingReview | null {
    const rowWarns = r.acked ? [] : warnTexts(r.messages)
    const fileWarns = ackedFiles.has(r.fileKey) ? [] : fileWarnsOf(r.fileKey)
    return rowWarns.length || fileWarns.length ? { rowWarns, fileName: r.fileName, fileWarns } : null
  }

  /** 人が確認した行と、その取り込み元の画像を確認済みにする */
  function acknowledge(targets: CandidateRow[]) {
    const ids = new Set(targets.map(r => r.id))
    setRows(prev => prev.map(r => (ids.has(r.id) ? { ...r, acked: true } : r)))
    setAckedFiles(prev => new Set([...prev, ...targets.map(r => r.fileKey)]))
  }

  function fadeRemove(id: string) {
    setRemovingIds(prev => new Set([...prev, id]))
    setTimeout(() => {
      setRows(prev => prev.filter(r => r.id !== id))
      setRemovingIds(prev => { const n = new Set(prev); n.delete(id); return n })
      setAddedCount(c => c + 1)
    }, 280)
  }

  // 見積エディタへのドラッグ: 送信開始・成功・失敗の通知を受ける
  useEffect(() => {
    const adding = (e: Event) => {
      const { importId } = (e as CustomEvent<{ importId: string }>).detail
      markAdding([importId], true)
    }
    const moved = (e: Event) => {
      const { importId } = (e as CustomEvent<{ importId: string }>).detail
      rememberImported([importId])
      markAdding([importId], false)
      fadeRemove(importId)
    }
    const failed = (e: Event) => {
      const { importId, error: msg } = (e as CustomEvent<{ importId: string; error?: string }>).detail
      markAdding([importId], false)
      setError(msg || '見積への追加に失敗しました')
    }
    window.addEventListener('genba:import-item-adding', adding)
    window.addEventListener('genba:import-item-moved', moved)
    window.addEventListener('genba:import-item-failed', failed)
    return () => {
      window.removeEventListener('genba:import-item-adding', adding)
      window.removeEventListener('genba:import-item-moved', moved)
      window.removeEventListener('genba:import-item-failed', failed)
    }
  }, [])

  function clearResults() {
    runRef.current += 1
    setRows([]); setError(null); setAddedCount(0); setConfirmAll(false); setAckedFiles(new Set())
  }

  function addFiles(newFiles: FileList | File[]) {
    if (loading) return
    const picked = Array.from(newFiles)
    const msgs: string[] = []
    const accepted: File[] = []
    for (const f of picked) {
      const check = checkEstimateImageFile(f)
      if (!check.ok) { msgs.push(check.message); continue }
      if (files.some(x => fileKey(x) === fileKey(f)) || accepted.some(x => fileKey(x) === fileKey(f))) {
        msgs.push(`「${f.name}」はすでに選択されています`)
        continue
      }
      if (importedFilesRef.current.has(fileKey(f))) {
        msgs.push(`「${f.name}」はこの画面で見積に追加済みの画像です。読み取ると同じ明細が重複して追加される場合があります`)
      }
      accepted.push(f)
    }
    let combined = [...files, ...accepted]
    if (combined.length > MAX_FILES) {
      msgs.push(`最大${MAX_FILES}枚までです。${combined.length - MAX_FILES}枚を超えた分は選択されませんでした。`)
      combined = combined.slice(0, MAX_FILES)
    }
    setNotices(msgs)
    if (combined.length === files.length) return
    clearResults()
    previews.forEach(u => URL.revokeObjectURL(u))
    setFiles(combined)
    setSelectedSourceKey(fileKey(combined[0]))
    setPreviews(combined.map(f => URL.createObjectURL(f)))
    setFileStates(combined.map(() => ({ state: 'selected' })))
  }

  function removeFile(i: number) {
    if (loading) return
    clearResults(); setNotices([])
    URL.revokeObjectURL(previews[i])
    const remaining = files.filter((_, idx) => idx !== i)
    setSelectedSourceKey(prev => remaining.some(f => fileKey(f) === prev) ? prev : remaining[0] ? fileKey(remaining[0]) : null)
    setFiles(remaining)
    setPreviews(previews.filter((_, idx) => idx !== i))
    setFileStates(fileStates.filter((_, idx) => idx !== i))
  }

  function reset() {
    abortRef.current?.abort()
    clearResults()
    previews.forEach(u => URL.revokeObjectURL(u))
    setFiles([]); setPreviews([]); setFileStates([]); setNotices([]); setLoading(false); setSelectedSourceKey(null)
  }

  /** 画像 1 枚を縮小して送り、結果を返す */
  async function extractFile(file: File, i: number, run: number, signal: AbortSignal): Promise<CandidateRow[]> {
    const setState = (st: FileState) => {
      if (runRef.current === run) setFileStates(prev => prev.map((x, idx) => (idx === i ? st : x)))
    }
    setState({ state: 'running' })
    const prepared = await prepareEstimateImage(file)
    if (!prepared.ok) { setState({ state: 'failed', error: prepared.message }); return [] }
    const note = prepared.resized ? `送信用に縮小しました（${formatMegabytes(prepared.originalBytes)} → ${formatMegabytes(prepared.file.size)}）` : undefined
    if (note) setState({ state: 'running', note })

    const fd = new FormData()
    fd.append('files', prepared.file, file.name)
    let res: Response
    try {
      res = await fetch('/api/ai/extract-estimate', { method: 'POST', body: fd, signal })
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e
      setState({ state: 'failed', error: '通信できませんでした。電波の良い場所でもう一度お試しください' })
      return []
    }
    const data = await readJson(res)
    if (!res.ok || !data) {
      const msg = typeof data?.error === 'string' ? data.error
        : res.status === 413 ? '画像が大きすぎて送れませんでした。見積書の部分だけが写るように撮り直してください'
        : '読み取りに失敗しました。時間をおいてもう一度お試しください'
      setState({ state: 'failed', error: msg })
      return []
    }
    const fileResults = (Array.isArray(data.files) ? data.files : []) as Partial<EstimateOcrFile>[]
    const failures = (Array.isArray(data.failures) ? data.failures : []) as Array<{ error?: string }>
    if (!fileResults.length) {
      setState({ state: 'failed', error: failures[0]?.error ?? '読み取りに失敗しました' })
      return []
    }
    const fr = fileResults[0]
    const items = (Array.isArray(fr.items) ? fr.items : []).map(it => toCandidate(it, file)).filter(r => r.name)
    const messages = Array.isArray(fr.messages) ? fr.messages : []
    // 旧形式の応答（raw_warning）も注意書きとして出す
    const legacy = (fr as { raw_warning?: unknown }).raw_warning
    if (typeof legacy === 'string' && legacy && !messages.length) messages.push({ level: 'warn', text: `AI の注意書き: ${legacy}` })
    setState({
      state: 'done', note, messages, count: items.length,
      summary: { supplier: fr.supplier ?? '', document_type: fr.document_type ?? '' },
    })
    return items
  }

  async function extract() {
    if (!files.length || loading) return
    const ac = new AbortController()
    abortRef.current = ac
    const run = ++runRef.current
    setLoading(true); setError(null); setRows([]); setAddedCount(0); setConfirmAll(false); setAckedFiles(new Set())
    setFileStates(files.map(() => ({ state: 'selected' })))
    const results: CandidateRow[][] = files.map(() => [])
    try {
      let next = 0
      const worker = async () => {
        while (next < files.length) {
          const i = next++
          results[i] = await extractFile(files[i], i, run, ac.signal)
        }
      }
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker))
      if (runRef.current !== run) return
      const all = results.flat()
      setRows(all)
      if (!all.length) setError('明細を読み取れませんでした。各画像の案内を確認してください')
    } catch (e) {
      if ((e as Error).name !== 'AbortError' && runRef.current === run) setError('読み取りに失敗しました')
    } finally {
      if (runRef.current === run) { setLoading(false); abortRef.current = null }
    }
  }

  function cancelExtract() {
    abortRef.current?.abort()
    runRef.current += 1
    setLoading(false)
    setFileStates(files.map(() => ({ state: 'selected' })))
  }

  function updateRow(id: string, patch: Partial<Pick<CandidateRow, 'name' | 'quantity' | 'unit' | 'cost_price'>>) {
    setConfirmAll(false)
    setRows(prev => prev.map(r => {
      if (r.id !== id) return r
      const { messages: _m, ...rest } = r
      void _m
      return withReview({
        ...rest, ...patch,
        // 値を直したら、直した後の内容でもう一度確認してもらう
        acked: false,
        // 人が数量を入力したら「読めなかった」扱いをやめる
        quantityRead: patch.quantity !== undefined ? true : r.quantityRead,
        cost_from: patch.cost_price !== undefined ? 'printed_unit_price' : r.cost_from,
      })
    }))
  }

  async function postImport(targets: CandidateRow[]): Promise<boolean> {
    const res = await fetch('/api/estimate-items/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: projectId, items: targets.map(toImportItem) }),
    }).catch(() => null)
    if (res?.ok) {
      window.dispatchEvent(new CustomEvent('genba:data-changed', { detail: { target_table: 'estimate_items' } }))
      return true
    }
    const d = res ? await readJson(res) : null
    setError(typeof d?.error === 'string' ? d.error : '追加に失敗しました。通信状態を確認してもう一度お試しください')
    return false
  }

  // 1件だけ追加（カードの「→ 追加」ボタン用）
  // 要確認の行・警告のある画像の行は、カードの確認欄の「確認したので追加する」からだけ送る（confirmed = true）
  async function quickAdd(row: CandidateRow, confirmed: boolean) {
    if (inFlightRef.current.has(row.id) || !row.name.trim()) return
    if (pendingOf(row) && !confirmed) return
    if (confirmed) acknowledge([row])
    markAdding([row.id], true)
    try {
      if (await postImport([row])) { rememberImported([row.id]); fadeRemove(row.id) }
    } finally {
      markAdding([row.id], false)
    }
  }

  // 残り全件追加（要確認の行・警告のある画像・読み取れなかった画像があるときは、確認欄を挟む）
  // confirmed は確認欄の「確認したので追加する」からだけ true（一括ボタンの連打で確認を飛ばさない）
  async function addAll(confirmed: boolean) {
    const targets = rows.filter(r => !inFlightRef.current.has(r.id) && !removingIds.has(r.id) && r.name.trim())
    if (!targets.length) return
    if ((targets.some(r => pendingOf(r)) || failedFiles.length > 0) && !confirmed) { setConfirmAll(true); return }
    setConfirmAll(false)
    acknowledge(targets)
    const ids = targets.map(r => r.id)
    markAdding(ids, true)
    try {
      if (await postImport(targets)) { rememberImported(ids); ids.forEach(id => fadeRemove(id)) }
    } finally {
      markAdding(ids, false)
    }
  }

  // removingIds.size > 0 を含めることで、最後の1件が消えるアニメーション中に
  // アップロード画面に戻ってしまうフラッシュを防ぐ
  const showResults = rows.length > 0 || addedCount > 0 || removingIds.size > 0
  const reviewCount = rows.filter(r => needsReview(r.messages)).length
  const bulkBusy = rows.some(r => addingIds.has(r.id))
  const failedFiles = fileStates.flatMap((st, i) => (st.state === 'failed' ? [files[i]?.name ?? ''] : []))
  // 一括追加の確認欄に出す、画像ごとの未確認の警告（取り込み元の画像ごとにまとめる）
  const bulkFileWarns = files.flatMap(f => {
    const key = fileKey(f)
    if (ackedFiles.has(key) || !rows.some(r => r.fileKey === key)) return []
    const warns = fileWarnsOf(key)
    return warns.length ? [{ key, name: f.name, warns }] : []
  })
  const unackedReviewCount = rows.filter(r => !r.acked && needsReview(r.messages)).length
  const doneFiles = fileStates
    .map((st, i) => ({ st, name: files[i]?.name ?? '' }))
    .filter(x => x.st.state === 'done' || x.st.state === 'failed')

  return (
    <div data-testid={wide ? 'estimate-import-wide' : 'estimate-import-compact'} style={{ ...s.root, ...(wide ? { padding: '18px 22px 32px', gap: 14 } : {}) }}>
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
          from { opacity: 1; transform: translateX(0); max-height: 400px; margin-bottom: 8px; }
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
        .ei-wide-review { display: grid; grid-template-columns: minmax(0, 44fr) minmax(0, 56fr); gap: 18px; align-items: start; }
        .ei-wide-source { position: sticky; top: 0; align-self: start; min-width: 0; }
        .ei-wide-candidates { min-width: 0; display: flex; flex-direction: column; gap: 12px; }
        @media (max-width: 1000px) { .ei-wide-review { grid-template-columns: minmax(0, 1fr); } .ei-wide-source { position: static; } }
        @media (max-width: 650px) { .ei-wide-numbers { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; } }
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
            <input ref={inputRef} type="file" multiple accept="image/jpeg,image/png,image/webp"
              style={{ display: 'none' }}
              onChange={e => { if (e.target.files) addFiles(e.target.files); e.target.value = '' }}
            />
            <div style={s.dropIconCircle}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none"
                stroke={G.med} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 16V8m0 0l-3 3m3-3l3 3"/>
                <path d="M20.39 18.39A5 5 0 0018 9h-1.26A8 8 0 103 16.3"/>
              </svg>
            </div>
            <p style={s.dropTitle}>ドラッグ＆ドロップ、またはクリックして選択</p>
            <p style={s.dropSub}>JPEG・PNG・WebP • 最大{MAX_FILES}枚 • 1ページ1枚で撮影 • 大きい写真は自動で縮小します</p>
            <button style={s.browseBtn} disabled={loading} onClick={e => { e.stopPropagation(); inputRef.current?.click() }}>
              ファイルを選択
            </button>
          </div>

          {files.length > 0 && (
            <div style={s.fileCardList}>
              {files.map((file, i) => {
                const st = fileStates[i] ?? { state: 'selected' }
                return (
                  <div key={fileKey(file)} style={s.fileCard}>
                    <div style={s.fileThumbWrap}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={previews[i]} alt="" style={s.fileThumb} />
                    </div>
                    <div style={s.fileCardInfo}>
                      <span style={s.fileCardName}>{file.name}</span>
                      <div style={s.fileCardMeta}>
                        <span style={s.fileCardSize}>{(file.size / 1024).toFixed(0)} KB</span>
                        <span style={s.fileCardDot}>•</span>
                        {st.state === 'running' ? (
                          <>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                              stroke={G.med} strokeWidth="2.5" strokeLinecap="round" className="ei-spin">
                              <path d="M21 12a9 9 0 11-6.219-8.56"/>
                            </svg>
                            <span style={s.fileCardStatus}>解析中</span>
                          </>
                        ) : st.state === 'failed' ? (
                          <span style={{ ...s.fileCardStatus, color: '#991B1B' }}>失敗</span>
                        ) : st.state === 'done' ? (
                          <span style={{ ...s.fileCardStatus, color: G.med }}>完了（{st.count}件）</span>
                        ) : (
                          <span style={{ ...s.fileCardStatus, color: G.med }}>{loading ? '待機中' : '選択済み'}</span>
                        )}
                      </div>
                      {st.state === 'running' && (
                        <div style={s.progressTrack}>
                          <div style={s.progressFill} className="ei-progress" />
                        </div>
                      )}
                      {(st.state === 'running' || st.state === 'done') && st.note && (
                        <span style={{ fontSize: 11, color: G.textSec }}>{st.note}</span>
                      )}
                      {st.state === 'failed' && <span style={{ fontSize: 12, color: '#991B1B' }}>{st.error}</span>}
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
                )
              })}
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

      {notices.length > 0 && (
        <div style={s.warnBox} role="status">
          {notices.map((m, i) => <div key={i}><span style={{ fontWeight: 700 }}>⚠</span> {m}</div>)}
        </div>
      )}
      {error && <div style={s.errorBox} role="alert">{error}</div>}

      {/* ── 表示だけを切り替える。同じ候補データ・保存ロジックを1画面と2画面で使う ── */}
      <div className={wide ? 'ei-wide-review' : undefined} data-testid={wide ? 'estimate-wide-review-layout' : undefined}>
        <div className={wide ? 'ei-wide-source' : undefined}>
      {/* ── 原本表示（選択後から取り込み完了まで保持。送信前の元画像を表示）── */}
      {files.length > 0 && (
        <EstimateSourceViewer
          pages={files.map((f, i) => ({ key: fileKey(f), name: f.name, url: previews[i] }))}
          selectedKey={selectedSourceKey}
          onSelect={setSelectedSourceKey}
          openRequest={openSourceRequest}
          wide={wide}
        />
      )}

        </div>
        <div className={wide ? 'ei-wide-candidates' : undefined}>
      {wide && showResults && (
        <div role="note" style={{ ...s.infoBanner, background: '#F7FAF8', color: G.textSec, fontSize: 12 }}>
          左の見積エディタはそのまま広く使えます。右画面の「追加」は、現在は案件の未分類に登録します。
          工種や挿入位置を指定したい場合は、1画面モードでドラッグしてください。
        </div>
      )}
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

          {/* 画像ごとの読み取り結果（業者名・確認事項・失敗） */}
          {doneFiles.some(x => x.st.state === 'failed' || (x.st.state === 'done' && (x.st.messages.length > 0 || x.st.summary.supplier))) && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {doneFiles.map(({ st, name }, i) => st.state === 'failed' ? (
                <div key={i} style={s.errorBox}><strong>{name}</strong>：{st.error}</div>
              ) : st.state === 'done' && (st.messages.length > 0 || st.summary.supplier) ? (
                <div key={i} style={st.messages.some(m => m.level === 'warn') ? s.warnBox : s.fileSummary}>
                  <div style={{ fontWeight: 700 }}>
                    {name}{st.summary.supplier ? `（${st.summary.supplier}${st.summary.document_type ? `・${st.summary.document_type}` : ''}）` : ''}
                  </div>
                  {st.messages.map((m, j) => <div key={j}>{m.level === 'warn' ? '⚠ ' : ''}{m.text}</div>)}
                </div>
              ) : null)}
            </div>
          )}

          {/* インフォバナー */}
          {rows.length > 0 && (
            <div style={s.infoBanner}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' as const }}>
                <span>
                  <strong>{rows.length}件</strong> の明細が読み取れました。
                  {reviewCount > 0 && (
                    <strong style={{ color: WARN.text, marginLeft: 6 }}>うち {reviewCount}件は要確認です。</strong>
                  )}
                  <span style={{ color: G.textSec, marginLeft: 6 }}>
                    金額は AI の読み取り候補です。原本と照らして、違っていれば「修正」で直してから追加してください。
                  </span>
                </span>
                <button
                  style={{ ...s.addAllBtn, ...(bulkBusy || confirmAll ? { opacity: 0.5, cursor: 'not-allowed' } : {}) }}
                  onClick={() => addAll(false)}
                  disabled={bulkBusy || confirmAll}
                >
                  残り全件を追加（{rows.length}件）
                </button>
              </div>
              {confirmAll && (
                <div data-testid="bulk-confirm" role="alertdialog" style={{ ...s.warnBox, marginTop: 8, display: 'flex', flexDirection: 'column' as const, gap: 6 }}>
                  {unackedReviewCount > 0 && <div>⚠ 要確認の行が {unackedReviewCount}件 含まれています。</div>}
                  {bulkFileWarns.map(g => (
                    <div key={g.key} data-testid="bulk-confirm-file">
                      <div style={{ fontWeight: 700 }}>⚠ 画像「{g.name}」全体の注意</div>
                      {g.warns.map((w, j) => <div key={j} style={{ paddingLeft: 14 }}>{w}</div>)}
                    </div>
                  ))}
                  {failedFiles.length > 0 && (
                    <div data-testid="bulk-confirm-failed">⚠ 読み取れなかった画像があります（{failedFiles.join('、')}）。その画像の明細は追加されません。</div>
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' as const }}>
                    <span>原本と照らして確認しましたか？</span>
                    <button style={s.addAllBtn} onClick={() => addAll(true)} disabled={bulkBusy}>確認したので追加する</button>
                    <button style={s.changeBtn} onClick={() => setConfirmAll(false)}>戻る</button>
                  </div>
                </div>
              )}
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
                pending={pendingOf(row)}
                onAdd={confirmed => quickAdd(row, confirmed)}
                onAck={() => acknowledge([row])}
                onChange={patch => updateRow(row.id, patch)}
                wide={wide}
                onShowSource={() => { setSelectedSourceKey(row.fileKey); setOpenSourceRequest(n => n + 1) }}
              />
            ))}
          </div>

          {rows.length > 0 && !wide && (
            <div style={{ fontSize: 11, color: G.textTer, textAlign: 'center' }}>
              ドラッグして左の見積エディタのグループに直接入れることもできます
            </div>
          )}
        </>
      )}
        </div>
      </div>
    </div>
  )
}

// ── ItemCard ──────────────────────────────────────────────

function ItemCard({ row, removing, adding, pending, onAdd, onAck, onChange, onShowSource, wide }: {
  row: CandidateRow
  removing: boolean
  adding: boolean
  /** 追加の前に確認すべき内容（null なら確認なしで追加・ドラッグできる） */
  pending: PendingReview | null
  onAdd: (confirmed: boolean) => void
  /** 確認済みにする（その後はドラッグで見積エディタの好きな位置に入れられる） */
  onAck: () => void
  onChange: (patch: Partial<Pick<CandidateRow, 'name' | 'quantity' | 'unit' | 'cost_price'>>) => void
  onShowSource: () => void
  wide: boolean
}) {
  const [dragOver, setDragOver] = useState(false)
  const [editing, setEditing] = useState(false)
  const [asking, setAsking] = useState(false)
  const showConfirm = asking && pending != null
  const flagged = needsReview(row.messages)
  const accent = flagged ? WARN.bar : G.med

  return (
    <div
      className={removing ? 'ei-removing' : 'ei-card'}
      data-testid="ocr-candidate"
      data-needs-review={flagged ? 'true' : 'false'}
      style={{
        marginBottom: 8,
        background: dragOver ? '#E8F5EC' : G.cardBg,
        borderTop: `1px solid ${dragOver ? G.dark : G.borderLight}`,
        borderRight: `1px solid ${dragOver ? G.dark : G.borderLight}`,
        borderBottom: `1px solid ${dragOver ? G.dark : G.borderLight}`,
        borderLeft: `4px solid ${accent}`,
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
        draggable={!wide && !adding && !editing && row.name.trim() !== ''}
        onDragStart={e => {
          // 別ウィンドウ間のドラッグは保証できない。1画面だけ既存操作を提供する。
          if (wide) { e.preventDefault(); return }
          // 要確認の行・警告のある画像の行は、確認するまでドラッグで見積に入れさせない
          if (pending) { e.preventDefault(); setAsking(true); return }
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
          display: wide ? 'none' : 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: adding ? 'not-allowed' : 'grab',
          color: G.textTer,
          userSelect: 'none',
        }}
        title={pending ? '原本と照らして確認してからドラッグできます' : 'ドラッグして左の見積エディタに追加'}
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
      <div style={{ flex: 1, padding: wide ? '14px 16px' : '10px 12px', minWidth: 0 }}>
        {/* 名称 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: wide ? 12 : 5, flexWrap: wide ? 'wrap' : 'nowrap' }}>
          <div style={{
            flex: 1, minWidth: 0,
            fontSize: wide ? 16 : 14, fontWeight: 700, color: G.textPri,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: wide ? 'normal' : 'nowrap',
          }}>
            {row.name || '（品名なし）'}
          </div>
          <button type="button" style={s.editBtn} onClick={onShowSource} title="この明細の原本画像を表示">原本を見る</button>
          <button
            style={s.editBtn}
            onClick={() => setEditing(v => !v)}
            disabled={adding}
            aria-expanded={editing}
          >
            {editing ? '閉じる' : '修正'}
          </button>
        </div>

        {/* 広い右モニターでは、見積エディタ同様、金額を列で見比べられる表示にする */}
        {wide && (
          <>
            <div data-testid="ocr-wide-fields" className="ei-wide-numbers" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 0.75fr) minmax(0, 0.6fr) minmax(0, 1fr) minmax(0, 1.1fr)', gap: 8 }}>
              <WideNumber label="数量" value={fmt(row.quantity)} />
              <WideNumber label="単位" value={row.unit} />
              <WideNumber label="原価単価" value={row.cost_price == null ? '未読取' : `¥${fmt(row.cost_price)}`} highlight={row.cost_price == null ? 'warning' : 'normal'} />
              <WideNumber label="原本の金額" value={row.amount == null ? '記載なし' : `¥${fmt(row.amount)}`} />
            </div>
            {(row.list_price != null || row.vendor_name || row.memo) && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 9, color: G.textSec, fontSize: 12 }}>
                {row.list_price != null && <span>定価 ¥{fmt(row.list_price)}{row.rate != null ? ` / 掛率 ${Math.round(row.rate * 1000) / 10}%` : ''}</span>}
                {row.vendor_name && <span>業者：{row.vendor_name}</span>}
                {row.memo && <span title="社内メモとして取り込みます">社内メモ：{row.memo}</span>}
              </div>
            )}
          </>
        )}
        {/* 1画面では従来のコンパクトな表示をそのまま維持 */}
        {!wide && <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' as const, alignItems: 'center' }}>
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

          {/* 仕入原価（単価） */}
          {row.cost_price != null ? (
            <MetaChip
              icon={
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/>
                </svg>
              }
              label={`原価単価 ¥${fmt(row.cost_price)}`}
              color="#1E5C3A"
              bg="#E3F4EA"
            />
          ) : (
            <MetaChip icon={<span>?</span>} label="原価 未読取" color={WARN.text} bg={WARN.bg} />
          )}

          {/* 原本の金額（照合用） */}
          {row.amount != null && (
            <MetaChip icon={<span>=</span>} label={`原本の金額 ¥${fmt(row.amount)}`} color={G.textSec} />
          )}
          {row.list_price != null && (
            <MetaChip icon={<span>定</span>} label={`定価 ¥${fmt(row.list_price)}${row.rate != null ? ` × ${Math.round(row.rate * 1000) / 10}%` : ''}`} color={G.textSec} />
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

          {/* 元見積書の備考 → 取込後は「社内メモ」（お客様向け見積書には出ない） */}
          {row.memo && (
            <MetaChip
              icon={
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="4" y="11" width="16" height="10" rx="2"/>
                  <path d="M8 11V7a4 4 0 018 0v4"/>
                </svg>
              }
              label={`社内メモ: ${row.memo}`}
              title={`社内メモとして取り込みます（お客様には表示されません）\n${row.memo}`}
              color={G.textSec}
            />
          )}
        </div>}

        {/* 確認事項 */}
        {row.messages.length > 0 && (
          <ul style={s.rowMessages}>
            {row.messages.map((m, i) => (
              <li key={i} style={{ color: m.level === 'warn' ? WARN.text : G.textSec }}>
                {m.level === 'warn' ? '⚠ ' : ''}{m.text}
              </li>
            ))}
          </ul>
        )}

        {/* 追加の前の確認（要確認の行・警告のある画像の行） */}
        {showConfirm && (
          <div data-testid="row-confirm" role="alertdialog" style={{ ...s.warnBox, marginTop: 8, display: 'flex', flexDirection: 'column' as const, gap: 4 }}>
            {pending.rowWarns.length > 0 && (
              <div>
                <div style={{ fontWeight: 700 }}>⚠ この行は要確認です</div>
                {pending.rowWarns.map((w, i) => <div key={i} style={{ paddingLeft: 14 }}>{w}</div>)}
              </div>
            )}
            {pending.fileWarns.length > 0 && (
              <div>
                <div style={{ fontWeight: 700 }}>⚠ 画像「{pending.fileName}」全体の注意</div>
                {pending.fileWarns.map((w, i) => <div key={i} style={{ paddingLeft: 14 }}>{w}</div>)}
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' as const }}>
              <span>原本と照らして確認しましたか？</span>
              <button style={s.addAllBtn} onClick={() => { setAsking(false); onAdd(true) }} disabled={adding}>確認したので追加する</button>
              <button style={s.editBtn} onClick={() => { setAsking(false); onAck() }}>確認済みにする（ドラッグで入れる）</button>
              <button style={s.changeBtn} onClick={() => setAsking(false)}>戻る</button>
            </div>
          </div>
        )}

        {/* 修正フォーム（原本と違う値を直す） */}
        {editing && (
          <div style={s.editGrid}>
            <label style={{ ...s.editLabel, gridColumn: '1 / -1' }}>
              品名
              <Input inputSize="compact" value={row.name} maxLength={200}
                onChange={e => onChange({ name: e.target.value })} />
            </label>
            <label style={s.editLabel}>
              数量
              <Input inputSize="compact" inputMode="decimal" defaultValue={String(row.quantity)}
                onChange={e => { const n = toOcrNumber(e.target.value); if (n != null) onChange({ quantity: n }) }} />
            </label>
            <label style={s.editLabel}>
              単位
              <Input inputSize="compact" value={row.unit} maxLength={20}
                onChange={e => onChange({ unit: e.target.value })} />
            </label>
            <label style={s.editLabel}>
              原価単価（円）
              <Input inputSize="compact" inputMode="decimal" defaultValue={row.cost_price != null ? String(row.cost_price) : ''}
                placeholder="原本の単価"
                onChange={e => {
                  const v = e.target.value.trim()
                  if (v === '') onChange({ cost_price: null })
                  else { const n = toOcrNumber(v); if (n != null) onChange({ cost_price: n }) }
                }} />
            </label>
          </div>
        )}
      </div>

      {/* 追加ボタン（常時表示・固定幅） */}
      <button
        onClick={() => (pending ? setAsking(true) : onAdd(false))}
        disabled={adding || !row.name.trim()}
        style={{
          width: wide ? 78 : 60,
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
          fontSize: wide ? 13 : 11,
          fontWeight: 700,
        }}
        title={wide ? '見積に追加（未分類）' : '見積に追加'}
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

function WideNumber({ label, value, highlight = 'normal' }: { label: string; value: string; highlight?: 'normal' | 'warning' }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, background: highlight === 'warning' ? '#FFFBEB' : '#F7FAF8', padding: '9px 10px', borderRadius: 6 }}>
      <span style={{ color: G.textSec, fontSize: 11 }}>{label}</span>
      <strong style={{ color: highlight === 'warning' ? WARN.text : G.textPri, fontSize: 15, fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere' }}>{value}</strong>
    </div>
  )
}

function MetaChip({ icon, label, color, bg, title }: {
  icon: React.ReactNode; label: string; color: string; bg?: string; title?: string
}) {
  return (
    <div title={title} style={{
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

  fileSummary: { padding: '10px 14px', background: G.cardBg, border: `1px solid ${G.border}`, borderRadius: 8, fontSize: 13, color: G.textSec },
  editBtn: {
    flexShrink: 0, minHeight: 28, padding: '2px 10px',
    background: G.cardBg, border: `1px solid ${G.border}`, borderRadius: 6,
    fontSize: 12, fontWeight: 600, color: G.textSec, cursor: 'pointer',
  },
  rowMessages: { margin: '6px 0 0', padding: 0, listStyle: 'none', fontSize: 12, lineHeight: 1.6, display: 'flex', flexDirection: 'column' as const, gap: 2 },
  editGrid: { marginTop: 8, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(100px, 1fr))', gap: 8 },
  editLabel: { display: 'flex', flexDirection: 'column' as const, gap: 4, fontSize: 11, color: G.textSec, fontWeight: 600 },
}
