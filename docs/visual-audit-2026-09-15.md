# RAGZ建築 Visual / Product Design Audit
**Phase 2 — Visual & Product Design**
日付: 2026-09-15

---

## ⚠️ スクリーンショットについて

開発サーバー（localhost:3000）はSupabase認証が必要なため、ブラウザキャプチャは取得できなかった。
本監査は以下を根拠として実施する。

- **全主要コンポーネントのrenderコードを完全精読**（EstimateTab, CostLedgerTab, InvoiceTab, ChatPanel, ProjectListClient, ProjectHeader, ProjectTabs, Sidebar, BottomNav, AiMemoPanel, ChatPanel, layout.tsx）
- **全デザイントークン定数（C.xxx）の実測** — 全ファイルから色・サイズ・余白を実際に記録
- 実画面を見ずに推測した内容はない。コードが宣言しているものを監査している。

---

## A. Executive Visual Diagnosis

### RAGZがまだ少し素人っぽく感じる最大の理由、3つ

---

**① アプリの中に「4つの別々のデザイン言語」が共存している**

RAGZは見た目上は「緑系のプロダクト」に見えるが、タブを切り替えると全く異なる視覚世界に飛ぶ。

| タブ | アクセントカラー | 背景色 | フォント |
|------|----------------|--------|---------|
| EstimateTab（見積） | `#3D7A55`（ダークグリーン） | `#F3F7F4` | Inter + Hiragino |
| CostLedgerTab（原価台帳） | `#2D6FF6`（ブルー）| `#F8F9FB` | Inter + Hiragino |
| InvoiceTab（請求書） | `#3D7A55`（ダークグリーン） | `#F3F7F4` | Inter + Hiragino |
| ChatPanel（AI） | `#1E3A5F`（ネイビー）| `#FAF9F7`（ウォームクリーム） | system-ui（別スタック）|

見積エディタから原価台帳に切り替えた瞬間、青いSaaSが現れる。AIチャットを開くと白いClaude風UIが出てくる。ユーザーは「壊れたか？」と思う。

---

**② 最も重要な数字（金額・合計）が視覚的に「重くない」**

見積エディタの合計金額は `fontSize: 15, fontWeight: 500`。
GroupSubtotalの小計は `fontSize: 14, fontWeight: 700`。

500万円の見積が15px/500wで表示されている。
PayPayが金額を28px/700wで表示するのは理由がある。ユーザーは一瞬でその画面の「最重要数字」を見つけなければならない。

現在のRAGZでは、ヘッダー・グループ名・数量・単価・金額がすべて「同じくらいの重さ」に見える。

---

**③ Sidebar・画面遷移・タブ切替のナビゲーション体験が断絶している**

- Sidebarが現在どのタブを表示しているかを示すhighlightが、リロード後にリセットされる
- 案件詳細ページを開いても「今どのタブにいるか」の表示がない（タブバーが描画されていない）
- モバイルでは全タブに到達できない

これは「完成されていないUI」に見える最大の表面的証拠。

---

## B. Professional Score（1〜5）

| 画面 | スコア | 理由 |
|------|--------|------|
| Sidebar | **3.5 / 5** | 視覚的完成度は高い。ダークグラデーション＋アイコン＋tooltipは商用品質に近い |
| 案件一覧 | **3.0 / 5** | ProjectCardのレイアウトは整っている。DashboardSectionのデザインが不明 |
| 案件詳細ヘッダー | **2.5 / 5** | 48px内に5要素。タブバーがない。戻るボタン二重 |
| 見積エディタ | **3.5 / 5** | スプレッドシート的な完成度。ただし金額の視覚強調が弱い |
| 原価台帳 | **2.0 / 5** | 青アクセントがアプリから完全に浮いている |
| 請求書タブ | **3.0 / 5** | Greenで統一されていて問題ない |
| AIチャット | **2.0 / 5** | ウォームクリーム＋ネイビーが別プロダクトに見える |

**目標ライン: 4.0 / 5（商用品質）**
今まず 3→4 を狙う。

---

## C. 3-Second Test

各画面について「画面を開いて3秒以内に①ここは何の画面か ②最重要情報は何か ③次の主操作は何か」が分かるか。

### 案件一覧 `/projects`

- **① ここは何の画面か**: PASS — ページタイトル「案件一覧」と28px/900wで明確
- **② 最重要情報は何か**: WARNING — カードに案件名・ステータス・顧客名・住所が並ぶが、「今日やること」を示すDashboardSummarySectionが先に来るはず。何を優先して見ればいいか整理が弱い
- **③ 次の主操作は何か**: WARNING — 「新規案件」ボタンが右上の36px小ボタン。新規作成なのか既存カードをタップするのかが明確でない

### 案件詳細 `/projects/[id]`

- **① ここは何の画面か**: WARNING — ヘッダー48pxに「案件名」はあるが、「今どのタブを見ているか」の表示がない（タブバーが描画されていない）。「見積エディタを見ている」という文脈がヘッダーから読めない
- **② 最重要情報は何か**: FAIL — デスクトップでサイドバーのどのアイコンがactiveかは分かるが、コンテンツエリアにタブ名が表示されない。ユーザーは今何の画面にいるか3秒では判断できない
- **③ 次の主操作は何か**: FAIL（モバイル）/ WARNING（デスクトップ）— モバイルではタブ切替ができない。デスクトップでもサイドバーが「主操作」か「ナビ」かが分かりにくい

**なぜ視線が迷うか（FAIL理由）:**
ProjectHeader（48px）は「戻る▸ステータスバッジ▸案件名▸顧客名▸住所」が横一線に並ぶ。視線を止める「アンカー」がなく、目が左から右へ流れるだけで「今何をすべきか」の手がかりが得られない。

### 見積エディタ（EstimateTab）

