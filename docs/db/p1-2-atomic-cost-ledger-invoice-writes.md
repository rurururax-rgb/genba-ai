# P1-2: 業者請求書と実績原価（actual_cost）のアトミック更新基盤

migration: `supabase/migrations/20261010000002_atomic_cost_ledger_invoice_writes.sql`

> **この PR では本番に適用しない。**
>
> - 適用は人間の明示的な承認のあと、Supabase SQL Editor で手動実行する。
> - 実行するのは `docs/db/p1-2-sql-editor-apply.sql`（1 トランザクション・migration 履歴の登録付き）。
> - `supabase db push` は使わない。
> - ロールバックは `docs/db/p1-2-sql-editor-rollback.sql`。
> - アプリ側（API）の切り替えは PR #32 で行う。

## 目的

現行 API は「請求書の INSERT / UPDATE / DELETE」と「actual_cost の再集計」を別々のリクエストで行い、
ロックも取らない。そのため次のずれが起こりうる。

- 同じ台帳項目への同時登録で、再集計が古い合計で上書きされる
- 請求書の書き込みは成功したが、再集計が失敗したまま（`syncActualCost` はエラーを無視する）

これを 1 トランザクションで行う PostgreSQL 関数を追加する。テーブル・RLS・既存の一意制約は変更しない。

## 追加する関数

いずれも `SECURITY INVOKER`、`SET search_path = ''`、`SET lock_timeout = '5s'`、`EXECUTE` は `authenticated` のみ。

| 関数 | 役割 | 戻り値（jsonb） |
|---|---|---|
| `cost_ledger_invoice_insert(p_item_id uuid, p_amount numeric, p_invoice_date date, p_payment_date date, p_note text, p_source text, p_vendor_name text, p_invoice_number text, p_document_sha256 text, p_idempotency_key uuid)` | 請求書を登録し再集計 | `{invoice, item_id, actual_cost, invoice_count}` |
| `cost_ledger_invoice_update(p_invoice_id uuid, p_patch jsonb)` | 金額・請求日・支払日・備考を変更し再集計 | `{invoice, item_id, actual_cost, invoice_count}` |
| `cost_ledger_invoice_delete(p_invoice_id uuid)` | 請求書を削除し再集計 | `{deleted_id, item_id, actual_cost, invoice_count}` |

`invoice` は現行 API の SELECT と同じ列（id, cost_ledger_item_id, amount, invoice_date, payment_date, note,
source, vendor_name, invoice_number, created_at）。画像ハッシュ・idempotency_key・project_id は返さない。

### 処理の順序（3 関数共通）

1. `auth.uid()` が無ければ CL401
2. 入力を検証（不正なら CL400。この時点ではまだ何も書かない）
3. 親の台帳項目を `SELECT … FOR UPDATE OF ci` でロック。
   条件は「台帳項目が見える（RLS）・未削除」「案件が見える（RLS）・未削除」「案件の company_id = 台帳項目の company_id」。
   1つでも満たさなければ CL404（他社の行・存在しない行・削除済みを区別しない）
4. update / delete は請求書の行も `FOR UPDATE` でロックし、親が変わっていないか・project_id が親の案件と一致するか
   （NULL の既存行は許可）を確認。食い違えば CL409
5. 請求書を書き込む。project_id はリクエストではなく親の台帳項目から入れる
6. 同じトランザクションで `count(*)` と `sum(amount::numeric)` を取り、actual_cost を更新
   （0 件なら NULL）。更新できなければ CL409
7. 途中のどこで失敗しても、請求書の変更と actual_cost の変更はまとめて取り消される

### 入力の検証（現行 POST / PATCH API と同じ範囲）

- 金額: NULL・0・絶対値 1 兆以上は不可。マイナス（値引・返品）は可
- source: `ocr` / `manual`（NULL は manual）。OCR は画像ハッシュ（小文字 16 進 64 桁）と idempotency_key が必須。
  manual は画像ハッシュ不可、業者名・請求番号は保存しない
