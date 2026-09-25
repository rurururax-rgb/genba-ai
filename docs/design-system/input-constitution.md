# RAGZ Input Constitution v1.0

**Status:** FROZEN  
**Frozen:** 2026-09-25  
**Applies to:** `components/ui/input.tsx` · `components/ui/textarea.tsx` · すべての Input / Textarea / Select / Table Editor / Chat Composer

---

## 目的

RAGZにおける Input / Textarea / Select / Table Editor / Inline Editor / Chat Composer の
visual・interaction・architecture rule を定義する。

これは Phase レポートではなく **設計仕様** である。
今後 RAGZ を開発する人間・AI はこのドキュメントを守る。

---

## 設計原則

1. **Simple first** — 通常のフォームには Shared Foundation（`<Input>` / `<Textarea>`）を使う
2. **Behavior preservation over visual uniformity** — 視覚の統一のために業務 behavior を変えない
3. **Table geometry over global input height** — テーブルの行高は Shared Input height に合わせない
4. **Reuse > Extend > Create** — 既存 Shared Component の再利用を最優先
5. **共通化率は成功指標ではない** — Shared Component 使用率を高めること自体を目的にしない
6. **Business-critical interaction は visual consistency のために変えない**
7. **AI 機能は通常の RAGZ visual language を使う** — purple/blue/gradient は使わない
8. **Japanese IME safety は Enter-to-send を持つすべての Composer で必須**

---

## Input Families

RAGZ の Input を 6 Family に分類する。

| Family | 名称 | Height | Shared Component |
|--------|------|--------|-----------------|
| A | Comfortable Form | 44px | `<Input>` |
| B | Compact Data Input | 36px | `<Input inputSize="compact">` |
| C | Estimate Cell Editor | 40px（table 固定） | 使用しない |
| D | CostLedger Editor | 28px min（compact） | 使用しない |
| E | Chat Composer | —（auto-grow or rows=2） | 使用しない |
| F | Legacy / Special | 可変 | 将来 migration 候補 |

---

## Foundation — Shared Input / Textarea

通常フォームでは必ず Shared Foundation を使う。

### `<Input>` — `components/ui/input.tsx`

```tsx
// 通常フォーム
<Input />                          // default: h=44px, 15px
<Input inputSize="compact" />      // compact: h=36px, 14px
<Input error={true} />             // error state
<Input readOnly />                 // readonly state
```

| Size | Height | Font | Padding |
|------|--------|------|---------|
| `default` | 44px | 15px | px-3 |
| `compact` | 36px | 14px | px-[10px] |
| `large` | 48px | 16px | px-[14px] |

### `<Textarea>` — `components/ui/textarea.tsx`

```tsx
<Textarea />                       // default: min-h=96px, 15px/22px
<Textarea inputSize="compact" />   // compact: min-h=72px, 14px
```

**forwardRef 対応済み。** error prop あり（aria-invalid 自動設定）。

---

## Standard Visual Tokens

`app/globals.css` に定義済み（`--input-*`）。ハードコードより token 参照を優先する。

```
REST border:    #D5DED8   (--input-border-default)
HOVER border:   #AFC4B5   (--input-border-hover)
FOCUS border:   #2B5E40   (--input-border-focus)
ERROR border:   #DC2626   (--input-border-error)
READONLY border:#E4E8E5   (--input-border-readonly)
DISABLED border:#E4E8EE   (--input-border-disabled)

background:     #FFFFFF   (--input-bg)
bg readonly:    #F8FAF8   (--input-bg-readonly)
bg disabled:    #F3F4F6   (--input-bg-disabled)

text:           #1A2E24   (--input-text)
text readonly:  #47564E   (--input-text-readonly)
text disabled:  #9CA3AF   (--input-text-disabled)
placeholder:    #8A9A91   (--input-placeholder)

focus ring:     rgba(43, 94, 64, 0.14)  (--input-ring-focus)  3px
dense ring:     rgba(43, 94, 64, 0.12)                        2px
error ring:     rgba(220, 38, 38, 0.12) (--input-ring-error)
```

---

## Radius System

機械的に全 component を 8px にしない。scale・density・geometry に比例して選択する。

| Context | Radius | 理由 |
|---------|--------|------|
| Standard Input / Textarea / Select | **8px** | Standard |
| Chat Composer | **8px** | Standard |
| CostLedger editing inputs | **6px** | dense table geometry |
| Estimate GroupHeader input | **6px** | header row density（EX-INPUT-002）|
| Estimate SummaryEditCell | **4px** | micro editor（EX-INPUT-003） |
| ProjectInfoPanel inputs | **6px** | Legacy（EX-INPUT-008） |