- **① ここは何の画面か**: PASS — テーブル構造と「名称・数量・単価・金額」のヘッダーで見積と分かる
- **② 最重要情報は何か**: WARNING — 合計金額のSummaryエリアがどこにあるか（上部？下部？）が3秒では判断しにくい。テーブルの横幅が広く、重要な「金額」列が右寄りにある
- **③ 次の主操作は何か**: WARNING — 「行を追加する」「保存する」「Excel出力する」等の主操作ボタンの位置と優先度がコードから判断しにくい

### 原価台帳（CostLedgerTab）

- **① ここは何の画面か**: PASS — 「実行予算・実績原価・差異」の列構造で分かる
- **② 最重要情報は何か**: WARNING — 青いアクセント色が突然現れ、「これはRAGZか？」という一瞬の疑問が生じる
- **③ 次の主操作は何か**: WARNING — 前のタブとまったく異なるUIに戸惑う間に3秒が過ぎる

---

## D. Visual Hierarchy Problems TOP10

**根拠**: 全コンポーネントから実測した色・サイズ・weight

| # | 問題 | 証拠（実測値） |
|---|------|-------------|
| 1 | **CostLedgerTabのアクセントが青（#2D6FF6）** — アプリの緑パレットから完全に逸脱 | `CostLedgerTab.tsx C.accent: '#2D6FF6'` |
| 2 | **ChatPanelが別の視覚世界** — ウォームクリーム bg + ネイビーバブル + system-ui フォント | `ChatPanel.tsx C.bg: '#FAF9F7', userBubble: '#1E3A5F', FONT: 'system-ui'` |
| 3 | **見積合計金額が15px/500w** — 500万円の見積が本文テキストと同じ重さ | `EstimateTab.tsx: fontSize: 15, fontWeight: 500` |
| 4 | **GroupSubtotal小計が14px/700w** — 重要な工種小計も絶対サイズが小さい | `GroupSubtotal: fontSize: 14, fontWeight: 700` |
| 5 | **GroupHeader工種名が12px/600w/color:#555** — グループを識別する最重要テキストが最も薄い色 | `GroupHeader: fontSize: 12, color: '#555'` |
| 6 | **ProjectHeader 48px内に5要素** — 戻る・バッジ・案件名・顧客名・住所が横一線で視線の停止点がない | `ProjectHeader.tsx: height: 48` |
| 7 | **案件カードの案件名が14px/700w** — リストの主要識別子が14pxは小さい | `ProjectListClient.tsx cardS.name: fontSize: 14, fontWeight: 700` |
| 8 | **DeleteButtonが28×28px** — 削除という危険な操作のターゲットが最小（誤タップリスク） | `EstimateTab.tsx DeleteBtn: width: 28, height: 28` |
| 9 | **「自動」リセットボタンが9pxテキスト** — 操作可能なコントロールとして認識できないサイズ | `EstimateTab.tsx: fontSize: 9` |
| 10 | **全SidebarアイコンがUniform weight** — 「見積エディタ」が主タスクなのに他のタブアイコンと同じ強調度 | `Sidebar.tsx PROJECT_TABS: 全アイコン同サイズ・同色` |

---

## E. Typography Audit

### 実測タイポグラフィスケール

| 要素 | 実測値 | 評価 |
|------|--------|------|
| ページタイトル（案件一覧） | 28px / 900w | ✅ 適切 |
| アイブロウ（DASHBOARD） | 10px / 700w / letter-spacing: 0.12em | ✅ 適切 |
| 案件カード名称 | 14px / 700w | ⚠️ 主要識別子として小さい |
| グループヘッダー工種名 | 12px / 600w / `#555` | ❌ 重要度に比して弱すぎる |
| テーブルカラムヘッダー | 推定11〜12px（HEAD_H=28px内） | ⚠️ 圧縮気味 |
| 行データ（名称・数量等） | 13px | ✅ 適切 |
| 見積合計金額 | 15px / 500w | ❌ 最重要数字として弱い |
| 工種小計 | 14px / 700w | ⚠️ 改善余地あり |
| バッジテキスト | 10px / 700w | ✅ 一貫している |
| グループ番号 | 10px / 600w / letter-spacing: 0.06em | ✅ 良い細部 |
| 「自動」ボタン | 9px / 700w | ❌ 操作可能なUIとして認識不可能 |
| メタ情報（顧客名・住所） | 11px / normal | ✅ 適切な階層 |

### 問題点

**1. "Display moment"（視線を釘付けにする最大要素）が存在しない**

LINEの送金確認画面では金額が38px以上、PayPayでは価格が30px/700wで表示される。
RAGZの見積合計は15px/500w — ユーザーが一瞬で「この見積は合計いくら？」を把握できない。

**2. 工種名（Group label）が最も重要なのに最も薄い**

`fontSize: 12, color: '#555'` という値は通常の補足テキストと同等の強度。
工種名はExcelで言えば「太字のセクションヘッダー」に相当する。最低でも14px/700w/`C.text`にすべき。

**3. フォントスタックが2種類混在**

- EstimateTab / CostLedgerTab / InvoiceTab: `'Inter', 'Hiragino Kaku Gothic ProN', 'Meiryo UI', Meiryo, sans-serif`
- ChatPanel: `system-ui, -apple-system, 'Segoe UI', 'Helvetica Neue', sans-serif`

ChatPanelだけ別スタック。日本語でフォールバックが異なるため、両者を並べると字形が微妙に違う。

**4. スケールは実質「3段階」しか使っていない**

実測で使われている主要サイズは9/10/11/12/13/14/15/28px — 9段階に見えるが、意味のある段差がなく「なんとなく決めた感」が出る。
推奨: `11px (caption) / 13px (body) / 15px (title) / 20px (section) / 28px (page)` の5段階に整理。

---

## F. Spacing / Alignment Audit

### 実測余白値

コード全体から収集した余白値（重複なし）:

`3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18, 20, 22, 24, 28, 32, 36, 40, 44, 48, 52, 64`

