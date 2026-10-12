# KI-002 PR-4b: 原価台帳の行が指す見積行を「同じ案件の見積行」に DB で限る（未適用）

- migration: `supabase/migrations/20261016000001_enforce_ledger_estimate_item_project_match.sql`
- 前提: `20261014000001`（PR-3）が本番に適用済みであること（2026-10-12 適用・検証済み）
- PR-4a（`20261015000001`）とは独立している。どちらを先に適用しても、片方だけでも動く（隔離 DB で両方の順序を確認）。
  履歴の並びをそろえるため、**PR-4a → PR-4b の順を推奨**する。
- **本番 DB への適用は人間の承認待ち。** Claude Code は本番・Preview DB への接続・バックアップ・適用のどれも行わない。
- 調査・計画: `docs/db/ki-002-pr4-plan.md`（R3）。本番の事前調査（2026-10-13・人間が実行）では R3 の参照 115 件、
  `blocking_orphan`・`blocking_target_null`・`blocking_mismatch` はすべて 0。**調査時点の値なので、適用前に precheck ⑤ で再確認する。**

| ファイル | 内容 |
|---|---|
| `scripts/db/backup-ki002-pr4b.sh` | 適用前の読み取り専用バックアップ（public・migration 履歴・precheck ①〜⑧ の結果） |
| `docs/db/ki-002-pr4b-ledger-estimate-item-precheck.sql` | 適用前の確認（読み取りのみ・①〜⑧） |
| `docs/db/ki-002-pr4b-ledger-estimate-item-sql-editor-apply.sql` | ガード → migration 本体 → 検証 → 履歴登録 → `NOTIFY pgrst` を 1 トランザクションで実行 |
| `docs/db/ki-002-pr4b-ledger-estimate-item-verify.sql` | 適用後の確認（読み取りのみ） |
| `docs/db/ki-002-pr4b-ledger-estimate-item-sql-editor-rollback.sql` | 追加した 2 制約の削除 → 履歴 1 行の削除 を 1 トランザクションで実行 |

## 不具合と原因

`cost_ledger_items.estimate_item_id` は単独の外部キー → `estimate_items(id)` で、見積行の案件・会社を見ない。
RLS は行の `company_id` しか見ず、外部キーの確認は RLS を通らない。
そのため PostgREST を直接叩くか service_role を使えば、**他の案件（他社を含む）の見積行**を指す台帳行を作れる。

- 台帳の初期化・同期（`app/api/cost-ledger/init`・`sync`）は同じ案件の見積行からしか `estimate_item_id` を入れない。
  台帳の編集 API（`cost-ledger/[id]`・AI チャットの確定）は `estimate_item_id`・`project_id` を変更できない。
- 同期は `estimate_item_id` で見積行と台帳行を突き合わせる。他の案件の見積行を指す行は「見積から消えた行」として論理削除される。

## 設計

| 制約 | 定義 |
|---|---|
| `estimate_items_id_project_id_key` | `UNIQUE (id, project_id)`（id は主キーなので常に一意。複合外部キーの参照先） |
| `cost_ledger_items_estimate_item_project_fkey` | `FOREIGN KEY (estimate_item_id, project_id) REFERENCES estimate_items(id, project_id) ON DELETE SET NULL (estimate_item_id)` |

- **同じ案件 ⇒ 同じ会社。** PR #35・PR-3 で、見積行・台帳行の `(project_id, company_id)` は `projects` と一致する。会社の列は含めない。
- **ON DELETE SET NULL (estimate_item_id)**（PostgreSQL 15 以上・本番 17.6）: 見積行の物理削除で `estimate_item_id` だけを NULL にする。
  既存の単独の外部キーと同じ動き。`project_id`・実績・請求書には触れない（P1-3 の actual_cost ロックのトリガーにも当たらない）。
  素の `SET NULL` だと NOT NULL の `project_id` まで NULL にしようとして失敗する。
- **NULL（手動で追加した台帳行）:** MATCH SIMPLE なので `estimate_item_id` が NULL の行は確かめない（従来どおり）。
  参照元の `project_id` は NOT NULL（事前確認で確かめる）。
