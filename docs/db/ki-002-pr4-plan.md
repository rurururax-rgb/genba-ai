# KI-002 PR-4: 関連データ同士の「同じ会社・同じ案件」を DB で保証する（調査・計画）

- 状態: **調査・計画のみ。migration は未作成。本番 DB には接続していない。**
- 前提: PR #35（20261013000002）・PR-3（20261014000001）が本番適用済み。
  これにより、対象テーブルの各行の `(project_id, company_id)` は `projects` と一致することが DB で保証されている。
- 本番向けの読み取り専用調査 SQL: `docs/db/ki-002-pr4-precheck.sql`（①〜⑨）

## 結論（推奨する順序）

| 順 | PR | 内容 | DB 変更 |
|---|---|---|---|
| 0 | **PR-4.0（先に確認）** | 朝のブリーフィングの `projects!inner` 埋め込みが、PR-3 の外部キー追加で PGRST201（あいまい）になっていないか確認し、なっていれば外部キー名のヒントを付ける | なし（アプリ 1 行） |
| 1 | PR-4a | 工種の参照 R1・R2（`estimate_items.group_id`・`schedule_items.estimate_group_id`）を同じ案件に限る | 一意制約 1・外部キー 2 |
| 2 | PR-4b | 原価台帳 → 見積行 R3（`cost_ledger_items.estimate_item_id`）を同じ案件に限る | 一意制約 1・外部キー 1 |
| 3 | PR-4c | LINE イベントの参照 R4・R5 を**同じ会社**に限る（案件は見ない） | 一意制約 1・外部キー 2 |
| — | 見送り | R6 `schedule_draft_adoptions.draft_id` | 変更しない（理由は下） |
| — | PR-5 以降 | `estimate_revisions`・`cost_ledger_invoices` | precheck ⑧ の本番定義を見てから設計する |

各 PR は PR-3 と同じ作り（NOT VALID で追加 → VALIDATE、1 トランザクション、`lock_timeout`、ガード・verify・rollback・SQL Editor 用スクリプト、隔離 DB テスト）。
どの PR も**既存の外部キーは消さず、追加だけ**にする。

## PR-4.0: 朝のブリーフィングの埋め込み（PR-4 より先に確認）

`lib/services/daily-briefing.ts:101` は `project_billing_milestones` から `projects!inner ( ... )` を埋め込む。
PR-3 で `project_billing_milestones` → `projects` の外部キーが 2 本
（`project_billing_milestones_project_id_fkey` と `project_billing_milestones_project_company_fkey`）になった。
PostgREST は 2 テーブル間に外部キーが複数あると、ヒントの無い埋め込みを PGRST201（あいまい）で拒否する。

- 結果は `overdueMilestoneProjectsRes.data ?? []` で読まれ、**エラーは握りつぶされる**。
  画面は壊れず、朝のブリーフィングから「入金予定日を過ぎた案件」だけが黙って消える。
- 隔離 DB テスト（`__tests__/db/helpers/pg-supabase.ts`）は PostgREST の模擬なので、あいまいさを再現しない。PR-3 のテストでは気づけない。
- 他の埋め込みは無い（`app`・`lib`・`components` を検索済み）。

**確認方法（読み取りのみ・人間が行う）:** Vercel のログで daily-briefing の実行結果を見るか、
本番の朝のブリーフィングに、入金予定日を過ぎた案件が出るはずの日に出ているかを確かめる。
precheck ⑦ で外部キー名を確かめる。

**修正案:** `projects!project_billing_milestones_project_id_fkey!inner ( ... )` のように既存の単独外部キー名をヒントに付ける（1 行）。
ヒントの外部キー名は本番の precheck ⑦ の結果で確かめてから使う。

PR-4 で追加する外部キーも同じく 2 本目になるが、`estimate_groups`・`estimate_items`・`line_events` を埋め込むクエリは無い。
PR-4 の各 PR には「対象の組を埋め込むクエリが無い」ことを確かめる静的テストを足す。

## 参照ごとの調査結果

前提（リポジトリの migration。本番は precheck ③④ で確かめる）:

| 列 | 型・NULL | 既存の外部キー |
|---|---|---|
| `estimate_items.project_id` / `company_id` | NOT NULL / NOT NULL | → projects（PR #35 で複合も） |
| `estimate_groups.project_id` / `company_id` | **NULL 可** / NULL 可 | → projects（PR-3 で複合 + CHECK） |
| `schedule_items.project_id` / `company_id` | NOT NULL / NOT NULL | → projects（PR-3） |
| `cost_ledger_items.project_id` / `company_id` | NOT NULL / NULL 可 | → projects（PR-3 で複合 + CHECK） |
| `line_events.project_id` / `company_id` | **NULL 可（未振り分け）** / NULL 可 | → projects（PR #35 で複合 + CHECK） |
| `line_event_notes.project_id` / `company_id` | NULL 可 / NOT NULL | → projects（PR-3） |

### R1 `estimate_items.group_id` → `estimate_groups`

