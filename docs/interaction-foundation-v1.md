# RAGZ Interaction Foundation v1
**Audit & Design Specification — 2026-09-16**

コード実読（Sidebar.tsx / ProjectListClient.tsx / ProjectTabs.tsx / globals.css 等）
および LINE Design System / PayPay App Style Guide / デジタル庁 Design System を照合して作成。

---

## A. Executive Diagnosis

静止画では整っているRAGZが、操作すると個人開発のような不安定感を残す最大要因3つ。

### 最重要 #1 — カード・ボタンにHover/Press状態がない

`ProjectCard`（案件一覧）は `<Link>` 要素だが、hover style が一切定義されていない。`newBtn` も同様。ユーザーがマウスを乗せても画面が反応しないため「止まっているのか？クリックできるのか？」が分からない。商用SaaSで最も目立つ品質欠陥。LINE・PayPay ではタッチした瞬間（< 80ms）に必ず visual feedback が出る。

### 最重要 #2 — Focus Ring がブランド色と乖離、かつ全クリックで発火

`globals.css` の `--ring: 210 100% 52%` は青（#0A84FF 相当）。RAGZ ブランドはグリーンなのに青いリングが出る。さらに `:focus-visible` ではなく `:focus` が使われているため、マウスクリックでもリングが表示される。デジタル庁 Design System が最重要とする「**見える・一貫している・ブランドと調和している**」の3条件すべてに違反。

### 重要 #3 — 非同期操作のフィードバックシステムが存在しない

Modal 開閉にアニメーションなし（瞬間表示）。保存・削除・AI 生成の完了通知が統一されていない。AI 処理中の表示がコンポーネントごとに異なる。ユーザーは「保存されたのか？」「処理中なのか？」を確認する手段がなく、操作を繰り返したり不安になる。

---

## B. Current Interaction Inventory

コード実読から確認した現状の interaction 一覧。

| コンポーネント | 実装済み interaction | 欠けているもの | 評価 |
|---|---|---|---|
| **Sidebar — IconBtn**<br>`Sidebar.tsx` | `transition: all 0.18s` / active: gradient bg + left indicator 3px + glow shadow / tooltip: onMouseEnter 即時表示 | hover bg 変化なし（transition はあるが何も変化しない）/ `:focus-visible` / tooltip delay | 要改善 |
| **Sidebar — Tooltip**<br>`Sidebar.tsx:142` | マウス追従で固定位置表示 / pointer-events: none / ブランド色スタイル（良好） | 表示遅延なし（0ms）/ 消去遅延なし | 要改善 |
| **BottomNav — Tab**<br>`BottomNav.tsx` | active: icon stroke 太さ変化 + pip bar / color change | transition なし / hover state なし（モバイル専用のため許容範囲） | 低優先 |
| **ProjectCard**<br>`ProjectListClient.tsx:61` | border-left 4px status color / thumb / badge / chevron icon | hover: なし / pressed: なし / focus-visible: なし / cursor: pointer 未定義 | **最優先** |
| **FilterTabs**<br>`ProjectListClient.tsx:221` | `transition: background 0.15s` / active: bg white + boxShadow | boxShadow transition なし（影がジャンプする）/ hover 中間状態なし | 要改善 |
| **newBtn（新規案件）**<br>`ProjectListClient.tsx:234` | bg #2B5E40 / color white / border-radius 8px | transition: なし / hover: なし / pressed: なし / cursor: pointer 未定義 | **最優先** |
| **NewProjectModal**<br>`ProjectListClient.tsx:109` | overlay click close / auto-focus first input / disabled opacity 0.6 / saving text | open/close animation: なし / Escape key: なし / focus return on close: なし | 要改善 |
| **ProjectTabs（タブ切替）**<br>`ProjectTabs.tsx:150` | `transition: color 0.15s` / tab click → content instantly | active indicator（underline 等）なし / hover bg: なし / content transition: なし | **最優先** |
| **EstimateTab — NumInput**<br>`EstimateTab.tsx` | inline editing / RAGZ green palette 適用済み / drag-and-drop（@hello-pangea/dnd） | cell focus ring / saving state / error state / layout shift（確認要） | 要確認 |
| **globals.css** | `@keyframes spin` / `--shadow-card` / `--shadow-float` / `--shadow-modal` | `--ring` が青（#0A84FF 系）/ `prefers-reduced-motion`: なし / global transition system なし | **最優先** |

---

## C. Inconsistency TOP10