- **論理削除:** 外部キーは `deleted_at` を見ない。論理削除済みの見積行を指す台帳行（sync が論理削除した行・同期前の行）はそのまま許す。
  論理削除済みの台帳行が他の案件の見積行を指していれば、適用は止まる（事前確認は論理削除済みの行も数える）。
- **既存の単独の外部キー（`cost_ledger_items_estimate_item_id_fkey`）は消さない・変えない。** RLS・権限・列・関数・トリガー・業務ロジックも変えない。
- インデックスは足さない（参照先の一意制約が作るインデックスだけ）。見積行の削除時の台帳の検索は従来どおり。

### 安全方針（PR-3・PR-4a と同じ）

- 既存データの UPDATE / DELETE なし。食い違いの自動補正もしない。
- 次のどれかに当てはまれば、何も作らずに止まる（1 つのメッセージにまとめて出す）:

  | メッセージ（`ledger-item-project-1 precondition failed: ...`） | 意味 |
  |---|---|
  | `PostgreSQL 15 or later is required` | ON DELETE SET NULL (列) が使えない |
  | `<tbl>: table missing` / `unexpected columns` | テーブル・列が無い、型が uuid でない |
  | `cost_ledger_items: project_id is nullable` | 参照元の project_id が NULL を許す（NULL の抜け道ができる） |
  | `cost_ledger_items: existing estimate_item_id fkey on delete is ... (expected n)` | 既存の単独の外部キーが無い・ON DELETE が SET NULL でない |
  | `... exists with a different definition` | 同じ名前の制約が想定と違う定義で既にある |
  | `cost_ledger_items: orphan=… estimate_item_project_null=… mismatched=…` | 参照先の見積行が無い・見積行の project_id が NULL・見積行の案件が違う台帳行がある（論理削除済みの行も数える） |

- NOT VALID で追加してから VALIDATE（同じトランザクション）。再適用しても増えない（定義が一致する制約があれば作らない）。

### ロック

- `estimate_items` に一意制約を足す間は、`estimate_items` の**読み書き**が止まる（ACCESS EXCLUSIVE。コミットまで）。
  見積の画面・AI チャット・LINE からの見積追加が数秒待たされる可能性がある。precheck ⑥ で行数を見て、利用の少ない時間に適用する。
- 外部キーの追加・VALIDATE 中は `cost_ledger_items`・`estimate_items` の書き込みが待たされる（コミットまで）。
- ロック待ちは `lock_timeout = 5s` で打ち切り、全体を取り消す（55P03）。利用の少ない時間に再実行する。
  隔離 DB で、`cost_ledger_items`・`estimate_items` のどちらが書き込み中でも何も残らずに止まり、待ちが解消すれば適用できることを確かめた。

### 影響

- 見積行を指したまま台帳行の `project_id` を別の案件へ変えること、台帳から参照されている見積行の `project_id` を変えることはできなくなる。
  アプリにどちらの経路も無い（`app`・`lib` と DB 関数を確認済み。台帳の編集 API が変更できる列は名前・予算・完工予算・実績・業者・メモだけ）。
- PostgREST: `cost_ledger_items` → `estimate_items` の外部キーが 2 本になる。この組を埋め込むクエリは無い。
  PR #41 の回帰テスト（`__tests__/postgrest-embeds.test.ts`・`__tests__/db/postgrest-embeds.db.test.ts`）が、この migration を含む DB で確かめている。

## 検証（隔離 DB・`npm run test:db`）

`__tests__/db/ledger-estimate-item-match.db.test.ts`（32 件）:

- 修正前の再現: PostgREST と同じ権限で、同じ会社の別案件の見積行・他社の見積行を指す台帳行を INSERT / UPDATE できる。
- 適用が止まる条件: 食い違い（論理削除済みの台帳行を含む）・孤児行・見積行の project_id が NULL・定義の違い
  （project_id が NULL 可、既存外部キーの ON DELETE・欠落、同名の別定義、テーブルが無い）。
