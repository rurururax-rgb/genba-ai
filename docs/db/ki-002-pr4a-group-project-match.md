# KI-002 PR-4a: 見積行・工程が指す工種を「同じ案件の工種」に DB で限る（本番適用済み）

- migration: `supabase/migrations/20261015000001_enforce_group_project_match.sql`
- 前提: `20261014000001`（PR-3）が本番に適用済みであること（2026-10-12 適用・検証済み）
- **状態: 本番適用・事後検証（verify）・RLS ポリシーの適用前後の比較・PR #42 のマージ（2026-10-13）まで完了**（人間が実施。2026-10-15 に報告）。
  Claude Code は本番・Preview DB への接続・バックアップ・適用のどれも行っていない。以下の手順は適用時の記録として残す。
- 調査・計画: `docs/db/ki-002-pr4-plan.md`（R1・R2）。本番の事前調査（PR-4 precheck ①〜⑨）は blocking がすべて 0。

| ファイル | 内容 |
|---|---|
| `scripts/db/backup-ki002-pr4a.sh` | 適用前の読み取り専用バックアップ（public・migration 履歴・precheck ①〜⑧ の結果） |
| `docs/db/ki-002-pr4a-group-project-precheck.sql` | 適用前の確認（読み取りのみ・①〜⑧） |
| `docs/db/ki-002-pr4a-group-project-sql-editor-apply.sql` | ガード → migration 本体 → 検証 → 履歴登録 → `NOTIFY pgrst` を 1 トランザクションで実行 |
| `docs/db/ki-002-pr4a-group-project-verify.sql` | 適用後の確認（読み取りのみ） |
| `docs/db/ki-002-pr4a-group-project-sql-editor-rollback.sql` | 追加した 3 制約の削除 → 履歴 1 行の削除 を 1 トランザクションで実行 |

## 不具合と原因

`estimate_items.group_id`・`schedule_items.estimate_group_id` は単独の外部キー → `estimate_groups(id)` で、工種の案件・会社を見ない。
RLS は行の `company_id` しか見ず、外部キーの確認は RLS を通らない。
そのため PostgREST を直接叩くか service_role を使えば、**他の案件（他社を含む）の工種**を指す見積行・工程を作れる。
API は PR #38（KI-002 PR-2）で塞いだが、API を通らない書き込みは止められない。

## 設計

| 制約 | 定義 |
|---|---|
| `estimate_groups_id_project_id_key` | `UNIQUE (id, project_id)`（id は主キーなので常に一意。複合外部キーの参照先） |
| `estimate_items_group_project_fkey` | `FOREIGN KEY (group_id, project_id) REFERENCES estimate_groups(id, project_id) ON DELETE SET NULL (group_id)` |
| `schedule_items_estimate_group_project_fkey` | `FOREIGN KEY (estimate_group_id, project_id) REFERENCES estimate_groups(id, project_id) ON DELETE SET NULL (estimate_group_id)` |

- **同じ案件 ⇒ 同じ会社。** PR #35・PR-3 で、見積行・工程・工種の `(project_id, company_id)` は `projects` と一致する。会社の列は含めない。
- **ON DELETE SET NULL (列)**（PostgreSQL 15 以上・本番 17.6）: 工種の物理削除で工種の列だけを NULL にする。既存の単独の外部キーと同じ動き。
  素の `SET NULL` だと NOT NULL の `project_id` まで NULL にしようとして失敗する。
- **NULL（未分類）:** MATCH SIMPLE なので工種が NULL の行は確かめない（従来どおり）。参照元の `project_id` は NOT NULL（事前確認で確かめる）。
- **論理削除:** 外部キーは `deleted_at` を見ない。論理削除済みの工種を指す行（工種の削除 API は工程の参照を NULL にしない）はそのまま許す。
- **既存の単独の外部キーは消さない・変えない。** RLS・権限・列・関数・業務ロジックも変えない。

### 安全方針（PR-3 と同じ）

- 既存データの UPDATE / DELETE なし。食い違いの自動補正もしない。
- 次のどれかに当てはまれば、何も作らずに止まる（1 つのメッセージにまとめて出す）:

  | メッセージ（`group-project-1 precondition failed: ...`） | 意味 |
  |---|---|
  | `PostgreSQL 15 or later is required` | ON DELETE SET NULL (列) が使えない |
  | `<tbl>: table missing` / `unexpected columns` | テーブル・列が無い、型が uuid でない |
  | `<tbl>: project_id is nullable` | 参照元の project_id が NULL を許す（NULL の抜け道ができる） |
  | `<tbl>: existing <col> fkey on delete is ... (expected n)` | 既存の単独の外部キーが無い・ON DELETE が SET NULL でない |
  | `... exists with a different definition` | 同じ名前の制約が想定と違う定義で既にある |
  | `<tbl>: orphan=… group_project_null=… mismatched=…` | 参照先の工種が無い・工種の project_id が NULL・工種の案件が違う行がある（論理削除済みの行も数える） |

