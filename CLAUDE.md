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
- `admin.ts` を import できるファイルは以下の3箇所のみ：
  - `app/api/webhook/line/route.ts`
  - `app/api/share/[token]/route.ts`
  - `app/api/pdf/route.ts`（必要時のみ）
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
