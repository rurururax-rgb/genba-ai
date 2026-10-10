# P1-4: 業者請求書テーブルへの直接書き込みを禁止する（未適用）

migration: `supabase/migrations/20261012000001_restrict_cost_ledger_invoice_writes.sql`

**状態: 本番未適用。適用は人間の承認後に行う。** 前提: P1-2（20261010000002）・P1-3（20261011000001）が適用済み。
アプリのコード変更は無い（アプリは既に請求書の書き込みをすべて RPC で行っている）。

## 抜け道と原因

P1-2 の RPC（`cost_ledger_invoice_insert / update / delete`）は SECURITY INVOKER のため、
呼び出すユーザー（authenticated）自身に `cost_ledger_invoices` の INSERT / UPDATE / DELETE 権限が必要だった。
Supabase は public のテーブルに anon・authenticated・service_role へ既定で ALL を付与するので、
ログイン済みユーザーは PostgREST（`/rest/v1/cost_ledger_invoices`）から RPC を通らずに自社の請求書を
直接追加・変更・削除できた。親の actual_cost は更新されないため、請求書の合計とずれる
（P1-3 のトリガーは cost_ledger_items 側の UPDATE だけを見るので、この経路は止められない）。

| 書き込み | 適用前 | 適用後 |
|---|---|---|
| 画面・API からの請求書の登録・編集・削除（RPC） | 可 | 可（引数・戻り値・エラーは同じ） |
| PostgREST からの `cost_ledger_invoices` 直接 INSERT / UPDATE / DELETE（authenticated） | **可（合計とずれる）** | 42501 で拒否 |
| 同上（anon） | RLS で 0 行（権限はある） | 42501 で拒否 |
| `cost_ledger_items.actual_cost` の直接変更（請求書あり） | P1-3 で拒否 | 同左 |
| `cost_ledger_items.actual_cost` の直接入力（請求書 0 件） | 可 | 可（変わらない） |
| 請求書の読み取り（一覧・内訳・件数） | RLS で自社分 | 同左（SELECT 権限・RLS は変えない） |
| service_role（サーバー専用キー）からの直接書き込み | 可 | **可（対象外。下記「残るリスク」）** |

## 設計

1. **直接の書き込み権限を取り消す。** `cost_ledger_invoices` の INSERT / UPDATE / DELETE / TRUNCATE を
   PUBLIC・anon・authenticated から REVOKE する（テーブル単位の REVOKE は列単位の権限も取り消す）。
   「RPC を通ったか」をセッション変数やフラグで判定する方式は、ユーザーが同じ値を設定できるため採らない。
2. **RPC を SECURITY DEFINER にする。** 書き込み権限が無いユーザーでも RPC だけは書ける。
   関数の中身は P1-2 と同じ（入力の検証・二重登録防止・ロック順・戻り値・エラーコード）で、
   違いは親の台帳項目をロックする 3 箇所に次の条件を足したことだけ:

   ```sql
   AND p.company_id = ci.company_id
   AND EXISTS (SELECT 1 FROM public.company_members m
               WHERE m.company_id = ci.company_id AND m.user_id = auth.uid())
   ```

### SECURITY DEFINER で他社のデータに届かない理由

DEFINER 関数は所有者の権限で動き、RLS が効かない。そのため所属の確認を関数の中で明示する。

- `auth.uid()` は PostgREST が検証した JWT の `sub`。RLS ポリシーと同じ根拠で、利用者が書き換えられない。
  無ければ CL401。
- 登録・編集・削除のどれも、**最初に親の台帳項目をロックする時点で**次の 4 条件をすべて確かめる。
  1 つでも外れれば何も書かずに CL404。
  - 台帳項目が未削除
  - 案件が未削除
  - 案件の会社 = 台帳項目の会社
  - 呼び出したユーザーがその会社のメンバー
- 編集・削除は請求書 ID から親を引くが、この段階で返すのは CL404 だけ。
  他社の請求書・存在しない請求書・削除済みの区別はつかない。
- ロック後に、請求書の cost_ledger_item_id / project_id が親と一致することを確かめる。
  食い違えば CL409（P1-2 と同じ）。
- company_id・project_id はリクエストから受け取らない（project_id はロックした親から入れる）。
  `p_patch` で変更できるのは amount / invoice_date / payment_date / note だけで、他のキーは CL400。