| # | 不統一の内容 | 影響箇所 | P |
|---|---|---|---|
| 1 | Transition duration: Sidebar `0.18s` / FilterTab `0.15s` / BottomNav `0ms` / ProjectTabs `0.15s`（color only） | 全画面ナビ | P0 |
| 2 | Hover state: Sidebar IconBtn あり（implied）/ ProjectCard なし / newBtn なし → 同じ「クリックできる要素」なのに反応が違う | 案件一覧 | P0 |
| 3 | Focus ring color: `--ring: 210 100% 52%`（青）/ ブランド: RAGZ Green → 全 input にブランド外の青リングが出る | 全フォーム | P0 |
| 4 | Focus trigger: `:focus`（マウスクリックでも発火）ではなく `:focus-visible` が必要 | 全インタラクティブ要素 | P0 |
| 5 | Tooltip delay: Sidebar `0ms`（即時）→ 標準 UX は 400–600ms delay。Hover 意図確認前に表示される | Sidebar | P1 |
| 6 | Modal animation: NewProjectModal が `0ms` 瞬間表示 → 背景があるのに前景が突然出現、空間感がない | 案件一覧 | P1 |
| 7 | Box-shadow on hover: FilterTabActive が `boxShadow` を持つが transition なし → 影がジャンプ | 案件一覧 | P1 |
| 8 | Border color: Modal `#C8D8CA` / Card `#E5EDE7` / TabBar `#E8ECF6` → 3種類の「デフォルト border」が存在 | 複数画面 | P1 |
| 9 | cursor: pointer 宣言: filterTab あり / newBtn なし / ProjectCard（Link）なし → ブラウザデフォルトに依存 | 案件一覧 | P1 |
| 10 | `transition: 'all'` の使用: Sidebar IconBtn に `transition: 'all 0.18s'` → 意図しないプロパティにもアニメーションが適用される危険性 | Sidebar | P2 |

---

## D. Motion Tokens

LINE は 100–200ms を標準域とし「即時性」を最重視。PayPay はタッチ反応を 80ms 以内に限定。デジタル庁は「アニメーションがない状態でも機能すること」を原則とする。これらと RAGZ の 40–60 代ユーザー（過剰な動きが不安を生む）を踏まえ、以下を定義する。

```css
/* RAGZ Motion Tokens — globals.css に追加 */
--motion-instant:  0ms;    /* チェック・トグル確認など即時フィードバック */
--motion-micro:   80ms;    /* ボタン pressed 暗転・アイコン即時変化 */
--motion-fast:   120ms;    /* hover in/out・focus ring 表示 */
--motion-normal: 180ms;    /* tab indicator・dropdown open */
--motion-medium: 250ms;    /* modal/panel open・toast 出現 */
--motion-slow:   350ms;    /* 大型要素の enter（原則使わない） */
```

| Token | Duration | 使用場面 | 使用禁止 |
|---|---|---|---|
| `instant` | 0ms | checkbox check, toggle switch, immediate value | — |
| `micro` | 80ms | button pressed bg darkening, icon state change (play→stop) | 要素の移動・サイズ変化 |
| `fast` | 120ms | hover in/out, focus ring, tooltip fade, badge color change | Modal・Drawer |
| `normal` | 180ms | tab indicator slide, filter tab bg, dropdown appear, filterTabActive shadow | 大型 Panel |
| `medium` | 250ms | modal open/close, AI chat panel slide, toast enter/exit | — |
| `slow` | 350ms | （原則使用しない。初回ページ load 時のみ） | 反復操作・button・tab |

> **設計根拠：** LINE Design System は「ユーザーが気づかない速度で動く」を理想とし、UI アニメーションの上限を 200ms 程度に設定。PayPay は「操作感の遅れ」を最大の品質問題として、タッチフィードバックを 80ms 以内に制約。デジタル庁は「アニメーションは操作の補助であり目的ではない」とし、全アニメーションに `prefers-reduced-motion` 対応を義務付ける。RAGZ の 40–60 代業務ユーザーには「動かないように感じるが触ると明確に反応する」が最適解。

---

## E. Easing Tokens

現状の RAGZ は `ease`・`ease-in-out`・`linear`・記述なし（ブラウザデフォルト）が混在。以下の4種類に統一する。

```css
/* RAGZ Easing Tokens */
--ease-standard:  cubic-bezier(0.4, 0, 0.2, 1);  /* ほとんどの状態変化 */
--ease-enter:     cubic-bezier(0, 0, 0.2, 1);    /* 要素が出現する（減速して止まる） */
--ease-leave:     cubic-bezier(0.4, 0, 1, 1);    /* 要素が退出する（加速して消える） */
--ease-linear:    linear;                         /* spinner・progress bar のみ */
```

