# CLAUDE.md — 現場AI 実装指示書 v1.0

## このファイルについて
Claude Code が実装時に必ず参照する設計指示書。
変更する場合は必ずたかしさんと合意した上で更新すること。

---

## プロジェクト概要

**プロダクト名：** 現場AI  
**目的：** 工務店の現場情報（写真・メモ・音声）をLINEで集め、AIで整理し、見積作成・職人共有までをシンプルに行う業務補助ツール  
**対象ユーザー：** 工務店の社長・管理者・現場職人（スマホ操作・手袋あり想定）  
**技術スタック：** Next.js / TypeScript / Tailwind CSS / shadcn/ui / Supabase / Vercel / Claude API / LINE Messaging API

---

## 絶対に守る方針

### AIの役割制限
- AI は「整理係」であり「判断者」ではない
- 見積金額を AI が確定してはいけない
- 発注・通知を AI が自動送信してはいけない
- AI が出力するものは必ず「候補」「下書き」「叩き台」
- AI 出力は必ず編集可能な JSON 形式で返す（文章のみの返却禁止）
- 写真のカテゴリ分類も AI は候補を出すだけ。自動確定禁止。
- AI 出力には必ず免責文を内部的に持たせる：
  「この内容はAIによる整理結果です。最終判断は担当者が行ってください。」

### セキュリティ（絶対厳守）
- `service_role` key は `lib/supabase/admin.ts` のみに記述
- `NEXT_PUBLIC_` の変数名に秘密鍵を置かない
- `admin.ts` を import できるファイルは以下の4箇所のみ：
  - `app/api/webhook/line/route.ts`
  - `app/api/share/[token]/route.ts`
  - `app/api/pdf/route.ts`（必要時のみ）
  - `app/api/cron/daily-briefing/route.ts`（Phase 3 追加・全会社横断処理のため承認済み）
- それ以外は必ず `getServerClient()`（RLS有効）を使う
- Storage バケットは private
- signed URL をDBに保存しない（`storage_path` のみ保存）
- `share_links` テーブルに anon 用 RLS ポリシーを作らない
- 共有リンクの検証は `/api/share/[token]` のサーバーサイドのみで行う
- 共有リンクのレスポンスに原価・利益・見積金額・管理者メモを含めない

---

## 画面構成（3画面 + 見積書ドキュメント）

### 画面① 案件一覧 `/projects`
- カード形式（写真サムネイル優先表示）
- ステータスバッジで色分け
- 未確認メモは赤で表示
- 未振り分けLINEメッセージは上部バナーで通知
- 進行中・完了でセクション分け
- 下部固定ナビ（案件一覧・設定の2項目）

**ステータス定義：**
| status | 表示 | バッジ色 |
|--------|------|---------|
| collecting | 情報収集中 | グレー |
| reviewing | 確認中 | 黄 |
| estimating | 見積作成中 | オレンジ |
| scheduled | 工程作成済 | 青 |
| done | 完了 | 緑 |

### 画面② 案件詳細 `/projects/[id]`
**レイアウト：上下分割（案B）**

```
┌─────────────────────────────────┐
│ ヘッダー（戻る・案件名・共有・PDF）│
├─────────────────────────────────┤
│ 上段：写真エリア（横スクロール）   │
│ 現場メモ（チップ形式・横スクロール）│
├──────────────┬──────────────────┤
│ 左：AI整理メモ │ 右：見積エディタ   │
│  ・現調まとめ  │  ・項目テーブル    │
│  ・作業項目候補│  ・金額自動計算    │
│  ・注意点     │  ・Excel/PDF出力  │
│  ・見積参考   │  ・見積書を作成ボタン│
└──────────────┴──────────────────┘
│ FAB右下：AIで整理する             │
```

**レスポンシブ：**
- PC（1025px〜）：上下分割・下段2カラム並列
- タブレット（768〜1024px）：同上
- スマホ（〜767px）：タブ切替（写真 / AI整理 / 見積 / 工程）、デフォルトは「写真」タブ

**写真エリア仕様：**
- 場所フィルター（横スクロールチップ）＋ 工程フィルター（タブ）の2軸
- 場所 × 工程でグループ表示
- 未振り分け写真は黄色バナーで通知
- 振り分けはタップ → 場所・工程を選択 → 確定
- AIは分類候補を出すが自動確定しない
- 管理者がWeb画面で振り分ける

### 画面③ 設定 `/settings`
- iOSライクなリスト形式
- 会社情報・見積書設定・LINE連携・通知・アカウント
- LINE Webhook URL のコピーボタン

