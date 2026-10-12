# KI-002 PR-3: 案件にぶら下がる 12 テーブルの「案件」と「会社」の一致を DB で保証する（未適用）

- migration: `supabase/migrations/20261014000001_enforce_project_company_match_more_tables.sql`
- 前提: `20261013000002_enforce_project_company_match.sql`（PR #35 の追加監査）が本番に適用済みであること
- **本番 DB への適用は人間の承認待ち。** Claude Code は本番・Preview DB への接続・バックアップ・適用のどれも行わない。

| ファイル | 内容 |
|---|---|
| `scripts/db/backup-ki002-pr3.sh` | 適用前の読み取り専用バックアップ（手順は `ki-002-pr3-backup-and-restore.md`） |
| `docs/db/ki-002-pr3-project-company-precheck.sql` | 適用前の確認（読み取りのみ・①〜⑧） |
| `docs/db/ki-002-pr3-project-company-sql-editor-apply.sql` | ガード → migration 本体 → 検証 → 履歴登録 → `NOTIFY pgrst` を 1 トランザクションで実行 |
| `docs/db/ki-002-pr3-project-company-verify.sql` | 適用後の確認（読み取りのみ） |
| `docs/db/ki-002-pr3-project-company-sql-editor-rollback.sql` | 追加した 17 制約の削除 → 履歴 1 行の削除 を 1 トランザクションで実行 |

## 不具合と原因

各テーブルの RLS は行の `company_id` が自社かどうかしか見ない。`project_id` の外部キーの確認は RLS を通らない。
そのため PostgREST（`/rest/v1/...`）を直接叩くか service_role（Webhook・cron・SQL）を使えば、
`company_id = 自社`・`project_id = 他社の案件` の行を INSERT / UPDATE できる。

- 他社のデータは読めないが、他社の案件に自社の行がぶら下がる。
- 他社が案件を物理削除すると、カスケードでその行が消える。
- 案件 UUID が存在するかどうかの確認にも使える。

KI-002 PR-1 / PR-2 は API で拒否するようにしたが、API を通らない書き込みは止められない。
20261013000002 は `estimate_items`・`line_events` だけを DB で塞いでいた。

## 設計

### 制約（テーブルごと）

20261013000002 で作った `projects` の `UNIQUE (id, company_id)`（`projects_id_company_id_key`）を参照先として再利用する（新しく作らない）。

| テーブル | 追加する外部キー（`(project_id, company_id) → projects(id, company_id)`） | ON DELETE | 追加する CHECK |
|---|---|---|---|
| project_files | `project_files_project_company_fkey` | CASCADE | なし（company_id NOT NULL） |
| project_notes | `project_notes_project_company_fkey` | CASCADE | なし（同上） |
| ai_summaries | `ai_summaries_project_company_fkey` | CASCADE | なし（同上） |
| estimate_documents | `estimate_documents_project_company_fkey` | CASCADE | なし（同上） |
| schedule_items | `schedule_items_project_company_fkey` | CASCADE | なし（同上） |
| share_links | `share_links_project_company_fkey` | CASCADE | なし（同上） |
| line_event_notes | `line_event_notes_project_company_fkey` | NO ACTION | なし（同上） |
| cost_ledger_items | `cost_ledger_items_project_company_fkey` | CASCADE | `cost_ledger_items_project_requires_company_check` |
| invoice_documents | `invoice_documents_project_company_fkey` | CASCADE | `invoice_documents_project_requires_company_check` |
| project_billing_milestones | `project_billing_milestones_project_company_fkey` | CASCADE | `project_billing_milestones_project_requires_company_check` |
| estimate_groups | `estimate_groups_project_company_fkey` | CASCADE | `estimate_groups_project_requires_company_check` |
| schedule_draft_adoptions | `schedule_draft_adoptions_project_company_fkey` | CASCADE | `schedule_draft_adoptions_project_requires_company_check` |