| Token | Curve | 使用場面 |
|---|---|---|
| `ease-standard` | cubic-bezier(0.4, 0, 0.2, 1) | hover bg 変化、tab indicator slide、button color 変化、すべての状態遷移 |
| `ease-enter` | cubic-bezier(0, 0, 0.2, 1) | modal open、panel slide-in、toast enter、dropdown open |
| `ease-leave` | cubic-bezier(0.4, 0, 1, 1) | modal close、panel slide-out、toast exit、dropdown close |
| `ease-linear` | linear | spinner 回転、progress bar、思考中ドット |

> **禁止：** spring / bounce / elastic 系の easing。工務店業務 SaaS にゲームのような弾力感は不要であり、40–60 代ユーザーには「壊れた？」という不安を与える可能性がある。

---

## F. Button States

> **Scale animation 禁止。** 業務 SaaS では background / border / shadow の変化だけで十分な押下感を出せる。scale(0.96) 等は「おもちゃ感」を与え、40–60 代ユーザーには視覚的ノイズになる。

### Primary Button（例：新規案件・保存・確定）

| State | Background | Border | Text | Shadow | Transition |
|---|---|---|---|---|---|
| Default | `#2B5E40` | none | white | none | — |
| Hover | `#244E36`（−8%） | none | white | `0 2px 8px rgba(43,94,64,0.3)` | fast 120ms ease-standard |
| Pressed | `#1D3D2A`（−15%） | none | white | none | micro 80ms ease-standard |
| Focus-visible | Default bg | 2px solid `#3D7A55`, offset 2px | — | — | fast 120ms |
| Disabled | opacity: 0.38 | none | opacity 0.38 | none | instant |
| Loading | `#2B5E40` | none | +spinner left, opacity 0.8 | none | — |
| Success | `#2B5E40` → 800ms 後 default | none | ✓ アイコン（800ms 表示） | — | fast |

### Secondary Button（例：キャンセル・CSV 出力）

| State | Background | Border | Text |
|---|---|---|---|
| Default | transparent | `1.5px solid #C8D8CA` | `#2B5E40` |
| Hover | `#EAF3DE` | `1.5px solid #A8D4B5` | `#2B5E40` |
| Pressed | `#D5E8DC` | — | — |
| Disabled | transparent, opacity 0.38 | — | — |

### Danger Button（例：削除・取消）

| State | Background / Border | Text |
|---|---|---|
| Default（Tertiary variant） | transparent / border `#F4B8C8` | `#D12953` |
| Hover | `#FFF0F4` / border `#E87499` | `#B01E44` |
| Pressed | `#FFE4EC` | — |

### Icon Button（Sidebar）

現状の active 状態（gradient bg + 3px left indicator + glow）は **KEEP**。追加するのは hover 状態のみ。

- Hover: `background: rgba(108,179,130,0.10)`, transition fast 120ms
- Active 状態は変えない

---

## G. Card States

案件カードは**「押せること」が一目で分かること**が最優先。大きく浮かせる・scale する必要はない。

### ProjectCard（案件一覧）

| State | Background | Box-shadow | Left border | Chevron | Transition |
|---|---|---|---|---|---|
| Default | `#FFFFFF` | `0 0.5px 0 rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.05)` | 4px status-color | `#BDD1C3` | — |
| Hover | `#F8FAF9` | `0 2px 10px rgba(43,94,64,0.10), 0 0 0 1px rgba(43,94,64,0.06)` | 同 | `#6CB382` | fast 120ms ease-standard |
| Pressed | `#F3F7F4`（= pageBg） | none（押し込まれた感） | 同 | `#3D7A55` | micro 80ms ease-standard |
| Focus-visible | Default | +`0 0 0 3px rgba(61,122,85,0.35)` | — | — | fast 120ms |

> `cursor: pointer` を Link スタイルに明示追加すること（現在未定義）。Selected 状態は不要（カードタップ→即ページ遷移）。

---

## H. Tab States

RAGZ には2種類のタブが存在する。見た目はそれぞれのコンテキストに合わせるが、**Hover・Pressed・Active・Focus の「物理法則」は共通化する。**

### Type A — Segmented Control（FilterTabs / 案件一覧）

現状の iOS 風 Pill タブは良好。修正点は shadow transition の欠落のみ。

| State | Background | Shadow | Text | Transition |
|---|---|---|---|---|
| Default | transparent | none | `#5E8A6E` | — |
| Hover | `rgba(255,255,255,0.55)` | none | `#3D7A55` | fast 120ms ease-standard |
| Active | `#FFFFFF` | `0 1px 3px rgba(43,94,64,0.12)` | `#2B5E40`, fw 700 | normal 180ms ease-standard（**shadow 含む**） |
| Focus-visible | — | +ring | — | fast 120ms |

