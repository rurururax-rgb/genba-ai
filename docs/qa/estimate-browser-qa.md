# EstimateTab Browser QA 手順

## 前提（重要）

localhost の `.env.local` は **本番と同じ Supabase プロジェクト** を向いている。
実案件ページ（`/projects/[id]`）で値を編集・保存する Browser QA は **禁止**。
「変更して後で戻す」方式も禁止（戻し漏れ・他ユーザーの操作との競合が起きる）。

## 書き込みを伴う QA：Fixture ページを使う

```
npm run dev
open http://localhost:3000/qa/estimate
```

- 開発環境のみ有効（本番ビルドでは 404）
- `window.fetch` を差し替え、EstimateTab の Supabase REST / `/api/*` 呼び出しを
  sessionStorage 上の Fixture で応答する（`lib/qa/estimate-fixture-backend.ts`）
- 未対応の呼び出しは実サーバーへ送らず 403 でブロックし、`console.warn` に記録する
- 「初期データに戻す」ボタンでシナリオ用の初期データに戻る
- reload しても sessionStorage の値が残るため、保存 → 再読込の一致確認ができる

確認項目：DevTools の Network に `supabase.co/rest` と `/api/` へのリクエストが 0 件であること。

## 実データでの QA（読み取りのみ）

実案件ページでは **表示の確認だけ** 行う（セルをクリックして編集しない）。
DOM 表示値と DB 値（REST GET）の突合は読み取りのみで実施する。

## 表示崩れの確認

`<html lang="ja" translate="no">` のため Chrome の自動翻訳は動作しない。
もし「32万」「炭水化物」のような表記が見えたら、まず翻訳が有効になっていないかを確認する
（`document.documentElement.className` に `translated-` が含まれる／`<font>` 要素が挿入される）。