合計 17 制約（外部キー 12・CHECK 5）。CHECK の定義はすべて `CHECK (project_id IS NULL OR company_id IS NOT NULL)`。
既存の単独の外部キー（`project_id → projects(id)`）・RLS ポリシー・テーブル権限・列・トリガー・関数は変えない。

### NULL の扱い

- 外部キーは MATCH SIMPLE（既定）。列のどれかが NULL なら一致を確かめない。
- `project_id` が NULL の行は、これまでどおり作れる。未振り分けのメモ、案件なしの請求書・工種・工程案の採用記録がこれに当たる。
- `company_id` が NULL を許すテーブルでは、`company_id = NULL`・`project_id = 他社の案件` の行が複合外部キーを素通りする。
  そのため、上の 5 テーブルにだけ CHECK を足す（違反は 23514）。`project_id` も `company_id` も NULL の行は従来どおり作れる。
- 残りの 7 テーブルは `company_id` が NOT NULL なので CHECK は要らない。
  ただし本番の定義がリポジトリと違って NULL を許していた場合は、事前確認で止まる。

### ON DELETE

既存の `project_id` の外部キーと同じにする（変えない）。

- 案件を物理削除したとき、11 テーブルは従来どおりカスケードで消える。
- `line_event_notes` は従来どおり削除を拒否する（23503）。
- SET NULL は使わない。複合外部キーの SET NULL は `company_id` まで NULL にしてしまうため。

ON DELETE が想定と違う（本番の定義がリポジトリと違う）場合は、事前確認で止まる。

### 安全方針

- 既存データの UPDATE / DELETE / TRUNCATE はしない。食い違いの自動補正もしない。
- 事前確認に 1 つでも当てはまれば何も作らずに止まり、全テーブル分を 1 つのメッセージにまとめて出す：
  `project-company-2 precondition failed: <テーブル>: <理由>; ...`

  | 理由 | 意味 |
  |---|---|
  | `projects has no UNIQUE (id, company_id) (apply 20261013000002 first)` | 前提の migration が未適用 |
  | `table missing` | テーブルが無い |
  | `unexpected columns (...)` | `project_id` / `company_id` が無い、または uuid でない |
  | `company_id is nullable` | CHECK を付けないテーブルで company_id が NULL を許す |
  | `existing project_id fkey on delete is ... (expected ...)` | 既存の外部キーが無い、または ON DELETE が違う |
  | `constraint ... exists with a different definition` | 同じ名前の制約が違う定義で既にある |
  | `mismatched=N orphan=N null_company=N` | 会社が食い違う行、参照先の案件が無い行、案件に紐付いているのに company_id が NULL の行 |

- 既存の制約は名前ではなく定義で確かめる。比べるのは種類・参照先・ON DELETE / ON UPDATE・MATCH・列の順序・CHECK の式。
- 制約は NOT VALID で追加してから VALIDATE する。どちらも同じトランザクション内なので、途中で失敗すれば何も残らない。
- 再適用できる。定義が一致する制約が既にあれば作らないので、制約は増えない。
- `SET LOCAL lock_timeout = '5s'`・`statement_timeout = '120s'`。ロックを待ちきれなければ 55P03 で全体が取り消される。

### ロック

- 外部キーの追加・VALIDATE は、子テーブルと `projects` に SHARE ROW EXCLUSIVE ロックを取る。
  読み取り（SELECT）は止めないが、そのテーブルへの書き込みはコミットまで待たされる。
- CHECK の追加は ACCESS EXCLUSIVE ロックを取る（5 テーブル。読み取りも一瞬止まる）。
- 12 テーブルを 1 トランザクションで処理するので、ロックはコミットまで保持される。
  本番のデータ量は少ないため VALIDATE は短時間で終わる想定。
- ロック待ちで失敗する場合の代替（今回は作っていない）: migration を 3 つに分ける。
  1. company_id が NOT NULL の 6 テーブル
  2. CHECK を付ける 5 テーブル
  3. `line_event_notes`