- 現状: `FOREIGN KEY (group_id) REFERENCES estimate_groups(id) ON DELETE SET NULL`。工種の会社・案件は見ない。
- 抜け道: PostgREST 直叩き・service_role で、**他の案件（他社を含む）の工種**を `group_id` に入れられる。
  API は PR #38 で塞いだ（`isActiveGroupInProject` / `checkOptionalGroup`）。
- 既存の挙動:
  - `group_id = NULL` は「未分類（その他）」で正当。
  - 工種の削除は論理削除。API（`app/api/estimate-groups/[id]/route.ts`）が先に所属行の `group_id` を NULL にする。
  - 工種の物理削除は案件の物理削除（CASCADE）のときだけ。
  - 見積行は論理削除。削除済みの行の `group_id` はそのまま残る。
- 制約案: `estimate_groups` に `UNIQUE (id, project_id)` を足し、
  `FOREIGN KEY (group_id, project_id) REFERENCES estimate_groups(id, project_id) ON DELETE SET NULL (group_id)`。
  - 同じ案件であれば、PR #35 / PR-3 により会社も一致する（案件は 1 社に属する）。会社列まで含める必要はない。
  - `ON DELETE SET NULL (group_id)`（PostgreSQL 15 以上）にして、`project_id` を NULL にしない。素の SET NULL は NOT NULL の `project_id` に NULL を入れようとして失敗する。
  - MATCH SIMPLE: `group_id` が NULL なら検査しない（未分類は従来どおり）。`estimate_items.project_id` は NOT NULL なので NULL の抜け道は無い。
- 互換性リスク:
  - `estimate_groups.project_id` が NULL の工種を指す行は拒否される → precheck ⑤ `blocking_target_project_null`・⑤-2。
  - **論理削除済みの工種**は DB 上は存在するので拒否しない（従来どおり）。⑤ `info_live_row_to_deleted_target` は情報として見るだけ。
  - 別案件へ見積行を移す機能は無い（AI チャットのコピーは今の案件に新しい行を作る）。

### R2 `schedule_items.estimate_group_id` → `estimate_groups`

- 現状: 単独の外部キー `ON DELETE SET NULL`。
- 既存の挙動: 工種の論理削除では `schedule_items.estimate_group_id` は NULL にされない（削除済みの工種を指したまま残る）。
  画面・API はこれを前提に動いているので、**削除済みの工種を指す行は拒否しない**（R1 と同じく DB 上は存在する）。
- 制約案: R1 と同じ一意制約を使い、
  `FOREIGN KEY (estimate_group_id, project_id) REFERENCES estimate_groups(id, project_id) ON DELETE SET NULL (estimate_group_id)`。
- 書き込み元: `lib/services/schedule.ts`・`lib/services/schedule-batch.ts`（PR #38 で同じ案件・未削除を確認済み）。

### R3 `cost_ledger_items.estimate_item_id` → `estimate_items`

- 現状: 単独の外部キー `ON DELETE SET NULL`。
- 書き込み元: `app/api/cost-ledger/init`・`sync`。どちらも同じ案件の見積行から作り、`project_id`・`company_id` は案件のもの。
  見積行が論理削除されると、`sync` が台帳の行を論理削除する。
- 抜け道: 直叩きで他の案件の見積行を指せる。`sync` の突き合わせ（`estimate_item_id` で引く）を他案件の行で汚せる。
- 制約案: `estimate_items` に `UNIQUE (id, project_id)` を足し、
  `FOREIGN KEY (estimate_item_id, project_id) REFERENCES estimate_items(id, project_id) ON DELETE SET NULL (estimate_item_id)`。
- 互換性リスク: 低い。論理削除済みの見積行を指す台帳行は拒否しない。

### R4 `estimate_items.line_event_id` → `line_events`

- 現状: 単独の外部キー（ON DELETE は NO ACTION）。
- 書き込み元: `add_line_event_estimate_items` RPC（20261013000001）だけ。RPC は会社の一致を確かめ、
  イベントが未振り分けなら案件を入れ、別の案件に振り分け済みなら拒否する。
- **案件の一致は制約にしない。** 理由:
  - 未振り分け（`line_events.project_id = NULL`）のイベントは正当。
  - KI-001 修正前に追加された見積行は、イベントの `project_id` が NULL のまま残っている可能性がある。
  - precheck ⑤ `info_live_row_to_deleted_target` 列（R4 では「イベントの案件が NULL か別」）で件数を見るだけにする。
- 制約案: `line_events` に `UNIQUE (id, company_id)` を足し、
  `FOREIGN KEY (line_event_id, company_id) REFERENCES line_events(id, company_id)`（ON DELETE は既存と同じ NO ACTION）。
- 互換性リスク: 会社が NULL のイベントを指す行は拒否される（⑤ `blocking_target_project_null` 列に会社 NULL の件数を出す）。
  RPC は会社 NULL のイベントを受け付けないので、正当な経路では作られない。

### R5 `line_event_notes.anchor_event_id` → `line_events`