### 見積書ドキュメント `/projects/[id]/estimate`
- 案件詳細エディタから「見積書を作成」ボタンで遷移
- 顧客提出用の正式書類フォーマット
- 型番・仕様・備考・特記事項を自由記入
- 会社名・担当者・発行日・有効期限・見積番号
- PDF出力 / Excel出力

---

## デザイントークン

```
カラー：
  Primary   : #1e3a5f（ネイビー）
  Background: var(--color-background-primary)（白）
  Border    : var(--color-border-tertiary)
  Warning   : #FFF7ED / #9A3412（オレンジ・注意点）
  Alert     : #FFFBEB / #92400E（黄・未振り分け）
  Success   : #EAF3DE / #3B6D11（緑・完了）
  AI accent : #EFF6FF / #1D4ED8（青・AI生成行）

タイポグラフィ：
  見出し  : 15-16px / font-weight 500
  本文    : 13px
  補足    : 11-12px
  ラベル  : 11px / uppercase / letter-spacing 0.04em

タッチターゲット：
  ボタン最小高さ : 44px（FABは52px）
  カードタップ領域: カード全体

角丸：
  カード   : border-radius-lg
  ボタン   : border-radius-md
  バッジ   : 4px
  チップ   : 20px（ピル型）
```

---

## ディレクトリ構成

```
genba-ai/
├── app/
│   ├── (auth)/
│   │   └── login/page.tsx
│   ├── (dashboard)/
│   │   ├── layout.tsx                ← 認証チェック・ナビ
│   │   ├── projects/
│   │   │   ├── page.tsx              ← 画面①：案件一覧
│   │   │   └── [id]/
│   │   │       ├── page.tsx          ← 画面②：案件詳細
│   │   │       └── estimate/
│   │   │           └── page.tsx      ← 見積書ドキュメント
│   │   └── settings/
│   │       └── page.tsx              ← 画面③：設定
│   ├── share/
│   │   └── [token]/
│   │       └── page.tsx              ← 職人向け共有（認証不要）
│   └── api/
│       ├── webhook/line/route.ts     ← ★admin.ts使用①
│       ├── share/[token]/route.ts    ← ★admin.ts使用②
│       ├── pdf/route.ts              ← ★admin.ts使用③（必要時のみ）
│       ├── cron/daily-briefing/route.ts ← ★admin.ts使用④（Phase 3 承認済み）
│       ├── ai/summarize/route.ts     ← AI整理（server.ts）
│       ├── ai/estimate/route.ts      ← 見積叩き台生成（server.ts）
│       ├── ai/schedule/route.ts      ← 工程叩き台生成（server.ts）
│       ├── ai/classify-photos/route.ts ← 写真分類候補（server.ts）
│       └── files/signed-url/route.ts ← Storage URL発行（server.ts）
├── components/
│   ├── projects/
│   │   ├── ProjectCard.tsx
│   │   ├── PhotoPanel.tsx            ← 写真エリア（分類UI含む）
│   │   ├── PhotoCategoryFilter.tsx   ← 場所・工程フィルター
│   │   ├── PhotoClassifyModal.tsx    ← 振り分けモーダル
│   │   ├── AiMemoPanel.tsx
│   │   ├── EstimateEditor.tsx        ← 下書きエディタ
│   │   ├── EstimateDocument.tsx      ← 正式見積書
│   │   ├── ScheduleEditor.tsx
│   │   ├── ShareLinkPanel.tsx
│   │   └── LineEventInbox.tsx        ← 未振り分けLINEメッセージ
│   └── ui/                           ← shadcn/ui
├── lib/
│   ├── supabase/
│   │   ├── admin.ts                  ← service_role専用（3箇所のみ）
│   │   ├── server.ts                 ← 通常処理（RLS有効）
│   │   └── client.ts                 ← ブラウザ用
│   ├── ai/
│   │   ├── summarize.ts
│   │   ├── estimate.ts
│   │   ├── schedule.ts
│   │   └── classify-photos.ts        ← 写真分類候補生成
│   ├── line/
│   │   └── webhook.ts
│   ├── storage/
│   │   └── index.ts
│   └── excel/
│       └── index.ts
├── types/
│   └── index.ts
└── middleware.ts
```

---

## DB設計（確定版）

