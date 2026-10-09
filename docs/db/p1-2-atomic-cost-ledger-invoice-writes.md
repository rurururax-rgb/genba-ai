# P1-2: 業者請求書と実績原価（actual_cost）のアトミック更新基盤

migration: `supabase/migrations/20261010000002_atomic_cost_ledger_invoice_writes.sql`

> **この PR では本番に適用しない。** 適用は人間の明示的な承認のあと、Supabase SQL Editor で手動実行する
> （`supabase db push` は使わない）。アプリ側（API）の切り替えは PR #32 で行う。

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
```

確認すること:

- `amount` が numeric であること（それ以外の型でも動くが、丸めの扱いを人間が判断する）
- 請求書の UPDATE / DELETE を許すポリシーがあること（無ければ現行 API と同じく関数でも書けない）
- 請求書のポリシーで「自社の請求書の一部が見えない」状態になっていないこと。
  見えない行は SUM にも含まれない（現行 API と同じ）

## 適用（人間の承認後のみ）

1. 上の確認 SQL の結果を人間が確認
2. Supabase SQL Editor で migration ファイルの内容をそのまま実行（1 トランザクションで実行される）
3. 下の適用後の確認 SQL を実行

migration は既存の行を書き換えない（関数・権限・コメントを作るだけ）。

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

## ロールバック

PR #32（アプリの切り替え）を本番に出した後なら、**先にアプリを PR #32 より前に戻してから**関数を消す。

```sql
DROP FUNCTION IF EXISTS public.cost_ledger_invoice_insert(uuid, numeric, date, date, text, text, text, text, text, uuid);
DROP FUNCTION IF EXISTS public.cost_ledger_invoice_update(uuid, jsonb);
DROP FUNCTION IF EXISTS public.cost_ledger_invoice_delete(uuid);
```

関数を消すだけで、テーブル・データ・RLS・一意インデックスは残る（テストで確認）。

## テスト

```bash
npm run test:db
```

- 一時ディレクトリに使い捨ての PostgreSQL 17（embedded-postgres）を 127.0.0.1 で起動し、
  Supabase の最小限（ロール、`auth.uid()`、`get_my_company_ids()`、RLS）を再現した上で、
  リポジトリの実際の migration（台帳項目 → 請求書の代用定義 → P1-1 → P1-2）を順に適用する
- 本番・Preview の DB には接続しない
- 同時実行のテストは複数の独立した接続で実際にトランザクションを重ね、
  `pg_stat_activity.wait_event_type = 'Lock'` で本当にロック待ちになっていることを確かめる
- `npm test`（CI の Quality Gate）には含めていない

## PR #32 で必要な変更

1. `POST /api/cost-ledger/[id]/invoices`、`PATCH` / `DELETE /api/cost-ledger/invoices/[invoiceId]` を
   `supabase.rpc('cost_ledger_invoice_insert' | '…_update' | '…_delete')` に切り替え、
   `recalcActualCost` / `syncActualCost` の呼び出しをやめる。idempotency の再送（23505 → 既存行を返す）は API 側に残す
2. SQLSTATE → HTTP の変換（上の表）。`error.message` をクライアントに返さない
3. **actual_cost の直接編集**
   - 直接入力の機能は残す（請求書 0 件の台帳項目では、見積原価の初期値・手入力値として使う）
   - 請求書が 1 件以上ある台帳項目では、`PATCH /api/cost-ledger/[id]` と AI チャットの confirm-change で
     actual_cost の変更を 409 で拒否する（請求書の合計が正）。ロックを取って件数を確かめるため、
     小さな RPC（台帳項目をロックし、請求書 0 件のときだけ actual_cost を設定する）を追加するのが安全
   - CostLedgerTab は請求書を開いたときに初めて読み込むため、開いていない行では請求書があっても
     actual_cost を編集できてしまう。一覧の取得時に請求書の件数を返し、それで読み取り専用にする
4. init（actual_cost = 見積原価）・sync（新規行は NULL）・台帳項目の作成（NULL）は請求書 0 件の行にしか
   書かないため変更不要（init は既存行を作り直さないことを PR #32 で再確認する）

## 未解決のリスク

- 本番の `cost_ledger_invoices` の定義・RLS はリポジトリから確認できない。テストは代用の定義で行った。
  適用前の確認 SQL で必ず確かめる
- PR #32 までは RPC を通らない書き込みが残るため、同時実行の保証は RPC どうしに限られる
- 最後の請求書を削除すると actual_cost は NULL になり、登録前の見積原価の初期値には戻らない（現行と同じ仕様）
- 既存の不整合（actual_cost ≠ 内訳合計）は migration では直さない。その台帳項目に次に RPC が書き込んだ時点で揃う