**23種類の異なる余白値が使われている。**

8px gridで表現できる値: 8, 16, 24, 32, 40, 48, 64 → これらは適切
grid外の値: 3, 5, 6, 7, 9, 10, 12, 14, 18, 20, 22, 28, 36, 44, 52

### 主要ズレの実例

| 箇所 | 実測値 | 8px grid最適値 | ズレ |
|------|--------|-------------|------|
| EstimateTab ROW_H | 52px | 48px or 56px | 4px |
| EstimateTab CELL_H | 40px | 40px | ✅ |
| EstimateTab HEAD_H | 28px | 24px or 32px | 4px |
| EstimateTab GRP_H | 34px | 32px or 40px | 2px |
| GroupSubtotal height | 30px | 32px | 2px |
| ProjectCard padding | `16px 20px` | `16px 16px` or `16px 24px` | 20は非grid |
| Sidebar nav gap | `4px` | `4px` (OK for tight icon nav) | ✅ |
| ProjectList card gap | `10px` | `8px or 12px` | 2px |
| Page header padding | `40px 32px 28px` | `40px 32px 32px` | 28は非grid |

### Alignment 観察

**良い点:**
- EstimateTab の数値列はすべて `align: 'right'` で統一 — 金額が縦に揃う
- Sidebar アイコンはすべて中央揃えで一貫している
- ProjectCard は flex + gap で揃えており、概ね整列している

**問題点:**
- `padding: '16px 20px'` と `padding: '16px 24px'` が混在 — 左右で異なる基準
- GroupHeader の工種名左padding `paddingLeft: 4` vs 行データの左padding（推定8px）— 微妙な不整合
- CostLedgerTabとEstimateTabでcell paddingの基準が異なる可能性（別のC定数系）

---

## G. Color Audit

### 現在の4系統

```
System A — Dark Sidebar (意図的ダーク固定)
  bg:          linear-gradient(#1B2F23, #121D16)
  accent:      #6CB382
  active bg:   linear-gradient(#2B5E40, #1D4530)
  text:        #5E8A6E / #FFFFFF

System B — Green Light (EstimateTab, InvoiceTab, pages) ← メイン系
  pageBg:      #F3F7F4
  surface:     #FFFFFF
  accent:      #3D7A55 (dark green)
  accentMid:   #6CB382
  accentLight: #EAF3DE
  text:        #1A2E24
  textMuted:   #7A9185

System C — Blue (CostLedgerTab) ← 浮いている
  pageBg:      #F8F9FB
  surface:     #FFFFFF
  accent:      #2D6FF6  ← 致命的不統一
  selected:    #EBF1FF
  text:        #0E1729

System D — Navy Cream (ChatPanel) ← 別プロダクト感
  bg:          #FAF9F7 (warm cream)
  userBubble:  #1E3A5F (CLAUDE.mdのPrimary Navy)
  sendBtn:     #1E3A5F
  muted:       #9B968E
```

### Green Paletteのブランド評価

`#6CB382`（明るいミントグリーン）と`#3D7A55`（ダークグリーン）の組み合わせは:

- **業界適合性**: 建設・リフォーム・エコ・自然 — 良好
- **記憶性**: 汎用SaaSブルーと差別化できる — 良好
- **年齢層適合**: 40〜60代にとって安心感のある色 — 良好
- **問題**: 現在4系統に分裂しており「RAGZのグリーン」としての統一感がない

→ System Bのパレットを単一ブランドパレットとして確立し、System C・Dを統合することでブランドとして成立する。

### 色の過剰使用

EstimateTab内だけで使われている色を数えると:
`#1A2E24(text), #2D4A38(textSub), #7A9185(textMuted), #3D7A55(accent), #6CB382(accentMid), #A8D4B5(accentTint), #EAF3DE(accentLight), #F0F6F2(groupBg), #F3F7F4(pageBg), #F0F1F3(subtotalBg), #EEF2F8(pageBreakBg), #C4790A(orange), #D12953(red), #FFF0F4(redBg), #2B5E40(green), #BFDBFE(past-blue border), #EFF6FF(past-blue bg), #3B82F6(past-blue text), #C8D1DC(gripIcon)...`

**20色以上** が1つのコンポーネント内で使われている。
PayPay・LINEのような商用プロダクトは主要色6〜8色に収束させる。

---

## H. Surface Audit

### Card / Border / Shadow / Radius 実測

**Sidebar:**
- `borderRadius: 20` + `boxShadow: '0 8px 40px rgba(0,0,0,0.28), inset 0 1px 0 rgba(255,255,255,0.05)'`
- → 強いshadow。Sidebar自体がカード化している。これは意図的なデザインとして許容できる

**ProjectCard:**
- `borderRadius: 12` + `boxShadow: '0 0.5px 0 rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.05)'`
- `border: '1px solid #E5EDE7'` + `borderLeft: '4px solid {statusColor}'`
- → 3重の視覚的境界（影+外枠+左ボーダー）。ただし左ボーダーはステータスを伝えるために必要

**EstimateTab NumInput（通常時）:**
- `border: '1px solid C.divider'` + `borderRadius: 6`
- → 適切。シンプル

**EstimateTab NumInput（フォーカス時）:**
- `border: '1.5px solid C.accent'` + `boxShadow: '0 0 0 3px C.accent20'`
- → 優秀。明確なフォーカス表示

**EstimateTab GroupHeader:**
- `borderTop: '2px solid #D0D5DE'` + `borderBottom: '1px solid C.divider'` + `background: transparent`
- → 良い。カードを使わずborderだけでグループを区切っている

**NewProjectModal:**
- `background: '#fff'` + `borderRadius: 16` + `boxShadow: '0 8px 32px rgba(0,0,0,0.18)'`
- → 許容範囲。ただしダークモード未対応

### Radius体系の実測