- 戻り値は自分が書いた 1 行と、親の合計・件数だけ。
- `search_path = ''` に固定し、すべて schema 修飾で参照する。一時テーブルで同名の表を作っても影響しない（テストで確認）。
- EXECUTE は authenticated のみ。PUBLIC・anon・service_role には付けない。

隔離 DB のテストは、関数の所有者を 2 通りにして行っている。

- superuser（RLS も権限も素通り）。所有者にかかわらず、関数内の確認だけで分離できていることを確かめる。
- 必要な権限だけを持つ一般ロール（superuser でも BYPASSRLS でもない）。
  この所有者でも登録・編集・削除と他社分離が動くことを確かめる。
  さらに、権限を 1 つ欠かした所有者では、適用スクリプトが全体を取り消して止まることを確かめる。

### 同時実行・P1-3

- ロック順は P1-2 と同じ（親の台帳項目 `FOR UPDATE` → 請求書 `FOR UPDATE`）。lock_timeout は 5s。
- P1-3 のトリガーはそのまま動く。RPC は常に合計を書くので通る。
- 適用（CREATE OR REPLACE FUNCTION・GRANT / REVOKE）はテーブルロックを取らない。
  別の接続が ACCESS EXCLUSIVE でロックしていても適用は完了する（テストで確認）。
  実行中の RPC は旧定義のまま最後まで動く。

## 適用後の権限

| 対象 | PUBLIC | anon | authenticated | service_role |
|---|---|---|---|---|
| `cost_ledger_invoices` SELECT | – | 可（RLS で 0 行） | 可（RLS で自社分） | 可（RLS 回避） |
| `cost_ledger_invoices` INSERT / UPDATE / DELETE / TRUNCATE | 不可 | **不可** | **不可** | 可（変えない） |
| RPC 3 つの EXECUTE | 不可 | 不可 | 可 | 不可 |
| `cost_ledger_items` | 変えない | 変えない | 変えない | 変えない |

RLS ポリシーは変えない。REFERENCES / TRIGGER 権限も変えない（書き込みには使えない）。

## 検証（隔離 DB）

`npm run test:db` を実行する。`__tests__/db/restrict-invoice-writes.db.test.ts` は、ローカルの使い捨て
PostgreSQL に P1-1 → P1-2 → P1-3 → P1-4 を適用し、実際のロールに `SET ROLE` して次を確かめる
（本番・Preview には接続しない）。

- 直接の書き込み
  - authenticated と anon の直接 INSERT / UPDATE / DELETE / TRUNCATE は 42501 で拒否される。
  - 列単位の権限も残っていない。
- 自社の請求書
  - RPC で登録・編集・削除できる。
  - 戻り値の形は P1-2 と同じ。
  - actual_cost は請求書の合計と一致する。
- 他社データの分離
  - 他社の請求書・他社の台帳項目への操作は CL404 で拒否され、存在するかどうかも区別できない。
  - 所属の無いユーザー、所属を外されたユーザー、会社が食い違う行も拒否される。
  - 削除済みの案件・台帳項目への操作は CL404。
  - 未認証は CL401。
  - anon と service_role は RPC を実行できない。
  - 一時テーブルで同名の表を作っても関数には影響しない。
- 二重登録の防止
  - idempotency_key の再送、同じ OCR 画像の再登録は 23505。
  - 2 本の接続から同時に送っても 1 件だけ登録される。
- 同時実行
  - 親行ロックの待ち合わせが起きる。
  - 8 本の接続から登録・編集・削除を混ぜても、actual_cost = 合計になる。
- P1-3 との組み合わせ
  - 請求書がある項目の不正な値は CL423。
  - 請求書 0 件の項目は直接入力できる。
- 読み取り
  - 一覧・内訳・件数・keyset ページングが従来どおり動く。
- migration 自体
  - P1-3 が未適用なら何も変えずに止まる。
  - 2 回適用しても同じ状態になる。
  - RLS ポリシーと既存データは変わらない。
- SQL Editor 用スクリプト
  - 本体が migration ファイルと一致する。
  - 成功時は全部そろって確定する。
  - 二重適用、前提不足、想定外の権限のときはガードで止まる。
  - 最後の履歴登録で失敗すると全体が取り消される。
  - ロールバックで関数と権限が適用前と完全に一致し、その後もう一度適用できる。

