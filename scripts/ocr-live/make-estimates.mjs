// 見積書 OCR の実 AI 検証用に、架空の業者見積書の画像（PNG）と正解データ（JSON）を作る。
// 実在の会社・顧客の情報は使わない。ヘッドレス Chrome で HTML を撮影する（DB・API には接続しない）。
//
//   node scripts/ocr-live/make-estimates.mjs
//
// 出力: __tests__/live/fixtures/<case>.png と <case>.expected.json
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const OUT = path.resolve('__tests__/live/fixtures')
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const yen = n => n.toLocaleString('ja-JP')

/**
 * 正解の行。printed はその列に印字する値（null は空欄）。
 * expected は取り込みで期待する値: cost_price は原本の単価（空欄なら null。数量 1 の行は金額）、
 * review は要確認になるべきか。
 */
function row(name, unit, q, { list = null, rate = null, price = null, amount = null, review = false, costExpected } = {}) {
  return {
    name, unit, quantity: q, list_price: list, rate, unit_price: price, amount,
    expected: { cost_price: costExpected !== undefined ? costExpected : price, review },
  }
}

function header(title, supplier, no) {
  return `
  <div class="top"><div><h1>${title}</h1><div class="to">架空リフォーム株式会社 御中</div>
  <div class="small">件名: 架空邸 改修工事（検証用サンプル）</div></div>
  <div class="from"><div>見積No. ${no}</div><div>発行日 2026年10月20日</div><div class="sup">${supplier}</div>
  <div class="small">〒000-0000 架空県架空市1-2-3（実在しません）</div></div></div>`
}

const CSS = `
  body { font-family: 'Hiragino Kaku Gothic ProN','Hiragino Sans',sans-serif; margin: 40px 48px; color: #111; background: #fff; }
  h1 { font-size: 30px; letter-spacing: 12px; margin: 0 0 12px; }
  .top { display: flex; justify-content: space-between; margin-bottom: 18px; }
  .to { font-size: 18px; border-bottom: 1px solid #111; padding-bottom: 4px; }
  .from { text-align: right; font-size: 13px; line-height: 1.6; } .sup { font-size: 17px; font-weight: bold; margin-top: 6px; }
  .small { font-size: 12px; color: #333; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { border: 1px solid #333; padding: 4px 6px; } th { background: #e8e8e8; font-weight: normal; }
  td.n { text-align: right; white-space: nowrap; } td.c { text-align: center; }
  .sum td { font-weight: bold; } .note { font-size: 12px; margin-top: 10px; }
  table.dense { font-size: 11.5px; } table.dense td, table.dense th { padding: 2px 5px; }`

function table(cols, rows, { dense = false, footer = '' } = {}) {
  const cell = (r, c) => {
    const v = r[c.key]
    if (c.key === 'name' || c.key === 'unit') return `<td${c.key === 'unit' ? ' class="c"' : ''}>${v ?? ''}</td>`
    if (c.key === 'rate') return `<td class="n">${v == null ? '' : `${Math.round(v * 100)}%`}</td>`
    if (r.text && c.key === 'amount') return `<td class="n">${r.text}</td>`
    return `<td class="n">${v == null ? '' : yen(v)}</td>`
  }
  return `<table class="${dense ? 'dense' : ''}"><tr><th>No</th>${cols.map(c => `<th>${c.label}</th>`).join('')}</tr>
  ${rows.map((r, i) => `<tr><td class="c">${i + 1}</td>${cols.map(c => cell(r, c)).join('')}</tr>`).join('\n')}
  ${footer}</table>`
}

const sumRow = (cols, label, value) =>
  `<tr class="sum"><td></td><td>${label}</td>${cols.slice(1, -1).map(() => '<td></td>').join('')}<td class="n">${value}</td></tr>`

// ── ケース 1: 定価・掛率・単価・数量・金額（すべて整合） ─────────────────
function caseRate() {
  const rows = [
    row('システムバス 架空 SB-1616 本体', '台', 1, { list: 980000, rate: 0.55, price: 539000, amount: 539000 }),
    row('浴室換気乾燥機 KV-200', '台', 1, { list: 128000, rate: 0.6, price: 76800, amount: 76800 }),
    row('洗面化粧台 W750 LX-750', '台', 1, { list: 186000, rate: 0.58, price: 107880, amount: 107880 }),
    row('混合水栓 TS-10', '個', 2, { list: 42000, rate: 0.6, price: 25200, amount: 50400 }),
    row('クッションフロア CF-180', '㎡', 12.5, { list: 3800, rate: 0.5, price: 1900, amount: 23750 }),
    row('ビニルクロス 量産品 VC-01', '㎡', 48, { list: 1200, rate: 0.55, price: 660, amount: 31680 }),
    row('温水洗浄便座 架空 WB-3', '台', 1, { list: 89000, rate: 0.62, price: 55180, amount: 55180 }),
    row('タイル目地材 GM-5', '袋', 6, { list: 2400, rate: 0.7, price: 1680, amount: 10080 }),
    row('給湯器 24号 GT-2460', '台', 1, { list: 412000, rate: 0.48, price: 197760, amount: 197760 }),
    row('配管部材 一式', '式', 1, { list: null, rate: null, price: 38000, amount: 38000 }),
  ]
  const cols = [
    { key: 'name', label: '品名・型番' }, { key: 'unit', label: '単位' }, { key: 'quantity', label: '数量' },
    { key: 'list_price', label: '定価' }, { key: 'rate', label: '掛率' }, { key: 'unit_price', label: '単価' }, { key: 'amount', label: '金額' },
  ]
  const subtotal = rows.reduce((s, r) => s + r.amount, 0)
  const tax = Math.floor(subtotal * 0.1)
  const footer = sumRow(cols, '小計', yen(subtotal)) + sumRow(cols, '消費税（10%）', yen(tax)) + sumRow(cols, '合計', yen(subtotal + tax))
  return {
    id: 'case1-rate', title: '御見積書', supplier: '架空住設株式会社', no: 'Q-TEST-0001',
    body: table(cols, rows, { footer }) + '<div class="note">※ 単価・金額は税抜です。有効期限: 発行日より30日</div>',
    rows, subtotal, adjustments: [],
  }
}

