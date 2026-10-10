# KI-001: 「見積に追加」と LINE イベントの案件紐付けを 1 トランザクションにする（未適用）

migration: `supabase/migrations/20261013000001_link_line_event_on_estimate_add.sql`

**状態: 本番未適用。適用は人間の承認後に行う。**
前提: `20260711000002`（estimate_items.category）と `20260711000005`（line_events.reflected_to_estimate・
estimate_items.line_event_id）が適用済み。前提の列が無い DB では、migration は何も作らずに止まる。

**マージ順: 本番に migration を適用してから PR をマージする。**
逆順だと、新しい API が存在しない関数を呼び、「見積に追加」が 500（PGRST202）になる。

## 不具合と原因

| | 修正前 | 修正後 |
|---|---|---|
| 未振り分け（`project_id = NULL`）のイベントを見積に追加 | 見積項目は追加されるが `line_events.project_id` は NULL のまま | 同じトランザクションで表示中の案件に紐付く |
| 見積追加と反映済みフラグの更新 | 別々のリクエスト（片方だけ成功しうる） | 1 トランザクション（両方成功か、両方取り消し） |
| 別の案件に紐付け済みのイベント | 追加できた（紐付けとずれる） | 409 `linked_to_other_project`。紐付けは上書きしない |
| 反映済みのイベントを再度追加（二重クリック・別タブ） | 見積項目が二重に追加された | 409 `already_reflected` |
| 他社の案件 ID を送る | `estimate_items` の RLS は `company_id` しか見ず、FK 確認は RLS を通らないため、**他社の案件に項目を追加できた** | 404 |
| イベントと案件の会社が違う（複数社に所属するユーザー） | 確認なし | 403 `company_mismatch` |
| 未認証 | 401 | 401（変わらない） |

## 設計

- 関数 `public.add_line_event_estimate_items(p_project_id uuid, p_line_event_id uuid, p_items jsonb) RETURNS jsonb` を追加する。
  **SECURITY INVOKER**（呼び出したユーザーの権限と RLS で動く）。`search_path = ''`、`lock_timeout = 5s`。
- 処理順:
  1. LINE イベントを `FOR UPDATE` でロック（自社のものだけ）。
  2. 案件を確認（自社・未削除）。
  3. 会社の一致・別案件への紐付け・反映済みを確認。
  4. `estimate_items` を INSERT（`source = 'past_item'`、`sort_order` は配列順、数量が無ければ 1、`company_id` は案件の会社）。
  5. `line_events` を更新。`project_id = coalesce(project_id, 案件 ID)`、`reflected_to_estimate = true`。
     更新が 1 行でなければ INSERT ごと取り消す。
- 同じイベントへの操作はイベント行のロックで直列化される。後の操作は先の操作がコミットした状態を見て拒否される。
- EXECUTE は authenticated のみ（PUBLIC・anon・service_role は不可）。
- テーブル・列・RLS ポリシーは変えない。既存データの UPDATE / DELETE もしない。
- 「取り消す」（`DELETE /api/line-events/[id]/estimate-items`）は変更なし。見積項目を論理削除して
  反映済みフラグを戻すが、紐付け（`project_id`）は残るので、同じ案件にもう一度追加できる。

### エラーと HTTP 応答（`lib/line-events/add-estimate-items.ts`）

| SQLSTATE / message | HTTP | code |
|---|---|---|
| LE401 | 401 | — |
| LE400 / 22xxx | 400 | — |
| LE404 | 404 | `not_found`（他社・削除済み・存在しないを区別しない） |
| LE403 | 403 | `company_mismatch` |
| LE409 `linked_to_other_project` | 409 | `linked_to_other_project` |
| LE409 `already_reflected` | 409 | `already_reflected` |
| 55P03 / 40P01 | 503 | `busy` |
| その他（PGRST202 等） | 500 | — |

DB のエラー文は返さない（ログにも SQLSTATE だけを残す）。

## 検証（隔離 DB）

`npm run test:db`（embedded PostgreSQL。本番・Preview には接続しない）の
`__tests__/db/link-line-event-estimate.db.test.ts`:

- 未振り分け → 紐付く。同じ案件に紐付け済み → 追加でき、紐付けは変わらない。
- 別の案件に紐付け済み → 拒否。重複実行 → 拒否。取り消し後の再追加 → できる。
- 他社のイベント・他社の案件・削除済みの案件・存在しない ID → 404。会社の不一致 → 403。
- 未認証 → LE401。anon・service_role は実行できない（42501）。入力不正 → LE400。
- イベントの更新を失敗させると見積項目の追加も取り消される。
- 同時実行（別々の接続で実際にトランザクションを重ねる）:
  - 同じイベントへの同時追加 → 後の操作は `already_reflected`。
  - 同じ未振り分けイベントを別々の案件へ同時追加 → 先の案件だけに紐付き、後は `linked_to_other_project`。
  - 先の操作が取り消された場合 → 待っていた操作が成功する。
- RLS ポリシーが変わらない。EXECUTE 権限・SECURITY INVOKER・関数設定。
- SQL Editor 用スクリプト: 本体が migration と一致・適用・二重適用の拒否・前提不足で何も残らない・ロールバック・再適用。

