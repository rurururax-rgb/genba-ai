# 既知の課題・技術的負債

Claude Code が実装中に発見した既知の問題を記録するファイル。
解決時はその旨を追記してからチェックを外すこと。

---

## 未解決

### KI-002: 案件に紐づく他のテーブルでも、他社の案件 ID を直接指定できる（API 側は解決済み・DB 側が残り）

**発見:** 2026-10-10（PR #35 の追加監査）
**関連:** `supabase/migrations/20261013000002_enforce_project_company_match.sql` / `docs/db/ki-001-link-line-event-on-estimate-add.md` /
`docs/db/ki-002-pr3-project-company-match.md`

RLS は行の `company_id` しか確認しない。外部キーの確認は RLS を通らないため、ログイン済みのユーザーは
PostgREST から `company_id = 自社`、`project_id = 他社の案件` の行を INSERT / UPDATE できる。
他社のデータは読めないが、他社の案件に自社の行がぶら下がる。他社が案件を物理削除するとカスケードで消え、
案件 UUID の存在確認にも使える。

#### 解決済み: アプリの API（PR #37 / #38・main にマージ済み）

アプリの API を通る書き込みは、書き込む前に拒否する。存在しない・他社・削除済みは区別せず 404 を返す（他社データの有無を漏らさない）。
判定は `lib/estimate/ownership.ts` にまとめてある。

- **PR #37（KI-002 PR-1）: 案件**
  - 案件 ID を受け取って書き込む API は、`isActiveProject()` で「存在する・未削除・自社」を確かめる。
  - AI チャットの確定（`app/api/ai/chat/confirm-change/route.ts`）にある `estimate_items` の create / bulk_create も対象。
    以前の記載（「会社を確かめていない」「DB エラーで 500 を返す」）は解消済み。
  - update は DB 上の行の会社・案件で更新先を決める。リクエストの `project_id` / `company_id` は使わない。
- **PR #38（KI-002 PR-2）: 工種**
  - 工種は `checkOptionalGroup()` / `isActiveGroupInProject()` で確かめ、同じ会社・同じ案件・未削除のものだけ許可する。
    UUID でない値は 400、それ以外の不正は 404、null（未分類）は可。
  - 対象:
    - AI チャットの確定: create の `group_id`、bulk_create の `target_group_id` と各行の `group_id`（1 件でも不正なら 1 行も登録しない）、update の `group_id`
    - `estimate-items/manual`・`estimate-items/import`
    - `estimate-items/reorder` の移動先の工種
    - `schedule-items` の `estimate_group_id`

#### 未解決: DB 側（API を通らない書き込みは止まらない）

PostgREST を直接叩く書き込みや、service_role（Webhook・cron・SQL）の書き込みは、DB の制約でしか止められない。

| 対象 | 状態 |
|---|---|
| `estimate_items`・`line_events` | 20261013000002（PR #35）で対処。複合外部キー (project_id, company_id)。`line_events` は company_id が NULL だと複合外部キーを素通りするため、CHECK (project_id IS NULL OR company_id IS NOT NULL) も追加 |
| 12 テーブル: `project_files`・`project_notes`・`ai_summaries`・`estimate_documents`・`schedule_items`・`share_links`・`cost_ledger_items`・`invoice_documents`・`project_billing_milestones`・`estimate_groups`・`line_event_notes`・`schedule_draft_adoptions` | **KI-002 PR-3（PR #39・`20261014000001`）で対処。本番適用・検証済み（2026-10-12 時点）。** 複合外部キー 12 + CHECK 5 = 17 制約がすべて有効、RLS ポリシーは適用前後で一致。手順・結果は `docs/db/ki-002-pr3-project-company-match.md` |
| `estimate_revisions`・`cost_ledger_invoices` | **未対処（PR-4 以降）。** 本番で直接作られ、リポジトリに定義が無い。precheck ⑥ で本番の定義を読み取りで確かめてから別 PR で扱う |
| 工種の参照: `estimate_items.group_id`・`schedule_items.estimate_group_id` → `estimate_groups` | **未対処（PR-4 以降）。** API では PR #38 で確認済みだが、DB は工種の会社・案件の一致を保証していない（単独の外部キー・ON DELETE SET NULL のみ） |

- 他のテーブルに複合外部キーを足すときも、company_id が NULL 許容なら同じ CHECK が必要。

