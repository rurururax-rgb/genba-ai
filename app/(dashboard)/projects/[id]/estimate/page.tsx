import React from 'react'
import { getServerClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { PrintButton } from './PrintButton'

type Params = { params: Promise<{ id: string }> }

type Item = {
  id: string
  name: string | null
  category: string | null
  quantity: number
  unit: string | null
  selling_price: number | null
  retail_price: number | null
  amount: number | null
  group_id: string | null
  sort_order: number
  memo: string | null
  row_type: string | null
}

type GroupData = {
  id: string | null
  label: string
  items: Item[]
  subtotal: number
  no: number
}

// ── 定数 ──────────────────────────────────────────────────────────────

const SALMON = '#EAA57C'
const BOR    = '1px solid #888'
const FONT   = "'Hiragino Kaku Gothic ProN', 'Yu Gothic', 'Meiryo UI', Meiryo, sans-serif"
const ROW_H  = 24

// 列幅（合計 ≈ 812px。テーブルは width:100% で引き伸ばされる）
// 種別(cat)は狭め・名称(name)は広め。ヘッダーは colSpan=2 で統合して「名称」1つ表示
const COL = { no: 28, cat: 90, name: 190, qty: 44, unit: 36, price: 78, amount: 88, retail: 72, note: 186 }

// ── ユーティリティ ─────────────────────────────────────────────────────

function n(v: number | null | undefined): string {
  if (v == null) return ''
  return Math.round(Math.abs(v)).toLocaleString('ja-JP')
}

function isSection(s: string | null)  { return /^【.*】/.test((s ?? '').trim()) }
function isWarning(s: string | null)  { return /^※/.test((s ?? '').trim()) }
function isBlank(s: string | null)    { return !(s ?? '').trim() }

// ── 共通スタイル ───────────────────────────────────────────────────────

const td0: React.CSSProperties = {
  border: BOR, padding: '2px 6px', fontSize: 11.5,
  height: ROW_H, lineHeight: `${ROW_H}px`,
  verticalAlign: 'middle', fontFamily: FONT, fontWeight: 500,
  fontVariantNumeric: 'tabular-nums', overflow: 'hidden', whiteSpace: 'nowrap',
}
const th0: React.CSSProperties = {
  border: BOR, padding: '4px 6px', fontSize: 11.5,
  fontWeight: 700, textAlign: 'center', fontFamily: FONT,
  background: SALMON, whiteSpace: 'nowrap',
}
// 名称・仕様など長文を折り返す列用
const tdWrap: React.CSSProperties = {
  ...td0,
  whiteSpace: 'normal', overflow: 'visible',
  lineHeight: '1.5', verticalAlign: 'top',
  paddingTop: 5, paddingBottom: 5, wordBreak: 'break-word',
  height: ROW_H,  // テーブルでは min-height として機能する
}

// ── ページ共通パーツ（関数） ────────────────────────────────────────────

function Title({ page }: { page: number }) {
  return (
    <div style={{ position: 'relative', textAlign: 'center', marginBottom: 7, fontFamily: FONT }}>
      <span style={{ fontSize: 16, fontWeight: 700, letterSpacing: '0.6em' }}>内　訳　明　細　書</span>
      <span style={{ position: 'absolute', right: 0, top: 2, fontSize: 12 }}>{page}</span>
    </div>
  )
}

function ColGroup() {
  return (
    <colgroup>
      <col style={{ width: COL.no }} />
      <col style={{ width: COL.cat }} />
      <col style={{ width: COL.name }} />
      <col style={{ width: COL.qty }} />
      <col style={{ width: COL.unit }} />
      <col style={{ width: COL.price }} />
      <col style={{ width: COL.amount }} />
      <col style={{ width: COL.retail }} />
      <col style={{ width: COL.note }} />
    </colgroup>
  )
}

function THead() {
  return (
    <thead>
      <tr>
        <th style={th0}></th>
        <th colSpan={2} style={th0}>名　称</th>
        <th style={th0}>数量</th>
        <th style={th0}>呼称</th>
        <th style={th0}>単　価</th>
        <th style={th0}>金　額</th>
        <th style={th0}>定価</th>
        <th style={th0}>備　考</th>
      </tr>
    </thead>
  )
}

function EmptyRow() {
  return (
    <tr>
      <td style={td0}></td>
      <td style={td0}></td>
      <td style={td0}></td>
      <td style={td0}></td>
      <td style={td0}></td>
      <td style={td0}></td>
      <td style={td0}></td>
      <td style={td0}></td>
      <td style={td0}></td>
    </tr>
  )
}

function CompanyName({ name }: { name: string }) {
  return (
    <div style={{ textAlign: 'right', marginTop: 5, fontSize: 11, fontWeight: 700, fontFamily: FONT }}>
      {name}
    </div>
  )
}

// ── メインコンポーネント ───────────────────────────────────────────────

export default async function EstimateDocumentPage({ params }: Params) {
  const { id: projectId } = await params
  const supabase = await getServerClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: project } = await supabase
    .from('projects')
    .select(`
      id, name, customer_name, site_address,
      misc_expense_override, rounding_discount,
      person_in_charge, construction_period,
      estimate_valid_from, estimate_valid_months,
      construction_overview, project_memo
    `)
    .eq('id', projectId)
    .single()
  if (!project) redirect('/projects')

  const { data: membership } = await supabase
    .from('company_members')
    .select('company_id, companies(name, display_name, tax_rate)')
    .eq('user_id', user.id)
    .single()
  const company = membership?.companies as unknown as { name: string; display_name: string | null; tax_rate: number } | null

  const { data: groups } = await supabase
    .from('estimate_groups')
    .select('id, label, sort_order')
    .eq('project_id', projectId)
    .is('deleted_at', null)
    .order('sort_order')

  const { data: rawItems } = await supabase
    .from('estimate_items')
    .select('id, name, category, quantity, unit, selling_price, retail_price, amount, group_id, sort_order, memo, row_type')
    .eq('project_id', projectId)
    .is('deleted_at', null)
    .order('sort_order')

  const items = (rawItems ?? []) as Item[]
  const taxRate = company?.tax_rate ?? 0.10

  // グループ集計
  const grouped: GroupData[] = (groups ?? []).map((g, gi) => {
    const gItems = items.filter(i => i.group_id === g.id)
    return {
      id: g.id, label: g.label,
      items: gItems,
      subtotal: gItems.reduce((s, i) => s + (i.amount ?? 0), 0),
      no: gi + 1,
    }
  })
  const ungrouped = items.filter(i => !i.group_id)
  if (ungrouped.length > 0) {
    grouped.push({
      id: null, label: 'その他', items: ungrouped,
      subtotal: ungrouped.reduce((s, i) => s + (i.amount ?? 0), 0),
      no: grouped.length + 1,
    })
  }

  const p = project as typeof project & { misc_expense_override?: number | null; rounding_discount?: number | null }
  const subtotalAll     = grouped.reduce((s, g) => s + g.subtotal, 0)
  const miscExpense     = p.misc_expense_override != null ? p.misc_expense_override : Math.round(subtotalAll * 0.08)
  const roundingDiscount = p.rounding_discount ?? 0
  const taxBase         = subtotalAll + miscExpense - roundingDiscount
  const taxAmount       = Math.floor(taxBase * taxRate)
  const grandTotal      = taxBase + taxAmount

  const companyName = company?.display_name ?? company?.name ?? 'ラグズ建築'

  // 表紙用の日付計算
  const now = new Date()
  const issuedDateStr = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日`
  // 見積有効期間: estimate_valid_from + estimate_valid_months ヶ月、または発行日からNヶ月
  const validMonths = (project as typeof project & { estimate_valid_months?: number | null }).estimate_valid_months
  const validFrom   = (project as typeof project & { estimate_valid_from?: string | null }).estimate_valid_from
  let validStr = '—'
  if (validMonths) {
    const base = validFrom ? new Date(validFrom) : now
    const exp  = new Date(base)
    exp.setMonth(exp.getMonth() + validMonths)
    validStr = `${base.getFullYear()}年${base.getMonth() + 1}月${base.getDate()}日 〜 ${exp.getFullYear()}年${exp.getMonth() + 1}月${exp.getDate()}日（${validMonths}ヶ月）`
  }

  const p2 = project as typeof project & {
    person_in_charge?: string | null
    construction_period?: string | null
    construction_overview?: string | null
    project_memo?: string | null
  }

  // 総括表の空行数（最低 12 行確保）
  const summaryFiller = Math.max(0, 12 - grouped.length)
  // 明細ページの空行数（最低 20 データ行 = グループヘッダー1行 + 最低 19 行）
  const DETAIL_MIN = 19

  // 明細ページをチャンクに分割（グループが19行超の場合は複数ページに分割）
  type PageInfo = {
    group: GroupData
    chunk: Item[]
    chunkIndex: number
    isLastChunk: boolean
    isLastPage: boolean
    pageNumber: number
    chunkSubtotal: number
  }
  let pageCounter = 2
  const detailPages: PageInfo[] = []
  for (let gi = 0; gi < grouped.length; gi++) {
    const g = grouped[gi]
    const numChunks = Math.max(1, Math.ceil(g.items.length / DETAIL_MIN))
    for (let ci = 0; ci < numChunks; ci++) {
      const chunk = g.items.slice(ci * DETAIL_MIN, (ci + 1) * DETAIL_MIN)
      const isLastChunk = ci === numChunks - 1
      const isLastPage  = isLastChunk && gi === grouped.length - 1
      const chunkSubtotal = chunk.reduce((s, i) => s + (i.amount ?? 0), 0)
      detailPages.push({ group: g, chunk, chunkIndex: ci, isLastChunk, isLastPage, pageNumber: pageCounter, chunkSubtotal })
      pageCounter++
    }
  }

  const pageStyle: React.CSSProperties = {
    background: '#fff',
    width: 1050,
    margin: '0 auto 32px',
    padding: '18px 20px 14px',
    boxShadow: '0 2px 10px rgba(0,0,0,0.14)',
    fontFamily: FONT,
  }

  return (
    <>
      <style>{`
        @media print {
          *, *::before, *::after {
            print-color-adjust: exact !important;
            -webkit-print-color-adjust: exact !important;
          }
          /* ナビ・サイドバーを非表示 */
          .no-print { display: none !important; }
          nav { display: none !important; }

          html, body {
            background: white !important;
            margin: 0 !important;
            padding: 0 !important;
            overflow: visible !important;
            height: auto !important;
          }

          /* レイアウトの overflow:hidden / h-dvh をリセットして全ページ印刷 */
          #dashboard-layout {
            overflow: visible !important;
            height: auto !important;
            display: block !important;
          }
          #dashboard-main {
            overflow: visible !important;
            height: auto !important;
            padding-bottom: 0 !important;
            background: white !important;
          }

          .print-wrapper {
            background: white !important;
            padding: 0 !important;
            min-height: 0 !important;
          }
          .doc-page {
            box-shadow: none !important;
            margin: 0 !important;
            width: 100% !important;
            padding: 10mm 12mm !important;
          }
          .page-break {
            page-break-after: always;
            break-after: page;
          }
        }
        /* margin: 0 でブラウザ自動ヘッダー／フッター（タイトル・URL・ページ番号）を非表示 */
        @page { size: A4 landscape; margin: 0; }
        * { box-sizing: border-box; }
        body { margin: 0; }
        /* 見積書ページ: 画面表示時もサイドバー・ボトムナビを非表示 */
        #dashboard-layout > .no-print { display: none !important; }
      `}</style>

      {/* コントロールバー */}
      <div className="no-print" style={{
        position: 'fixed', top: 0, left: 0, right: 0, zIndex: 100,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 20px', background: '#2B3A4A',
        boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
      }}>
        <a href={`/projects/${projectId}`} style={{
          color: '#90B8CC', fontSize: 13, fontWeight: 600, textDecoration: 'none',
        }}>
          ← 案件詳細へ戻る
        </a>
        <PrintButton />
      </div>

      <div className="print-wrapper" style={{ background: '#CCCCCC', minHeight: '100vh', paddingTop: 58, paddingBottom: 40 }}>

        {/* ─────────────────────────────────────────────────────
            表紙（Page 0）: 御見積書
            Excel の「見積表紙」シートに相当。
            L2=顧客名, L4=現場住所, L6=見積有効期間,
            L10=担当者, L13=工期, H57=税込合計金額
        ───────────────────────────────────────────────────── */}
        {/*
          A4 横向き比率: 1050px幅 → 高さ = 1050 × (210/297) = 741px
          Excel 見積表紙と同じ行構成で verticalに配置する
        */}
        <div className="doc-page page-break" style={{
          ...pageStyle,
          padding: '18px 22px 14px',
          height: 741,
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          fontFamily: FONT,
        }}>

          {/* ── タイトル ── */}
          <div style={{ textAlign: 'center', fontSize: 20, fontWeight: 700, letterSpacing: '1em', paddingLeft: '1em', paddingBottom: 14, paddingTop: 4 }}>
            御　見　積　書
          </div>

          {/* ── Row1: 顧客名+様 / 金額ラベル / 金額枠 / ハイフン ── */}
          {/* alignItems:stretch で全列が同じ高さ(52px)になり、二重線と金額枠が横に揃う */}
          <div style={{ display: 'flex', alignItems: 'stretch', height: 52 }}>
            <div style={{ width: '3%', flexShrink: 0 }} />
            {/* 顧客名 + 様（名前は左・様は右端に右寄せ・二重線はこのdiv底） */}
            <div style={{ width: '22%', flexShrink: 0, display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', borderBottom: '2.5pt double #000', paddingBottom: 4, paddingRight: 8 }}>
              <span style={{ fontSize: 18, fontWeight: 700 }}>{project.customer_name || '　'}</span>
              <span style={{ fontSize: 11, paddingBottom: 1 }}>様邸</span>
            </div>
            {/* 金額ラベル（枠外・二重線と同じ高さに揃う） */}
            <div style={{ width: '8%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700 }}>
              金　額
            </div>
            {/* 金額枠（数字のみ囲む・A4中央付近に収まる幅） */}
            <div style={{ width: '40%', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1.5px solid #333' }}>
              <span style={{ fontSize: 26, fontWeight: 900, fontVariantNumeric: 'tabular-nums', letterSpacing: '0.02em' }}>
                ¥{grandTotal.toLocaleString('ja-JP')}
              </span>
            </div>
            {/* ハイフン（金額の締め記号） */}
            <div style={{ width: '6%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, color: '#333' }}>
              ―
            </div>
            <div style={{ width: '21%', flexShrink: 0 }} />
          </div>

          {/* ── Row2: (消費税込み) ── */}
          <div style={{ display: 'flex', height: 20, marginBottom: 10 }}>
            <div style={{ width: '33%', flexShrink: 0 }} />
            <div style={{ width: '40%', textAlign: 'right', fontSize: 11, paddingTop: 3, paddingRight: 6 }}>
              （消費税込み）
            </div>
            <div style={{ width: '27%', flexShrink: 0 }} />
          </div>

          {/* ── 工事情報テーブル（flex:1 で残り高さを埋める） ── */}
          <div style={{ flex: 1, minHeight: 0 }}>
            {(() => {
              const LBL: React.CSSProperties = {
                border: '0.5px solid #888', padding: '0 8px',
                fontWeight: 700, fontSize: 11, whiteSpace: 'nowrap',
                background: '#F5F5F5', verticalAlign: 'middle',
              }
              const VAL: React.CSSProperties = {
                border: '0.5px solid #888', padding: '0 8px',
                fontSize: 11, verticalAlign: 'middle',
              }
              return (
                <table style={{ width: '100%', height: '100%', borderCollapse: 'collapse' }}>
                  <colgroup>
                    <col style={{ width: '3%' }} />
                    <col style={{ width: '11%' }} />
                    <col style={{ width: '39%' }} />
                    <col style={{ width: '11%' }} />
                    <col style={{ width: '32%' }} />
                    <col style={{ width: '4%' }} />
                  </colgroup>
                  <tbody>
                    <tr style={{ height: '16.67%' }}>
                      <td />
                      <td style={LBL}>工　　事　　名</td>
                      <td style={VAL}>{project.name || '—'}</td>
                      <td style={LBL}>御支払条件</td>
                      <td style={{ ...VAL, fontSize: 10 }}>お支払イメージは下記参照</td>
                      <td />
                    </tr>
                    <tr style={{ height: '16.67%' }}>
                      <td />
                      <td style={LBL}>工　事　場　所</td>
                      <td style={VAL}>{project.site_address || '—'}</td>
                      <td style={LBL} />
                      <td style={{ ...VAL, fontSize: 9.5, color: '#c00' }}>※振込手数料はお施主様負担でお願いいたします</td>
                      <td />
                    </tr>
                    <tr style={{ height: '16.67%' }}>
                      <td />
                      <td style={LBL}>工　　　　　　期</td>
                      <td style={VAL}>{p2.construction_period || 'お打ち合わせによる'}</td>
                      <td style={LBL} />
                      <td style={VAL} />
                      <td />
                    </tr>
                    <tr style={{ height: '16.67%' }}>
                      <td />
                      <td style={LBL}>見積有効期間</td>
                      <td style={VAL}>{validStr}</td>
                      <td style={LBL}>担　当　者</td>
                      <td style={VAL}>{p2.person_in_charge || '—'}</td>
                      <td />
                    </tr>
                    <tr style={{ height: '16.67%' }}>
                      <td />
                      <td style={LBL}>工　事　概　要</td>
                      <td colSpan={3} style={VAL}>{p2.construction_overview || '内訳明細書に準ずる'}</td>
                      <td />
                    </tr>
                    <tr style={{ height: '16.67%' }}>
                      <td />
                      <td style={LBL}>（備　　　考）</td>
                      <td colSpan={3} style={VAL}>{p2.project_memo || '工事中に電気・水道を使用させて頂きます。'}</td>
                      <td />
                    </tr>
                  </tbody>
                </table>
              )
            })()}
          </div>

          {/* ── スペーサー ── */}
          <div style={{ height: 20 }} />

          {/* ── 上記のとおり ── */}
          <div style={{ paddingTop: 9, paddingBottom: 9, fontSize: 12, textAlign: 'center', letterSpacing: '0.08em', marginBottom: 14 }}>
            上記のとおり御見積り申しあげます
          </div>

          {/* ── お支払イメージ（契約時・着工時・完工時）+ ロゴ + 捺印 ── */}
          <div style={{ paddingLeft: '8%', paddingRight: '3%' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#c00', marginBottom: 3 }}>
              お支払イメージ
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-start' }}>
              {/* 3ボックス（grandTotal × % で計算）・ロゴ上面と上揃え */}
              <div style={{ flex: '0 0 48%', display: 'flex', alignItems: 'stretch' }}>
                {[
                  { label: '契約時', pct: 20 },
                  { label: '着工時', pct: 50 },
                  { label: '完工時', pct: 30 },
                ].map((item, i, arr) => {
                  const yen = Math.round(grandTotal * item.pct / 100)
                  return (
                    <React.Fragment key={item.label}>
                      <div style={{ flex: 1, border: '1px solid #555', padding: '8px 4px', textAlign: 'center' }}>
                        <div style={{ fontSize: 11, fontWeight: 700 }}>{item.label}</div>
                        <div style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', marginTop: 6, fontWeight: 600 }}>
                          ¥{yen.toLocaleString('ja-JP')}
                        </div>
                      </div>
                      {i < arr.length - 1 && (
                        <span style={{ fontSize: 14, padding: '0 3px', display: 'flex', alignItems: 'center', alignSelf: 'center' }}>→</span>
                      )}
                    </React.Fragment>
                  )
                })}
              </div>
              {/* ロゴ（上）+ 捺印（「建築」の下・右寄せ）：縦並びで右端に揃える */}
              <div style={{ flex: '0 0 52%', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', paddingLeft: 18 }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/excel-images/cover-logo.png"
                  alt="株式会社ラグズ建築"
                  style={{ width: '100%', height: 76, objectFit: 'contain', objectPosition: 'right top' }}
                />
                {/* 捺印欄：「建築」の2文字の下 = 右端に配置 */}
                <div style={{
                  width: 60, height: 60, marginTop: 4,
                  border: '1px solid #888',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 12, color: '#aaa',
                }}>
                  印
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ─────────────────────────────────────────────────────
            Page 1: 総括表
        ───────────────────────────────────────────────────── */}
        <div className="doc-page page-break" style={pageStyle}>
          <Title page={1} />
          <table style={{ width: '100%', borderCollapse: 'collapse', border: BOR, tableLayout: 'fixed' }}>
            <ColGroup />
            <THead />
            <tbody>
              {/* グループ一覧行 */}
              {grouped.map(g => (
                <tr key={g.id ?? '_ug'}>
                  <td style={{ ...td0, textAlign: 'center' }}>{g.no}</td>
                  <td colSpan={2} style={{ ...td0, textAlign: 'left' }}>{g.label}</td>
                  <td style={{ ...td0, textAlign: 'right' }}>1</td>
                  <td style={{ ...td0, textAlign: 'center' }}>式</td>
                  <td style={td0}></td>
                  <td style={{ ...td0, textAlign: 'right' }}>{n(g.subtotal)}</td>
                  <td style={td0}></td>
                  <td style={td0}></td>
                </tr>
              ))}

              {/* 空行フィラー */}
              {Array.from({ length: summaryFiller }).map((_, i) => (
                <EmptyRow key={`sf${i}`} />
              ))}
              <EmptyRow key="sep" />

              {/* 小計合計（全グループ小計の合算） */}
              <tr>
                <td style={td0}></td>
                <td colSpan={2} style={{ ...td0, textAlign: 'center', fontWeight: 700, fontSize: 13 }}>合　　　計</td>
                <td style={{ ...td0, textAlign: 'right' }}>1</td>
                <td style={{ ...td0, textAlign: 'center' }}>式</td>
                <td style={td0}></td>
                <td style={{ ...td0, textAlign: 'right', fontWeight: 700, fontSize: 13 }}>{n(subtotalAll)}</td>
                <td style={td0}></td>
                <td style={td0}></td>
              </tr>
            </tbody>
          </table>
          <CompanyName name={companyName} />
        </div>

        {/* ─────────────────────────────────────────────────────
            Pages 2+: 工種別明細
        ───────────────────────────────────────────────────── */}
        {detailPages.map(pg => {
          const filler = pg.isLastChunk ? Math.max(0, DETAIL_MIN - pg.chunk.length) : 0
          const subtotalAmount = pg.chunkSubtotal
          return (
            <div
              key={`${pg.group.id ?? '_ug'}-${pg.chunkIndex}`}
              className={`doc-page${!pg.isLastPage ? ' page-break' : ''}`}
              style={pageStyle}
            >
              <Title page={pg.pageNumber} />
              <table style={{ width: '100%', borderCollapse: 'collapse', border: BOR, tableLayout: 'fixed' }}>
                <ColGroup />
                <THead />
                <tbody>
                  {/* グループ見出し行 */}
                  <tr>
                    <td style={{ ...td0, textAlign: 'center', fontWeight: 700 }}>{pg.group.no}</td>
                    <td colSpan={8} style={{ ...td0, fontWeight: 700 }}>
                      {pg.group.label}{pg.chunkIndex > 0 ? '（続き）' : ''}
                    </td>
                  </tr>

                  {/* 明細行 */}
                  {pg.chunk.map(item => {
                    const rt = item.row_type ?? 'item'

                    // 見出し行（row_type='header' または 【...】 パターン）
                    if (rt === 'header' || isSection(item.name)) {
                      return (
                        <tr key={item.id}>
                          <td style={td0}></td>
                          <td colSpan={8} style={{ ...tdWrap, fontWeight: 700, textAlign: 'center' }}>
                            {item.name}
                          </td>
                        </tr>
                      )
                    }
                    // メモ行（row_type='note'）：自由記載
                    if (rt === 'note') {
                      return (
                        <tr key={item.id}>
                          <td style={td0}></td>
                          <td colSpan={8} style={{ ...tdWrap, fontSize: 10, color: '#c00', fontStyle: 'italic' }}>
                            {item.name}
                          </td>
                        </tr>
                      )
                    }
                    // 注意書き行（※...）
                    if (isWarning(item.name)) {
                      return (
                        <tr key={item.id}>
                          <td style={td0}></td>
                          <td colSpan={8} style={{ ...tdWrap, color: '#c00', fontSize: 10, fontStyle: 'italic' }}>
                            {item.name}
                          </td>
                        </tr>
                      )
                    }
                    // 空行（スペーサー）
                    if (isBlank(item.name)) {
                      return <EmptyRow key={item.id} />
                    }
                    // 通常行：種別・名称を別セルで表示
                    const neg = (item.amount ?? 0) < 0
                    const red = neg ? ('red' as const) : undefined
                    const showPrice = (item.quantity ?? 1) !== 1 && item.selling_price != null
                    return (
                      <tr key={item.id}>
                        <td style={td0}></td>
                        <td style={{ ...tdWrap, color: red }}>{item.category ?? ''}</td>
                        <td style={{ ...tdWrap, color: red }}>{item.name ?? ''}</td>
                        <td style={{ ...td0, textAlign: 'right', color: red }}>
                          {item.quantity}
                        </td>
                        <td style={{ ...td0, textAlign: 'center', color: red }}>
                          {item.unit}
                        </td>
                        <td style={{ ...td0, textAlign: 'right', color: red }}>
                          {showPrice ? n(item.selling_price) : ''}
                        </td>
                        <td style={{ ...td0, textAlign: 'right', color: red }}>
                          {item.amount != null
                            ? neg ? `-${n(item.amount)}` : n(item.amount)
                            : ''}
                        </td>
                        <td style={{ ...td0, textAlign: 'right', color: red }}>
                          {n(item.retail_price)}
                        </td>
                        <td style={{ ...tdWrap, fontSize: 10, color: neg ? 'red' : '#444' }}>
                          {item.memo ?? ''}
                        </td>
                      </tr>
                    )
                  })}

                  {/* 空行フィラー（最後のチャンクのみ） */}
                  {Array.from({ length: filler }).map((_, i) => (
                    <EmptyRow key={`df${i}`} />
                  ))}

                  {/* 小計（ページ内の合計のみ） */}
                  <tr>
                    <td style={td0}></td>
                    <td style={td0}></td>
                    <td style={{ ...td0, textAlign: 'center' }}>小　　計</td>
                    <td style={td0}></td>
                    <td style={td0}></td>
                    <td style={td0}></td>
                    <td style={{ ...td0, textAlign: 'right', fontWeight: 700 }}>{n(subtotalAmount)}</td>
                    <td style={td0}></td>
                    <td style={td0}></td>
                  </tr>

                </tbody>
              </table>
              <CompanyName name={companyName} />
            </div>
          )
        })}
      </div>
    </>
  )
}
