'use client'

import { useState, useCallback } from 'react'

type ProjectInfo = {
  id: string
  name: string | null
  customer_name: string | null
  site_address: string | null
  person_in_charge: string | null
  construction_period: string | null
  payment_terms: string | null
  estimate_valid_from: string | null
  estimate_valid_months: number | null
  construction_overview: string | null
  project_memo: string | null
  payment_contract_pct: number | null
  payment_start_pct: number | null
  payment_completion_pct: number | null
}

// ── スタイル定数 ────────────────────────────────────────────

const FONT = "'Hiragino Kaku Gothic ProN', 'Yu Gothic', Meiryo, sans-serif"
const C = {
  bg:       '#F3F7F4',
  card:     '#FFFFFF',
  border:   '#DDE5E0',
  accent:   '#3D7A55',
  accentBg: '#EAF3DE',
  label:    '#6B7A74',
  text:     '#1A2E24',
  muted:    '#94A3B8',
  divider:  '#EEF2EF',
  warning:  '#92400E',
  warningBg:'#FEF3C7',
}

const s: Record<string, React.CSSProperties> = {
  wrap: {
    padding: '20px 16px 40px',
    maxWidth: 760,
    margin: '0 auto',
    fontFamily: FONT,
  },
  section: {
    background: C.card,
    border: `1px solid ${C.border}`,
    borderRadius: 12,
    marginBottom: 16,
    overflow: 'hidden',
  },
  sectionHead: {
    padding: '12px 16px',
    borderBottom: `1px solid ${C.divider}`,
    fontSize: 12,
    fontWeight: 700,
    color: C.accent,
    letterSpacing: '0.06em',
    background: C.accentBg,
  },
  sectionBody: {
    padding: '4px 0',
  },
  row: {
    display: 'grid',
    gridTemplateColumns: '140px 1fr',
    alignItems: 'start',
    borderBottom: `1px solid ${C.divider}`,
    minHeight: 44,
  },
  label: {
    padding: '11px 14px',
    fontSize: 12,
    color: C.label,
    fontWeight: 600,
    lineHeight: '22px',
  },
  valueWrap: {
    padding: '6px 10px 6px 0',
    display: 'flex',
    alignItems: 'center',
    minHeight: 44,
  },
  input: {
    width: '100%',
    border: `1px solid ${C.border}`,
    borderRadius: 6,
    padding: '7px 10px',
    fontSize: 13,
    fontFamily: FONT,
    color: C.text,
    background: '#FAFCFB',
    outline: 'none',
    transition: 'border-color 0.15s, box-shadow 0.15s',
  },
  textarea: {
    width: '100%',
    border: `1px solid ${C.border}`,
    borderRadius: 6,
    padding: '7px 10px',
    fontSize: 13,
    fontFamily: FONT,
    color: C.text,
    background: '#FAFCFB',
    outline: 'none',
    resize: 'vertical',
    minHeight: 60,
    lineHeight: '1.5',
    transition: 'border-color 0.15s, box-shadow 0.15s',
  },
  numInput: {
    width: 72,
    border: `1px solid ${C.border}`,
    borderRadius: 6,
    padding: '7px 10px',
    fontSize: 13,
    fontFamily: FONT,
    color: C.text,
    background: '#FAFCFB',
    outline: 'none',
    textAlign: 'right',
  },
  unit: {
    fontSize: 12,
    color: C.label,
    marginLeft: 6,
  },
  saveBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    background: C.accent,
    color: '#fff',
    border: 'none',
    borderRadius: 8,
    padding: '10px 20px',
    fontSize: 13,
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: FONT,
  },
  saveBtnDisabled: {
    opacity: 0.5,
    cursor: 'not-allowed',
  },
  payRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 16,
    flexWrap: 'wrap' as const,
  },
  payItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 13,
  },
  payLabel: {
    fontSize: 12,
    color: C.label,
    fontWeight: 600,
  },
  toast: {
    position: 'fixed' as const,
    bottom: 24,
    left: '50%',
    transform: 'translateX(-50%)',
    background: C.accent,
    color: '#fff',
    padding: '10px 24px',
    borderRadius: 20,
    fontSize: 13,
    fontWeight: 600,
    fontFamily: FONT,
    zIndex: 9999,
    boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
    pointerEvents: 'none' as const,
  },
}

// ── フォームフィールドのヘルパー ────────────────────────────

function Field({
  label, children,
}: { label: string; children: React.ReactNode }) {
  return (
    <div style={s.row}>
      <div style={s.label}>{label}</div>
      <div style={s.valueWrap}>{children}</div>
    </div>
  )
}

// ── メインコンポーネント ────────────────────────────────────

