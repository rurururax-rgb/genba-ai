# 既知の課題・技術的負債

Claude Code が実装中に発見した既知の問題を記録するファイル。
解決時はその旨を追記してからチェックを外すこと。

---

## 未解決

### KI-001: 未振り分けLINEイベントを「見積に追加」してもproject_idが更新されない

**発見日:** 2026-07-11  
**関連ファイル:** `app/api/estimate-items/route.ts`, `components/projects/AiMemoPanel.tsx`

**問題の内容:**  
`line_events.project_id` が NULL（未振り分け）の音声・写真イベントに対して
「見積に追加」を実行した場合、`estimate_items.project_id` は現在表示中の案件に
正しく設定されるが、`line_events.project_id` は NULL のまま更新されない。

「この LINE 音声はどの案件の現調で録音したものか」というトレーサビリティが失われる。
1案件・1ユーザーのデモ段階では実害がないが、複数案件を並行して扱うようになると
「見積に追加済みなのにどの案件か分からない」状態が生じる。

**再現手順:**  
1. LINE で音声を送信（project_id = NULL のまま受信）  
2. `/projects/[id]` の AI整理タブを開く  
3. 未振り分けセクションの候補チップを選択して「見積に追加」  
4. `line_events` テーブルを確認 → `project_id` が NULL のまま  

**対応方法（未実施）:**  
`app/api/estimate-items/route.ts` の INSERT 後に以下を追加する：

```typescript
// 見積追加と同時に未振り分けイベントの project_id を確定させる
await supabase
  .from('line_events')
  .update({ project_id })
  .eq('id', line_event_id)
  .is('project_id', null)   // 既に振り分け済みの行は上書きしない
```

**対応優先度:** 複数案件を並行して扱い始めるタイミングまでに対応必須。

---

## 解決済み

（なし）