- 備考 500 字・業者名 200 字・請求番号 100 字まで（前後の空白を除き、空なら NULL）
- update の `p_patch` は `amount` / `invoice_date` / `payment_date` / `note` だけ。それ以外のキー
  （`cost_ledger_item_id`・`project_id`・`source` など）が含まれていたら何も変えずに CL400。
  **別の台帳項目への付け替えはできない。** 金額は JSON の数値のみ、日付は `YYYY-MM-DD` の文字列か null（空文字は null）

### エラー

| SQLSTATE | message | 意味 | PR #32 での HTTP |
|---|---|---|---|
| CL401 | unauthenticated | auth.uid() なし | 401 |
| CL400 | invalid_input | 入力が不正 | 400 |
| CL404 | not_found | 見えない・存在しない・削除済み | 404 |
| CL409 | inconsistent | 請求書と親の不整合 | 409 |
| 23505 | （既存インデックス） | 同じ idempotency_key／同じ案件の同じ画像 | 409（現行 API と同じ扱い） |
| 55P03 | lock_not_available | 5 秒以内にロックが取れない | 503 などで再試行を促す |
| 40P01 | deadlock_detected | RPC を通らない書き込みとのデッドロック | 503 などで再試行を促す |
| 42501 | permission denied | anon・service_role からの呼び出し | — |

関数が自分で出すエラーは短い識別子だけで、内部の値や SQL は含めない。PR #32 の API も `error.message` を
そのまま返さず、SQLSTATE から固定の文言に変換すること。

## ロック方式と保証範囲

- ロックの単位は**台帳項目 1 行**（`cost_ledger_items` の行ロック）。全体ロックや advisory lock は使わない。
  別の台帳項目への操作は互いに待たない
- ロックの順序は 3 関数とも「台帳項目 → 請求書」。関数どうしではデッドロックしない
- READ COMMITTED でも、ロック取得後の SUM は先にロックを持っていたトランザクションの確定結果を含む。
  そのため**関数どうしの同時実行では、最後に actual_cost = 内訳の合計（0 件なら NULL）が必ず成り立つ**
- `lock_timeout = 5s`。長く待たずに 55P03 で失敗し、何も書かない

**保証しないもの（PR #32 まで残る）:**

- RPC を通らない書き込み（現行の請求書 API、`PATCH /api/cost-ledger/[id]` の actual_cost 直接編集、
  AI チャットの confirm-change）はロックを取らない。これらと同時に動くと合計がずれうる。
  ただし次に RPC が動いた時点で、その台帳項目の actual_cost は内訳合計に揃う
- 現行の請求書 PATCH API（請求書 → 親の順に書く）とは、ロック順が逆なのでデッドロックしうる。
  PostgreSQL が片方を 40P01 で取り消すため、中途半端な状態は残らない（テスト 15b で確認）

## 権限・RLS

- `SECURITY INVOKER`。呼び出したユーザーの RLS がそのまま効く（他社の台帳項目・案件・請求書は見えず CL404）
- `SECURITY DEFINER` は使わない。service_role による RLS の回避もしない
- `REVOKE ALL … FROM PUBLIC`、存在すれば `anon` / `service_role` からも REVOKE、`GRANT EXECUTE … TO authenticated`
- company_id・project_id はリクエストから受け取らない（台帳項目と案件から決める）
- 既存の RLS ポリシー・テーブル定義・一意インデックスは変更しない

## 適用前の確認（読み取りのみ・本番で実行してよい SQL）

**この結果を人間が確認するまで適用しない。**
リポジトリには `cost_ledger_invoices` の元の CREATE TABLE が無い（本番で直接作られた）ため、特に列の型と RLS を確かめる。