## 本番への適用手順（Supabase SQL Editor・人間が実行する）

`supabase db push` は使わない。P1-2・P1-3 と同じく SQL Editor 専用のスクリプトで適用する。

| ファイル | 内容 |
|---|---|
| `docs/db/p1-4-sql-editor-apply.sql` | ガード → migration 本体 → 検証 → 履歴登録 を 1 トランザクション（BEGIN / COMMIT）で実行 |
| `docs/db/p1-4-sql-editor-rollback.sql` | P1-2 の関数定義に戻す → 取り消した権限を付け直す → 履歴 1 行の削除 を 1 トランザクションで実行 |

適用スクリプトの `-- >>> MIGRATION BODY` 〜 `-- <<< MIGRATION BODY` は migration ファイルと、
ロールバックの `-- >>> P1-2 MIGRATION BODY` 〜 `-- <<< P1-2 MIGRATION BODY` は P1-2 の migration ファイルと
1 文字も違わないことを `npm run test:db` で照合している。

### 0. バックアップ（適用直前・人間が実行する）

P1-3 のときと同じ形式の読み取り専用スクリプト（`rugz-backup-pre-p14.sh`。PR とは別に渡す）を
ターミナル.app で実行する。public スキーマ・migration 履歴のダンプに加えて、請求書テーブル・RPC の権限を
`invoice_privileges.txt` に記録する。「バックアップ完了」と表示された場合だけ次へ進む。

### 1. 適用前の確認（読み取りのみ）

```sql
-- 期待値: p13_history = 1, p14_history = 0, rpc_count = 3, rpc_definer = 0
SELECT
  (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '20261011000001') AS p13_history,
  (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '20261012000001') AS p14_history,
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname IN ('cost_ledger_invoice_insert', 'cost_ledger_invoice_update', 'cost_ledger_invoice_delete')) AS rpc_count,
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname IN ('cost_ledger_invoice_insert', 'cost_ledger_invoice_update', 'cost_ledger_invoice_delete')
       AND p.prosecdef) AS rpc_definer;

-- 請求書テーブルの権限（期待値: anon・authenticated がそれぞれ DELETE / INSERT / TRUNCATE / UPDATE を持つ。
-- PUBLIC の書き込み権限は無い）。違う場合は適用スクリプトのガードが止まる
SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS grantee, a.privilege_type
FROM pg_class t, aclexplode(coalesce(t.relacl, acldefault('r', t.relowner))) a
WHERE t.oid = 'public.cost_ledger_invoices'::regclass
ORDER BY 1, 2;

-- 列単位の権限（期待値: 0 行）
SELECT attname, attacl FROM pg_attribute
WHERE attrelid = 'public.cost_ledger_invoices'::regclass AND attacl IS NOT NULL;

-- RLS ポリシー（参考。適用で変わらないことを後で比べるため記録しておく）
SELECT tablename, policyname, cmd, roles::text, qual, with_check FROM pg_policies
WHERE schemaname = 'public' AND tablename IN ('cost_ledger_invoices', 'cost_ledger_items') ORDER BY 1, 2;

-- 3つの RPC それぞれの所有者が、本体で使う権限を 1 つずつすべて持つこと
-- 期待値: 0 行（1 行でも出たら適用しない。適用スクリプトの検証も同じ条件で全体を取り消す）
-- ※ has_table_privilege に 'SELECT, INSERT' のように複数を渡すと「どれか 1 つ」で true になるので、必ず 1 権限ずつ確かめる
--   FOR UPDATE（行ロック）には UPDATE 権限が要る
-- ※ RPC が 3 つ揃っていないと行が出ないため、上の rpc_count = 3 と合わせて判断する
SELECT req.sig, pg_get_userbyid(f.proowner) AS owner, req.obj, req.priv
FROM (
  SELECT fn.sig, 'table' AS kind, 'public.cost_ledger_invoices' AS obj, unnest(fn.invoice_privs) AS priv
  FROM (VALUES
    ('public.cost_ledger_invoice_insert(uuid, numeric, date, date, text, text, text, text, text, uuid)', ARRAY['SELECT', 'INSERT']),
    ('public.cost_ledger_invoice_update(uuid, jsonb)', ARRAY['SELECT', 'UPDATE']),
    ('public.cost_ledger_invoice_delete(uuid)', ARRAY['SELECT', 'UPDATE', 'DELETE'])
  ) AS fn(sig, invoice_privs)
  UNION ALL
  SELECT fn.sig, c.kind, c.obj, c.priv
  FROM (VALUES
    ('public.cost_ledger_invoice_insert(uuid, numeric, date, date, text, text, text, text, text, uuid)'),
    ('public.cost_ledger_invoice_update(uuid, jsonb)'),
    ('public.cost_ledger_invoice_delete(uuid)')
  ) AS fn(sig),
  (VALUES
    ('table', 'public.cost_ledger_items', 'SELECT'),
    ('table', 'public.cost_ledger_items', 'UPDATE'),
    ('table', 'public.projects', 'SELECT'),
    ('table', 'public.company_members', 'SELECT'),
    ('schema', 'public', 'USAGE'),
    ('schema', 'auth', 'USAGE'),
    ('function', 'auth.uid()', 'EXECUTE')
  ) AS c(kind, obj, priv)
) AS req
JOIN pg_proc f ON f.oid = to_regprocedure(req.sig)
WHERE NOT CASE req.kind
  WHEN 'table'  THEN has_table_privilege(f.proowner, req.obj, req.priv)
  WHEN 'schema' THEN has_schema_privilege(f.proowner, req.obj, req.priv)
  ELSE               has_function_privilege(f.proowner, req.obj, req.priv)
END
ORDER BY 1, 3, 4;

-- 参考: RPC の所有者（3 つとも記録しておく）
SELECT p.oid::regprocedure AS fn, pg_get_userbyid(p.proowner) AS owner
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname IN ('cost_ledger_invoice_insert', 'cost_ledger_invoice_update', 'cost_ledger_invoice_delete')
ORDER BY 1;

-- 参考: 請求書があるのに actual_cost が合計と違う既存行（適用しても修正されない。P1-3 適用後は 0 件の想定）
SELECT count(*) FROM public.cost_ledger_items i
WHERE i.deleted_at IS NULL
  AND EXISTS (SELECT 1 FROM public.cost_ledger_invoices v WHERE v.cost_ledger_item_id = i.id)
  AND i.actual_cost IS DISTINCT FROM
      (SELECT sum(v.amount) FROM public.cost_ledger_invoices v WHERE v.cost_ledger_item_id = i.id);
```