### Type B — Underline Tab（ProjectTabs / 見積内サブタブ）

| State | Background | Indicator（bottom border） | Text | Transition |
|---|---|---|---|---|
| Default | transparent | none | `#7A9185` | — |
| Hover | `rgba(61,122,85,0.05)` | `2px solid #A8D4B5` | `#3D7A55` | fast 120ms |
| Active | transparent | `2px solid #2B5E40` | `#2B5E40`, fw 700 | indicator: normal 180ms（slide）/ color: fast 120ms |

> **Tab 幅の固定：** Active 時に font-weight が 500→700 に変わると width が変化しレイアウトシフトが起きる。対策：`::after { content: attr(data-label); visibility: hidden; font-weight: 700 }` で常に太文字分の幅を確保する。

---

## I. Input States

EstimateTab を中心に大量の Input がある。**常に強い border を出すと「フォームだらけ」に見える。** Default 状態は軽くし、Focus 時だけ明確に示す。

| State | Border | Background | Shadow | Cursor |
|---|---|---|---|---|
| Default | `1.5px solid #D4DED7` | `#FFFFFF` | none | text |
| Hover | `1.5px solid #A8D4B5` | `#FFFFFF` | none | text |
| Focus | `2px solid #3D7A55` | `#FFFFFF` | `0 0 0 3px rgba(61,122,85,0.12)` | text |
| Filled（入力済み） | Default border | `#FFFFFF` | none | text |
| Error | `2px solid #D12953` | `#FFF5F7` | `0 0 0 3px rgba(209,41,83,0.10)` | text |
| Disabled | `1px solid #E0E8E2` | `#F5F7F5` | none | not-allowed |
| Read Only（計算セル） | **none（border 削除）** | `#F8FAF9` | none | default |

> **最重要：** EstimateTab の「計算されるセル（amount 等）」から border を除去し、背景色をわずかに変えることで「編集できるセル」「読み取り専用セル」が自然に判別できる状態にすること。Excel 的な編集感を損なわずに実現できる。

---

## J. Table / Cell States

| State | Background | Border | Cursor | その他 |
|---|---|---|---|---|
| Row Default | white / groupBg alternating | bottom `#DDE8E2` | default | — |
| Row Hover | `#EDF5EF`（= C.hover） | — | default | fast 120ms（C.hover は定義済み。適用するだけ） |
| Row Selected | `#EAF3DE` | left `2px solid #3D7A55` | default | normal 180ms |
| Cell Editable（hover） | `#FAFDF9` | `1px solid #C8D8CA` | text | 「編集可能」を示す微妙な枠 |
| Cell Focus（editing） | white | `2px solid #3D7A55` + glow | text | layout shift なし（input 幅 = セル幅） |
| Cell Modified（確定直後） | → `#EAF3DE` 400ms flash → default | — | — | 「変更が保存された」の暗示 |
| Cell Saving | — | — | — | 右端に spinner 12px（micro 80ms fade-in） |
| Cell Error | `#FFF5F7` | `2px solid #D12953` | — | エラー text を inline で表示 |
| Read-only Cell | `#F8FAF9` | none | default（text 不可） | border 除去で editable との区別を自然に |

> **Layout shift の防止：** セルをクリックして input が出現するとき、input の padding/border-width で行高が変わるのを防ぐ。解決策：行高を固定し（`height: 40px` 相当）、input を initial 状態から `border: 2px solid transparent` にしておくこと。

---

## K. Modal / Drawer

### Dialog Modal（NewProjectModal 等）

| State | Animation |
|---|---|
| Open | Backdrop: opacity 0→0.35, fast 120ms / Modal: scale 0.96→1.0 + opacity 0→1, medium 250ms ease-enter |
| Close | Modal: scale 1→0.97 + opacity 1→0, fast 150ms ease-leave / Backdrop: opacity → 0, fast 120ms |
| Escape | Close と同じ。現状未実装。追加必須。 |
| Outside Click | Close（現状実装済み・KEEP） |
| Focus | Open 時に最初の Input へ auto-focus（現状実装済み・KEEP） |
| Focus Return | Close 後に開いたボタン（newBtn 等）へ focus return。現状未実装。 |
| Scroll Lock | Modal open 中は body scroll を `overflow: hidden` でロック |

### AI Chat Panel（右側スライドパネル）

現在の思想（右側パネルで作業画面を残す）は維持。別ページ遷移案は不採用。

