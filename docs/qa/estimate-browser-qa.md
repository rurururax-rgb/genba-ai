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

## 標準チェック（毎回実施）

### 1. html lang / translate / 自動翻訳 / 拡張機能の干渉

- `document.documentElement.lang === 'ja'` かつ `getAttribute('translate') === 'no'`
- `<meta name="google" content="notranslate">` が存在する
- `document.documentElement.className` に `translated-` が含まれない
- `document.querySelectorAll('font').length === 0`（翻訳・拡張機能による DOM 置換がない）
- 拡張機能（翻訳・辞書・パスワード管理等）が DOM に要素や属性を挿入していないか。
  疑わしい場合はシークレットウィンドウ（拡張機能なし）で同じ表示になるか比較する

翻訳・拡張機能で置換されたテキストノードには React の更新が届かず、
「保存したのに表示が古いまま」に見える（再読み込みで直る）ため、表示不整合の調査では最初に確認する。

### 2. DOM 表示と React state（データ）の一致

- 操作後、画面に表示されている値と、保存先（Fixture の sessionStorage / 実データは REST GET）の値を
  スクリプトで突き合わせる（見た目の目視だけで PASS にしない）
- 対象：数量・単位・単価・金額・定価・備考・業者名・原価・粗利率・案件標準・見積全体の粗利率・小計
- 再読み込み後にも同じ突合を行い、保存 → 再取得 → 表示が一致することを確認する
- `NaN` / `Infinity` / `undefined` / `null` が画面文字列に含まれないこと

### 3. モード解除時の UI state の一致

モード（合計モード・選択・Popover・ダイアログ等）は、解除経路ごとに
「state」「選択の中身」「ボタンの active 表示」「付随 UI の表示」がすべて同じ状態に戻ることを確認する。

- 解除経路をすべて試す：トグルボタン再押下 / ✕ ボタン / Esc / 背景クリック
- 解除後にボタンが非 active 表示に戻る（色だけでなく、もう一度押すと「開始」になること）
- 解除後に再開したとき、前回の選択が残っていない
- 例：合計モード … ON → セル選択 → 右下 ✕ → 「∑ 合計」ボタンが非 active・合計バー非表示
  → 再度押すと新しい合計モードが 0 セルから開始