```sql
-- ① 会社
CREATE TABLE companies (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  display_name TEXT,
  tax_rate     NUMERIC DEFAULT 0.10,
  created_at   TIMESTAMPTZ DEFAULT now()
);

-- ② 会社メンバー
CREATE TABLE company_members (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
  user_id    UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  role       TEXT DEFAULT 'member',
  UNIQUE(company_id, user_id)
);

-- ③ 案件
CREATE TABLE projects (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID REFERENCES companies(id) ON DELETE CASCADE,
  name          TEXT NOT NULL DEFAULT '新規現調',
  customer_name TEXT,
  site_address  TEXT,
  status        TEXT DEFAULT 'collecting',
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);

-- ④ 現場ファイル（写真・音声・PDF統合）
CREATE TABLE project_files (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     UUID REFERENCES projects(id) ON DELETE CASCADE,
  company_id     UUID REFERENCES companies(id),
  file_type      TEXT NOT NULL,  -- 'photo' | 'audio' | 'pdf' | 'other'
  source         TEXT DEFAULT 'web',  -- 'web' | 'line'
  storage_path   TEXT NOT NULL,
  thumb_path     TEXT,
  medium_path    TEXT,
  file_size      INT,
  memo           TEXT,
  transcription  TEXT,
  ai_description TEXT,
  location_tag   TEXT,   -- 場所（LDK / 屋根 / 外壁 / 浴室 / 玄関 / その他）NULL=未振り分け
  process_tag    TEXT,   -- 工程（着工前 / 施工中 / 完工後）NULL=未振り分け
  ai_location_suggestion TEXT,  -- AIが提案した場所候補（参考のみ）
  ai_process_suggestion  TEXT,  -- AIが提案した工程候補（参考のみ）
  sort_order     INT DEFAULT 0,
  created_at     TIMESTAMPTZ DEFAULT now(),
  deleted_at     TIMESTAMPTZ
);

-- ⑤ 現場メモ
CREATE TABLE project_notes (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  company_id UUID REFERENCES companies(id),
  source     TEXT DEFAULT 'web',
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ⑥ AI整理結果
CREATE TABLE ai_summaries (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   UUID REFERENCES projects(id) ON DELETE CASCADE,
  company_id   UUID REFERENCES companies(id),
  result_type  TEXT NOT NULL,
  -- 'summary' / 'work_list' / 'cautions' / 'estimate_memo'
  -- 'estimate_items' / 'schedule_items'
  content      JSONB NOT NULL,
  is_confirmed BOOLEAN DEFAULT false,
  model_used   TEXT,
  tokens_in    INT,
  tokens_out   INT,
  created_at   TIMESTAMPTZ DEFAULT now()
);

-- ⑦ 見積項目（下書きエディタ用）
CREATE TABLE estimate_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID REFERENCES projects(id) ON DELETE CASCADE,
  company_id    UUID REFERENCES companies(id),
  name          TEXT NOT NULL,
  description   TEXT,
  quantity      NUMERIC DEFAULT 1,
  unit          TEXT DEFAULT '式',
  cost_price    NUMERIC,
  selling_price NUMERIC,
  amount        NUMERIC GENERATED ALWAYS AS (quantity * selling_price) STORED,
  memo          TEXT,
  sort_order    INT DEFAULT 0,
  source        TEXT DEFAULT 'manual',  -- 'manual' | 'ai' | 'past_item'
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);

-- ⑧ 見積書ドキュメント（正式書類）
CREATE TABLE estimate_documents (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     UUID REFERENCES projects(id) ON DELETE CASCADE,
  company_id     UUID REFERENCES companies(id),
  estimate_number TEXT,          -- 見積番号（EST-2024-0042）
  issued_at      DATE DEFAULT CURRENT_DATE,
  expires_at     DATE,
  customer_name  TEXT,
  project_title  TEXT,
  content        JSONB NOT NULL, -- 行データ（型番・仕様・備考含む自由形式）
  notes          TEXT,           -- 備考・特記事項
  subtotal       NUMERIC,
  tax_amount     NUMERIC,
  total          NUMERIC,
  created_at     TIMESTAMPTZ DEFAULT now(),
  updated_at     TIMESTAMPTZ DEFAULT now()
);

-- ⑨ 会社の過去見積項目DB
CREATE TABLE company_estimate_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID REFERENCES companies(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  category      TEXT,
  unit          TEXT DEFAULT '式',
  cost_price    NUMERIC,
  selling_price NUMERIC,
  memo          TEXT,
  usage_count   INT DEFAULT 1,
  last_used_at  TIMESTAMPTZ DEFAULT now(),
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

-- ⑩ 工程項目
CREATE TABLE schedule_items (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  company_id UUID REFERENCES companies(id),
  name       TEXT NOT NULL,
  start_date DATE,
  end_date   DATE,
  assignee   TEXT,
  memo       TEXT,
  sort_order INT DEFAULT 0,
  source     TEXT DEFAULT 'manual',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

-- ⑪ 会社メモ
CREATE TABLE company_memos (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
  category   TEXT,
  content    TEXT NOT NULL,
  is_active  BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ⑫ 共有リンク
CREATE TABLE share_links (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  company_id UUID REFERENCES companies(id),
  token      TEXT UNIQUE NOT NULL,
  label      TEXT,
  expires_at TIMESTAMPTZ,
  is_revoked BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ⑬ LINEイベントログ
CREATE TABLE line_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   UUID REFERENCES companies(id),
  line_user_id TEXT NOT NULL,
  event_type   TEXT,
  raw_content  TEXT,
  storage_path TEXT,
  project_id   UUID REFERENCES projects(id),  -- 手動紐付け後に設定
  is_processed BOOLEAN DEFAULT false,
  received_at  TIMESTAMPTZ DEFAULT now()
);

-- ⑭ 同義語辞書（将来追加予定）
-- pg_trgm は表記ゆれ・誤字に強いが「浴室→システムバス」のような同義語・別表現には対応できない。
-- 栗本様自身が自社用語でカスタム登録できる仕組みを将来提供する。
-- extractSearchTerms() が Claude に渡す前処理として適用し、変換後の用語でマッチングする。
CREATE TABLE company_synonyms (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  input_word  TEXT NOT NULL,  -- ユーザーが話す言葉（例: 浴室、ユニットバス、台所）
  target_term TEXT NOT NULL,  -- company_estimate_items.name に近い標準用語（例: システムバス）
  created_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE(company_id, input_word)
);
```