// ── ケース 2: 出精値引あり（値引後の小計は印字しない） ─────────────────
function caseDiscount() {
  const rows = [
    row('既存浴室解体撤去', '式', 1, { price: 85000, amount: 85000 }),
    row('産業廃棄物処分費', '式', 1, { price: 42000, amount: 42000 }),
    row('給排水配管工事', '式', 1, { price: 68000, amount: 68000 }),
    row('電気配線工事', '式', 1, { price: 36000, amount: 36000 }),
    row('ユニットバス組立工事', '式', 1, { price: 95000, amount: 95000 }),
    row('ドア枠補修', '箇所', 2, { price: 14500, amount: 29000 }),
    row('養生費', '式', 1, { price: 12000, amount: 12000 }),
  ]
  const cols = [
    { key: 'name', label: '名称' }, { key: 'quantity', label: '数量' }, { key: 'unit', label: '単位' },
    { key: 'unit_price', label: '単価' }, { key: 'amount', label: '金額' },
  ]
  const subtotal = rows.reduce((s, r) => s + r.amount, 0)
  const discount = 17000
  const tax = Math.floor((subtotal - discount) * 0.1)
  const footer = sumRow(cols, '小計', yen(subtotal)) + sumRow(cols, '出精値引', `▲${yen(discount)}`)
    + sumRow(cols, '消費税', yen(tax)) + sumRow(cols, '御見積金額（税込）', yen(subtotal - discount + tax))
  return {
    id: 'case2-discount', title: '御見積書', supplier: '架空設備工業', no: 'Q-TEST-0002',
    body: table(cols, rows, { footer }), rows, subtotal, adjustments: [{ label: '出精値引', amount: discount }],
  }
}

// ── ケース 3: 明細 65 行（A4 1 枚に詰めた内訳明細書） ───────────────────
function caseLong() {
  const units = ['本', '枚', '箱', '㎡', 'm', '個', '袋', '缶']
  const kinds = ['下地合板', '石膏ボード', '断熱材', '巾木', '廻り縁', 'ビス', '接着剤', 'シーリング材', '防水テープ', '見切材', '野縁', '胴縁', 'コーナー材']
  const rows = []
  for (let i = 0; i < 65; i++) {
    const q = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 24][(i * 7) % 12]
    const price = 150 + ((i * 1373) % 98) * 125 // 150〜12,275 円
    rows.push(row(`${kinds[i % kinds.length]} ${String.fromCharCode(65 + (i % 26))}-${100 + i}`, units[i % units.length], q, { price, amount: q * price }))
  }
  const cols = [
    { key: 'name', label: '品名' }, { key: 'quantity', label: '数量' }, { key: 'unit', label: '単位' },
    { key: 'unit_price', label: '単価' }, { key: 'amount', label: '金額' },
  ]
  const subtotal = rows.reduce((s, r) => s + r.amount, 0)
  return {
    id: 'case3-long65', title: '内訳明細書', supplier: '架空建材センター', no: 'Q-TEST-0003',
    body: table(cols, rows, { dense: true, footer: sumRow(cols, '小計', yen(subtotal)) }), rows, subtotal, adjustments: [], height: 2000,
  }
}