```sql
-- 1. 列と型（amount の型が numeric か。numeric 以外なら関数内で ::numeric に変換して合計する）
SELECT table_name, column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('cost_ledger_invoices', 'cost_ledger_items', 'projects')
ORDER BY table_name, ordinal_position;

-- 2. P1-1 の一意インデックスが存在する（無ければ migration は何も作らずにエラーで止まる）
SELECT indexname, indexdef FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'cost_ledger_invoices';

-- 3. 制約（外部キー・CHECK）
SELECT conrelid::regclass AS tbl, conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid IN ('public.cost_ledger_invoices'::regclass, 'public.cost_ledger_items'::regclass);

-- 4. RLS が有効か・ポリシーの内容（請求書は「親の台帳項目が見える」ことで絞られているか）
SELECT relname, relrowsecurity FROM pg_class
WHERE oid IN ('public.cost_ledger_invoices'::regclass, 'public.cost_ledger_items'::regclass, 'public.projects'::regclass);
SELECT tablename, policyname, cmd, roles, qual, with_check FROM pg_policies
WHERE schemaname = 'public' AND tablename IN ('cost_ledger_invoices', 'cost_ledger_items', 'projects');

-- 5. 同名の関数がまだ無い
SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname LIKE 'cost_ledger_invoice_%';

-- 6. 適用前の不整合の件数（参考。適用しても既存行は書き換えない）
SELECT count(*) AS mismatched FROM public.cost_ledger_items ci
JOIN (SELECT cost_ledger_item_id, sum(amount) AS total FROM public.cost_ledger_invoices GROUP BY 1) s
  ON s.cost_ledger_item_id = ci.id
WHERE ci.actual_cost IS DISTINCT FROM s.total;

-- 7. migration 履歴の現状（20261010000002 が未登録であること。P1-1 の 20261010000001 の有無も確認）
SELECT version, name FROM supabase_migrations.schema_migrations
WHERE version >= '20260912000000' ORDER BY version;

-- 8. 履歴テーブルの列（適用スクリプトは version だけを必須とし、name は列があれば埋める）
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'supabase_migrations' AND table_name = 'schema_migrations'
ORDER BY ordinal_position;
```

確認すること:

- `amount` が numeric であること（それ以外の型でも動くが、丸めの扱いを人間が判断する）
- 請求書の UPDATE / DELETE を許すポリシーがあること（無ければ現行 API と同じく関数でも書けない）
- 請求書のポリシーで「自社の請求書の一部が見えない」状態になっていないこと。
  見えない行は SUM にも含まれない（現行 API と同じ）
- 7 の結果に `20261010000002` が**無い**こと。あれば適用しない（何かが既に行われている。原因を調べる）
- 7 の結果に `20261010000001`（P1-1）が無い場合、P1-1 も「実体はあるが履歴が無い」状態。
  P1-2 とは別に人間が判断する（この手順で P1-1 の履歴は登録しない）
- 8 の結果に、`version` 以外で NOT NULL かつ既定値の無い列が無いこと。
  あれば適用スクリプトの履歴登録が失敗し、全体が取り消される（安全側。列に合わせた手順を作り直す）

## 適用方法は 2 つ。混同しない

| | A. Supabase CLI（通常の migration） | B. SQL Editor による手動適用（**今回の予定**） |
|---|---|---|
| 実行するもの | `supabase/migrations/20261010000002_*.sql` | `docs/db/p1-2-sql-editor-apply.sql`（migration 本体を同梱） |
| トランザクション | CLI が管理する | スクリプト自身の `BEGIN` / `COMMIT` |
| 履歴の登録 | CLI が自動で登録 | スクリプトが同じトランザクションの最後で登録 |
| 今回 | **使わない**（`supabase db push` 禁止） | 人間の承認後に 1 回だけ |

- migration ファイルには `BEGIN` / `COMMIT` を入れていない。CLI は自分でトランザクションと履歴を扱うため、
  ファイルにトランザクション制御を入れると CLI の処理と衝突しうる。トランザクション制御は B のスクリプトにだけ置く
- B のスクリプトの migration 本体は、migration ファイルと 1 文字も違わないことをテストで照合している
  （ファイルを直したらスクリプトも作り直す。ずれていれば `npm run test:db` が失敗する）
- B で適用した後に A（`supabase db push`）を実行しても、履歴に `20261010000002` があるので再実行されない

## 適用（B. SQL Editor・人間の承認後のみ）