| State | Animation | Duration / Easing |
|---|---|---|
| Open | translateX(100%) → translateX(0) + opacity 0→1 | medium 250ms ease-enter |
| Close | translateX(0) → translateX(100%) + opacity 1→0 | fast 200ms ease-leave |
| Overlay | 不要（パネルは作業画面の横に出る。モーダルではない） | — |

---

## L. AI Chat Interaction

> **Quiet AI 原則：** 派手な Typing Animation・Sparkle・Gradient Animation は禁止。「止まった？」と思わせないことが最優先。

### Suggested Prompt Chips

| State | 変化 | Transition |
|---|---|---|
| Default | bg white, border `#D4DED7`, text `#5E8A6E` | — |
| Hover | bg `#EAF3DE`, border `#A8D4B5`, text `#2B5E40` | fast 120ms |
| Pressed | bg `#D5E8DC` | micro 80ms |

### AI Processing States

| State | 表示 | Animation |
|---|---|---|
| Sending（ユーザー送信直後） | Send button が一瞬 darken、input は clear | micro 80ms |
| Thinking | 「考えています...」+ 3点ドット pulse（RAGZ green） | ドット: translateY(−3px) 0.6s ease-in-out, delay 0/0.2s/0.4s, infinite。回転・sparkle 禁止。 |
| Streaming | テキストが自然に流れる（CSS animation なし） | ブラウザの自然なテキスト描画のみ |
| Tool Execution | 「データを確認しています...」+ spinner 14px | spinner: rotate 1s linear infinite |
| Error | 赤テキスト + retry button | instant |

---

## M. Toast / Feedback System

すべてを Toast にする必要はない。操作の規模に応じて Inline・Button State・Toast を使い分ける。

| 操作 | Feedback の種類 | 実装 |
|---|---|---|
| 見積セル保存（auto-save） | **Inline** | セル bg が `#EAF3DE` に 400ms フラッシュ → default。無音・無 Toast。 |
| 行削除 | **Toast** | 「削除しました」+「元に戻す」3秒。上部 center。 |
| PDF/Excel 出力 | **Button State** | Button: 「生成中...」(spinner) → 「完了 ✓」(800ms) → default |
| AI 生成（見積叩き台） | **Inline（Panel 内）** | Panel 内に Thinking 状態表示。完了後に結果表示。成功 Toast は不要（結果が目の前に出るため）。 |
| 案件作成 | **Navigation** | 成功 → 新案件詳細ページへ遷移。Toast 不要。 |
| エラー（通信エラー等） | **Toast（永続）** | 赤 Toast + 具体的なエラー内容 + 「再試行」ボタン。ユーザーが閉じるまで残す。 |
| データ同期完了 | **Status dot** | Sidebar 下部の status dot が pulse（現状実装済みの要素を活用） |

### Toast 仕様

| 属性 | 値 |
|---|---|
| 位置 | top-center（モバイルは bottom-nav の上方 → 画面上部が安全） |
| 成功 duration | 2500ms（自動消去） |
| Info duration | 4000ms（自動消去） |
| エラー duration | 永続（ユーザー操作で閉じる） |
| Enter animation | slideDown + fadeIn, medium 250ms ease-enter |
| Exit animation | slideUp + fadeOut, fast 150ms ease-leave |
| max-width | 360px |

---

## N. Tooltip

| 属性 | 現状 | 推奨 | 理由 |
|---|---|---|---|
| 表示 Delay | 0ms（即時） | **400ms** | Hover 通過を意図的ホバーと区別。400ms は HIG/Material 両方の標準値。 |
| 非表示 Delay | 0ms | **0ms（即時）** | 消えるのは速くて良い。遅いと邪魔になる。 |
| 表示 Animation | なし | opacity 0→1, fast 120ms | 突然出現よりも自然。 |
| 位置 | 右側（良好） | KEEP | — |
| Touch | 未対応 | Touch devices では非表示 | タッチ操作では tooltip は不要。BottomNav の label が代替。 |
| Keyboard Focus | 未対応 | focus-visible でも表示（delay 0ms） | キーボード操作者への配慮。 |

---

## O. Focus / Accessibility

> **デジタル庁 Design System より：**「フォーカスインジケーターは必ず視覚的に確認できること。キーボードとマウスで操作感に差があってはならない（ただしマウスで focus ring を見せる必要はない）。」