// ── ケース 4: 取り違え・作り出しを誘う行 ─────────────────────────────
function caseTraps() {
  const rows = [
    // 単価欄が空・数量 3（金額 ÷ 数量 で単価を作ってはいけない）
    row('外壁シーリング打替', 'm', 3, { list: null, rate: null, price: null, amount: 45000, review: true, costExpected: null }),
    // 数量 1・単価欄が空（金額をそのまま単価にしてよい）
    row('足場架設 一式', '式', 1, { price: null, amount: 30000, costExpected: 30000 }),
    // 業者側の誤記：数量 × 単価 ≠ 金額（必ず要確認）
    row('雨樋交換 KT-60', 'm', 2, { price: 8000, amount: 15000, review: true }),
    // 定価・掛率あり・単価欄が空・数量 1（金額を単価に。定価 × 掛率 と一致）
    row('換気扇 VF-25', '台', 1, { list: 50000, rate: 0.6, price: null, amount: 30000, costExpected: 30000 }),
    // 定価・掛率あり・数量 4（単価と金額が別。定価を単価として読まないこと）
    row('照明器具 LED-D10', '台', 4, { list: 24000, rate: 0.5, price: 12000, amount: 48000 }),
    // 通常の行
    row('コーキング材 CK-1', '本', 10, { price: 680, amount: 6800 }),
  ]
  // 「含む」・0 円の行（明細に入れない）
  const excluded = [
    { name: '運搬費', unit: '式', quantity: 1, text: '含む' },
    { name: '現場管理費', unit: '式', quantity: 1, unit_price: 0, amount: 0 },
    { name: '電気配線工事', unit: '式', quantity: 1, text: '別途' },
  ]
  const cols = [
    { key: 'name', label: '品名' }, { key: 'quantity', label: '数量' }, { key: 'unit', label: '単位' },
    { key: 'list_price', label: '定価' }, { key: 'rate', label: '掛率' }, { key: 'unit_price', label: '単価' }, { key: 'amount', label: '金額' },
  ]
  const subtotal = rows.reduce((s, r) => s + r.amount, 0)
  return {
    id: 'case4-traps', title: '御見積書', supplier: '架空外装', no: 'Q-TEST-0004',
    body: table(cols, [...rows, ...excluded], { footer: sumRow(cols, '小計', yen(subtotal)) }),
    rows, subtotal, adjustments: [], excludedNames: excluded.map(e => e.name), separateNames: ['電気配線工事'],
  }
}

// ── ケース 5: スマホ撮影を模した画像（ケース 1 を傾け・ぼかし・低解像度・紙の影） ──────
function casePhoto() {
  const c = caseRate()
  return {
    ...c, id: 'case5-photo', no: 'Q-TEST-0005', width: 900, height: 1200, scale: 0.72,
    wrap: body => `<div style="background:#cfc9bd;padding:30px;min-height:100vh;box-sizing:border-box">
      <div style="background:#fbfaf6;padding:28px;transform:perspective(1400px) rotateX(4deg) rotate(-1.8deg);
        filter:blur(0.75px) contrast(0.82) brightness(0.97);box-shadow:0 8px 24px rgba(0,0,0,.35)">${body}</div></div>`,
  }
}

// ── ケース 6: 単価の列しかない見積書（金額・定価の列がなく、単価を照合できない） ──────────
function caseUnitOnly() {
  const rows = [
    row('フローリング 12mm FL-12', '㎡', 18, { price: 4850 }),
    row('フローリング施工手間', '㎡', 18, { price: 2200 }),
    row('既存床撤去', '㎡', 18, { price: 1500 }),
    row('床下地調整', '㎡', 18, { price: 900 }),
    row('巾木 H60', 'm', 24, { price: 780 }),
    row('廃材処分', '式', 1, { price: 25000 }),
  ]
  const cols = [
    { key: 'name', label: '品名' }, { key: 'quantity', label: '数量' }, { key: 'unit', label: '単位' }, { key: 'unit_price', label: '単価（税抜）' },
  ]
  return {
    id: 'case6-unit-only', title: '御見積書', supplier: '架空床材店', no: 'Q-TEST-0006',
    body: table(cols, rows) + '<div class="note">※ 数量は概算です。施工後に精算いたします。</div>',
    rows, subtotal: null, adjustments: [],
  }
}

const cases = [caseRate(), caseDiscount(), caseLong(), caseTraps(), casePhoto(), caseUnitOnly()]
const only = process.argv.slice(2)
const work = mkdtempSync(path.join(tmpdir(), 'ocr-live-'))
for (const c of cases.filter(c => !only.length || only.includes(c.id))) {
  const inner = `${header(c.title, c.supplier, c.no)}${c.body}`
  const html = `<!doctype html><meta charset="utf-8"><style>${CSS}${c.scale ? `body{zoom:${c.scale};margin:0}` : ''}</style>${c.wrap ? c.wrap(inner) : inner}`
  const htmlPath = path.join(work, `${c.id}.html`)
  writeFileSync(htmlPath, html)
  execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--window-size=${c.width ?? 1240},${c.height ?? 1754}`,
    `--screenshot=${path.join(OUT, `${c.id}.png`)}`, `file://${htmlPath}`], { stdio: 'ignore' })
  const expected = {
    id: c.id, supplier: c.supplier, subtotal: c.subtotal, adjustments: c.adjustments, excludedNames: c.excludedNames ?? [], separateNames: c.separateNames ?? [],
    rows: c.rows.map(r => ({ name: r.name, unit: r.unit, quantity: r.quantity, list_price: r.list_price, rate: r.rate, unit_price: r.unit_price, amount: r.amount, ...r.expected })),
  }
  writeFileSync(path.join(OUT, `${c.id}.expected.json`), JSON.stringify(expected, null, 2) + '\n')
  console.log(`${c.id}: ${c.rows.length} rows`)
}