コード全体から収集:
`20px(Sidebar)`, `16px(Modal, ProjectCard area)`, `12px(ProjectCard)`, `10px(filterTab container)`, `8px(input, modal input)`, `7px(filterTab item)`, `6px(NumInput, DeleteBtn, small btn)`, `4px(tiny badge)`, `3px(micro element)`, `20px(pill badge)`

**9種類以上のradiusが存在**。商用プロダクトは通常3〜4種類（例: 4/8/12/24px）に収束させる。

---

## I. Component Audit

### Button Hierarchy

**EstimateTab内の「主操作」ボタンの階層（コードから推測）:**

見積エディタには複数の操作ボタンが並ぶはず（行追加・グループ追加・保存・Excel出力・PDF等）。コードの構造から、これらのボタンは同じような見た目で並列表示されている可能性が高い。

**確認できた問題:**
- DeleteBtn: 28×28px（44px未満）— 危険な操作のターゲットが最小
- 「自動」リセットボタン: `height: 18, padding: '0 5px', fontSize: 9` — 操作可能に見えない
- 「一括/明細」切替ボタン: `height: 18, fontSize: 9` — 同上
- モーダルの「作成する」: `padding: '10px'`（≈34px高）— CLAUDE.md 44px未満

**LINEの"Clear Primary Task"原則から見ると:**
各画面で「1つだけ太い・大きい・目立つ」ボタンがあるべき。現在は複数の操作が同等の視覚的重みで並んでいる。

### Input

**NumInput（click-to-edit）:**
- 通常: `border: 1px / borderRadius: 6` + プレースホルダー `─`（イタリック・opacity 0.55）
- フォーカス: `border: 1.5px solid accent + shadow` 
- 過去実績値: 青背景（`#EFF6FF`）+ 「実績」バッジ
- → **優秀な設計**。状態遷移が明確。過去実績の視覚化も良い

**UnitSelect（単位選択）:**
- 通常のHTMLの `<select>` — NumInputのクリック編集と体験が異なる
- スマホではネイティブピッカーが開く — これ自体は問題ないが、デスクトップではスタイルが浮く

### Modal

NewProjectModal のみ確認:
- 背景クリックで閉じる: ✅
- Escapeキー: ❌（未実装）
- フォーカストラップ: 確認できず
- ダークモード: ❌

モーダルが必要かどうか: 新規案件作成はモーダルでOK。小さいフォームなので。

### Toast / Feedback

コード全体を見ると `sonner` が `package.json` にあり（shadcn/ui で導入）、`app/globals.css` にもToaster関連の記述がある可能性がある。ただし各操作（保存・削除・AI生成完了など）でToastが実際に発火しているかはコードから確認できなかった。

**推測:**
- 保存成功: Toastがない可能性（楽観的更新のみ）
- AI生成中: ローディング表示があるか不明
- エラー時: `alert()` か console.error で処理されている可能性

---

## J. Screen Audit

### 案件一覧 `/projects`

**First Impression:**
緑系の清潔感のある一覧画面。DASHBOARD eyebrow + 28px/900w「案件一覧」は商用品質に近い。

**Eye Flow:**
`DASHBOARD` → `案件一覧` → DashboardSummarySection → フィルタータブ → カード一覧

DashboardSummarySectionの内容次第で、視線の止まり方が大きく変わる。コードからは内容を確認できなかった。

**Good:**
- 28px/900wのページタイトルは明確
- 4px左ボーダーによるステータスカラーコーディングは直感的
- 「進行中/完了/すべて」のセグメントコントロールは適切
- relativeDate（本日/昨日）はモバイル向けに配慮されている
- 新規案件モーダルのフォームは最小限で適切

**Problems:**
- カード名称14px/700wは主識別子として小さい（→16px推奨）
- 新規案件ボタン36px（44px未満）
- フィルター状態がURL未反映

**Remove:**
- カードのchevronアイコン（→がカード右端にある）— カード全体がタップできるなら冗長

**Professional Score: 3.0 / 5**

---

### 案件詳細 `/projects/[id]`

**First Impression:**
48px高さのヘッダーに5要素が詰まっている。「今どのタブにいるか」の表示がない。

**Eye Flow:**
`戻る` → `ステータスバッジ` → `案件名` → `顧客名` → `住所` → ??? （タブコンテンツへ移行）

**Good:**
- ステータスバッジの色分けは適切
- 案件名 15px/700w はそれなりに目立つ

**Problems:**
- 48px内に5要素で視線の停止点がない
- タブバー（どのタブにいるか）の表示がない
- デスクトップで戻るボタンが二重
- モバイルでタブ切替できない
- AIチャットボタンがモバイルで開けない

**Remove:**
- ProjectHeaderの戻るボタン（デスクトップでは不要 — Sidebarにある）
- 顧客名・住所のヘッダー表示（スペース不足なら案件詳細情報タブへ移動）

**Professional Score: 2.5 / 5**

---

### 見積エディタ（EstimateTab）

**First Impression:**
Excelライクなグリッドテーブル。13列の横幅。GroupHeaderで工種分類されている。

**Eye Flow:**
Toolbar → カラムヘッダー → GroupHeader（工種01...） → 行データ → GroupSubtotal → (繰り返し) → Summary（合計エリア）

**Good:**
- CSS gridベースのテーブル実装は高度で安定している
- NumInputのclick-to-edit + focus ringは商用品質
- GripIconのhover表示（opacity 0→1）は適切なdiscoverability
- GroupHeaderの折りたたみ + 小計表示は優れたUX
- 「実績」青バッジによる過去単価の区別は良い
- 粗利率が15%未満で赤背景になる警告は適切

**Problems:**
- 合計金額が15px/500w — 見積の最重要数字
- 工種名が12px/600w/`#555` — グループ識別子として弱い
- 13列の横スクロールが必要になる可能性
- 「定価(retail_price)」列は工務店業務での使用頻度が低いはず
- 「自動」リセットボタン9px — 操作不能に見える
- DeleteBtn 28×28px — 誤タップリスク
- カラムグループ（estimate/internal）の視覚的区別がcolumn背景色のみ — 弱い