### RLS（全テーブル共通）

```sql
-- 例：projects（他テーブルも同パターン）
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY "自社データのみ" ON projects
  FOR ALL USING (
    company_id IN (
      SELECT company_id FROM company_members
      WHERE user_id = auth.uid()
    )
  );

-- share_links：anon用ポリシーは作らない
ALTER TABLE share_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY "管理者のみ操作可" ON share_links
  FOR ALL USING (
    company_id IN (
      SELECT company_id FROM company_members
      WHERE user_id = auth.uid()
    )
  );
-- 職人からのアクセスは /api/share/[token] 経由のみ
```

---

## AI出力 JSON仕様

AIは必ずこの形式で返す。文章のみの返却禁止。

```typescript
// /api/ai/summarize
{
  summary: string,
  work_list: string[],
  cautions: string[],
  estimate_memo: string
}

// /api/ai/estimate
{
  items: Array<{
    name: string,
    description?: string,
    quantity: number,
    unit: string,
    selling_price: number | null,  // 不明はnull
    memo?: string
  }>
}

// /api/ai/schedule
{
  items: Array<{
    name: string,
    duration_days: number,
    order: number,
    memo?: string
  }>
}

// /api/ai/classify-photos
{
  suggestions: Array<{
    file_id: string,
    location_suggestion: string,  // 場所候補
    process_suggestion: string,   // 工程候補
    confidence: 'high' | 'low'
  }>
}
```

---

## Storage設計

```
バケット名: genba-ai（private）

{company_id}/
└── {project_id}/
    ├── photos/
    │   ├── original/  {file_id}.jpg
    │   ├── medium/    {file_id}.jpg  （1200px）
    │   └── thumb/     {file_id}.jpg  （400px）
    ├── audio/
    │   └── {file_id}.m4a
    └── estimates/
        └── {file_id}.pdf
```

---

## 環境変数

```bash
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=     # フロント用・公開可
SUPABASE_SERVICE_ROLE_KEY=         # サーバーのみ・絶対公開禁止
LINE_CHANNEL_SECRET=
LINE_CHANNEL_ACCESS_TOKEN=
ANTHROPIC_API_KEY=
OPENAI_API_KEY=                    # Whisper用
NEXT_PUBLIC_APP_URL=
```

---

## 実装順序