export function ProjectInfoPanel({ project }: { project: ProjectInfo }) {
  const [form, setForm] = useState<ProjectInfo>({ ...project })
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState('')

  const set = useCallback(<K extends keyof ProjectInfo>(key: K, val: ProjectInfo[K]) => {
    setForm(prev => ({ ...prev, [key]: val }))
  }, [])

  const paySum = (form.payment_contract_pct ?? 0)
              + (form.payment_start_pct    ?? 0)
              + (form.payment_completion_pct ?? 0)
  const payValid = paySum === 100

  async function save() {
    setSaving(true)
    try {
      const res = await fetch(`/api/projects/${project.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      if (!res.ok) throw new Error(await res.text())
      setToast('保存しました')
      setTimeout(() => setToast(''), 2500)
    } catch (e) {
      console.error(e)
      setToast('保存に失敗しました')
      setTimeout(() => setToast(''), 2500)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={s.wrap}>

      {/* ── 顧客・現場情報 ── */}
      <div style={s.section}>
        <div style={s.sectionHead}>顧客・現場情報</div>
        <div style={s.sectionBody}>
          <Field label="顧客名（様）">
            <input
              style={s.input}
              value={form.customer_name ?? ''}
              onChange={e => set('customer_name', e.target.value || null)}
              placeholder="例：谷口"
            />
          </Field>
          <Field label="工事名">
            <input
              style={s.input}
              value={form.name ?? ''}
              onChange={e => set('name', e.target.value || null)}
              placeholder="例：谷口様リフォーム"
            />
          </Field>
          <Field label="工事場所">
            <input
              style={s.input}
              value={form.site_address ?? ''}
              onChange={e => set('site_address', e.target.value || null)}
              placeholder="例：各務原市蘇原中央町２丁目40"
            />
          </Field>
          <Field label="担当者">
            <input
              style={s.input}
              value={form.person_in_charge ?? ''}
              onChange={e => set('person_in_charge', e.target.value || null)}
              placeholder="例：栗本 佳一"
            />
          </Field>
        </div>
      </div>

      {/* ── 見積・工期 ── */}
      <div style={s.section}>
        <div style={s.sectionHead}>見積・工期</div>
        <div style={s.sectionBody}>
          <Field label="工期">
            <input
              style={s.input}
              value={form.construction_period ?? ''}
              onChange={e => set('construction_period', e.target.value || null)}
              placeholder="例：お打ち合わせによる"
            />
          </Field>
          <Field label="見積有効期間">
            <input
              type="date"
              style={{ ...s.input, width: 150 }}
              value={form.estimate_valid_from ?? ''}
              onChange={e => set('estimate_valid_from', e.target.value || null)}
            />
            <span style={s.unit}>より</span>
            <input
              type="number"
              style={{ ...s.numInput, marginLeft: 8 }}
              value={form.estimate_valid_months ?? 1}
              min={1} max={12}
              onChange={e => set('estimate_valid_months', Number(e.target.value))}
            />
            <span style={s.unit}>か月</span>
          </Field>
          <Field label="御支払条件">
            <input
              style={s.input}
              value={form.payment_terms ?? ''}
              onChange={e => set('payment_terms', e.target.value || null)}
              placeholder="例：お支払イメージは下記参照"
            />
          </Field>
        </div>
      </div>

      {/* ── 支払内訳 ── */}
      <div style={s.section}>
        <div style={s.sectionHead}>支払内訳（合計100%）</div>
        <div style={s.sectionBody}>
          <Field label="支払割合">
            <div style={s.payRow}>
              {(
                [
                  { key: 'payment_contract_pct',    label: '契約時' },
                  { key: 'payment_start_pct',        label: '着工時' },
                  { key: 'payment_completion_pct',   label: '完工時' },
                ] as { key: keyof ProjectInfo; label: string }[]
              ).map(({ key, label }) => (
                <div key={key} style={s.payItem}>
                  <span style={s.payLabel}>{label}</span>
                  <input
                    type="number"
                    style={s.numInput}
                    value={(form[key] as number | null) ?? 0}
                    min={0} max={100}
                    onChange={e => set(key, Number(e.target.value))}
                  />
                  <span style={s.unit}>%</span>
                </div>
              ))}
              <span style={{
                fontSize: 12,
                color: payValid ? C.accent : C.warning,
                fontWeight: 600,
                background: payValid ? C.accentBg : C.warningBg,
                padding: '3px 10px',
                borderRadius: 12,
              }}>
                合計 {paySum}%
              </span>
            </div>
          </Field>
        </div>
      </div>

      {/* ── 工事概要・備考 ── */}
      <div style={s.section}>
        <div style={s.sectionHead}>工事概要・備考</div>
        <div style={s.sectionBody}>
          <Field label="工事概要">
            <textarea
              style={s.textarea}
              value={form.construction_overview ?? ''}
              onChange={e => set('construction_overview', e.target.value || null)}
              placeholder="例：内訳明細書に準ずる"
            />
          </Field>
          <Field label="備考">
            <textarea
              style={s.textarea}
              value={form.project_memo ?? ''}
              onChange={e => set('project_memo', e.target.value || null)}
              placeholder="例：工事中に電気・水道を使用させて頂きます"
            />
          </Field>
        </div>
      </div>

      {/* ── 保存 + 挨拶回り出力 ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
        <a
          href={`/projects/${form.id}/greeting`}
          target="_blank"
          rel="noreferrer"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '8px 16px', borderRadius: 8,
            background: '#E3EFE7', color: '#2B5E40', border: '1px solid #BDD1C3',
            fontSize: 13, fontWeight: 600, textDecoration: 'none',
            fontFamily: FONT,
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
            <line x1="16" y1="13" x2="8" y2="13"/>
            <line x1="16" y1="17" x2="8" y2="17"/>
          </svg>
          挨拶回り文書を出力
        </a>
        <button
          style={{ ...s.saveBtn, ...(saving ? s.saveBtnDisabled : {}) }}
          onClick={save}
          disabled={saving}
        >
          {saving ? '保存中…' : '保存する'}
        </button>
      </div>

      {/* ── トースト ── */}
      {toast && <div style={s.toast}>{toast}</div>}
    </div>
  )
}