- 現状: 単独の外部キー `ON DELETE CASCADE`。`line_event_notes.company_id` は NOT NULL。
- 書き込み元: `app/api/line-events/[id]/notes`。API は `isOwnLineEvent`（自社）と、指定があれば `isActiveProject` を確かめる。
  メモの `project_id` はイベントの `project_id` と独立に指定される（未振り分けのイベントにメモを付けられる）。
- **案件の一致は制約にしない**（R4 と同じ理由。未振り分けのイベントへのメモは正当）。
- 制約案: R4 と同じ一意制約を使い、
  `FOREIGN KEY (anchor_event_id, company_id) REFERENCES line_events(id, company_id) ON DELETE CASCADE`。
- 互換性リスク: 低い。

### R6 `schedule_draft_adoptions.draft_id`（見送り）

- `draft_id` は TEXT の主キーで、会社・案件をまたいで一意。画面（`components/projects/ScheduleTab.tsx:821`）が
  `'draft-' + Math.random() の英数字 8 文字` で作り、`lib/services/schedule-batch.ts` が二重採用の防止に使う。
- 会社をまたぐ衝突: 他社が同じ `draft_id` を先に登録すると、自社の採用が「採用済み」で拒否される。
  ただし `draft_id` は採用の直前に画面で作られ、他社からは見えない（RLS）。偶然の衝突は約 2.8 兆分の 1、狙って衝突させるには相手の画面の乱数を知る必要がある。
- 主キーを `(company_id, draft_id)` などに変えるのは、PostgREST の upsert・二重採用防止の挙動を変える割に効果が小さい。
  **DB は変えない。** 必要なら別 PR で、画面の生成を `crypto.randomUUID()` に変える（DB 変更なし・小さいアプリ修正）。
- precheck ⑥ で形式・件数だけ確かめる。

## PR に共通する設計

- 一意制約: `ALTER TABLE ... ADD CONSTRAINT ... UNIQUE (...)` はインデックスを作る間、対象テーブルへの書き込みを止める。
  件数は数百行程度なので一瞬だが、PR-3 と同じく `lock_timeout` をかけ、止まったら時間を変えて再実行する。
- 外部キー: NOT VALID で追加 → VALIDATE。食い違いがあれば何も作らずに止まる（自動補正しない）。
- RLS・権限・既存の外部キーは変えない。PR ごとに precheck ⑨ を適用前後で比べる。
- 適用は PR-3 と同じく SQL Editor 用スクリプトで人間が行う。`supabase db push` は使わない。

## テスト計画（隔離 DB・`npm run test:db`）

各 PR で:

1. 修正前の再現: 直叩きで他案件・他社の工種 / 見積行 / LINE イベントを指せること。
2. 修正後: 同じ操作が 23503 で拒否されること。
3. **正当なデータが通ること:**
   - 未分類（`group_id = NULL`）、論理削除済みの工種を指す工程。
   - 未振り分けの LINE イベントからの見積追加（RPC）、未振り分けのイベントへのメモ。
   - 工種の削除 API（所属行を NULL → 論理削除）、`cost-ledger/init`・`sync`。
   - 案件の物理削除で CASCADE / SET NULL (列) が従来どおり動き、`project_id` が NULL にならないこと。
4. 原子性・再適用・ガード（食い違いがあると止まる）・lock_timeout。
5. 静的テスト: 対象の組を PostgREST で埋め込むクエリが無いこと。

## precheck の読み方（`ki-002-pr4-precheck.sql`）

| # | 見るもの | 期待値 |
|---|---|---|
| ① | バージョン | 17.x（15 以上なら SET NULL (列) が使える） |
| ② | 履歴 | 3 件とも `recorded = true` |
| ③ | 列の型・NULL | 上の「前提」の表と同じ。違えば報告 |
| ④ | 既存の外部キー・一意制約 | 単独の外部キー 5 本と主キーだけ。`pr4_name_exists` はすべて false |
| ⑤ | 参照ごとの食い違い | `blocking_*` がすべて 0。0 でない参照は、その PR を作る前に件数を報告して相談 |
| ⑤-2 | 工種・イベントの内訳 | 情報（`line_events.project_null` は未振り分けの件数で正当） |
| ⑥ | draft_id | `unexpected_format = 0` |
| ⑦ | 外部キーが 2 本以上の組 | PR-3 の 12 テーブル + PR #35 の 2 テーブル → projects。**PR-4.0 の判断に使う** |
| ⑧ | 本番だけの 2 テーブル | 結果を PR-5 の設計に使う（推測しない） |
| ⑨ | RLS | 記録（各 PR の適用前後で比べる） |

⑤ の `info_live_row_to_deleted_target` 列は参照ごとに意味が違う:
R1〜R3 は「未削除の行が論理削除済みの参照先を指す件数」、R4 は「イベントの案件が NULL か別の案件」、R5 は「メモとイベントの案件が違う」。
どれも制約では拒否しない（情報）。

この SQL は隔離ローカル PostgreSQL（全 migration 適用済み）で読み取り専用セッションのまま最後まで実行できることを確かめた。