1. 「適用前の確認」の SQL を実行し、結果を人間が確認する
2. `docs/db/p1-2-sql-editor-apply.sql` の**全文**を SQL Editor に貼り付け、1 回だけ実行する。中身は次の順に進む。
   1. `BEGIN`
   2. ガード：次のどれかに当てはまれば何もせずに止まる
      - 履歴テーブルが無い
      - `20261010000002` が履歴に登録済み
      - 同名の関数が既にある
   3. migration 本体（P1-1 の列・インデックスが無ければ、migration 自身の事前条件で止まる）
   4. 検証：関数が 3 つあること、INVOKER であること、`search_path` / `lock_timeout`、EXECUTE 権限
   5. 履歴の登録：`version = '20261010000002'`。`name` 列があれば `atomic_cost_ledger_invoice_writes` も入れる
   6. `COMMIT`
   7. 最終照合（読み取りのみ）
3. 結果を確認する。
   - **成功**：最後の結果が `history_rows = 1, functions = 3`
   - **エラーが出た場合**：COMMIT には到達していないため、関数も履歴も確定していない。
     1. `ROLLBACK;` だけを実行する（トランザクションが既に閉じていれば警告が出るだけで無害）
     2. 下の「履歴と実体の照合」が `0 / 0` であることを確かめる
     3. エラー文を人間に報告する。**再実行は原因を確かめてから**
4. 「適用後の確認」の SQL を実行する

途中失敗で何も残らないことは、ローカルの隔離 DB で確かめている。

- 送り方：スクリプトの全文を 1 回のクエリ（複数文）として送った
- 確かめた失敗の位置：次の 3 つ
  - 事前条件（migration 本体の冒頭）
  - 最後の履歴登録
  - ガード
- 最後の履歴登録で失敗した場合でも、作成済みの関数ごと取り消される

SQL Editor が内部でスクリプトをどう送るかは、このリポジトリからは確認できない。ただし、どちらの送り方でも部分適用にはならない。

- 全文を 1 回で送る場合：エラーの時点で残りの文は実行されない
- 文ごとに送り、エラーの後も続ける場合：
  - 失敗したトランザクションの中では、後続の文がすべてエラー（25P02）になる
  - 最後の `COMMIT` は `ROLLBACK` として扱われる

どちらの場合も COMMIT は成立しない。

## 適用後の確認（読み取りのみ）

```sql
SELECT p.oid::regprocedure AS fn, p.prosecdef, p.proconfig,
       has_function_privilege('anon', p.oid, 'EXECUTE')          AS anon,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
       has_function_privilege('service_role', p.oid, 'EXECUTE')  AS service_role
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname LIKE 'cost_ledger_invoice_%';
-- 期待値: 3 行。prosecdef = false、proconfig に search_path="" と lock_timeout=5s、
--         anon = false、authenticated = true、service_role = false
```

### 履歴と実体の照合（読み取りのみ・適用後とロールバック後の両方で使う）

```sql
SELECT
  (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '20261010000002') AS history_rows,
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('cost_ledger_invoice_insert', 'cost_ledger_invoice_update', 'cost_ledger_invoice_delete')) AS functions;
```

| history_rows | functions | 状態 |
|---|---|---|
| 1 | 3 | 適用済み（正常） |
| 0 | 0 | 未適用・ロールバック済み（正常） |
| それ以外 | | 履歴と実体がずれている。**何も実行せずに人間に報告**（履歴を手で足したり消したりしない） |

CLI が使える環境では、`supabase migration list` でも `20261010000002` が Local と Remote の両方に出ることを確かめられる
（読み取りのみ。`db push` / `migration repair` は実行しない）。

## ロールバック

方法は 1 つ。人間の承認後のみ実行する。

1. PR #32 を本番に出した後なら、**先にアプリを PR #32 より前に戻す**
   （戻さないと請求書の登録・編集・削除が失敗する）
2. `docs/db/p1-2-sql-editor-rollback.sql` の全文を SQL Editor で 1 回だけ実行する。
   関数 3 つの `DROP FUNCTION` と、履歴の `20261010000002` の 1 行の削除を、1 トランザクションで行う。
   - ガード：関数も履歴も無ければ、何もせずに止まる
   - 最後の結果が `history_rows = 0, functions = 0` なら成功
   - エラーが出たら、適用時と同じく `ROLLBACK;` だけを実行してから照合する