### 影響

- 正しい会社・案件の組み合わせでの作成・案件の付け替え・論理削除・`project_id = NULL` の行は従来どおり。
- これらのテーブルに行がある案件は、`projects.company_id` を変更できなくなる（23503）。アプリに変更する経路は無い。
- 原価台帳の請求書 RPC（`cost_ledger_invoice_insert / update / delete`）は `cost_ledger_items.actual_cost` しか更新しないため影響しない（テストで確認済み）。
- アプリの INSERT はすべて会員情報から `company_id` を決めているため、正しい操作が 23503 になることはない。

## 検証（隔離 DB）

`__tests__/db/project-company-match-more.db.test.ts`（129 テスト）。全 migration を当てた使い捨ての DB で実行する。本番・Preview DB には接続しない。

- **修正前の再現:** 12 テーブルすべてで、次の 3 つが通ってしまうことを確かめる。
  - 他社案件を指定した INSERT
  - 自社の行を他社案件へ付け替える UPDATE
  - service_role で `company_id = NULL`・`project_id = 他社案件` の行を作る（CHECK 対象の 5 テーブル）
- **適用が止まる条件:**
  - 食い違い・孤児・NULL 会社のデータがある（全テーブル分が 1 つのメッセージに出る）
  - `projects` の一意制約が無い
  - company_id が NULL を許す
  - ON DELETE が違う
  - 同じ名前で定義の違う制約がある
  - テーブルが無い
  - どの場合も制約は 1 つも残らない
- **ロック:** `share_links` に書き込み中のトランザクションがあると 55P03 で止まり、何も残らない。解放後に再適用できる。
- **適用後:**
  - 17 制約がちょうどある（すべて VALID）。
  - 既存の単独外部キーが残っている。
  - PR #35 の 4 制約が残っている。
  - RLS ポリシーとテーブル権限は適用前と同一。
  - 再適用しても変わらない。
- **修正後の拒否:**
  - 他社案件を指定した INSERT・UPDATE は 23503（authenticated と service_role の両方）。
  - 両社に所属するユーザーが company_id だけを変えた場合も 23503。
  - NULL 会社の行は 23514（CHECK 対象の 5 テーブル）、NOT NULL のテーブルは 23502。
  - 他社の company_id を指定すると RLS で 42501。
  - 子行がある案件の `projects.company_id` の変更は 23503。
- **既存機能:**
  - 作成、自社の別案件への付け替え、論理削除、`project_id = NULL` の行。
  - 案件の物理削除: 11 テーブルはカスケード、`line_event_notes` は 23503。
  - 案件の論理削除。
  - 原価台帳の請求書 RPC 3 つ（actual_cost 1000 → 2500 → NULL）。
- **SQL Editor 用スクリプト:**
  - apply の本体は migration と同一で、BEGIN / COMMIT は 1 つずつ。
  - precheck・verify に書き込み文が無い。
  - apply → verify がすべて ok になる。
  - ガード（履歴なし・二重適用・履歴なしで制約あり）。
  - 食い違いがあれば制約も履歴も残らない。
  - precheck が食い違い・テーブル欠落を正しく数える。
  - rollback → 再 apply ができる。
  - PR-3 を当てたまま PR #35 のロールバックを流すと 2BP01 で止まり、何も変わらない。
- **既存テスト:** `__tests__/db/company-isolation-api.db.test.ts` のブリーフィング用の他社データは、新しい制約より前に作られた行として
  `session_replication_role = 'replica'` で作るように変えた。同じ INSERT が authenticated では 23503 になることも確かめる。

## 本番への適用手順（Supabase SQL Editor・人間が実行する）

`supabase db push` は使わない。PR #35 と同じく SQL Editor 専用のスクリプトで適用する。

**順序:**