- NOT VALID で追加してから VALIDATE（同じトランザクション）。再適用しても増えない（定義が一致する制約があれば作らない）。

### ロック

- `estimate_groups` に一意制約を足す間は、`estimate_groups` の読み書きが止まる（ACCESS EXCLUSIVE。行数が少ないため一瞬）。
- 外部キーの追加中は `estimate_items`・`schedule_items`・`estimate_groups` の書き込みが待たされる（コミットまで）。
- ロック待ちは `lock_timeout = 5s` で打ち切り、全体を取り消す（55P03）。利用の少ない時間に再実行する。

### 影響

- 工種を指したまま見積行・工程の `project_id` を別の案件へ変えること、参照されている工種の `project_id` を変えることはできなくなる。
  アプリにどちらの経路も無い（`app`・`lib` と DB 関数を確認済み）。
- PostgREST: `estimate_items`・`schedule_items` → `estimate_groups` の外部キーが 2 本になる。これらを埋め込むクエリは無い。
  PR #41 の回帰テスト（`__tests__/postgrest-embeds.test.ts`・`__tests__/db/postgrest-embeds.db.test.ts`）が、この migration を含む DB で確かめている。

## 検証（隔離 DB・`npm run test:db`）

`__tests__/db/group-project-match.db.test.ts`（36 件）:

- 修正前の再現: PostgREST と同じ権限で、同じ会社の別案件の工種・他社の工種を INSERT / UPDATE できる。
- 適用が止まる条件: 食い違い・工種の project_id が NULL・孤児行・定義の違い（project_id が NULL 可、既存外部キーの ON DELETE、同名の別定義、テーブルが無い）。
- ロック待ちでの中断（55P03）で何も残らないこと、待ちが解消すれば適用できること。
- 適用後: 他案件・他社の工種の INSERT / UPDATE は 23503（authenticated・service_role とも）。工種を指したままの案件移動・参照中の工種の案件変更も 23503。
- 正常な操作: 同じ案件の工種での登録・移動、未分類（NULL）、論理削除済みの工種への参照、工種の削除 API と同じ操作、
  工種の物理削除（工種の列だけ NULL・project_id は残る）、案件の物理削除（カスケード）。
- 既存の制約（単独の外部キー・PR #35・PR-3）・RLS ポリシー・テーブル権限が適用前後で同じ。再適用しても増えない。
- SQL Editor 用スクリプト: 本体と migration の一致、成功・ガード（二度目・履歴なしの制約・前提未記録）・食い違いで何も残らない、
  precheck・verify が読み取り専用、ロールバックで 3 制約と履歴だけが消え再適用できる、PR-3 のロールバックと独立していること。

API を通る工種の保存・再読み込み（AI チャットの確定・schedule-items の作成と編集など）は
`company-isolation-groups.db.test.ts` が、この migration を含む全 migration の DB で確かめている（全件 PASS）。

## 本番への適用手順（Supabase SQL Editor・人間が実行する）

`supabase db push` は使わない。

1. 20261014000001（PR-3）が適用済みであること。
2. この PR の migration を適用する。
3. PR をマージする。

この PR にはアプリのコード変更が無いため、マージと適用の順序に依存はない。ただし、適用してからマージする。

### 0. バックアップ（適用直前・人間が実行する）

PR-3 と同じ形式の読み取り専用バックアップを、ターミナル.app で実行する。

```bash
cd ~/genba-ai
git switch fix/ki-002-pr4a-group-project-fk
git pull --ff-only
bash scripts/db/backup-ki002-pr4a.sh
```

- 20261014000001 = 1 件・20261015000001 = 0 件を確かめ、precheck ①〜⑧ の結果を `ki002pr4a_precheck.txt` に保存する。
- `[OK] バックアップ完了` と表示された場合だけ次へ進む。接続文字列・パスワードはコマンド履歴やチャットに貼らない。
- 出力先は `~/Desktop/rugz-backup-<日時>-pre-ki002-pr4a/`（既存のバックアップは上書きしない）。
- **完全バックアップではない**（public と migration 履歴だけ。Auth・Storage は含まない）。準備・出力ファイル・復元手順は
  `docs/db/ki-002-pr3-backup-and-restore.md` と同じ（スクリプト名・フォルダ名・precheck ファイル名だけが違う）。

### 1. 適用前の確認（読み取りのみ）