3. **履歴の扱い**：関数と一緒に履歴の行も消し、「履歴はあるが実体が無い」状態を作らない。
   - その場合、`supabase/migrations/20261010000002_*.sql` が main に残っていると、CLI からは未適用に見える
   - 誰かが `supabase db push` を実行すると、関数が再作成されてしまう
   - そのため、migration ファイル（とこの PR の変更）を revert する PR を作り、人間が merge する
4. ファイルを revert できない事情がある場合は、上のスクリプトを使わない。
   代わりに、関数を DROP する新しい migration を追加する「前進するロールバック」を、人間と相談して選ぶ

ロールバックで消えるのは関数と履歴の 1 行だけで、テーブル・データ・RLS・インデックスは残る（テストで確認）。

## テスト

```bash
npm run test:db
```

- 一時ディレクトリに使い捨ての PostgreSQL 17（embedded-postgres）を 127.0.0.1 で起動し、
  Supabase の最小限（ロール、`auth.uid()`、`get_my_company_ids()`、RLS、migration 履歴テーブルの代用）を再現した上で、
  リポジトリの実際の migration（台帳項目 → 請求書の代用定義 → P1-1 → P1-2）を順に適用する
- SQL Editor 用の適用・ロールバックスクリプトも、SQL Editor と同じく全文を 1 回のクエリで送って検証する
- 本番・Preview の DB には接続しない
- 同時実行のテストは複数の独立した接続で実際にトランザクションを重ね、
  `pg_stat_activity.wait_event_type = 'Lock'` で本当にロック待ちになっていることを確かめる
- `npm test`（CI の Quality Gate）には含めていない

## PR #32 で必要な変更

### 1. 請求書 API を RPC に切り替える

- `POST /api/cost-ledger/[id]/invoices`、`PATCH` / `DELETE /api/cost-ledger/invoices/[invoiceId]` を
  `supabase.rpc('cost_ledger_invoice_insert' | '…_update' | '…_delete')` に切り替える
- `recalcActualCost` / `syncActualCost` の呼び出しをやめる
- idempotency の再送（23505 → 既存行を返す）は API 側に残す
- SQLSTATE を HTTP に変換する（上の表）。`error.message` をクライアントに返さない

### 2. actual_cost の直接編集 —— API で拒否するだけでは防げない

**現状の事実:**

- `cost_ledger_items` の RLS は `FOR ALL USING (company_id IN (SELECT get_my_company_ids()))` で、WITH CHECK が無い
  （`20260912000001_reconcile_cost_ledger_items.sql`）
- そのため、ログイン済みの自社ユーザーは、ブラウザ用クライアント（anon key と本人の JWT）から PostgREST 経由で
  自社の台帳項目の actual_cost を直接 UPDATE できる。アプリにそのコードが無いだけで、DB は止めない
- テスト「（限界の確認）RPC を通らない現行の書き込み…」では、authenticated ロールで請求書のある項目の
  actual_cost を直接書き換えられ、合計とずれることを確認している
- 同じ理由で、請求書テーブル自体への直接の INSERT / UPDATE / DELETE も、本番の請求書ポリシー次第で可能

`PATCH /api/cost-ledger/[id]` や AI チャットの confirm-change で拒否しても、DB への直接の更新は防げない。

**維持すること:**

- 請求書が 0 件の台帳項目では、actual_cost の直接入力（見積原価の初期値・手入力の原価）をこれまでどおり許す
- RLS・GRANT は変更しない（この PR でも PR #32 でも、人間の合意なしに変えない）

**PR #32 での推奨案（DB 側で不変条件を強制。新しい migration になるので人間の承認が必要）:**

- `cost_ledger_items` に BEFORE UPDATE トリガーを追加する
  - 発火条件：`NEW.actual_cost IS DISTINCT FROM OLD.actual_cost`
  - 処理：その項目の請求書の件数と合計を数える。1 件以上あり、`NEW.actual_cost` が合計と一致しなければ拒否する
  - 0 件なら何もしない（手入力は維持）
  - RPC は合計と同じ値を書くので通る。経路（API・PostgREST・AI チャット）を問わず、DB で止まる
  - ロールや GUC で RPC を見分ける方式にしない（PostgREST 経由で偽装されうる）。値そのものを検証する