- ロック待ちでの中断（55P03。`cost_ledger_items`・`estimate_items` の両方）で何も残らないこと、待ちが解消すれば適用できること。
- 適用後: 他案件・他社の見積行の INSERT / UPDATE は 23503（authenticated・service_role とも）。見積行を指したままの案件移動・参照中の見積行の案件変更も 23503。
- 原価台帳の既存の操作: 初期化（init と同じ一括 INSERT）・手動の行（NULL）・同期（更新・論理削除・追加）・論理削除済みの見積行への参照・
  台帳の編集・請求書がある行の actual_cost ロック（P1-3・CL423）・見積行の物理削除（estimate_item_id だけ NULL、実績・請求書は残る）・
  案件の物理削除（カスケード）・他の案件への影響なし。
- 既存の制約（単独の外部キー・PR #35・PR-3・PR-4a）・RLS ポリシー・テーブル権限・トリガーが適用前後で同じ。再適用しても増えない。
- PR-4a の有無・順序: PR-4a 未適用の DB でも適用でき、PR-4a → PR-4b / PR-4b → PR-4a のどちらの順でも適用できる。
- SQL Editor 用スクリプト: 本体と migration の一致、成功・ガード（二度目・履歴なしの制約・前提未記録）・食い違いで何も残らない、
  precheck・verify が読み取り専用、ロールバックで 2 制約と履歴だけが消え再適用できる、PR-4a のロールバックと独立していること。

API を通る原価台帳の操作（`cost-ledger`・`init`・`sync` の他社・別案件の拒否と正常系）は
`company-isolation-api.db.test.ts` が、この migration を含む全 migration の DB で確かめている。
バックアップスクリプトは隔離ローカル PostgreSQL に対して最後（`[OK] バックアップ完了`）まで実行できることを確かめた。

## 本番への適用手順（Supabase SQL Editor・人間が実行する）

`supabase db push` は使わない。

1. 20261014000001（PR-3）が適用済みであること。PR-4a を先に適用する場合は、その確認まで終えておく。
2. この PR の migration を適用する。
3. PR をマージする。

この PR にはアプリのコード変更が無いため、マージと適用の順序に依存はない。ただし、適用してからマージする。

### 0. バックアップ（適用直前・人間が実行する）

PR-3・PR-4a と同じ形式の読み取り専用バックアップを、ターミナル.app で実行する。

```bash
cd ~/genba-ai
git switch fix/ki-002-pr4b-ledger-fk
git pull --ff-only
bash scripts/db/backup-ki002-pr4b.sh
```

- 20261014000001 = 1 件・20261016000001 = 0 件を確かめ、precheck ①〜⑧ の結果を `ki002pr4b_precheck.txt` に保存する。
- `[OK] バックアップ完了` と表示された場合だけ次へ進む。接続文字列・パスワードはコマンド履歴やチャットに貼らない。
- 出力先は `~/Desktop/rugz-backup-<日時>-pre-ki002-pr4b/`（既存のバックアップは上書きしない）。
- **完全バックアップではない**（public と migration 履歴だけ。Auth・Storage は含まない）。準備・出力ファイル・復元手順は
  `docs/db/ki-002-pr3-backup-and-restore.md` と同じ（スクリプト名・フォルダ名・precheck ファイル名だけが違う）。

### 1. 適用前の確認（読み取りのみ）

`ki002pr4b_precheck.txt`（または SQL Editor で `ki-002-pr4b-ledger-estimate-item-precheck.sql` の ①〜⑧ を 1 つずつ）を照合する。

| # | 期待値 | 違ったら |
|---|---|---|
| ① | 17.x | 報告して相談 |
| ② | 20261013000002・20261014000001 が `recorded = true`、20261016000001 が `false`（20261015000001 はどちらでもよい） | **中止** |
| ③ | `cost_ledger_items.project_id`・`estimate_items.project_id` が `nullable = false`、型はすべて uuid | **中止**（`project_id` が NULL 可なら報告して相談） |
| ④ | `cost_ledger_items_estimate_item_id_fkey`（ON DELETE SET NULL）と `estimate_items_pkey` の 2 行だけ | **中止**（PR-4b の名前が既にある・単独の外部キーが無い・想定外の一意制約がある） |
| ⑤ | `blocking_orphan`・`blocking_target_null`・`blocking_mismatch` が 0（事前調査では `with_ref` 115） | **中止**。補正 SQL は実行せず、件数を報告して相談 |
| ⑥ | 記録（行数。ロック時間の目安） | — |
| ⑦ | 記録しておく（適用後と比べる。`cost_ledger_items_lock_actual_cost` が `enabled=O`） | — |
| ⑧ | 0 行 | 長いトランザクションが終わるまで待つ |