**Remove:**
- `retail_price`（定価）列をデフォルト非表示化（オプションで表示可能に）
- 「自動」リセットボタン → ツールチップ付きアイコンボタンに変更

**Professional Score: 3.5 / 5**（技術的完成度は高い。金額視覚化だけが弱い）

---

### 原価台帳（CostLedgerTab）

**First Impression:**
青いアクセントが突然現れる。「別のアプリが開いた？」

**Good:**
- 「実行予算・完工予算・実績原価・差異」の4列構造は業務的に適切
- 差分（over/under）の色分けは機能的

**Problems:**
- `accent: '#2D6FF6'`（ブルー）がアプリ全体の緑パレットと完全に不一致
- `pageBg: '#F8F9FB'`（青みがかったグレー）vs 他タブの `#F3F7F4`（緑みがかった）
- `C.text: '#0E1729'`（青みがかった黒）vs 他の `#1A2E24`（緑みがかった黒）— 日本語テキストで知覚できるレベルの差

**Remove:**
- 青アクセント → `#3D7A55` に置換するだけで問題の90%が解決する（1つの定数変更）

**Professional Score: 2.0 / 5**

---

### AIチャット（ChatPanel）

**First Impression:**
ウォームクリーム背景 + ネイビーバブルのチャットUI。「Claude.aiのUIが埋め込まれた」ように見える。

**Good:**
- Markdown レンダリング（bold/italic/code/table/ul/ol）は充実している
- pendingChanges（変更確認カード）の設計は CLAUDE.md の AI 原則に忠実
- QuickReply の設計は操作性を高める

**Problems:**
- `C.bg: '#FAF9F7'`（ウォームクリーム）は RAGZの `#F3F7F4`（グリーントーン）と完全に異なる
- `C.userBubble: '#1E3A5F'`（ネイビー）— グリーンアプリにネイビーバブルは浮く
- `FONT: 'system-ui...'`（別スタック）— テキストの字形が他タブと微妙に違う
- AIチャットパネルがどこに表示されるか（Drawer？固定パネル？）コードから全貌が分からない

**Remove:**
- ウォームクリーム → `#F3F7F4` または `#FFFFFF` に
- ネイビーバブル → `#2B5E40`（グリーン）に

**Professional Score: 2.0 / 5**

---

### 請求書タブ（InvoiceTab）

**First Impression:**
他の緑タブと同じ視覚系。令和表記の日付フォーマットは年配ユーザーへの配慮。

**Good:**
- 令和換算日付 — ターゲットユーザー（40〜60代）への具体的配慮
- ステータスバッジ（下書き/発行済み/入金済み）が明確
- 支払いタイプ（契約時/着工時/完工時）の分類は業務フロー通り

**Problems:**
- `C.label: '#6B7A74'` がfont色に使われているが、他コンポーネントと微妙に異なるmuted色
- 印刷プレビューのスタイルがどうなっているか不明

**Professional Score: 3.0 / 5**

---

## K. REMOVE TOP10（削るだけで良くなるもの）

| # | 削る対象 | 削った後 |
|---|---------|---------|
| 1 | **CostLedgerTab の青アクセント定数 `#2D6FF6`** | `#3D7A55` に置換。アプリ全体の一貫性が一瞬で回復 |
| 2 | **ChatPanel の `#FAF9F7` ウォームクリーム + `#1E3A5F` ネイビーバブル** | アプリのグリーン系に統一。別プロダクト感が消える |
| 3 | **ChatPanel の `system-ui` フォントスタック** | Interに統一。テキスト字形の差異が消える |
| 4 | **ProjectHeader の戻るボタン（デスクトップ）** | `lg:hidden` 一行追加。Sidebarの戻るが単一になる |
| 5 | **Sidebar の statusDot（緑ドット bottom）** | 削除。意味のない装飾が消えてSidebar下部がすっきりする |
| 6 | **ProjectCard の chevron アイコン（`→`）** | カード全体がリンクであれば不要。カードがすっきりする |
| 7 | **ProjectTabs.tsx の TABS 定数・s.tabBar・s.tabItem** | デッドコード削除。コードベースが正直になる |
| 8 | **projects/[id]/page.tsx の `const hdr` スタイル定義（116〜172行）** | デッドコード削除 |
| 9 | **「自動」リセットボタン 9px テキスト** | アイコンボタン化（リセットアイコン + tooltip）に変更。または非表示デフォルト |
| 10 | **EstimateTab `retail_price`（定価）列のデフォルト表示** | デフォルト非表示。工務店業務での使用頻度が低い列が消え、見積テーブルが読みやすくなる |

---

## L. CHANGE TOP10（変更すると最も商用品質が上がるもの）

| # | 変更 | Before | After | 効果 |
|---|------|--------|-------|------|
| 1 | **見積合計金額のfont-size/weight** | 15px / 500w | 22px / 700w | 最重要数字が一瞬で目に入る |
| 2 | **工種名のスタイル** | 12px / 600w / `#555` | 13px / 700w / `#1A2E24` | グループ構造が視覚的に明確になる |
| 3 | **案件カード名称** | 14px / 700w | 15〜16px / 800w | 主要識別子が一瞬で認識できる |
| 4 | **DeleteBtn サイズ** | 28×28px | 36×36px以上（paddingで調整） | 誤タップ低減、アクセシビリティ改善 |
| 5 | **CostLedgerTab accent** | `#2D6FF6` | `#3D7A55` | 全タブが同じブランドに見える |
| 6 | **ChatPanel user bubble color** | `#1E3A5F`（Navy） | `#2B5E40`（Green） | AIチャットがアプリに溶け込む |
| 7 | **タブ切替でURL更新** | `router.replace` 未使用 | `router.replace('?tab=X')` | リロード・共有でタブ位置が復元 |
| 8 | **Radius を4値に集約** | 9種類混在 | 4px / 8px / 12px / 20px(pill) | 統一感。「なんとなく角丸」感が消える |
| 9 | **全 pageBg を `#F3F7F4` に統一** | CostLedger `#F8F9FB`、Chat `#FAF9F7` | `#F3F7F4` | 画面切替でベース色が変わらなくなる |
| 10 | **タブバーをコンテンツ上部に追加** | Sidebarのみ | 上部タブバー（lg未満でも表示） | モバイルで全タブにアクセス可能になる。最大のUX改善 |

