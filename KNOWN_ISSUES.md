# 既知の課題・技術的負債

Claude Code が実装中に発見した既知の問題を記録するファイル。
解決時はその旨を追記してからチェックを外すこと。

---

## 未解決

（なし）

---

## 解決済み

### ✅ KI-001: 未振り分けLINEイベントを「見積に追加」してもproject_idが更新されない

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

**当初の対応案（採用せず）:**  
`app/api/estimate-items/route.ts` の INSERT 後に以下を追加する案。
見積の追加と紐付けが別リクエストになり、片方だけ成功する状態が残るため採用しなかった：

```typescript
// 見積追加と同時に未振り分けイベントの project_id を確定させる
await supabase
  .from('line_events')
  .update({ project_id })
  .eq('id', line_event_id)
  .is('project_id', null)   // 既に振り分け済みの行は上書きしない
```

**対応優先度:** 複数案件を並行して扱い始めるタイミングまでに対応必須。

**解決（ブランチ `fix/ki-001-line-event-project-link`）:**  
- RPC `public.add_line_event_estimate_items`（migration `20261013000001_link_line_event_on_estimate_add.sql`）を追加。
  見積項目の INSERT と `line_events` の更新（`project_id` が NULL のときだけ案件 ID を設定・`reflected_to_estimate = true`）を
  1 トランザクションで行う。イベント行を `FOR UPDATE` でロックし、次を拒否する：
  他社のイベント・案件（404）、イベントと案件の会社の不一致（403）、
  別の案件に紐付け済み（409。既存の紐付けは上書きしない）、反映済み（409。重複実行の防止）。
- `POST /api/estimate-items` はこの RPC だけを呼ぶ（会社の確認をしていなかった直接 INSERT をやめた）。
- AI整理タブは追加に成功したイベントを「未振り分け」から「振り分け済み」へ移し、失敗時はエラーを表示する。
- 検証: `__tests__/db/link-line-event-estimate.db.test.ts`（隔離 DB・同時実行・RLS・未認証・他社）、
  `__tests__/line-event-estimate-items-route.test.ts`。
- **本番 DB への migration 適用は人間の承認待ち。** 手順: `docs/db/ki-001-link-line-event-on-estimate-add.md`
  （適用してからアプリをマージする。逆順だと「見積に追加」が 500 になる）。
- 過去に未振り分けのまま反映された行（`reflected_to_estimate = true AND project_id IS NULL`）は補正していない。