1. 20261013000002（PR #35 の追加監査）が適用済みであること。
2. この PR-3 の migration を適用する。
3. PR をマージする。

この PR にはアプリのコード変更が無いため、マージと適用の順序に依存はない。ただし、適用してからマージする。

### 0. バックアップ（適用直前・人間が実行する）

これまでと同じ形式の読み取り専用バックアップを、ターミナル.app で `bash scripts/db/backup-ki002-pr3.sh` として実行する。
public スキーマと migration 履歴のダンプを取り、事前確認として 20261013000002 = 1 件・20261014000001 = 0 件を確かめる。
準備・出力ファイル・復元手順は `ki-002-pr3-backup-and-restore.md` を参照。
`[OK] バックアップ完了` と表示された場合だけ次へ進む。接続文字列・パスワードはコマンド履歴やチャットに貼らない。

### 1. 適用前の確認（読み取りのみ）

`ki-002-pr3-project-company-precheck.sql` の ①〜⑧ を 1 つずつ実行する。必要なら ⓪ の `BEGIN READ ONLY;` で囲み、最後に `ROLLBACK;` する。

| # | 期待値 | 違ったら |
|---|---|---|
| ① | 17.x | 報告して相談 |
| ② | 20261013000001・20261013000002 が `recorded = true`、20261014000001 が `false` | **中止**（前提未適用 / 二重適用） |
| ③ | `projects` の (company_id, id) 一意制約 1 行と、PR #35 の 3 制約。すべて `convalidated = true` | **中止** |
| ④ | 12 行すべて下の条件を満たす | **中止**。補正 SQL は実行せず、件数を報告して相談 |
| ⑤ | 参考（インデックスの有無） | — |
| ⑥ | 対象外 2 テーブルの調査結果。適用の可否には使わない | 記録して別 PR で扱う |
| ⑦ | 記録しておく（適用後と比べる） | — |
| ⑧ | 0 行 | 長いトランザクションが終わるまで待つ |

④ で満たすべき条件:

- `table_exists = true`
- `project_id_col` は `uuid ...`
- `company_id_col` は `uuid ...`。`needs_check = false` の 7 テーブルは `uuid NOT NULL`
- `project_fkeys` に `project_id` の外部キーが 1 つあり、ON DELETE が `expected_on_delete` と同じ
- `pr3_constraints` が NULL
- `mismatched`・`orphan`・`null_company` がすべて 0

### 2. 適用

`ki-002-pr3-project-company-sql-editor-apply.sql` の全文を貼り付けて、1 回だけ実行する。

- 最後の結果が `history_rows = 1, valid_constraints = 17` なら完了。
- エラーが出たら、続けて `ROLLBACK;` だけを実行する。制約も履歴も残らない。
- 止まった場合のメッセージ:
  - `project-company-2 apply aborted: ...`（ガード）: 履歴テーブルが無い、20261013000002 が未登録、
    20261014000001 が登録済み（二重適用）、履歴なしで制約が既にある。
  - `project-company-2 precondition failed: ...`: 上の「安全方針」の表を参照。
    データの食い違いでも止まる。**補正はせず、メッセージをそのまま報告する。**
  - `canceling statement due to lock timeout`（55P03）: 書き込み中のトランザクションがある。
    `ROLLBACK;` してから、利用の少ない時間に再実行する。何度も止まる場合は、上の「ロック」に書いた 3 分割を相談する。
  - `project-company-2 verify failed: ...`: 制約の数・定義・ON DELETE が想定と違う、PR #35 の制約が無効、または RLS ポリシー・テーブル権限が変わった。
- `NOTIFY pgrst, 'reload schema'` はコミット時に送られる。

### 3. 適用後の確認（読み取りのみ）

- `ki-002-pr3-project-company-verify.sql` を実行する。期待値:
  - 12 行すべて `ok = true`
  - `_summary` 行が `history_recorded = true`・`ki001_constraints = 4`