## 本番への適用手順（Supabase SQL Editor・人間が実行する）

`supabase db push` は使わない。P1-2〜P1-4 と同じく SQL Editor 専用のスクリプトで適用する。
Claude Code は本番 DB への接続・バックアップ・適用のどれも行わない。

| ファイル | 内容 |
|---|---|
| `docs/db/ki-001-sql-editor-apply.sql` | ガード → migration 本体 → 検証 → 履歴登録 → `NOTIFY pgrst` を 1 トランザクションで実行 |
| `docs/db/ki-001-sql-editor-rollback.sql` | 関数の削除 → 履歴 1 行の削除 を 1 トランザクションで実行 |

### 0. バックアップ（適用直前・人間が実行する）

これまでと同じ形式の読み取り専用バックアップ（public スキーマと migration 履歴のダンプ）を
ターミナル.app で実行する。今回は関数を 1 つ追加するだけでデータは変えないが、念のため
`line_events`・`estimate_items` のデータも含める。「バックアップ完了」と表示された場合だけ次へ進む。
接続文字列・パスワードはコマンド履歴やチャットに貼らない。

### 1. 適用前の確認（読み取りのみ）

```sql
-- 期待値: ki001_history = 0, fn_exists = false, missing_columns = 0
SELECT
  (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '20261013000001') AS ki001_history,
  to_regprocedure('public.add_line_event_estimate_items(uuid, uuid, jsonb)') IS NOT NULL AS fn_exists,
  (SELECT count(*) FROM (VALUES
     ('line_events', 'project_id'), ('line_events', 'reflected_to_estimate'),
     ('estimate_items', 'line_event_id'), ('estimate_items', 'category'), ('projects', 'deleted_at')) r(t, c)
   WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = r.t AND column_name = r.c)) AS missing_columns;

-- 適用後と比べるため記録しておく（RLS ポリシー）
SELECT tablename, policyname, cmd, roles, qual, with_check FROM pg_policies
WHERE schemaname = 'public' AND tablename IN ('line_events', 'estimate_items', 'projects') ORDER BY 1, 2;

-- 参考: 過去に未振り分けのまま見積に反映されたイベントの件数（この migration では補正しない）
SELECT count(*) AS reflected_but_unassigned
FROM public.line_events WHERE reflected_to_estimate AND project_id IS NULL;
```

`reflected_but_unassigned` が 0 でなくても適用には影響しない。補正（`estimate_items.project_id` からの
逆引き UPDATE）が必要かは別途人間が判断する（この PR の範囲外）。

### 2. 適用

`ki-001-sql-editor-apply.sql` の全文を貼り付けて 1 回だけ実行する。

- 最後の結果が `history_rows = 1, function_exists = true, security_invoker = true` なら完了。
- エラーが出たら、続けて `ROLLBACK;` だけを実行する。関数・権限・履歴のどれも残らない。
- ガードで止まる（`KI-001 apply aborted: ...`）場合:
  - 履歴テーブルが無い。
  - 20261013000001 が登録済み（二重適用）。
  - 関数が履歴なしで既にある。
- 前提の列が無い場合は `KI-001 precondition failed: ...` で止まる。
- 検証で止まる（`KI-001 verify failed: ...`）場合: SECURITY INVOKER でない・関数設定が違う・
  EXECUTE 権限が想定と違う・RLS ポリシーが変わった。
- `NOTIFY pgrst, 'reload schema'` はコミット時に送られ、PostgREST が新しい関数を認識する。

### 3. 適用後の確認（読み取りのみ）

```sql
-- 期待値: prosecdef = false, proconfig = {search_path="",lock_timeout=5s},
--         public/anon/service_role = false, authenticated = true
SELECT p.prosecdef, p.proconfig,
       has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
       has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_exec,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec
FROM pg_proc p WHERE p.oid = 'public.add_line_event_estimate_items(uuid, uuid, jsonb)'::regprocedure;
```

RLS ポリシーは手順 1 と同じ SELECT で変わっていないことを確かめる。

### 4. マージと画面確認

1. 手順 3 まで完了してから PR をマージする。
2. 本番で、確認用の案件の AI整理タブから未振り分けの LINE メッセージを 1 件「見積に追加」し、
   「振り分け済み」に移ること・見積タブに項目が追加されることを見る（本番データへの書き込みになるため人間が行う）。

## ロールバック

1. 先にアプリを戻す（PR を revert するか、Vercel で直前のデプロイに戻す）。関数を先に消すと「見積に追加」が 500 になる。
2. `ki-001-sql-editor-rollback.sql` の全文を SQL Editor で実行する（人間の承認後）。
   - 関数を削除し、migration 履歴（20261013000001 の 1 行だけ）を削除する。
   - 最後の結果が `history_rows = 0, function_exists = false` なら完了。エラー時は `ROLLBACK;` だけを実行する。
   - テーブル・業務データ・RLS には触れない。関数が作った見積項目・紐付けはそのまま残る。
   - 何も適用されていなければ `KI-001 rollback aborted: nothing to roll back ...` で止まる。
3. migration ファイルも revert する（残っていると CLI からは「未適用」に見える）。