```css
/* globals.css に追加 — RAGZ Focus System */

/* マウスクリック時はリングを非表示（:focus-visible のみ有効） */
:focus:not(:focus-visible) {
  outline: none;
}

/* キーボード・Tab 操作時の focus ring（RAGZ ブランド色） */
:focus-visible {
  outline: 2px solid #3D7A55;
  outline-offset: 2px;
  border-radius: 4px;
}

/* 暗背景上の focus ring（Sidebar 等） */
.dark-surface :focus-visible {
  outline: 2px solid #6CB382;
  outline-offset: 2px;
}

/* --ring を更新（shadcn/ui の ring に影響） */
--ring: 152 43% 36%; /* #3D7A55 の HSL */

/* prefers-reduced-motion 対応 */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

> **`--ring` の修正は最優先。** shadcn/ui は input・button・checkbox 等の focus ring をこの変数から生成する。青→緑に変えるだけで全フォームの focus 表示が統一される。1行の変更で最大のインパクト。

---

## P. Schedule Direct Manipulation

工程表は他の UI と切り分けて設計する。ロジック変更なし。Visual feedback のみ定義。

| State | Cursor | Visual 変化 | Transition |
|---|---|---|---|
| Bar Hover | grab | bg: darken 8%、top border を 2px accent green | fast 120ms |
| Dragging | grabbing | opacity: 0.80、box-shadow: `0 4px 16px rgba(0,0,0,0.18)`（浮いた感） | micro 80ms |
| Valid Drop Zone | — | destination cell の bg: `rgba(108,179,130,0.15)` | fast 120ms |
| Invalid Drop Zone | no-drop | destination cell の bg: `rgba(209,41,83,0.08)` | fast 120ms |
| Drop Success | default | bar が新位置に収まる。flash animation なし（自然に落ち着く）。 | normal 180ms ease-enter |
| Resize Handle（hover） | ew-resize | handle の width: 3px→6px、bg: accent tint | fast 120ms |
| Resize 中 | ew-resize | bar がリアルタイムに伸縮（ライブプレビュー） | instant（lag なし） |

> **派手なアニメーション禁止。** 工程バー Drag で「ふわっと浮く・弾む・影が大きく広がる」等の効果は 40–60 代ユーザーにとって「バグ？」と映る。shadow 0→4px 程度の控えめな浮上感で十分。

---

## Q. KEEP — 現在の良い Interaction

| 要素 | なぜ良いか |
|---|---|
| **Sidebar Active State** | gradient bg + 3px left indicator + glow shadow の組み合わせが「現在地」を明確に示す。商用 SaaS 品質。このパターンをベースに hover state を追加すればよい。 |
| **FilterTab Segmented Control** | iOS 風の Pill タブは「進行中/完了/すべて」の切り替えとして直感的。白背景に浮かぶ動作が明快。shadow の transition を追加するだけでほぼ完成。 |
| **ProjectCard status border-left** | ステータスを 4px 左ボーダーの色でエンコード。一覧で瞬時にスキャンできる。スペース効率が高い。 |
| **Sidebar Tooltip デザイン** | 暗緑グラデーション背景 + 白テキスト + 左向き三角のスタイル自体は良好。表示遅延（400ms）を追加するだけでよい。 |
| **NewProjectModal auto-focus** | open と同時に inputRef に focus を当てる実装が正しい。キーボードユーザーにとって即座にタイプできる。 |
| **Disabled state opacity** | Saving 中の submit button に `opacity: 0.6` を適用するパターンは正しい。「操作できない状態」が視覚的に明確。 |
| **EstimateTab C object** | RAGZ green パレットが完全に定義されている。他コンポーネントがこれを参照するべきモデル。 |

---

## R. REMOVE — 削除・廃止すべき Interaction

| 要素 | 問題 | 代替 |
|---|---|---|
| `transition: 'all 0.18s'` | Sidebar IconBtn に使用。"all" はすべてのプロパティをアニメーションさせる。意図しない箇所に影響し、レイアウト計算コストが高い。 | `transition: 'background-color 120ms ease, box-shadow 120ms ease, color 120ms ease'` |
| Tooltip 即時表示（0ms delay） | マウス通過のたびに Tooltip が出現し、視覚ノイズになる。Sidebar アイコンを素早くスキャンすると全 tooltip が出る。 | 400ms delay + `clearTimeout` でマウスが去ったら表示キャンセル |
| `--ring: 210 100% 52%`（青） | ブランドカラーと完全に不一致。全 shadcn/ui input の focus ring が青になる。 | `--ring: 152 43% 36%`（#3D7A55 の HSL） |
| Modal instant appear | NewProjectModal が 0ms で突然出現。空間的な文脈がなく「ポップアップ広告のような唐突さ」がある。 | scale 0.96→1 + fadeIn, medium 250ms |

---

## S. STANDARDIZE — 共通化すべき Interaction

| カテゴリ | 現状 | 統一案 |
|---|---|---|
| Duration | 0ms / 0.15s / 0.18s が混在 | `--motion-micro(80)` / `--motion-fast(120)` / `--motion-normal(180)` / `--motion-medium(250)` |
| Hover background | 各コンポーネントが独自に定義 | 編集可能要素: `#EDF5EF`（C.hover 相当）/ カード: `#F8FAF9` |
| Border color（デフォルト） | `#C8D8CA` / `#E5EDE7` / `#E8ECF6` の3種 | `#D4DED7`（light）/ `#C8D8CA`（medium）の2種に整理 |
| Focus ring | 各所でバラバラ。`--ring` が青。 | `:focus-visible { outline: 2px solid #3D7A55; outline-offset: 2px; }` を globals.css に1箇所 |
| cursor: pointer | 一部の button のみ定義 | 全インタラクティブ要素（button, a, [role="button"]）に明示的に定義 |
| Disabled 表現 | opacity 0.6（一部） | `opacity: 0.38`（Material 準拠）+ `cursor: not-allowed` に統一 |