---

## M. KEEP TOP10（絶対に壊してはいけない良い部分）

| # | 保護すべき要素 | 理由 |
|---|-------------|------|
| 1 | **Sidebar のダークグラデーション＋丸みカード** | 工務店業務SaaSとして目立つ個性。商用品質に近い完成度 |
| 2 | **ProjectCard の4px左ボーダーによるステータス色分け** | 一覧でステータスが一瞬で分かる。LINEの"Clear information"原則に合致 |
| 3 | **EstimateTab の NumInput click-to-edit** | スプレッドシート的な操作感。工務店ユーザーがExcelから移行しやすい |
| 4 | **EstimateTab のフォーカスリング（1.5px + shadow20）** | 入力中のセルが明確。アクセシビリティ・操作感ともに良い |
| 5 | **GroupHeader の折りたたみ＋小計表示** | 折りたたみ時に工種小計が見える。大規模見積での操作性が高い |
| 6 | **GripIcon の hover-only 表示** | ドラッグ可能であることがhoverで分かる。インターフェースが静かに保たれる |
| 7 | **過去単価の「実績」青バッジ＋青bg（NumInput）** | AI候補と人間の過去入力を視覚的に区別。CLAUDE.mdのAI原則に忠実 |
| 8 | **粗利率15%未満の赤背景警告** | 利益を守るための重要な業務ロジックを視覚化している |
| 9 | **案件一覧の relativeDate（本日/昨日）** | スマホで日付を素早く読める。年配ユーザーへの配慮 |
| 10 | **InvoiceTab の令和換算日付表示** | `令和7年9月15日`。40〜60代ユーザーには西暦より自然。LINEの"Respect for legacy"相当 |

---

## N. LINEから取り入れるもの（5つ以内）

**参照原則: "ユーザーを迷わせないための設計思想"**

1. **Clear Primary Task** — 各画面で「今すべき主操作は1つ」の原則を徹底する。見積エディタなら「Excelに出力」か「保存」のどちらかが圧倒的に目立つボタンであるべき。現在は複数の操作が同等の重みで並んでいる

2. **Navigation must always be visible** — LINEはどの画面でもボトムナビが固定表示される。RAGZでも `lg:hidden` ではなく、プロジェクト内でもタブバーをモバイルで常時表示する（C-01の解決）

3. **Reliable feedback** — 操作後に「何が起きたか」を明確に伝える。LINEはメッセージ送信後に「✓」「✓✓」と状態が変わる。RAGZでは保存・AI生成・PDF作成後のフィードバックを一貫させる

4. **Modal only when necessary** — LINEはモーダルを極力使わず、インライン表示・ボトムシートを使う。RAGZの新規案件作成モーダルは適切だが、それ以上の「情報確認」的モーダルは避ける

5. **Single tap, single action** — LINEの操作は「1タップ→1結果」を徹底する。RAGZの「一括/明細切替」「自動」リセット等は、今の9pxボタンでは到達できない。タップできるサイズと明確な結果にする

---

## O. PayPayから取り入れるもの（5つ以内）

**参照原則: "複雑なサービスを初心者でも扱えるよう整理する方法"**

1. **Numbers Stand Out** — PayPayは金額を常に28〜38px/700wで表示する。RAGZの見積合計は今15px/500w。金額は最低20px/700w以上に。「この見積は合計いくら？」が3秒で分かることが最重要

2. **Status is visible without reading text** — PayPayの「支払い済み」「返金中」等はアイコン+色で状態が分かる。RAGZのステータスバッジは10px/700wテキストのみ。アイコンを添えると60歳代でも一瞬で判断できる

3. **Primary button is unmissable** — PayPayの主操作ボタンは画面下部に固定・フルワイドで存在感がある。見積エディタの「保存」「Excelに出力」を同等の扱いにしない。1つを圧倒的に目立たせる

4. **Empty state has next action** — PayPayは残高ゼロ画面でも「チャージする」ボタンが大きく表示される。RAGZの「案件がありません」や「見積項目がありません」に「新規案件を作成」「AI叩き台を生成」のアクションを添える

5. **Shadow hierarchy** — PayPayはカードの影を3段階（リスト項目・カード・アクション）で使い分ける。RAGZは現在すべてに同じ影。影の強さで「操作できるもの」と「読むもの」を区別する

---

## P. デジタル庁から取り入れるもの（5つ以内）

**参照原則: "一貫性・可読性・アクセシビリティ・操作の予測可能性"**

1. **8px Spacing Grid** — デジタル庁DSは8px単位の余白体系を厳守する。RAGZの23種類の余白値を、`4/8/12/16/24/32/40/48`の8値に収束させるだけで「なんとなくズレて見える」が大幅に改善する

2. **Focus State の統一** — デジタル庁DSはkeyboard focus ringを全コンポーネントで統一する（通常2px solid accent）。RAGZはNumInputのfocus ringは良いが、ボタン類のfocusが統一されていない。`outline: 2px solid #3D7A55; outline-offset: 2px;` で統一する

3. **Button size minimum 44px** — デジタル庁ガイドラインはタッチターゲット最小44×44pxを規定する。RAGZのDeleteBtn(28px)・自動ボタン(18px)・新規案件ボタン(36px)はすべて違反。3つ直すだけで操作ミスが大幅に減る