**⑤・⑧ は手順 2 の直前に、SQL Editor でもう一度実行する。** バックアップ時点・事前調査時点の結果だけでは判断しない。

### 2. 適用

直前に ⑤ の blocking が 0、⑧ が 0 行であることを確かめ、`ki-002-pr4b-ledger-estimate-item-sql-editor-apply.sql` の全文を貼り付けて、1 回だけ実行する。

- 最後の結果が `history_rows = 1, valid_constraints = 2, prior_constraints = 21` なら完了。
- エラーが出たら、続けて `ROLLBACK;` だけを実行する。制約も履歴も残らない。
- 止まった場合のメッセージ:
  - `ledger-item-project-1 apply aborted: ...`（ガード）: 履歴テーブルが無い、20261014000001 が未登録、20261016000001 が登録済み（二重適用）、履歴なしで制約が既にある。
  - `ledger-item-project-1 precondition failed: ...`: 上の「安全方針」の表を参照。**補正はせず、メッセージをそのまま報告する。**
  - `canceling statement due to lock timeout`（55P03）: `ROLLBACK;` してから、利用の少ない時間に再実行する。
  - `ledger-item-project-1 verify failed: ...`: 制約の数・定義が想定と違う、既存の制約・RLS ポリシー・テーブル権限・トリガーが変わった。
- `NOTIFY pgrst, 'reload schema'` はコミット時に送られる。

### 3. 適用後の確認（読み取りのみ）

- `ki-002-pr4b-ledger-estimate-item-verify.sql` を実行する。2 行とも `ok = true`、`_summary` 行で
  `history_recorded = true`・`single_fkeys = 1`・`prior_constraints = 21`・`blocking_rows = 0`・`lock_trigger_enabled` が手順 1 の ⑦ と同じ。
- precheck ⑦ をもう一度実行し、手順 1 の結果と同じであることを確かめる。

### 4. マージと画面確認（人間が行う）

PR をマージしたあと、本番の確認用案件で次を一通り操作し、エラーが出ないことを確かめる（本番データへの書き込みになるため人間が行う）。

1. 原価台帳: 見積から取り込み（初期化）、手動で行を追加、予算・実績・業者・メモの編集、行の削除。
2. 見積で行を追加・変更・削除してから、原価台帳の「見積と同期」を実行し、追加・更新・削除が反映されること。
3. 業者請求書の登録・編集・削除（実績原価が内訳の合計になること）。
4. 再読み込みして、台帳の表示が変わらないこと。

## ロールバック

`ki-002-pr4b-ledger-estimate-item-sql-editor-rollback.sql` の全文を貼り付けて、1 回だけ実行する。

- 複合外部キー → 一意制約 → 履歴の 20261016000001 の 1 行 の順に消す。データ・既存の制約・RLS・権限・トリガーには触れない。
- 最後の結果が `history_rows = 0, constraints = 0, prior_constraints = 21` なら完了。
- 何も無い状態で実行すると `ledger-item-project-1 rollback aborted: nothing to roll back ...` で止まる。
- PR-4a・PR-3 もロールバックするときは、新しい順（PR-4b → PR-4a → PR-3）に戻す（依存はないが順序をそろえる）。
- 履歴を消した後は migration ファイルも revert する（CLI から「未適用」に見えるため）。

## 残るリスク

- 論理削除済みの見積行を指す台帳行は許す（設計どおり）。
- 他社の見積行を指す行は、同じ案件ではありえないので拒否される。ただし同じ案件の見積行であれば会社は DB で保証済み（PR #35・PR-3）であることが前提。
  PR-3 をロールバックすると、この前提が弱くなる（PR-4b 単独では会社の一致を直接見ていない）。
- テーブル所有者（postgres・SQL Editor の利用者）は制約を外せる。
- R4・R5（LINE イベントの参照）は PR-4c、`estimate_revisions`・`cost_ledger_invoices` は PR-5 以降で扱う。