---

## T. Pilot — 案件一覧 Implementation Plan

案件一覧は Card・Button・Tab・Modal・Tooltip が揃う最適なパイロット画面。以下を順番に適用する。

| Step | 内容 | Priority | Risk | Cost |
|---|---|---|---|---|
| 1 | `globals.css` — `--ring` を緑に変更（1行）。全 shadcn/ui component の focus ring 色が一括修正される。 | P0 | Low | Low |
| 2 | `globals.css` — `:focus-visible` + `prefers-reduced-motion` 追加 | P0 | Low | Low |
| 3 | ProjectCard — hover / pressed state 追加。cursor: pointer 追加。 | P0 | Low | Low |
| 4 | newBtn — hover（background darken）/ transition fast 120ms / cursor: pointer 追加 | P0 | Low | Low |
| 5 | FilterTab — shadow transition 修正（boxShadow に transition を追加） | P1 | Low | Low |
| 6 | NewProjectModal — open/close animation / Escape key / focus return 追加 | P1 | Medium | Medium |
| 7 | Sidebar Tooltip — 400ms delay 追加 | P1 | Low | Low |
| 8 | Sidebar IconBtn — `transition: all` → specific properties に変更 / hover bg 追加 | P1 | Low | Low |

---

## U. Rollout Plan

| Phase | 対象 | 内容 |
|---|---|---|
| **1** | 案件一覧 | T項 Step 1–8 を適用。globals.css 修正が全画面に波及するため最初に行う。 |
| **2** | 見積エディタ | Row hover / Cell states / Read-only border 除去 / saving flash。EstimateTab.tsx の C.hover を実際の row hover に適用。 |
| **3** | 原価台帳 | CostLedgerTab の row hover / vendor 展開 / cell 状態。Phase 2 と同パターンのため実装コスト低。 |
| **4** | 請求書 | InvoiceTab。Button states（PDF 出力・発行）の Loading/Success を中心に。 |
| **5** | AI Chat Panel | slide animation / Thinking state / Suggested prompt hover。ChatPanel.tsx。 |
| **6** | 工程表 | ScheduleTab。Drag/Resize visual feedback のみ。ロジック変更なし。リスクが最も高いため最後。 |

> **Toast System は Phase 1 と同時に実装。** 全フェーズで使用するため、最初にグローバルな ToastProvider を用意しておく。

---

## Q1 – Q14

**Q1. 現在のRAGZを触った人が「個人開発っぽい」と感じる可能性が最も高いInteractionは何か？**

ProjectCard（案件一覧）にHover状態がないこと。一覧の主要要素であるカードがマウスに全く反応しない。「クリックできる」という最基本のシグナルが欠けており、これだけで商用SaaSとの品質差を瞬時に感じさせる。

---

**Q2. 逆に現在すでに「商用SaaSっぽい」Interactionは何か？**

SidebarのActive State。gradient背景 + 3px左インジケーター + glow shadowの組み合わせは、現在地を明確に示し視覚的な重みがある。LINE・PayPayに並ぶ水準。FilterTabのSegmented Controlも良好。

---

**Q3. 1つだけInteractionを改善するなら何か？**

globals.cssの `--ring` を緑に変更する（1行）。この1行で全shadcn/ui component（input, button, checkbox, select）のfocus ring色がRAGZブランドと一致する。影響範囲が最大、コストが最小。

---

**Q4. カードのHover / Pressedはどうするべきか？**