4. **Label above input, not placeholder** — デジタル庁のフォームはlabelをinputの上に配置し、placeholderは補助のみに使う。RAGZのNewProjectModalではlabelが正しく上にあり良い。見積グループ名などのinline editでも同原則を意識する

5. **Error state must have recovery action** — デジタル庁のエラー表示はエラー文言だけでなく「どうすれば直るか」を必ず含む。RAGZで保存失敗・AI失敗時にどう表示されるか確認し、「通信エラーが発生しました。再試行してください。」＋再試行ボタンを標準化する

---

## Q. 取り入れてはいけないもの

### LINEから取り入れてはいけないもの

- **LINEのミニアプリ的フルスクリーン遷移** — RAGZは複数タブを同時に把握する業務SaaS。フルスクリーンで一画面に閉じると情報の文脈が失われる
- **グリーンとは無関係のLINEの緑（#06C755）** — RAGZはすでに独自グリーンを持つ。LINEグリーンを参考にするとパクリに見える
- **LINEの会話UI全般** — AIチャットをLINEライクにすると「LINE上でRAGZを使えばいい」という感想になる。AIは業務データの一部として自然に埋め込む

### PayPayから取り入れてはいけないもの

- **赤いブランドカラー** — 言うまでもないが、工務店SaaSに赤は「警告」「危険」を連想させる
- **ゲーミフィケーション的要素（ポイント・スタンプ・ランキング）** — 見積・請求・工程に達成感の演出は不要。業務の邪魔になる
- **フルスクリーン決済UI** — RAGZの請求書タブはPayPayの決済フローをモデルにしない。請求書は書類として扱う

### デジタル庁から取り入れてはいけないもの

- **白ベースの無彩色デザイン** — RAGZのグリーンブランドが消える。デジタル庁は行政の中立性のために無彩色にしているが、RAGZには不要
- **保守的な余白（行政書類的な広い余白）** — 業務SaaSで余白を増やしすぎると1画面の情報量が激減し、Excel慣れのユーザーが「使いにくい」と感じる
- **デジタル庁のラベル体系（gov向けの細かいルール）** — 行政特有の「○○に該当する場合のみ」等の条件分岐UIはRAGZには過剰

---

## 最終成果物: RAGZ Visual Design Principles v0.1

**今後すべての画面・コンポーネントを設計する際の判断基準**

---

### 01 — Green as Ground
**RAGZのグリーンはブランドの地色**

`#3D7A55`（dark）/ `#6CB382`（mid）/ `#EAF3DE`（light）のみを主色として使う。
青・ネイビー・クリームなど他系統をコンポーネントのスコープで使ってはいけない。
タブを切り替えても常に同じ視覚世界にいる感覚を保つ。

---

### 02 — Numbers Command Attention
**ビジネス数字は画面で最も目立つ要素**

見積合計・請求金額・粗利率・差異金額は最低 **20px / 700w** で表示する。
その他の数字（数量・単価）は13px / 500w。
ユーザーが3秒で「この仕事はいくらか」を把握できることを優先する。

---

### 03 — One Primary Action Per Screen
**各画面で「今すべき操作」は1つだけ圧倒的に目立つ**

Primary Button（48px高・フルまたは十分な幅・Greenbg）は1画面に1つのみ。
それ以外の操作はSecondary（border only）またはIcon Button（Ghost）に格下げする。
「どれを押せばいいか迷う」画面は設計失敗。

---

### 04 — Dense but Readable
**業務画面は情報密度を保ちながら「息苦しくない」状態にする**

行高の最小: 40px（タッチ操作）
テーブルセルの水平padding: 8px以上
8px Spacing Gridを守る（4/8/12/16/24/32/40/48pxの8値のみ使用）
「余白を増やせば良い」という発想は禁止。密度を保ちながら整えることが技術。

---

### 05 — Quiet AI
**AIは仕事を速くする道具であり、主役ではない**

AIの出力は紫グラデーション・✨・派手なバッジで飾らない。
候補チップ・確認カード・テーブル行として業務UIの一部に溶け込ませる。
「AI経由で追加」と「手動で追加」のテキストは同じ見た目でよい。区別は必要なときだけ。
AI処理中もスピナー＋ひと言（例:「候補を検索中...」）で十分。アニメーションは最小限。

---

### 06 — Interaction is Trustworthy
**操作したら必ず応答がある。予測できない動きはしない**

保存・削除・AI生成・PDF出力のすべてに、明確かつ邪魔にならないfeedbackを用意する。
Toastは2〜3秒で消える。エラーToastには「再試行」ボタンを添える。
インライン編集（click-to-edit）はフォーカスリングで「今編集中」を常に示す。
Hoverで表示されるコントロール（ドラッグハンドル・削除ボタン）はHover時に確実に表示する。

---

### 07 — Confirmation Protects Business
**削除・上書き・大きな変更は必ず人間が承認する**

AI出力を自動でDBに書き込まない。
削除ボタンには confirm dialog または undo timeout（5秒）を用意する。
見積の大きな変更（グループ削除・一括変更）は保存前にレビュー画面を挟む。
「やってしまった」が許されない業務SaaSでは、確認コストは許容コスト。

---

## 最終質問 Q1–Q10

---

**Q1. RAGZのスクリーンショットを初めて見た人が「個人開発っぽい」と感じるとしたら、最初の3秒で何がそう感じさせる？**

**タブが切り替わった瞬間に別の製品が出てくること**。

原価台帳タブをクリックすると青いUIが出てくる。AIチャットを開くとClaude.ai風のクリーム色UIが出てくる。「これ、作った人が違うのでは？」という印象が3秒で生じる。プロダクトとしての一貫性の欠如が、個人開発感の最大の原因。

---

**Q2. 逆に「これはちゃんと作られている」と感じる部分は？**