- precheck ⑦ をもう一度実行し、手順 1 の結果と同じであることを確かめる。

### 4. マージと画面確認（人間が行う）

PR をマージしたあと、本番の確認用案件で次を一通り操作し、エラーが出ないことを確かめる。
本番データへの書き込みになるため、人間が行う。

1. 写真のアップロードと場所・工程の振り分け（`project_files`）。
2. 現場メモの追加（`project_notes`）。
3. AI で整理する（`ai_summaries`）。
4. 見積: 工種の追加（`estimate_groups`）、見積書ドキュメントの保存（`estimate_documents`）。
5. 工程: 工程の追加・編集、工程案の採用（`schedule_items`・`schedule_draft_adoptions`）。
6. 原価台帳: 項目の追加、業者請求書の登録・編集・削除（`cost_ledger_items`。請求書 RPC 経由）。
7. 請求書: 作成・保存（`invoice_documents`）、入金予定の追加（`project_billing_milestones`）。
8. 共有リンクの発行と、職人向けページの表示（`share_links`）。
9. LINE メモ: 未振り分けメッセージへのメモ、案件への紐付け（`line_event_notes`）。

## ロールバック

`ki-002-pr3-project-company-sql-editor-rollback.sql` の全文を貼り付けて、1 回だけ実行する。

- 追加した 17 制約だけを `DROP CONSTRAINT IF EXISTS` で消し、履歴の 20261014000001 を 1 行消す。データ・既存の制約・RLS・権限には触れない。
- 最後の結果が `history_rows = 0, constraints = 0, ki001_constraints = 4` なら完了。
- 何も無い状態で実行すると `project-company-2 rollback aborted: nothing to roll back ...` で止まる。

**ロールバックの順序:** PR #35（20261013000002）もロールバックするときは、**先にこの PR-3 をロールバックする**。

- PR #35 のロールバックは `projects_id_company_id_key` を消すが、PR-3 の 12 の外部キーがこの制約に依存している。
- そのため逆順だと 2BP01 で止まる。トランザクションごと取り消されるので、何も変わらない。

## 残るリスク

- 適用までの間に作られた食い違い行があれば、適用が止まる。補正するかどうか、どう補正するかは人間が判断する（この PR の範囲外）。
- 本番の定義がリポジトリと違う場合（列が NULL を許す、ON DELETE が違うなど）も止まる。
  その場合は precheck ④⑤ の結果をもとに migration を見直す。
- ロックは数秒で済む想定。ただし本番の書き込みが続いていると 55P03 で止まることがある。
- 外部キーの確認には `projects` の (id, company_id) 一意インデックスを使う。子テーブル側の (project_id, company_id) インデックスは足していない。
  - 案件を物理削除するときの子行探索は、従来どおり既存のインデックスに頼る。
  - 足りなければ precheck ⑤ を見て別途検討する。
- `estimate_items.group_id`・`schedule_items.estimate_group_id` → `estimate_groups` の会社・案件の一致は、まだ DB で保証していない
  （API では PR #38 で確認済み）。KNOWN_ISSUES.md の KI-002 に残している。
- AI チャットの確定（`confirm-change`）の `estimate_items` の create / bulk_create は、PR #37 で `isActiveProject()` による確認が入り、
  他社の案件 ID は書き込む前に 404 になる（解決済み）。

## 対象外のテーブル

- `estimate_revisions`・`cost_ledger_invoices` は本番で直接作られ、リポジトリの migration に定義が無い。
  列が NULL を許すか、既存の外部キーと ON DELETE がどうなっているかを、リポジトリから確かめられない。
- 定義が分からないまま制約を足すと、ON DELETE や NULL の扱いを誤るおそれがある。そのため今回は対象外にした。
- 本番の定義は precheck ⑥ で読み取りで確かめる（列・制約・ポリシー・行数・食い違いの件数）。その結果をもとに別 PR で扱う。