- 請求書テーブルへの直接書き込みで合計がずれる問題には、2 つの案がある
  - 案 1：請求書テーブルに DEFERRABLE INITIALLY DEFERRED の制約トリガーを置き、コミット時に、
    触れた台帳項目について「actual_cost = 合計（0 件なら NULL）」を検証する
  - 案 2：AFTER トリガーで合計を計算し直す（RPC の処理と重なる）
  - どちらを採るかは、現行の API を RPC に切り替えた後で人間と決める
  - 現行 API は INSERT と再集計が別のリクエストなので、切り替える前に入れると現行 API が失敗する
- トリガーの導入前に、既に「請求書があるのに actual_cost が合計とずれている」項目を数える（適用前の確認 6）
  - トリガー導入後は、こうした項目の actual_cost を直接編集しようとすると拒否される
  - 合計に揃えるデータ修正は既存行の UPDATE になるので、人間の承認なしに行わない

**採らない案:**

- 列単位の `REVOKE UPDATE (actual_cost)`
  - SECURITY INVOKER の RPC も同じ権限で動くため、RPC まで書けなくなる
  - 回避するには DEFINER が必要になり、方針に反する
- RLS ポリシーの変更：方針により行わない

**アプリ側:**

- 台帳項目の PATCH と confirm-change では、請求書がある項目の actual_cost 変更を 409 で返す
  （トリガーのエラーを分かりやすい文言にするため）
- CostLedgerTab は請求書を開いたときに初めて読み込むため、開いていない行では請求書があっても
  actual_cost を編集できてしまう
  - 一覧の取得時に請求書の件数を返し、それで読み取り専用にする

### 3. 【必須確認】請求実績の税区分（Excel との整合）

**現状:**

- 先方の原価台帳（Excel）の「請求実績」は、**税抜**の業者請求金額の合計
- 現行の OCR（`app/api/ai/extract-vendor-invoice/route.ts` の抽出プロンプト）は、`total_amount` に
  「税込合計が明記されていればそれ。なければ税抜合計」を返す
- 画面（`VendorInvoiceImportTab.tsx`）は、その値を金額欄の初期値にしている
- その結果、OCR で登録した請求書は多くが税込で入り、Excel の請求実績とずれる

**P1-2（この PR）の扱い:**

- 税区分は変えない。RPC は渡された金額をそのまま合計するだけで、税込・税抜を区別しない
- 既存の請求書の金額も変換しない

**PR #32 で必ず確認・対応すること:**

1. OCR の抽出項目を分ける：税抜小計・消費税額・税込合計
   - 金額欄の初期値は**税抜**にする
   - 税抜が読み取れないときは推測で割り戻さず、空欄にして人間に入力してもらう
2. 金額入力欄に「税抜」と明記する（手動登録も同じ）
3. 既存の請求書の行の扱い（**データは変更しない**）
   - OCR 由来（`source = 'ocr'`）の行は税込で入っている可能性が高い。
     ただし行ごとの税区分はデータから判別できないため、件数を数えて人間に報告するところまでとする
   - 修正するか、どう修正するかは人間が決める
4. 先方の Excel と同じ案件で突き合わせ、actual_cost が「請求実績」と一致することを確かめる
   （テストは本番以外のデータで行う）

## 未解決のリスク

- 本番の `cost_ledger_invoices` の定義・RLS はリポジトリから確認できない。テストは代用の定義で行った。
  適用前の確認 SQL で必ず確かめる
- 本番の `supabase_migrations.schema_migrations` の列構成も代用の定義でテストした。
  適用前の確認 8 で、必須列が version だけであることを確かめる
- PR #32 までは RPC を通らない書き込みが残るため、同時実行の保証は RPC どうしに限られる。
  さらに RLS 上、アプリを経由しない直接の UPDATE も可能（PR #32 の 2 を参照）
- 最後の請求書を削除すると actual_cost は NULL になり、登録前の見積原価の初期値には戻らない（現行と同じ仕様）
- 既存の不整合（actual_cost ≠ 内訳合計）は migration では直さない。その台帳項目に次に RPC が書き込んだ時点で揃う
- OCR で登録された既存の請求書は、税込で入っている可能性がある（PR #32 の 3 を参照）