```
Step 1  土台（Next.js作成済・shadcn/ui導入済）
        → Supabase新規プロジェクト・環境変数設定・Vercelデプロイ

Step 2  DB作成・RLS設定
        → 上記SQL全テーブル実行・全テーブルRLS設定

Step 3  認証
        → ログイン画面・middleware.ts・会社初期作成

Step 4  案件一覧画面

Step 5  案件詳細画面（上下分割レイアウト）

Step 6  写真アップロード・Storage・signed URL・分類UI

Step 7  AI整理ボタン（Claude API）

Step 8  見積エディタ（下書き）

Step 9  見積書ドキュメント画面（正式書類・自由編集）

Step 10 見積PDF・Excel出力

Step 11 過去見積候補・AI見積叩き台

Step 12 工程表

Step 13 共有リンク・職人向け閲覧ページ

Step 14 LINE Webhook・未振り分けUI・手動紐付け

Step 15 音声文字起こし（Whisper API）

Step 16 設定画面整備・会社メモ
```

---

## 将来の機能拡張

### マスター自動還元（今後実装）

案件が「完了（done）」になったとき、その案件の `estimate_items` を
`company_estimate_items` へ自動フィードバックする仕組み。

**目的:** 実際に使った単価・品名が蓄積されることで、pg_trgm マッチングの精度が
案件を経るごとに自然に向上する（使うほど賢くなるサイクル）。

**動作イメージ:**
1. `projects.status` が `done` に更新されたとき（または管理者が「確定」ボタンを押したとき）
2. `estimate_items` を `company_estimate_items` に UPSERT
   - 同名の項目が存在する場合は `usage_count + 1`・`last_used_at` を更新
   - 新規の場合は INSERT
3. 自動 UPSERT なので、将来的には「プレビュー＋承認」フローの追加を検討する

**実装上の注意:**
- `source = 'auto_reflected'` 等のフラグで手動登録と区別できるようにする
- service_role が必要なため API Route 経由（admin.ts の使用箇所に追加検討）

---

### 前例照合の限界を伝える仕組み ── 精度の自己申告（今後実装）

#### 背景・設計思想

現場AIの本質的な価値は「**前例照合が効く標準工事**」（設備交換・内装張替え・
外壁補修など）にある。構造変更・耐震補強・大規模改築など、前例が効かない案件まで
同じように候補チップを出すと、見た目上は動いているが実際には危険な状態になる。

強度計算・法規判断・特殊工法の積算といった専門領域にAIが踏み込むのではなく、
**「前例が効く/効かない」をシステム自身が正直に切り分けて伝えること**を優先する。

#### 実装方針

pg_trgm の `similarity` スコアをUIに反映し、スコアの高低に応じて注意喚起の強さを変える。

| スコア帯 | 表示 | 見た目 |
|---|---|---|
| 0.7 以上 | 候補チップを通常表示 | 現行と同じ |
| 0.3〜0.69 | チップを表示 + 「参考程度にご確認を」 | 黄色の補足テキスト |
| 0.1〜0.29 | チップを表示 + 「前例が薄い項目です。金額を要確認」 | オレンジの補足テキスト |
| 0件 | 「前例が薄い案件です。金額を1から確認してください」 | 赤みがかった警告テキスト |

#### 実装対象ファイル

- `components/projects/AiMemoPanel.tsx` — チップ表示部分に `similarity` を参照したラベルを追加
- `match_estimate_items()` の戻り値はすでに `similarity` を含んでいるため、
  DBやAPIの変更は不要。フロントエンドのみの修正で対応できる。

#### 注意点

- スコアの閾値（0.7 / 0.3 / 0.1）はデモ後に実データで調整する。
  初期値はあくまで仮の区切り。
- AI が「この案件は前例照合できない」と判断して候補を出さないのではなく、
  あくまで「スコアを正直に開示して人間に判断させる」設計にすること。
  AI が採否を決めない原則を守る。

---

### AI相棒機能（将来ロードマップ）

単なる「整理係」から「気づきを与える相棒」へのアップグレード案。
いずれも AI は「候補・気づき」を提示するにとどめ、確定・変更は行わない
（「AI は整理係であり判断者ではない」の原則を維持）。

**① 写真連動による精度向上**
音声・テキストに加え、同 LINE イベントに付随した写真を Claude Vision に渡し、
「写真から読み取れる工事内容」をコンテキストに加えて `extractSearchTerms()` の精度を上げる。
実装想定: 同一 `line_user_id` × 近い `received_at` の写真を自動的に紐付けてプロンプトに追加。

**② 相場逸脱の気づき提示**
見積叩き台を生成した際、単価が `company_estimate_items` の過去実績と大きく乖離している行を
ハイライトし「過去実績より ○% 高い」と表示する。
最終判断は担当者。AI が金額を変更・補正しない。