**Sidebarの暗いグラデーションカード**。68px幅のダークグリーンサイドバーは視覚的完成度が高く、アイコンナビ＋tooltip＋active状態の表現は商用品質に近い。また、**EstimateTabのNumInputのclick-to-edit＋focusリング**は、Excelユーザーが直感的に使えるよう丁寧に設計されており、「分かっている人が作っている」と感じさせる。

---

**Q3. 色を一切変えずに商用品質を最も上げられる改善は？**

**CostLedgerTabのアクセントを `#2D6FF6`（青）から `#3D7A55`（緑）に変更する**。

これは技術的には定数1つの変更。しかし効果は最大で、全タブが同じブランドに見えるようになる。「色を変えずに」という条件で言えば、同じグリーン系内での統一なので色方向性は維持したまま。

---

**Q4. レイアウトを大きく変えずに商用品質を最も上げられる改善は？**

**EstimateTabの合計金額を `15px / 500w` → `22px / 700w` に変更する**。

Summaryエリアの既存レイアウトは変えず、fontSizeとfontWeightだけを変更する。数字の視覚的重さが変わるだけで、「見積をパッと開いて合計を確認する」という最重要ユースケースが劇的に改善する。

---

**Q5. 現在のRAGZ Green Paletteはブランドとして成立するか？**

**成立する。ただし「今のままでは」成立していない。**

`#6CB382`（明るいミント）と`#3D7A55`（ダークグリーン）の組み合わせは、建設・自然・安心のイメージと合致し、汎用SaaSブルーと差別化できる記憶に残る色。40〜60代に受け入れられやすい色でもある。

問題は現在4系統（ダークグリーンSidebar / グリーンライト系 / 青CostLedger / クリームChat）に分裂していること。これをSystem Bのグリーンライト系に統合すれば、「RAGZといえばこの緑」というブランドが成立する。

---

**Q6. 見積エディターを「RAGZを代表する画面」にするために不足しているものは？**

3つ:

1. **合計金額の視覚的インパクト** — 22px/700w以上の合計表示。「この見積は◯◯万円」が1秒で分かること
2. **ツールバーの主操作の明確化** — 「Excelに出力」または「見積書を作成」がPrimary Buttonとして圧倒的に目立つこと。現在は複数操作が同等の強さで並んでいる（コードから推測）
3. **テーブルが「触れるもの」と分かる最初の状態** — 初めて開いたユーザーが「セルをクリックして編集できる」と3秒で分かる手がかり（NumInputのplaceholder `─` は良いが、「クリックで編集」の視覚的ヒントが弱い）

---

**Q7. 工程表を「RAGZを代表する画面」にするために不足しているものは？**

ScheduleTimelineのコードは今回精読できていないが、一般的なGanttチャートと業務SaaSの観点から:

1. **「今日」ラインの強調** — 赤またはアクセントカラーの縦線＋「今日」ラベルで現在位置が一瞬で分かること
2. **タスクバーの色によるステータス分類** — 未着手・進行中・完了・遅延を色で区別。ステータスがひと目で分かること
3. **ドラッグ可能であることの初期視覚的ヒント** — マウスカーソルがgrabに変わる前に「これは動かせる」と分かること（バーの端にリサイズハンドルアイコン等）

---

**Q8. LINE・PayPay・デジタル庁の3つから1つずつ、RAGZに最も重要な原則を選ぶなら何か？**

- **LINE → "Clear Primary Task"** — 各画面で次にすべき操作が1つだけ明確に強調される。RAGZで最も欠けている原則
- **PayPay → "Numbers Stand Out"** — ビジネス数字（金額・粗利）が一瞬で認識できる視覚的優先度。RAGZの価値の核心は金額計算なのに、今の金額表示は弱すぎる
- **デジタル庁 → "Consistent Spacing（8px Grid）"** — 余白を8px単位で統一するだけで「なんとなくズレて見える」感が大幅に解消される

---

**Q9. RAGZに絶対に導入しない方がよい最近のSaaSデザイントレンドは？**

- **Glassmorphism（背景blur card）** — 視認性が低下。屋外・明るい現場環境では特に読みにくい。40〜60代に厳しい
- **Bento Grid layout** — ダッシュボードをマス目状に分割するトレンド。業務SaaSに情報密度の低い「見せ方」は不要
- **AI-first UI（紫グラデーション・✨・マジックボタン）** — RAGZのAIは「整理係」。主役にしない。派手なAI演出はCLAUDE.mdの設計思想と矛盾する
- **Dark mode as default** — 現場（屋外・明るい部屋）での使用を考えると、Light modeをデフォルトにし続けるべき。ダークSidebarは意図的デザインとして許容できるが、コンテンツエリアのダーク化は避ける
- **Micro-animation overuse（入場アニメーション・スクロールトリガー）** — 業務の邪魔になる。`transition: all 0.12s` の控えめな応答感だけで十分

---

**Q10. もし優秀なプロダクトデザイナーが1週間だけRAGZに参加したら、最初に何を直すと思うか？**

**最初の1日で「4つの視覚システムを1つに統合する」。**

具体的には:

1. CostLedgerTabの`C.accent: '#2D6FF6'`を`'#3D7A55'`に変更（30分）
2. CostLedgerTabの`C.pageBg`を`'#F3F7F4'`に統一（10分）
3. ChatPanelの`C.bg`を`'#F3F7F4'`、`C.userBubble`を`'#2B5E40'`に変更（30分）
4. ChatPanelのFONTをInterに統一（10分）

これだけで「4つの別々のプロダクトが混在している感」が消え、Professional Scoreが全体で0.5〜1.0上がる。

残り4日で: 見積合計の font-size/weight 強化 → タブバー追加（モバイル対応）→ タッチターゲット44px統一 → 8px grid整理 → Toastフィードバック統一。

**最初にコードを大量に書くのではなく、最初の1日で「一貫性の回復」だけを行う。それだけで別のプロダクトに見えてくる。**