background微変化 + shadow 2段階 + chevron色変化。Scale禁止。
- Hover: bg `#F8FAF9`、shadow少し深く、chevron `#BDD1C3`→`#6CB382`
- Pressed: bg `#F3F7F4`、shadow消える（押し込まれた感）

この3つだけで十分なProfessional感が出る。

---

**Q5. Tab切替はどうするべきか？**

Indicator slideをnormal 180ms、content切替はinstant。contentにfadeやslideを入れると重く感じる。indicatorだけをアニメーションさせ、contentは即座に表示。Tab幅はfont-weight変化で変わらないよう `::after` 疑似要素で幅確保。

---

**Q6. Buttonを押した瞬間のFeedbackはどうするべきか？**

background darken（micro 80ms）のみ。Scale禁止。Primary buttonなら `#2B5E40`→`#1D3D2A`。Shadow消去（地面に押し込まれた感）。この変化は80msで即時起きるため「反応した」とユーザーが感じる。

---

**Q7. 保存処理はどのように見せるべきか？**

セルレベルはgreen flash（400ms）、主要操作はButton state、エラーのみToast。AutosaveのたびにToastを出すと画面が騒がしくなり40–60代ユーザーが不安になる。「静かに確実に保存される」体験が目標。エラーだけは永続Toastで必ず気づかせる。

---

**Q8. AIが考えている間は何を表示するべきか？**

「考えています...」テキスト + 3点ドットpulse（RAGZ green、垂直移動のみ、600ms）。回転アニメーション・sparkle・gradient animationは全て禁止。Quietさを保ちつつ「処理中」が明確に伝わる最小限の表現。

---

**Q9. 工程BarのDragを気持ちよくするには何が必要か？**

cursor: grab → grabbing の切り替え + opacity 0.80 + shadow lift（0→4px）の3つだけ。Drop zoneのgreen tint（rgba 15%）で「ここに置ける」が分かる。弾む・跳ねる・光る等の演出は禁止。正確な業務作業には余計なノイズ。

---

**Q10. RAGZにAnimationを入れすぎたと判断する基準は何か？**

「このAnimationが消えたらユーザーが状態を理解できなくなるか？」をすべてのAnimationに問う。答えがNoなら削除。すべてのAnimationはフィードバック・状態変化・空間移動の補助でなければならない。装飾・雰囲気のためのAnimationはRAGZでは禁止。「2秒間RAGZを見て、動きに気づかなければ成功」が判断基準。

---

**Q11. LINEからInteraction面で最も取り入れるべき原則は？**

「即時性（Immediate Response）」— タッチ・クリックから80ms以内にvisual feedbackを出す。LINEは「反応の遅さ」をUXの最大問題として、全インタラクションに即時フィードバックを課す。RAGZでもButton pressed(micro 80ms)とcell focus(fast 120ms)を守ることでこの原則を実現できる。

---

**Q12. PayPayからInteraction面で最も取り入れるべき原則は？**

「State Clarity（状態の明確性）」— pressed・disabled・loadingを視覚的に区別しきる。PayPayは決済という高信頼性が必要な文脈で、「操作が受け付けられたか？」「処理中か？」「完了したか？」を常に明確にする。RAGZも見積・請求という金額に関わる操作で同レベルのState clarityが必要。

---

**Q13. デジタル庁からInteraction面で最も取り入れるべき原則は？**

「`:focus-visible` + `prefers-reduced-motion`」— アクセシビリティの基礎を地道に実装する。デジタル庁DSは「見える・一貫している・ブランドと調和しているfocus indicator」と「Animationがなくても機能するUI」を義務とする。この2点はRAGZの40–60代ユーザー（メガネ着用・手袋操作）にも直接効く最重要項目。

---

**Q14. 優秀なProduct Designer + Frontend Engineerが1週間参加した場合、最初の3日で何を直すか？**

**1日目：** globals.cssを開いてfocus ring（--ring）を緑に修正。`:focus-visible`を追加。`prefers-reduced-motion`を追加。これだけで「作った人がアクセシビリティを理解している」という信頼が生まれる。

**2日目：** ProjectCard hover/pressed state追加。newBtn hover/transition追加。cursor: pointer漏れを全体で確認・修正。この日が終わると「触った瞬間の感触」が商用SaaS水準になる。

**3日目：** Toast Systemをグローバルに用意。NewProjectModal open/close animationを追加。Sidebar Tooltipに400ms delayを追加。この3日でPhase 1（案件一覧）のPilot実装が完成する。

---

*RAGZ Interaction Foundation v1 — 実装時は必ず本ドキュメントを参照し、Motion TokenとEasing Tokenに準拠すること。*