---

## Table Geometry Rule ⚠️ HIGHEST PRIORITY

```
TABLE GEOMETRY > GLOBAL INPUT HEIGHT
```

Shared Input の height（36px / 44px）に合わせるためにテーブルの行高・セル高を変更しない。

| Component | Height | 変更禁止理由 |
|-----------|--------|-------------|
| Estimate CELL_H | 40px | keyboard navigation・table レイアウト |
| CostLedger editing inputs | 28px min | dense table geometry |
| Estimate SummaryEditCell | 22px | 合計行 micro editor |

---

## Family C — Estimate Cell Editor

**Architecture:** span ↔ input swap（portal editor + UnitSelect）

```
CELL_H = 40px（変更禁止）
```

- REST: editable affordance（`.edit-cell:hover` inset ring）
- FOCUS: RAGZ green #2B5E40
- Radius: 通常 8px（GroupHeader は 6px、SummaryEditCell は 4px — Intentional Exceptions）
- `<Input>` へ移行しない（behavior が変わるため）

---

## Family D — CostLedger Editor

**Architecture:** span → input DOM swap

editing state は CSS `:focus` pseudo-class では代替できない。`editing` React state による DOM swap 設計を維持する。

```
editing border: 1.5px solid #2B5E40（常時 — EX-INPUT-005）
editing bg:     #EAF3DE (accentLight — EX-INPUT-004)
minHeight:      28px
radius:         6px
focus ring:     .cl-edit-input:focus { box-shadow: 0 0 0 2px rgba(43,94,64,0.12) }
```

`<Input>` へ移行しない。

---

## Family E — Chat Composer

Architecture の差異は正式に許容する（EX-INPUT-006 / EX-INPUT-007）。

| | ChatPanel | CompanyChat |
|-|-----------|-------------|
| Architecture | Container-wrapped | Flat textarea |
| border 担当 | Container div | Textarea 自身 |
| auto-grow | あり（maxH 120px）| なし（rows=2 固定）|
| ref | useRef あり | なし |
| REST border | #D5DED8 | #D5DED8 |
| FOCUS border | #2B5E40 | #2B5E40 |
| focus ring | 0 0 0 2px rgba(43,94,64,0.12) | 0 0 0 2px rgba(43,94,64,0.12) |
| radius | 8px | 8px |
| IME guard | ✅ | ✅ |

---

## IME Mandatory Rule 🚨

**Enter-to-send を持つすべての Composer は必ず `isComposing` を確認すること。**

```tsx
// REQUIRED PATTERN
onKeyDown={e => {
  if (
    e.key === 'Enter' &&
    !e.shiftKey &&
    !e.nativeEvent.isComposing   // ← 必須。日本語変換確定 Enter を送信として扱わない
  ) {
    e.preventDefault()
    send()
  }
}}
```

`compositionstart` / `compositionend` / `keyCode 229` 等の追加は不要。`e.nativeEvent.isComposing` で十分。

---

## Select

**Simple native `<select>` は Input visual language に合わせる。**  
Radix / shadcn Select への置換は UX 上の理由がない限り行わない。

```tsx
// 正しいパターン（ScheduleTab / InvoiceTab で実装済み）
const selectCls = "h-9 w-full rounded-[8px] border border-[#D5DED8] bg-white \
  px-[10px] text-sm text-[#1A2E24] outline-none \
  hover:border-[#AFC4B5] \
  focus:border-[#2B5E40] \
  focus:shadow-[0_0_0_3px_rgba(43,94,64,0.14)] \
  cursor-pointer"
```

例外: EstimateTab UnitSelect（テーブルインライン編集のため独自スタイル）。

---

## Textarea

| 用途 | Component |
|------|-----------|
| 通常テキストエリア | `<Textarea>` |
| compact テキストエリア | `<Textarea inputSize="compact">` |
| auto-grow Chat Composer | native textarea（Family E） |
| legacy | native textarea（Family F） |

auto-grow・Chat Composer は architecture を優先し、Shared Textarea への強制移行をしない。

---

## Number / Currency

数値（quantity・price・cost・amount）は原則右揃え。  
ただし format / parse / calculation / save representation は visual system と分離する。  
**visual refactor のために business logic を変更しない。**

---