**対応タイミング:** PR-3 は本番適用済み。残りは PR-4 以降で扱う。
PR-4 以降は、テーブルごとに食い違いの件数を読み取りで確かめてから migration を作る。
調査結果・制約案・順序は `docs/db/ki-002-pr4-plan.md`、本番向けの読み取り専用調査は `docs/db/ki-002-pr4-precheck.sql`。

### KI-003: 請求・入金の集計と朝のブリーフィングが黙って空になる可能性（PR-3 の影響・PR #41 で修正中）

**発見:** 2026-10-12（KI-002 PR-4 の調査と独立監査）
**関連:** `lib/services/billing-status.ts`（2 か所）・`lib/services/daily-briefing.ts`（1 か所）

PR-3 で `project_billing_milestones`・`invoice_documents` → `projects` の外部キーが 2 本になった。PostgREST はヒントの無い
`projects!inner` の埋め込みをあいまい（PGRST201）として拒否し、コードはそのエラーを 0 件として扱っていた。
画面は壊れずに、入金予定・未入金額・請求書・請求漏れの表示と朝の通知だけが消える。本番で起きているかは未確認。
修正（外部キー名のヒント・取得失敗を 0 件にしない・回帰テスト）は PR #41。詳細は `docs/db/ki-002-pr4-plan.md` の PR-4.0。

---

## 解決済み

### ✅ KI-001: 未振り分けLINEイベントを「見積に追加」してもproject_idが更新されない

**発見日:** 2026-07-11  
**関連ファイル:** `app/api/estimate-items/route.ts`, `components/projects/AiMemoPanel.tsx`

**問題の内容:**  
`line_events.project_id` が NULL（未振り分け）の音声・写真イベントに対して
「見積に追加」を実行した場合、`estimate_items.project_id` は現在表示中の案件に
正しく設定されるが、`line_events.project_id` は NULL のまま更新されない。

「この LINE 音声はどの案件の現調で録音したものか」というトレーサビリティが失われる。
1案件・1ユーザーのデモ段階では実害がないが、複数案件を並行して扱うようになると
「見積に追加済みなのにどの案件か分からない」状態が生じる。

**再現手順:**  
1. LINE で音声を送信（project_id = NULL のまま受信）  
2. `/projects/[id]` の AI整理タブを開く  
3. 未振り分けセクションの候補チップを選択して「見積に追加」  
4. `line_events` テーブルを確認 → `project_id` が NULL のまま  

**当初の対応案（採用せず）:**  
`app/api/estimate-items/route.ts` の INSERT 後に以下を追加する案。
見積の追加と紐付けが別リクエストになり、片方だけ成功する状態が残るため採用しなかった：

```typescript
// 見積追加と同時に未振り分けイベントの project_id を確定させる
await supabase
  .from('line_events')
  .update({ project_id })
  .eq('id', line_event_id)
  .is('project_id', null)   // 既に振り分け済みの行は上書きしない
```

**対応優先度:** 複数案件を並行して扱い始めるタイミングまでに対応必須。

**解決（ブランチ `fix/ki-001-line-event-project-link`）:**  
- RPC `public.add_line_event_estimate_items`（migration `20261013000001_link_line_event_on_estimate_add.sql`）を追加。
  見積項目の INSERT と `line_events` の更新（`project_id` が NULL のときだけ案件 ID を設定・`reflected_to_estimate = true`）を
  1 トランザクションで行う。イベント行を `FOR UPDATE` でロックし、次を拒否する：
  他社のイベント・案件（404）、イベントと案件の会社の不一致（403）、
  別の案件に紐付け済み（409。既存の紐付けは上書きしない）、反映済み（409。重複実行の防止）。
- `POST /api/estimate-items` はこの RPC だけを呼ぶ（会社の確認をしていなかった直接 INSERT をやめた）。
- AI整理タブは追加に成功したイベントを「未振り分け」から「振り分け済み」へ移し、失敗時はエラーを表示する。
- 検証: `__tests__/db/link-line-event-estimate.db.test.ts`（隔離 DB・同時実行・RLS・未認証・他社）、
  `__tests__/line-event-estimate-items-route.test.ts`。
- **本番 DB への migration 適用は人間の承認待ち。** 手順: `docs/db/ki-001-link-line-event-on-estimate-add.md`
  （適用してからアプリをマージする。逆順だと「見積に追加」が 500 になる）。
- 過去に未振り分けのまま反映された行（`reflected_to_estimate = true AND project_id IS NULL`）は補正していない。

