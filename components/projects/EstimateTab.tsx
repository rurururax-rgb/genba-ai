'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  DragDropContext,
  Droppable,
  Draggable,
  type DropResult,
  type DraggableProvidedDragHandleProps,
} from '@hello-pangea/dnd'
import { getClient } from '@/lib/supabase/client'

// ──────────────────────────────────────────────────────────
// 型定義
// ──────────────────────────────────────────────────────────

type EstimateGroup = {
  id: string
  label: string
  display_mode: 'detailed' | 'lump_sum'
  sort_order: number
}

type EstimateItem = {
  id: string
  name: string
  quantity: number
  unit: string
  selling_price: number | null
  amount: number | null
  group_id: string | null
  sort_order: number
  source: string
  line_event_id: string | null
  memo: string | null
}

const fmt = (v: number) => v.toLocaleString('ja-JP')

function reorder<T>(list: T[], from: number, to: number): T[] {
  const result = [...list]
  const [removed] = result.splice(from, 1)
  result.splice(to, 0, removed)
  return result
}

// ──────────────────────────────────────────────────────────
// GroupHeader
// ──────────────────────────────────────────────────────────

function GroupHeader({
  group,
  total,
  onLabelChange,
  onDisplayModeToggle,
  onDelete,
  dragHandleProps,
}: {
  group: EstimateGroup
  total: number
  onLabelChange: (label: string) => void
  onDisplayModeToggle: () => void
  onDelete: () => void
  dragHandleProps: DraggableProvidedDragHandleProps | null
}) {
  const [editing, setEditing] = useState(false)
  const [draft,   setDraft]   = useState(group.label)

  function commitLabel() {
    setEditing(false)
    if (draft !== group.label) onLabelChange(draft)
  }

  return (
    <div style={gs.header}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
        <div
          {...(dragHandleProps ?? {})}
          style={gs.handle}
          title="ドラッグして並び替え"
        >
          ⠿
        </div>
        {editing ? (
          <input
            value={draft}
            autoFocus
            onChange={e => setDraft(e.target.value)}
            onBlur={commitLabel}
            onKeyDown={e => {
              if (e.key === 'Enter')  { commitLabel(); return }
              if (e.key === 'Escape') { setDraft(group.label); setEditing(false) }
            }}
            style={gs.labelInput}
          />
        ) : (
          <span
            style={gs.labelText}
            onClick={() => { setDraft(group.label); setEditing(true) }}
            title="クリックで編集"
          >
            {group.label || '（グループ名未設定）'}
          </span>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        <span style={gs.total}>¥{fmt(total)}</span>
        <button
          style={{
            ...gs.modeBtn,
            background: group.display_mode === 'lump_sum' ? '#1e3a5f' : '#E4E8EE',
            color:      group.display_mode === 'lump_sum' ? '#fff'    : '#6B7280',
          }}
          onClick={onDisplayModeToggle}
          title={group.display_mode === 'detailed' ? '一括表示に切替' : '明細表示に切替'}
        >
          {group.display_mode === 'lump_sum' ? '一括' : '明細'}
        </button>
        <button style={gs.deleteBtn} onClick={onDelete} title="グループを削除">✕</button>
      </div>
    </div>
  )
}

// ──────────────────────────────────────────────────────────
// ItemRow
// ──────────────────────────────────────────────────────────

function ItemRow({
  item,
  editing,
  deleting,
  editQty,
  editPrice,
  onStartEdit,
  onQtyChange,
  onPriceChange,
  onSave,
  onCancelEdit,
  onDelete,
}: {
  item: EstimateItem
  editing: boolean
  deleting: boolean
  editQty: string
  editPrice: string
  onStartEdit: () => void
  onQtyChange: (v: string) => void
  onPriceChange: (v: string) => void
  onSave: () => void
  onCancelEdit: () => void
  onDelete: () => void
}) {
  if (editing) {
    const liveQty   = parseFloat(editQty)
    const livePrice = editPrice === '' ? null : parseFloat(editPrice)
    const liveAmt   = livePrice !== null && !isNaN(liveQty) && !isNaN(livePrice)
      ? `¥${fmt(Math.round(liveQty * livePrice))}`
      : '—'

    return (
      <div style={{ ...s.row, background: '#F0F7FF', minHeight: 44 }}>
        <span style={s.cName}>{item.name}</span>
        <input
          type="number" min="0" step="any"
          value={editQty}
          onChange={e => onQtyChange(e.target.value)}
          style={{ ...s.editInput, flex: 1 }}
          autoFocus
        />
        <span style={s.cUnit}>{item.unit}</span>
        <input
          type="number" min="0" step="any"
          value={editPrice}
          onChange={e => onPriceChange(e.target.value)}
          style={{ ...s.editInput, flex: 2 }}
          placeholder="単価"
        />
        <span style={s.cAmt}>{liveAmt}</span>
        <span style={s.cActions}>
          <button style={s.saveBtn}  onClick={onSave}>保存</button>
          <button style={s.iconBtn}  onClick={onCancelEdit}>✕</button>
        </span>
      </div>
    )
  }

  return (
    <div style={{ ...s.row, minHeight: 44 }}>
      <span style={s.cName}>
        {item.name}
        {item.line_event_id && <span style={s.lineBadge}>LINE</span>}
      </span>
      <span style={s.cQty}>{item.quantity}</span>
      <span style={s.cUnit}>{item.unit}</span>
      <span style={s.cPrice}>
        {item.selling_price != null ? `¥${fmt(item.selling_price)}` : '—'}
      </span>
      <span style={s.cAmt}>
        {item.amount != null ? `¥${fmt(item.amount)}` : '要確認'}
      </span>
      <span style={s.cActions}>
        <button style={s.iconBtn} onClick={onStartEdit} title="編集">✏</button>
        <button
          style={{ ...s.iconBtn, color: deleting ? '#9CA3AF' : '#EF4444' }}
          onClick={onDelete}
          disabled={deleting}
          title="削除"
        >
          {deleting ? '…' : '🗑'}
        </button>
      </span>
    </div>
  )
}

// ──────────────────────────────────────────────────────────
// EstimateTab
// ──────────────────────────────────────────────────────────

export function EstimateTab({ projectId }: { projectId: string }) {
  const supabase = useRef(getClient()).current

  const [groups,      setGroups]      = useState<EstimateGroup[]>([])
  const [items,       setItems]       = useState<EstimateItem[]>([])
  const [loading,     setLoading]     = useState(true)
  const [downloading, setDownloading] = useState(false)
  const [creating,    setCreating]    = useState(false)

  // 編集状態
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editQty,   setEditQty]   = useState('')
  const [editPrice, setEditPrice] = useState('')
  const [deleting,  setDeleting]  = useState<Record<string, boolean>>({})

  useEffect(() => {
    Promise.all([
      supabase
        .from('estimate_groups')
        .select('id, label, display_mode, sort_order')
        .eq('project_id', projectId)
        .is('deleted_at', null)
        .order('sort_order'),
      supabase
        .from('estimate_items')
        .select('id, name, quantity, unit, selling_price, amount, group_id, sort_order, source, line_event_id, memo')
        .eq('project_id', projectId)
        .is('deleted_at', null)
        .order('sort_order'),
    ]).then(([{ data: g }, { data: i }]) => {
      setGroups((g ?? []) as EstimateGroup[])
      setItems((i ?? []) as EstimateItem[])
      setLoading(false)
    })
  }, [projectId]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── 派生データ ──
  const ungroupedItems = useMemo(
    () => items.filter(i => !i.group_id).sort((a, b) => a.sort_order - b.sort_order),
    [items],
  )

  function itemsForGroup(groupId: string) {
    return items.filter(i => i.group_id === groupId).sort((a, b) => a.sort_order - b.sort_order)
  }

  const subtotal = useMemo(() => items.reduce((acc, i) => acc + (i.amount ?? 0), 0), [items])
  const tax      = Math.floor(subtotal * 0.1)
  const total    = subtotal + tax

  // ── 並び順の永続化 ──
  async function persistReorder(
    groupUpdates: { id: string; sort_order: number }[],
    itemUpdates:  { id: string; sort_order: number; group_id: string | null }[],
  ) {
    await fetch('/api/estimate-items/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groups: groupUpdates, items: itemUpdates }),
    })
  }

  // ── DnD ──
  function handleDragEnd(result: DropResult) {
    const { source, destination, type } = result
    if (!destination) return

    // グループの並び替え
    if (type === 'GROUP') {
      if (source.index === destination.index) return
      const newGroups = reorder(groups, source.index, destination.index)
        .map((g, i) => ({ ...g, sort_order: i * 1000 }))
      setGroups(newGroups)
      persistReorder(newGroups.map(g => ({ id: g.id, sort_order: g.sort_order })), [])
      return
    }

    // 項目の並び替え / グループ間移動
    if (type === 'ITEM') {
      const srcGroupId = source.droppableId === 'ungrouped'
        ? null
        : source.droppableId.replace('group-', '')
      const dstGroupId = destination.droppableId === 'ungrouped'
        ? null
        : destination.droppableId.replace('group-', '')

      const srcItems = items
        .filter(i => i.group_id === srcGroupId)
        .sort((a, b) => a.sort_order - b.sort_order)
      const dstItems = srcGroupId === dstGroupId
        ? srcItems
        : items.filter(i => i.group_id === dstGroupId).sort((a, b) => a.sort_order - b.sort_order)

      const movedItem = srcItems[source.index]
      if (!movedItem) return

      let updatedItems: EstimateItem[]

      if (srcGroupId === dstGroupId) {
        // 同グループ内の並び替え
        const reordered = reorder(srcItems, source.index, destination.index)
          .map((item, i) => ({ ...item, sort_order: i * 1000 }))
        updatedItems = items.map(i => reordered.find(u => u.id === i.id) ?? i)
      } else {
        // グループ間移動
        const newSrc = srcItems
          .filter((_, idx) => idx !== source.index)
          .map((item, i) => ({ ...item, sort_order: i * 1000 }))

        const newDst = [...dstItems]
        newDst.splice(destination.index, 0, { ...movedItem, group_id: dstGroupId })
        const newDstOrdered = newDst.map((item, i) => ({ ...item, sort_order: i * 1000 }))

        updatedItems = items.map(i => {
          const fromSrc = newSrc.find(u => u.id === i.id)
          if (fromSrc) return fromSrc
          const fromDst = newDstOrdered.find(u => u.id === i.id)
          if (fromDst) return fromDst
          return i
        })
      }

      setItems(updatedItems)

      const changed = updatedItems.filter(i => {
        const orig = items.find(o => o.id === i.id)
        return orig && (orig.sort_order !== i.sort_order || orig.group_id !== i.group_id)
      })
      persistReorder([], changed.map(i => ({ id: i.id, sort_order: i.sort_order, group_id: i.group_id })))
    }
  }

  // ── グループ操作 ──
  async function handleCreateGroup() {
    setCreating(true)
    try {
      const maxOrder = groups.length > 0 ? Math.max(...groups.map(g => g.sort_order)) + 1000 : 0
      const res = await fetch('/api/estimate-groups', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, label: '', sort_order: maxOrder }),
      })
      if (res.ok) {
        const newGroup = await res.json() as EstimateGroup
        setGroups(prev => [...prev, newGroup])
      }
    } finally {
      setCreating(false)
    }
  }

  async function handleGroupLabelChange(groupId: string, label: string) {
    setGroups(prev => prev.map(g => g.id === groupId ? { ...g, label } : g))
    await fetch(`/api/estimate-groups/${groupId}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label }),
    })
  }

  async function handleDisplayModeToggle(groupId: string) {
    const group = groups.find(g => g.id === groupId)
    if (!group) return
    const newMode = group.display_mode === 'detailed' ? 'lump_sum' : 'detailed'
    setGroups(prev => prev.map(g => g.id === groupId ? { ...g, display_mode: newMode } : g))
    await fetch(`/api/estimate-groups/${groupId}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_mode: newMode }),
    })
  }

  async function handleDeleteGroup(groupId: string) {
    if (!confirm('グループを削除しますか？\n項目はグループなしに移動されます。')) return
    const res = await fetch(`/api/estimate-groups/${groupId}`, { method: 'DELETE' })
    if (res.ok) {
      setGroups(prev => prev.filter(g => g.id !== groupId))
      setItems(prev => prev.map(i => i.group_id === groupId ? { ...i, group_id: null } : i))
    }
  }

  // ── 項目操作 ──
  function startEdit(item: EstimateItem) {
    setEditingId(item.id)
    setEditQty(String(item.quantity))
    setEditPrice(String(item.selling_price ?? ''))
  }

  function cancelEdit() {
    setEditingId(null)
    setEditQty('')
    setEditPrice('')
  }

  async function handleSave(itemId: string) {
    const qty   = parseFloat(editQty)
    const price = editPrice === '' ? null : parseFloat(editPrice)
    if (isNaN(qty) || qty < 0) return

    const res = await fetch(`/api/estimate-items/${itemId}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quantity: qty, selling_price: price }),
    })
    if (!res.ok) { alert('保存に失敗しました'); return }
    const updated = await res.json() as Partial<EstimateItem>
    setItems(prev => prev.map(i => i.id === itemId ? { ...i, ...updated } : i))
    cancelEdit()
  }

  async function handleDelete(itemId: string) {
    setDeleting(p => ({ ...p, [itemId]: true }))
    try {
      const res = await fetch(`/api/estimate-items/${itemId}`, { method: 'DELETE' })
      if (res.ok) setItems(prev => prev.filter(i => i.id !== itemId))
      else        alert('削除に失敗しました')
    } finally {
      setDeleting(p => { const n = { ...p }; delete n[itemId]; return n })
    }
  }

  // ── Excel 出力 ──
  async function handleExcelDownload() {
    setDownloading(true)
    try {
      const res = await fetch(`/api/projects/${projectId}/estimate/excel`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        alert((body as { error?: string }).error ?? 'ダウンロードに失敗しました')
        return
      }
      const blob = await res.blob()
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      a.href = url; a.download = '内訳明細書.xlsx'
      document.body.appendChild(a); a.click()
      document.body.removeChild(a); URL.revokeObjectURL(url)
    } finally {
      setDownloading(false)
    }
  }

  // ── ヘルパー: 項目行を DnD 対応でレンダリング ──
  function renderDraggableItem(item: EstimateItem, index: number) {
    return (
      <Draggable key={item.id} draggableId={`item-${item.id}`} index={index}>
        {(provided, snapshot) => (
          <div
            ref={provided.innerRef}
            {...provided.draggableProps}
            {...provided.dragHandleProps}
            style={{
              ...(snapshot.isDragging
                ? { background: '#EFF6FF', borderRadius: 6, opacity: 0.9 }
                : {}),
              ...provided.draggableProps.style,
            }}
          >
            <ItemRow
              item={item}
              editing={editingId === item.id}
              deleting={!!deleting[item.id]}
              editQty={editQty}
              editPrice={editPrice}
              onStartEdit={() => startEdit(item)}
              onQtyChange={setEditQty}
              onPriceChange={setEditPrice}
              onSave={() => handleSave(item.id)}
              onCancelEdit={cancelEdit}
              onDelete={() => handleDelete(item.id)}
            />
          </div>
        )}
      </Draggable>
    )
  }

  // ──────────────────────────────────────────────────────────
  // レンダリング
  // ──────────────────────────────────────────────────────────

  if (loading) return <div style={s.empty}>読み込み中...</div>

  if (!items.length && !groups.length) {
    return (
      <div style={s.empty}>
        <p style={{ margin: 0, color: '#8E8E93', fontSize: 14 }}>見積項目がありません。</p>
        <p style={{ margin: '8px 0 0', color: '#C7C7CC', fontSize: 12 }}>
          AI整理タブで候補を選択し「見積に追加」してください。
        </p>
      </div>
    )
  }

  const tableHeader = (
    <div style={{ ...s.row, ...s.headerRow }}>
      <span style={{ ...s.cName,  ...s.hCell }}>名称</span>
      <span style={{ ...s.cQty,   ...s.hCell }}>数量</span>
      <span style={{ ...s.cUnit,  ...s.hCell }}>単位</span>
      <span style={{ ...s.cPrice, ...s.hCell }}>単価</span>
      <span style={{ ...s.cAmt,   ...s.hCell }}>金額</span>
      <span style={s.cActions} />
    </div>
  )

  return (
    <div style={s.container}>
      <DragDropContext onDragEnd={handleDragEnd}>

        {/* ── グループ一覧（並び替え可能） ── */}
        <Droppable droppableId="group-list" type="GROUP">
          {provided => (
            <div
              ref={provided.innerRef}
              {...provided.droppableProps}
              style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
            >
              {groups.map((group, index) => {
                const groupItems = itemsForGroup(group.id)
                const groupTotal = groupItems.reduce((acc, i) => acc + (i.amount ?? 0), 0)

                return (
                  <Draggable key={group.id} draggableId={`group-${group.id}`} index={index}>
                    {(provided, snapshot) => (
                      <div
                        ref={provided.innerRef}
                        {...provided.draggableProps}
                        style={{
                          ...s.groupCard,
                          ...(snapshot.isDragging
                            ? { boxShadow: '0 8px 24px rgba(0,0,0,0.15)', opacity: 0.95 }
                            : {}),
                          ...provided.draggableProps.style,
                        }}
                      >
                        <GroupHeader
                          group={group}
                          total={groupTotal}
                          onLabelChange={label => handleGroupLabelChange(group.id, label)}
                          onDisplayModeToggle={() => handleDisplayModeToggle(group.id)}
                          onDelete={() => handleDeleteGroup(group.id)}
                          dragHandleProps={provided.dragHandleProps}
                        />

                        {group.display_mode === 'detailed' && (
                          <div style={s.tableWrap}>
                            {tableHeader}
                            <Droppable droppableId={`group-${group.id}`} type="ITEM">
                              {(provided, snapshot) => (
                                <div
                                  ref={provided.innerRef}
                                  {...provided.droppableProps}
                                  style={{
                                    minHeight: 40,
                                    background:   snapshot.isDraggingOver ? '#F0F7FF' : 'transparent',
                                    borderRadius: 8,
                                    transition:   'background 0.15s',
                                  }}
                                >
                                  {groupItems.map((item, idx) => renderDraggableItem(item, idx))}
                                  {provided.placeholder}
                                  {groupItems.length === 0 && (
                                    <div style={s.dropHint}>
                                      ここに項目をドラッグして追加
                                    </div>
                                  )}
                                </div>
                              )}
                            </Droppable>
                          </div>
                        )}

                        {group.display_mode === 'lump_sum' && (
                          <div style={{ color: '#6B7280', fontSize: 12, paddingTop: 4 }}>
                            {groupItems.length}項目を一括表示（明細は非表示）
                          </div>
                        )}
                      </div>
                    )}
                  </Draggable>
                )
              })}
              {provided.placeholder}
            </div>
          )}
        </Droppable>

        {/* ── グループなし項目 ── */}
        {(ungroupedItems.length > 0 || groups.length > 0) && (
          <div style={s.groupCard}>
            <div style={gs.ungroupedLabel}>グループなし</div>
            <div style={s.tableWrap}>
              {tableHeader}
              <Droppable droppableId="ungrouped" type="ITEM">
                {(provided, snapshot) => (
                  <div
                    ref={provided.innerRef}
                    {...provided.droppableProps}
                    style={{
                      minHeight: 40,
                      background:   snapshot.isDraggingOver ? '#F0F7FF' : 'transparent',
                      borderRadius: 8,
                      transition:   'background 0.15s',
                    }}
                  >
                    {ungroupedItems.map((item, idx) => renderDraggableItem(item, idx))}
                    {provided.placeholder}
                    {ungroupedItems.length === 0 && (
                      <div style={s.dropHint}>ここに項目をドラッグして移動</div>
                    )}
                  </div>
                )}
              </Droppable>
            </div>
          </div>
        )}

      </DragDropContext>

      {/* ── グループ追加 ── */}
      <button
        onClick={handleCreateGroup}
        disabled={creating}
        style={s.addGroupBtn}
      >
        {creating ? '作成中...' : '＋ グループを追加'}
      </button>

      {/* ── Excel 出力 ── */}
      <button
        onClick={handleExcelDownload}
        disabled={downloading}
        style={{
          ...s.excelBtn,
          ...(downloading ? { opacity: 0.5, cursor: 'not-allowed' as const } : {}),
        }}
      >
        {downloading ? '生成中...' : '📥 Excel出力（内訳明細書）'}
      </button>

      {/* ── 合計エリア ── */}
      <div style={s.totalArea}>
        <div style={s.totalRow}>
          <span style={s.totalLabel}>小計</span>
          <span style={s.totalValue}>¥{fmt(subtotal)}</span>
        </div>
        <div style={s.totalRow}>
          <span style={s.totalLabel}>消費税（10%）</span>
          <span style={s.totalValue}>¥{fmt(tax)}</span>
        </div>
        <div style={{ ...s.totalRow, ...s.grandTotalRow }}>
          <span style={{ ...s.totalLabel, color: '#1C1C1E', fontWeight: 600 }}>合計（税込）</span>
          <span style={s.grandTotal}>¥{fmt(total)}</span>
        </div>
      </div>

    </div>
  )
}

// ──────────────────────────────────────────────────────────
// スタイル
// ──────────────────────────────────────────────────────────

const gs = {
  header: {
    display: 'flex', alignItems: 'center', gap: 8,
    paddingBottom: 10, borderBottom: '1px solid #F5F7FA', marginBottom: 8,
  } as React.CSSProperties,
  handle: {
    cursor: 'grab', color: '#9CA3AF', fontSize: 18, flexShrink: 0,
    userSelect: 'none' as const, lineHeight: 1, paddingRight: 2,
  } as React.CSSProperties,
  labelText: {
    fontSize: 14, fontWeight: 600, color: '#1C1C1E',
    cursor: 'text', flex: 1, minWidth: 0,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const,
  } as React.CSSProperties,
  labelInput: {
    flex: 1, height: 30, borderRadius: 6, border: '1.5px solid #0A84FF',
    fontSize: 14, padding: '0 8px', color: '#0D1117', background: '#FFFFFF', minWidth: 0,
  } as React.CSSProperties,
  total: {
    fontSize: 18, fontWeight: 700, color: '#0D1117', letterSpacing: '-0.5px', flexShrink: 0,
  } as React.CSSProperties,
  modeBtn: {
    height: 26, padding: '0 10px', borderRadius: 13, border: 'none',
    fontSize: 11, fontWeight: 600, cursor: 'pointer', flexShrink: 0,
  } as React.CSSProperties,
  deleteBtn: {
    width: 26, height: 26, borderRadius: 6, border: 'none',
    background: 'none', cursor: 'pointer', color: '#EF4444', fontSize: 12,
    flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
  } as React.CSSProperties,
  ungroupedLabel: {
    fontSize: 12, fontWeight: 600, color: '#9CA3AF', marginBottom: 6,
    textTransform: 'uppercase' as const, letterSpacing: '0.05em',
  } as React.CSSProperties,
}

const s = {
  container: { padding: '12px 16px', display: 'flex', flexDirection: 'column' as const, gap: 12 },
  empty:     { padding: 40, textAlign: 'center' as const },

  groupCard: {
    background: '#FFFFFF', borderRadius: 16,
    boxShadow: '0 2px 8px rgba(0,0,0,0.07), 0 0 0 1px rgba(0,0,0,0.04)',
    padding: '16px 16px 14px',
    display: 'flex', flexDirection: 'column' as const,
  },

  tableWrap: { overflow: 'hidden' },
  row: {
    display: 'flex', alignItems: 'center',
    padding: '8px 0', borderBottom: '1px solid #F5F7FA', gap: 6,
  },
  headerRow: { background: 'transparent', borderBottom: '1px solid #E4E8EE' },
  hCell:     {
    fontSize: 10, fontWeight: 500, color: '#9CA3AF',
    textTransform: 'uppercase' as const, letterSpacing: '0.3px',
  },

  cName:  { flex: 3, fontSize: 13, color: '#0D1117' } as React.CSSProperties,
  cQty:   { flex: 1, fontSize: 13, color: '#6B7280', textAlign: 'right'  as const },
  cUnit:  { flex: 1, fontSize: 13, color: '#6B7280', textAlign: 'center' as const },
  cPrice: { flex: 2, fontSize: 13, color: '#6B7280', textAlign: 'right'  as const },
  cAmt:   { flex: 2, fontSize: 13, color: '#0D1117', fontWeight: 500, textAlign: 'right' as const },

  lineBadge: {
    display: 'inline-block', marginLeft: 5, padding: '1px 4px',
    borderRadius: 4, fontSize: 10, background: '#EFF6FF', color: '#1E40AF',
    fontWeight: 600, verticalAlign: 'middle',
  },

  dropHint: {
    padding: '12px 0', color: '#C7C7CC', fontSize: 12,
    textAlign: 'center' as const, pointerEvents: 'none' as const,
  },

  totalArea: {
    background: '#FFFFFF', borderRadius: 16,
    boxShadow: '0 2px 8px rgba(0,0,0,0.07), 0 0 0 1px rgba(0,0,0,0.04)',
    padding: '16px 18px', display: 'flex', flexDirection: 'column' as const, gap: 10,
  },
  totalRow:      { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  grandTotalRow: { borderTop: '1px solid #E4E8EE', paddingTop: 12, marginTop: 2 },
  totalLabel:    { fontSize: 14, color: '#6B7280' },
  totalValue:    { fontSize: 15, color: '#6B7280', fontWeight: 500 },
  grandTotal:    { fontSize: 24, fontWeight: 700, color: '#0D1117', letterSpacing: '-0.5px' },

  addGroupBtn: {
    height: 40, borderRadius: 10, border: '1.5px dashed #C7C7CC',
    background: 'transparent', color: '#6B7280', fontSize: 14,
    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  excelBtn: {
    height: 44, borderRadius: 10, border: '1px solid #E4E8EE',
    background: '#FFFFFF', color: '#0D1117', fontSize: 14,
    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
  },

  cActions: {
    width: 60, flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 2,
  } as React.CSSProperties,
  iconBtn: {
    width: 28, height: 28, borderRadius: 6, border: 'none', background: 'none',
    cursor: 'pointer', fontSize: 14,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: '#9CA3AF', padding: 0,
  } as React.CSSProperties,
  saveBtn: {
    height: 28, padding: '0 8px', borderRadius: 6, border: 'none',
    background: '#0A84FF', color: '#FFFFFF', fontSize: 11, fontWeight: 700,
    cursor: 'pointer', whiteSpace: 'nowrap' as const,
  },
  editInput: {
    minWidth: 0, height: 28, borderRadius: 6, border: '1.5px solid #0A84FF',
    fontSize: 12, padding: '0 6px', color: '#0D1117',
    textAlign: 'right' as const, background: '#FFFFFF',
  } as React.CSSProperties,
} as const