`ki002pr4a_precheck.txt`（または SQL Editor で `ki-002-pr4a-group-project-precheck.sql` の ①〜⑧ を 1 つずつ）を照合する。

| # | 期待値 | 違ったら |
|---|---|---|
| ① | 17.x | 報告して相談 |
| ② | 20261013000002・20261014000001 が `recorded = true`、20261015000001 が `false` | **中止** |
| ③ | `estimate_items.project_id`・`schedule_items.project_id` が `nullable = false` | **中止** |
| ④ | `estimate_items_group_id_fkey`・`schedule_items_estimate_group_id_fkey`（ON DELETE SET NULL）の 2 行だけ | **中止**（PR-4a の名前が既にある・単独の外部キーが無い） |
| ⑤ | 2 行とも `blocking_orphan`・`blocking_target_null`・`blocking_mismatch` が 0 | **中止**。補正 SQL は実行せず、件数を報告して相談 |
| ⑥ | 情報（事前調査では 26 件・project_id NULL 0・論理削除 12） | — |
| ⑦ | 記録しておく（適用後と比べる） | — |
| ⑧ | 0 行 | 長いトランザクションが終わるまで待つ |

**⑧ は手順 2 の直前に、SQL Editor でもう一度実行する。** バックアップ時点の結果だけでは判断しない。

### 2. 適用

直前に ⑧ が 0 行であることを確かめ、`ki-002-pr4a-group-project-sql-editor-apply.sql` の全文を貼り付けて、1 回だけ実行する。

- 最後の結果が `history_rows = 1, valid_constraints = 3, prior_constraints = 21` なら完了。
- エラーが出たら、続けて `ROLLBACK;` だけを実行する。制約も履歴も残らない。
- 止まった場合のメッセージ:
  - `group-project-1 apply aborted: ...`（ガード）: 履歴テーブルが無い、20261014000001 が未登録、20261015000001 が登録済み（二重適用）、履歴なしで制約が既にある。
  - `group-project-1 precondition failed: ...`: 上の「安全方針」の表を参照。**補正はせず、メッセージをそのまま報告する。**
  - `canceling statement due to lock timeout`（55P03）: `ROLLBACK;` してから、利用の少ない時間に再実行する。
  - `group-project-1 verify failed: ...`: 制約の数・定義が想定と違う、既存の制約・RLS ポリシー・テーブル権限が変わった。
- `NOTIFY pgrst, 'reload schema'` はコミット時に送られる。

### 3. 適用後の確認（読み取りのみ）

- `ki-002-pr4a-group-project-verify.sql` を実行する。3 行すべて `ok = true`、`_summary` 行で
  `history_recorded = true`・`single_fkeys = 2`・`prior_constraints = 21`・`blocking_rows = 0`。
- precheck ⑦ をもう一度実行し、手順 1 の結果と同じであることを確かめる。

### 4. マージと画面確認（人間が行う）

PR をマージしたあと、本番の確認用案件で次を一通り操作し、エラーが出ないことを確かめる（本番データへの書き込みになるため人間が行う）。

1. 見積: 工種の追加・名前変更、工種への項目の追加（手動・取り込み・AI チャット）、ドラッグで別の工種・未分類へ移動、工種の削除。
2. 工程: 工程の追加・編集で工種を選ぶ・外す、AI 工程案の採用。
3. 再読み込みして、見積・工程の工種の表示が変わらないこと。

## ロールバック

`ki-002-pr4a-group-project-sql-editor-rollback.sql` の全文を貼り付けて、1 回だけ実行する。

- 複合外部キー 2 つ → 一意制約 → 履歴の 20261015000001 の 1 行 の順に消す。データ・既存の制約・RLS・権限には触れない。
- 最後の結果が `history_rows = 0, constraints = 0, prior_constraints = 21` なら完了。
- 何も無い状態で実行すると `group-project-1 rollback aborted: nothing to roll back ...` で止まる。
- PR-3 もロールバックするときは、新しい順（PR-4a → PR-3）に戻す（依存はないが順序をそろえる）。
- 履歴を消した後は migration ファイルも revert する（CLI から「未適用」に見えるため）。

## 残るリスク

- 論理削除済みの工種を指す行は許す（設計どおり）。工程が削除済みの工種を指したまま残る挙動は従来どおり。
- 他社の工種を指す行は、同じ案件ではありえないので拒否される。ただし同じ案件の工種であれば会社は DB で保証済み（PR #35・PR-3）であることが前提。
  PR-3 をロールバックすると、この前提が弱くなる（PR-4a 単独では会社の一致を直接見ていない）。
- R3〜R5（原価台帳 → 見積行、LINE イベントの参照）は PR-4b / PR-4c で扱う。