期待値と違う場合は適用しない。

### 2. 適用

`p1-4-sql-editor-apply.sql` の全文を貼り付けて 1 回だけ実行する。

- 最後の結果が `history_rows = 1, definer_rpcs = 3, direct_write_roles = 0` なら完了。
- エラーが出たら、続けて `ROLLBACK;` だけを実行する。トランザクション全体が取り消され、
  関数の変更・権限の取り消し・履歴のどれも残らない（部分適用にならない）。
- 次の場合はガードで止まる（`P1-4 apply aborted: ...`）。
  - 履歴テーブルが無い。
  - 20261012000001 が登録済み（二重適用）。
  - P1-2 または P1-3 が未登録。
  - RPC が履歴なしで既に SECURITY DEFINER になっている。
  - 請求書テーブルの権限が Supabase の既定と違う。次のどれかに当てはまる場合で、ロールバックで正確に戻せないため止める。
    - anon または authenticated に書き込み権限が欠けている。
    - PUBLIC に書き込み権限がある。
    - 列単位の権限がある。
- 次の場合はトランザクション内の検証で止まる（`P1-4 verify failed: ...`）。
  - 関数の設定が想定と違う。対象は SECURITY DEFINER、`search_path`、lock_timeout、所属確認の有無。
  - EXECUTE 権限が想定と違う。
  - 書き込み権限が残っている。
  - authenticated が SELECT できない。
  - 3 つの RPC のどれかの所有者に、本体で使う権限が 1 つでも欠けている。
    権限は 1 つずつ確かめる。欠けたものは「関数・所有者・権限・対象」の形ですべてエラーに並べる。
    対象は次のとおり。
    - `cost_ledger_invoices`: SELECT。登録は INSERT、編集は UPDATE、削除は UPDATE と DELETE も
    - `cost_ledger_items`: SELECT と UPDATE
    - `projects`・`company_members`: SELECT
    - schema `public`・`auth`: USAGE
    - `auth.uid()`: EXECUTE
  - P1-3 のトリガーが無効。