## Disabled / Readonly

視覚的に区別する。opacity-only disabled は禁止。

| State | Background | Border | Text |
|-------|-----------|--------|------|
| disabled | #F3F4F6 | #E4E8EE | #9CA3AF |
| readonly | #F8FAF8 | #E4E8E5 | #47564E |

---

## AI Input Rule

AI 機能だからという理由で独自 Input visual language（purple / blue / gradient / glow）を作らない。  
AI の高度さは behavior・automation・context・result quality で表現する。

---

## New Feature Decision Tree

新規 Input を追加・変更するときは以下を確認する。

```
通常フォームか？
  → YES: <Input> を使う

密度が高い通常フォームか？
  → YES: <Input inputSize="compact"> を使う

Textarea か？
  → 通常: <Textarea>
  → auto-grow が必要: native textarea（IME guard も追加）

業務上重要なテーブル内か？
  → YES: table geometry を確認してから。高さ変更禁止

カスタム keyboard / focus / save behavior があるか？
  → YES: architecture を維持。visual token のみ再利用

Shared Component へ移行すると behavior が変わるか？
  → YES: 移行しない。Exception Register に記録

Chat Enter-to-send か？
  → YES: !e.nativeEvent.isComposing が必須

Simple native select か？
  → YES: selectCls パターンを使う。Radix Select に置換しない
```

---

## Forbidden Patterns

- 理由のないハードコード green（旧 accent `#3D7A55` 等）の新規追加
- 根拠のない 4 / 6 / 8 / 10 / 12px radius の乱立
- opacity-only disabled（`opacity: 0.5` だけの disabled 表現）
- AI Chat だからという理由での purple / blue / gradient / glow input
- behavior が変わる場合の Shared Input への強制 migration
- Shared Input height に合わせるためのテーブル行高変更
- **IME guard なしの Enter-to-send**（Critical）
- visual cleanup を理由にした business logic の変更
- UX 上の理由のない native select → Radix/shadcn Select 置換
- Chat Composer の Shared Component 化（LEVEL 3 abstraction 以上）

---

## Intentional Exception Register

| ID | Component | Rule deviation | Reason | Status |
|----|-----------|---------------|--------|--------|
| EX-INPUT-001 | EstimateTab CELL_H | Height 40px（Shared Input の 36/44 に非準拠） | 既存 table geometry・keyboard navigation 保持 | APPROVED |
| EX-INPUT-002 | Estimate GroupHeader input | radius 6px | ヘッダー行 density に合わせた縮小 | APPROVED |
| EX-INPUT-003 | Estimate SummaryEditCell | height 22px / radius 4px | 合計行 micro editor | APPROVED |
| EX-INPUT-004 | CostLedger editing inputs | background `#EAF3DE` (accentLight) | 「編集中」状態の視覚的強調。白では不明瞭 | APPROVED |
| EX-INPUT-005 | CostLedger editing inputs | 1.5px border 常時 / minH 28px / radius 6px | DOM swap 設計。CSS :focus では代替不可。dense geometry | APPROVED |
| EX-INPUT-006 | ChatPanel Composer | Container-wrapped architecture | Textarea+Button を一つの入力単位として表示。auto-grow 必要 | APPROVED |
| EX-INPUT-007 | CompanyChat Composer | Flat architecture / rows=2 固定 / ref なし | モーダルチャット用。auto-grow 不要（短い指示が主） | APPROVED |
| EX-INPUT-008 | ProjectInfoPanel inputs | native input with legacy style（pre-Constitution） | pre-Constitution 実装。現在は LEGACY ACCEPTABLE | PENDING MIGRATION |

---

## Remaining Backlog

Constitution 違反として認識しているが、今回修正しない課題。

| Issue | 分類 | 優先度 |
|-------|------|--------|
| `ProjectInfoPanel.tsx` — native input、旧 accent `#3D7A55`、RAGZ green focus なし | LEGACY ACCEPTABLE（EX-INPUT-008） | 低（業務動作に影響なし） |
| `CatalogImportModal.tsx` — native input スタイル詳細未確認 | NEEDS FUTURE AUDIT | 中 |
| `VendorInvoiceImportTab.tsx` — native `<select>` スタイル詳細未確認 | NEEDS FUTURE AUDIT | 低 |
| `globals.css :focus-visible` / `--ring` — `hsl(152 43% 36%)` ≈ `#3D7A55`（旧 accent）| FIX NOW CANDIDATE | 低 |
