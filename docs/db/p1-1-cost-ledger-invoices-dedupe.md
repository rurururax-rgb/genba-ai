# P1-1 cost_ledger_invoices 二重登録防止 — migration 適用手順

対象 migration: `supabase/migrations/20261010000001_add_dedupe_keys_to_cost_ledger_invoices.sql`

- この migration は **CI でも merge でも自動適用されない**（`.github/workflows/ci.yml` は typecheck / lint / test / build のみ。リポジトリに `supabase/config.toml` なし）。
- 本番への適用は **人間の承認後**、Supabase SQL Editor で行う。
- 適用後もアプリは新しい列を使わない（後方互換）。新しい列を使うのは後続のアプリ PR #30。
- 以下の SQL はすべて業務データの中身を読まない（件数・構造のみ）。

---

## 1. 適用前の確認（読み取りのみ）

```sql
-- 1-a. 列（追加予定の5列が存在しないこと）
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'cost_ledger_invoices'
order by ordinal_position;

-- 1-b. 制約（PK と FK のみで、追加予定と同名の制約がないこと）
select conname, contype, pg_get_constraintdef(oid)
from pg_constraint
where conrelid = 'public.cost_ledger_invoices'::regclass
order by conname;

-- 1-c. インデックス（追加予定と同名のインデックスがないこと）
select indexname, indexdef from pg_indexes
where schemaname = 'public' and tablename = 'cost_ledger_invoices'
order by indexname;

-- 1-d. RLS とポリシー（適用後と比較するため結果を保存しておく）
select relrowsecurity, relforcerowsecurity from pg_class
where oid = 'public.cost_ledger_invoices'::regclass;
select policyname, cmd, roles, qual, with_check from pg_policies
where schemaname = 'public' and tablename = 'cost_ledger_invoices'
order by policyname;

-- 1-e. trigger（なしのはず）
select tgname from pg_trigger
where tgrelid = 'public.cost_ledger_invoices'::regclass and not tgisinternal;

-- 1-f. 件数（適用後と比較する）
select count(*) as total, count(project_id) as with_project_id
from cost_ledger_invoices;
```

## 2. 適用

上記 migration ファイルの内容を SQL Editor でそのまま実行する。

- 既存行の更新・削除はない。既存行の新しい列は NULL のため、CHECK はすべて満たし、部分一意インデックスの対象にもならない。
  - そのため **既存の重複行があっても適用は失敗しない**（既存の重複は残る。整理は別途、人間が判断する）。
- `CREATE UNIQUE INDEX` は作成中その表への書き込みを短時間止める（`CONCURRENTLY` は SQL Editor のトランザクション内で使えないため使わない）。行数が少ない表なので影響は小さいが、利用の少ない時間に実行する。

## 3. 適用後の確認（読み取りのみ）

```sql
-- 3-a. 5列が NULL 許容で追加されている
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'cost_ledger_invoices'
  and column_name in ('source','vendor_name','invoice_number','document_sha256','idempotency_key')
order by column_name;
-- 期待: 5行、すべて is_nullable = YES。idempotency_key は uuid、他は text

-- 3-b. CHECK 制約4本
select conname, pg_get_constraintdef(oid)
from pg_constraint
where conrelid = 'public.cost_ledger_invoices'::regclass and contype = 'c'
order by conname;
-- 期待: cost_ledger_invoices_ocr_keys_check / _sha256_format_check / _sha256_source_check / _source_check

-- 3-c. 部分一意インデックス2本（既存インデックスも残っている）
select indexname, indexdef from pg_indexes
where schemaname = 'public' and tablename = 'cost_ledger_invoices'
order by indexname;
-- 期待: cost_ledger_invoices_idempotency_key_uq / cost_ledger_invoices_project_sha256_ocr_uq が追加、1-c の行もすべて残る

-- 3-d. RLS とポリシーが 1-d と同じ
select relrowsecurity, relforcerowsecurity from pg_class
where oid = 'public.cost_ledger_invoices'::regclass;
select policyname, cmd, roles, qual, with_check from pg_policies
where schemaname = 'public' and tablename = 'cost_ledger_invoices'
order by policyname;

-- 3-e. 件数が 1-f と同じで、既存行の新しい列はすべて NULL
select count(*) as total, count(project_id) as with_project_id,
       count(*) filter (where source is not null or vendor_name is not null or invoice_number is not null
                          or document_sha256 is not null or idempotency_key is not null) as with_new_values
from cost_ledger_invoices;
-- 期待: total / with_project_id は 1-f と同じ、with_new_values = 0
```

## 4. ロールバック

アプリ PR #30 を本番に出した後に戻す場合は、**先にアプリを戻してから** 実行する（アプリが新しい列に書き込んでいる間に列を消すと登録が失敗する）。

```sql
DROP INDEX IF EXISTS cost_ledger_invoices_idempotency_key_uq;
DROP INDEX IF EXISTS cost_ledger_invoices_project_sha256_ocr_uq;
ALTER TABLE cost_ledger_invoices
  DROP CONSTRAINT IF EXISTS cost_ledger_invoices_sha256_format_check,
  DROP CONSTRAINT IF EXISTS cost_ledger_invoices_sha256_source_check,
  DROP CONSTRAINT IF EXISTS cost_ledger_invoices_ocr_keys_check,
  DROP CONSTRAINT IF EXISTS cost_ledger_invoices_source_check;
ALTER TABLE cost_ledger_invoices
  DROP COLUMN IF EXISTS idempotency_key,
  DROP COLUMN IF EXISTS document_sha256,
  DROP COLUMN IF EXISTS invoice_number,
  DROP COLUMN IF EXISTS vendor_name,
  DROP COLUMN IF EXISTS source;
```

- 消えるのはこの migration で追加した列・制約・インデックスだけ。既存の列・行・インデックス・RLS は変わらない。
- PR #30 適用後に戻すと、OCR 登録で保存した `source` / `vendor_name` / `invoice_number` / `document_sha256` / `idempotency_key` の値は失われる（金額・日付・備考などの既存列は残る）。
- 一意制約だけを外したい場合は、`DROP INDEX` の2行だけを実行する。

## 5. この制約で防げないもの

- 再スキャン・撮り直し・PDF 変換・圧縮など、画像のバイト列が変わった同じ請求書（別ハッシュになる）
- 手動登録（`source = 'manual'`）と既存行（`source IS NULL`）の内容の重複（手動は分割請求・同額請求を許すため対象外。再送は `idempotency_key` で防ぐ）
- 別案件に誤って登録した同じ請求書（別案件は許可する仕様）
- `project_id` が親 `cost_ledger_items.project_id` と食い違う行
  - CHECK 制約は他テーブルを参照できないため DB では保証できない。後続 API が親台帳項目から `project_id` を取得して保存する
- アプリが `idempotency_key` を再試行ごとに作り直した場合の再送（キーの使い回しはアプリ側の責任）