### 3. 適用後の確認（読み取りのみ）

```sql
-- 期待値: 3 行とも prosecdef = true, proconfig = {search_path="",lock_timeout=5s},
--         public/anon/service_role = false, authenticated = true
SELECT p.proname, p.prosecdef, p.proconfig,
       has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
       has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_exec,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname LIKE 'cost_ledger_invoice\_%' ORDER BY 1;

-- 期待値: anon / authenticated / public は write = false, col_write = false。authenticated は read = true。
--         service_role は write = true（変えていない）
SELECT r,
       has_table_privilege(r, 'public.cost_ledger_invoices', 'INSERT, UPDATE, DELETE, TRUNCATE') AS write,
       has_any_column_privilege(r, 'public.cost_ledger_invoices', 'INSERT')
         OR has_any_column_privilege(r, 'public.cost_ledger_invoices', 'UPDATE') AS col_write,
       has_table_privilege(r, 'public.cost_ledger_invoices', 'SELECT') AS read
FROM unnest(ARRAY['public', 'anon', 'authenticated', 'service_role']) r ORDER BY 1;

-- 期待値: 1 / 1（P1-3 のトリガーが有効のまま）
SELECT (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '20261012000001') AS p14_history,
       (SELECT count(*) FROM pg_trigger WHERE tgname = 'cost_ledger_items_lock_actual_cost' AND tgenabled = 'O') AS p13_trigger;
```

RLS ポリシーと不整合行の件数は、手順 1 と同じ SELECT で変わっていないことを確かめる。
画面での確認は、請求書の登録・編集・削除を 1 件ずつ行い、実績原価が内訳の合計になることを見る。
本番データへの書き込みになるため、確認用の案件で人間が行う。

## ロールバック

`p1-4-sql-editor-rollback.sql` の全文を SQL Editor で実行する（人間の承認後）。

- 1 トランザクションで次を行う。
  - 3 つの RPC を P1-2 の定義（SECURITY INVOKER）に戻す。
  - anon・authenticated に INSERT / UPDATE / DELETE / TRUNCATE を付け直す。
  - migration 履歴（20261012000001 の 1 行だけ）を削除する。
- 最後の結果が `history_rows = 0, definer_rpcs = 0, direct_write_roles = 2` なら完了。
  エラー時は `ROLLBACK;` だけを実行する。
- テーブル・業務データ・RLS・P1-3 のトリガーには触れない。
  ロールバック後の関数定義・テーブルの権限は適用前と完全に一致する（`npm run test:db` で確認）。
- 何も適用されていなければ `P1-4 rollback aborted: nothing to roll back ...` で止まる。
- ロールバックすると、上の表の「適用前」（PostgREST から直接書き込める状態）に戻る。
  アプリはどちらの状態でも動く。

## 残るリスク（この migration の対象外）

- **service_role** は請求書テーブルに直接書き込める（RLS も回避する）。
  - キーはサーバー専用（`lib/supabase/admin.ts` と承認済みの 4 箇所のみ）で、請求書の書き込みには使っていない。
  - 将来 service_role で請求書を書く処理を追加する場合も、RPC と同じ合計の更新が必要。
- **テーブル所有者（postgres）** は直接書き込める。トリガーの無効化もできる（SQL Editor の利用者）。
- `cost_ledger_items.project_id` を自社の別案件に付け替えることは従来どおりできる。
  付け替えた項目の請求書は、以後 RPC で編集・削除すると CL409 になる。
  合計のずれは起きないが、操作できなくなる（既存の挙動で、P1-4 では変えない）。
- 本番の `cost_ledger_invoices` の元の定義・RLS ポリシーはリポジトリに無い。
  適用前の確認とガードで権限の状態を確かめているが、ポリシーの内容は手順 1 の SELECT で人間が確認する。
- idempotency_key の一意インデックスは P1-1 のまま全社共通。
  他社と衝突した場合は 23505 になるだけで、他社の行は返さない（UUID v4 のため実際には起きない）。