**③ 抜け漏れの気づき提示**
過去の類似案件と見積項目を比較し、
「この工種では通常〇〇が含まれますが今回は含まれていません」と候補を提示する。
判断・採否は担当者。AI は提案のみ。

---

### メーカー・型番の区別と仕様書データとの連携（今後実装）

現状、`company_estimate_items` はメーカー名を持たない（内訳明細書のみを取り込んだため）。
実際のメーカー・型番情報は、テンプレート内の「仕様書」「外部仕上げ表」「1階/2階仕上げ表」
等の別シートに存在している（例: Panasonic, LIXIL, サンゲツ, 神島化学）。

**目的:** 将来、これらのシートも横断的に取り込み、`company_estimate_items` に
`maker`（メーカー名）列を追加することで、音声からメーカー・型番まで区別した
候補提示が可能になる。

**実装方針:**
- まず「仕様書」「仕上げ表」シートの構造を調査し、品番・メーカー・品名の対応関係を把握する
- `company_estimate_items` に `maker TEXT` 列を追加
- 取り込みスクリプトを拡張して別シートも処理対象に含める
- `extractSearchTerms()` および `match_estimate_items()` にメーカー名も検索対象として含める

---

### 新規部材の登録フロー（今後実装）

音声で聞き取った品目が既存候補に一致しない場合、手動で「名称・単価」を入力して
`company_estimate_items` に新規登録できる導線を AI整理タブに追加する。

**設計方針:**
- 音声だけでの完全自動登録はしない（単価は現場の音声からは分からないため、人の入力が必須）
- AI整理タブに「候補なし → 手動登録」のフローを追加する
- 登録後は次回から自動的に類似検索（pg_trgm）の対象になる（マスター自動還元と同じ思想）

**実装対象ファイル（想定）:**
- `components/projects/AiMemoPanel.tsx` — 「登録」ボタンと入力フォームの追加
- `app/api/company-estimate-items/route.ts`（新設）— INSERT エンドポイント
- `company_estimate_items` テーブルへの INSERT（RLS で自社データのみ書き込み可）

---

## 禁止事項（実装時に守ること）

- `admin.ts` を3箇所以外でimportしない
- `NEXT_PUBLIC_` に秘密鍵を入れない
- Client Componentで `getServerClient()` を使わない
- DBに画像ファイル本体を保存しない
- signed URLをDBに保存しない
- `share_links` テーブルにanon用RLSポリシーを作らない
- 1ファイルに処理を詰め込みすぎない
- 過剰な抽象化・複雑な状態管理をしない
- AIに見積金額を確定させない
- AIに写真分類を自動確定させない
- 発注・通知をAIが自動送信しない

---

## デザインシステム

### Input Constitution v1.0（FROZEN）

Input / Textarea / Select / Table Editor / Chat Composer を追加・変更する前に必ず読む：

`docs/design-system/input-constitution.md`

**最重要ルール：**
- 通常フォームは `<Input>` / `<Textarea>` を使う（`components/ui/`）
- テーブルセルの高さを Shared Input height（36/44px）に合わせない（Table Geometry 優先）
- EstimateTab / CostLedgerTab の cell editor を `<Input>` へ機械的に移行しない
- Enter-to-send を実装するときは必ず `!e.nativeEvent.isComposing` を確認する
- AI チャットだからといって purple / blue / gradient の独自 Input を作らない

---

## 既知の課題

実装中に発見した問題の記録。解決時は ✅ を付けて解決済みに移動すること。
詳細・修正コードは `KNOWN_ISSUES.md` も参照。

### 未解決

#### KI-001: 見積追加時に line_events.project_id が更新されない

**関連ファイル:** `app/api/estimate-items/route.ts` / `components/projects/AiMemoPanel.tsx`  
**発見:** 2026-07-11

未振り分け（`project_id = NULL`）の LINE イベントを「見積に追加」した場合、
`estimate_items.project_id` は現在表示中の案件に正しく設定されるが、
`line_events.project_id` は NULL のまま更新されない。
1案件・1ユーザーのデモ段階では実害なし。複数案件を並行して扱うと
「この音声がどの案件の現調か」の追跡ができなくなる。

**修正方法（未実施）:** `app/api/estimate-items/route.ts` の INSERT 後に追加する。

```typescript
await supabase
  .from('line_events')
  .update({ project_id })
  .eq('id', line_event_id)
  .is('project_id', null)  // 既に振り分け済みの行は上書きしない
```

**対応タイミング:** 複数案件を並行して扱い始める前に対応必須。

### 解決済み

（なし）
