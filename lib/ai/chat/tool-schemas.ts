/**
 * チャットエージェント — Claude API tool use スキーマ定義
 *
 * このファイルは Claude API に渡す tools 配列そのものを定義する。
 * ビジネスロジック（DB アクセス）はここに書かない。
 * 実行は app/api/ai/chat/route.ts → tool-executor.ts で行う。
 *
 * セキュリティ注意:
 *   - project_id / company_id はスキーマに含めない（サーバー側注入）
 *   - 顧客向け情報を返す可能性のあるフィールドは description に明記
 */

import type { Tool } from '@anthropic-ai/sdk/resources'

// ─────────────────────────────────────────────────────────
// ツール名の定数（型安全なディスパッチに使う）
// ─────────────────────────────────────────────────────────

export const TOOL_NAME = {
  // ── project-scoped（project_id 必須） ──────────────────
  // read系
  SEARCH_ESTIMATES:         'search_estimates',
  SEARCH_CATALOG:           'search_catalog',
  SEARCH_COST_LEDGER:       'search_cost_ledger',
  // 外部検索
  SEARCH_MATERIAL_WEB:      'search_material_web',
  // write系（DB書き込みは行わず PendingChangeResult を返す）
  ADD_ESTIMATE_ITEM:        'add_estimate_item',
  EDIT_ESTIMATE_ITEM:       'edit_estimate_item',
  DELETE_ESTIMATE_ITEM:     'delete_estimate_item',
  UPDATE_COST_LEDGER:       'update_cost_ledger',
  COPY_ITEMS_FROM_PROJECT:  'copy_items_from_project',
  INSERT_CATALOG_ITEM:      'insert_catalog_item',
  ADD_TO_MATERIAL_MASTER:   'add_to_material_master',
  // ── company-scoped（project_id 不要、会社全体モード） ──
  LIST_PROJECTS_STATUS:     'list_projects_status',
  GET_PROJECT_SUMMARY:      'get_project_summary',
  GET_INVOICE_STATUS:       'get_invoice_status',
  GET_UNPAID_MILESTONES:    'get_unpaid_milestones',
  CREATE_INVOICE_DRAFT:     'create_invoice_draft',
} as const

export type ToolName = typeof TOOL_NAME[keyof typeof TOOL_NAME]

/** project-scoped ツール名セット（会社全体モードでの誤呼び出し防止用） */
export const PROJECT_SCOPED_TOOLS = new Set<string>([
  TOOL_NAME.SEARCH_ESTIMATES,
  TOOL_NAME.SEARCH_COST_LEDGER,
  TOOL_NAME.SEARCH_MATERIAL_WEB,
  TOOL_NAME.ADD_ESTIMATE_ITEM,
  TOOL_NAME.EDIT_ESTIMATE_ITEM,
  TOOL_NAME.DELETE_ESTIMATE_ITEM,
  TOOL_NAME.UPDATE_COST_LEDGER,
  TOOL_NAME.COPY_ITEMS_FROM_PROJECT,
  TOOL_NAME.INSERT_CATALOG_ITEM,
  TOOL_NAME.ADD_TO_MATERIAL_MASTER,
])

/** company-scoped ツール名セット */
export const COMPANY_SCOPED_TOOLS = new Set<string>([
  TOOL_NAME.LIST_PROJECTS_STATUS,
  TOOL_NAME.GET_PROJECT_SUMMARY,
  TOOL_NAME.GET_INVOICE_STATUS,
  TOOL_NAME.GET_UNPAID_MILESTONES,
  TOOL_NAME.CREATE_INVOICE_DRAFT,
])

// ─────────────────────────────────────────────────────────
// ツール定義
// ─────────────────────────────────────────────────────────

export const chatTools: Tool[] = [

  // ── 1. search_estimates ──────────────────────────────
  {
    name: TOOL_NAME.SEARCH_ESTIMATES,
    description: [
      '現在開いている案件の見積項目（estimate_items）を曖昧検索します。',
      '品名・備考・単位などを対象に pg_trgm で類似検索を行います。',
      '',
      '【使用タイミング】',
      '- 「○○という工事はいくら？」「△△の単価を確認したい」',
      '- 見積の合計や特定グループの小計を確認したいとき',
      '- 特定項目の存在確認（「防水工事は入っているか」等）',
      '',
      '【制約】',
      '- 閲覧専用。このツールは変更を行いません',
      '- cost_price / vendor_name は内部専用フィールドです。',
      '  顧客向け回答・画面には絶対に含めないでください',
    ].join('\n'),
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description:
            '検索キーワード。品名の断片でも可。' +
            '例: "外壁塗装", "ユニットバス", "足場"',
        },
        group_id: {
          type: 'string',
          description:
            '特定グループ内だけを検索する場合のグループID（省略可）。' +
            '通常は省略してください。',
        },
        limit: {
          type: 'integer',
          description: '返す最大件数（省略時: 10、最大: 30）',
          minimum: 1,
          maximum: 30,
          default: 10,
        },
        similarity_threshold: {
          type: 'number',
          description:
            'pg_trgm 類似度の最小値（0〜1）。' +
            '日本語は文字数が少なく trgm スコアが低くなるため 0.10〜0.20 が目安。' +
            '省略時: 0.15',
          minimum: 0.05,
          maximum: 0.90,
          default: 0.15,
        },
      },
      required: ['query'],
    },
  },

  // ── 2. search_catalog ────────────────────────────────
  {
    name: TOOL_NAME.SEARCH_CATALOG,
    description: [
      '自社の過去見積品目データベース（company_estimate_items）を検索します。',
      '実際に使用した実績のある品名・参考単価の候補を提示できます。',
      '',
      '【使用タイミング】',
      '- 「この工事の相場はどのくらいか」',
      '- 過去に類似工事をしたことがあるか確認したいとき',
      '- 新規見積項目を追加する際の参考単価を調べたいとき',
      '',
      '【制約】',
      '- カタログは会社全体のデータです（案件に絞り込まれません）',
      '- 閲覧専用。このツールは変更を行いません',
      '- cost_price は内部専用フィールドです。顧客向け回答に含めないこと',
    ].join('\n'),
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description:
            '検索キーワード。例: "サッシ交換", "クロス貼替", "給湯器設置"',
        },
        category: {
          type: 'string',
          description: 'カテゴリで絞り込む場合のみ指定（省略可）。',
        },
        limit: {
          type: 'integer',
          description: '返す最大件数（省略時: 10、最大: 30）',
          minimum: 1,
          maximum: 30,
          default: 10,
        },
        similarity_threshold: {
          type: 'number',
          description:
            'pg_trgm 類似度の最小値（省略時: 0.20）。' +
            'カタログは品名が統一されているため estimate より少し高めが有効。',
          minimum: 0.05,
          maximum: 0.90,
          default: 0.20,
        },
      },
      required: ['query'],
    },
  },

  // ── 3. search_cost_ledger ────────────────────────────
  {
    name: TOOL_NAME.SEARCH_COST_LEDGER,
    description: [
      '現在開いている案件の原価台帳（cost_ledger_items）を検索します。',
      '予算・実行予算・実際原価・業者名などを確認できます。',
      '',
      '【使用タイミング】',
      '- 「この工事の実際原価は？」',
      '- 「山田板金の担当箇所は？」（業者名でも検索可）',
      '- 予算と実績の差を確認したいとき',
      '',
      '【重要な制約 — 必ず守ること】',
      '- 原価情報は社内専用です',
      '- このツールの結果を顧客向け回答・提案・見積書に含めることは禁止',
      '- 閲覧専用。このツールは変更を行いません',
    ].join('\n'),
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description:
            '検索キーワード（品名または業者名）。' +
            '例: "防水工事", "山田板金", "外壁"',
        },
        limit: {
          type: 'integer',
          description: '返す最大件数（省略時: 10、最大: 30）',
          minimum: 1,
          maximum: 30,
          default: 10,
        },
        similarity_threshold: {
          type: 'number',
          description:
            'pg_trgm 類似度の最小値（省略時: 0.15）。' +
            '業者名は短いため低め（0.10 前後）にすると拾いやすい。',
          minimum: 0.05,
          maximum: 0.90,
          default: 0.15,
        },
      },
      required: ['query'],
    },
  },


  // ── 4. add_estimate_item ──────────────────────────────
  {
    name: TOOL_NAME.ADD_ESTIMATE_ITEM,
    description: [
      '見積項目を1件新規追加します。',
      '',
      '【重要】このツールはDBへの書き込みを行いません。',
      '変更内容（diff）を返すので、ユーザーが「確定する」を押した時だけ反映されます。',
      '',
      '【使用タイミング】',
      '- 「○○を見積に追加して」と明確に指示されたとき',
      '- 単価が不明な場合は selling_price を省略してください（null扱い）',
      '',
      '【注意】',
      '- 対象が曖昧なときは追加せず、まず何を追加するか確認すること',
      '- 同一案件に同じ品名が重複することを担当者が了解している場合のみ追加',
    ].join('\n'),
    input_schema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: '品名（必須）',
        },
        quantity: {
          type: 'number',
          description: '数量（省略時: 1）',
          default: 1,
        },
        unit: {
          type: 'string',
          description: '単位（省略時: 式）',
          default: '式',
        },
        selling_price: {
          type: ['number', 'null'],
          description: '売単価。不明な場合は省略またはnull',
        },
        group_id: {
          type: 'string',
          description: '追加先グループのID（search_estimates で確認できる group_id を指定。省略可）',
        },
        memo: {
          type: 'string',
          description: '備考（省略可）',
        },
      },
      required: ['name'],
    },
  },

  // ── 5. edit_estimate_item ─────────────────────────────
  {
    name: TOOL_NAME.EDIT_ESTIMATE_ITEM,
    description: [
      '既存の見積項目の内容を変更します（品名・数量・単価・備考など）。',
      '',
      '【重要】このツールはDBへの書き込みを行いません。',
      '変更内容（diff）を返すので、ユーザーが「確定する」を押した時だけ反映されます。',
      '',
      '【必須の手順】',
      '1. 先に search_estimates で対象項目を検索する',
      '2. status が found の場合のみ、best_match.id を item_id に渡す',
      '3. status が ambiguous の場合は、ユーザーに候補を提示してどれか選ばせてから呼び出す',
      '',
      '【注意】',
      '- item_id を推測・でたらめに渡さないこと',
      '- 変更後の値だけを指定し、変えない項目は省略すること',
    ].join('\n'),
    input_schema: {
      type: 'object' as const,
      properties: {
        item_id: {
          type: 'string',
          description: '変更対象のID（search_estimates の best_match.id から取得）',
        },
        name: { type: 'string', description: '新しい品名' },
        quantity: { type: 'number', description: '新しい数量' },
        unit: { type: 'string', description: '新しい単位' },
        selling_price: { type: ['number', 'null'], description: '新しい売単価（null = 未確定）' },
        memo: { type: ['string', 'null'], description: '新しい備考' },
        cost_price: { type: ['number', 'null'], description: '新しい原価（内部専用）' },
        vendor_name: { type: ['string', 'null'], description: '新しい業者名（内部専用）' },
      },
      required: ['item_id'],
    },
  },

  // ── 6. delete_estimate_item ───────────────────────────
  {
    name: TOOL_NAME.DELETE_ESTIMATE_ITEM,
    description: [
      '見積項目を削除します（論理削除）。',
      '',
      '【重要】このツールはDBへの書き込みを行いません。',
      '変更内容（diff）を返すので、ユーザーが「確定する（削除）」を押した時だけ反映されます。',
      '',
      '【必須の手順】',
      '1. 先に search_estimates で対象項目を検索する',
      '2. status が found かつユーザーが削除を明示的に承認している場合のみ呼び出す',
      '3. 曖昧な場合や削除の意図が不明な場合は確認を取ってから呼び出す',
      '',
      '【注意】',
      '- 削除は慎重に。誤削除は担当者が気づきにくい',
      '- 「消して」「なかったことにして」等の曖昧な指示では先に確認する',
    ].join('\n'),
    input_schema: {
      type: 'object' as const,
      properties: {
        item_id: {
          type: 'string',
          description: '削除対象のID（search_estimates の best_match.id から取得）',
        },
      },
      required: ['item_id'],
    },
  },

  // ── 8. copy_items_from_project ────────────────────────
  {
    name: TOOL_NAME.COPY_ITEMS_FROM_PROJECT,
    description: [
      '別の案件のグループ明細を丸ごと現在の案件にコピーします。',
      '',
      '【重要】このツールはDBへの書き込みを行いません。',
      'コピー内容（一覧）を返すので、ユーザーが「確定する」を押した時だけ反映されます。',
      '',
      '【使用タイミング】',
      '- 「○○の案件の水回り工事を持ってきて」',
      '- 「前回の改修工事と同じ構成でコピーして」',
      '',
      '【動作フロー】',
      '1. project_keyword で過去案件を検索',
      '2. 候補が複数あれば担当者に選ばせる（このツールは ambiguous を返すことがある）',
      '3. group_keyword でグループを絞り込む（省略時は全グループをリスト返答）',
      '4. コピー対象グループが確定したら、その明細一覧を pending_change として返す',
      '',
      '【注意】',
      '- 別会社の案件にはアクセスできません（RLS制限）',
      '- コピー後の単価は元データそのままです。担当者が個別に調整してください',
    ].join('\n'),
    input_schema: {
      type: 'object' as const,
      properties: {
        project_keyword: {
          type: 'string',
          description: 'コピー元案件を特定するキーワード（案件名・顧客名・住所の断片）',
        },
        group_keyword: {
          type: 'string',
          description: 'コピー対象グループ名の断片（省略時は候補一覧を返す）',
        },
        target_group_id: {
          type: ['string', 'null'],
          description: '追加先グループID（現在の案件のグループ。search_estimates で確認できる group_id を指定。省略時はグループなし）',
        },
      },
      required: ['project_keyword'],
    },
  },

  // ── 9. insert_catalog_item ────────────────────────────
  {
    name: TOOL_NAME.INSERT_CATALOG_ITEM,
    description: [
      '自社カタログ（過去実績品目）から項目を検索して現在の見積に追加します。',
      '',
      '【重要】このツールはDBへの書き込みを行いません。',
      '追加内容を返すので、ユーザーが「確定する」を押した時だけ反映されます。',
      '',
      '【使用タイミング】',
      '- 「よく使うシステムバスを水回りグループに追加して」',
      '- 「カタログの洗面化粧台を見積に入れて」',
      '',
      '【グループの指定方法】',
      '- グループ名が分かっている場合: target_group_keyword に「水回り」「足場施工」などを渡す',
      '  → executor が estimate_groups を検索して自動でグループIDを解決する',
      '- グループIDが分かっている場合（search_estimates の結果から取得済みなら）: target_group_id に UUID を渡す',
      '- グループ名もIDも不明な場合: 両方省略してグループなしとして追加し、担当者に後で移動してもらう',
      '',
      '【動作フロー】',
      '1. catalog_query でカタログを検索',
      '2. 候補が曖昧なら担当者に選ばせる',
      '3. 対象が確定したら、追加提案（pending_change）を返す',
      '',
      '【注意】',
      '- カタログ単価はあくまで参考値。確定後に担当者が調整してください',
    ].join('\n'),
    input_schema: {
      type: 'object' as const,
      properties: {
        catalog_query: {
          type: 'string',
          description: '検索キーワード（品名）',
        },
        catalog_item_id: {
          type: ['string', 'null'],
          description:
            'カタログ品目ID（UUID）。ユーザーが候補一覧から特定品目を選んだとき、' +
            'メッセージ中の [catalog_id:XXX] 形式から抽出してここに渡す。' +
            '指定された場合はfuzzy検索をスキップしてその品目を直接使う。',
        },
        target_group_keyword: {
          type: ['string', 'null'],
          description:
            '追加先グループ名のキーワード（例: "水回り" "足場"）。' +
            'executor がこのキーワードで estimate_groups を検索してグループIDを解決する。' +
            'target_group_id が未知の場合はこちらを優先して使うこと。',
        },
        target_group_id: {
          type: ['string', 'null'],
          description:
            '追加先グループID（UUID）。' +
            'search_estimates 等で既にグループIDが判明している場合のみ指定する。' +
            '不明な場合は target_group_keyword を使うこと。',
        },
        quantity: {
          type: 'number',
          description: '数量（省略時: 1）',
          default: 1,
        },
      },
      required: ['catalog_query'],
    },
  },

  // ── 10. search_material_web ───────────────────────────
  {
    name: TOOL_NAME.SEARCH_MATERIAL_WEB,
    description: [
      'Web 検索を使って建材・資材の情報を検索します。',
      'カタラボ（icata.jp）などの資材サイトを中心に、品名・型番で検索し、',
      '参考価格・仕様・製品 URL を返します。',
      '',
      '【使用タイミング】',
      '- 「TOTOサザナの価格を調べて」',
      '- 「タカラスタンダードのシステムキッチン型番は？」',
      '- 「外部でこのメーカーの参考単価を確認したい」',
      '',
      '【制約】',
      '- 検索結果は参考情報です。実際の単価は担当者が確認してください',
      '- 検索結果は DB に保存されません（永続化しない）',
      '- 見積に追加したい場合は insert_catalog_item または add_estimate_item を使うこと',
      '- 資材マスターに登録したい場合は add_to_material_master を使うこと',
    ].join('\n'),
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: '検索キーワード（品名・メーカー名・型番など）。例: "TOTOサザナ", "LIXIL システムキッチン リシェル"',
        },
      },
      required: ['query'],
    },
  },

  // ── 11. add_to_material_master ────────────────────────
  {
    name: TOOL_NAME.ADD_TO_MATERIAL_MASTER,
    description: [
      '品目を自社の資材マスター（company_estimate_items）に登録します。',
      'Web 検索結果やカタログ候補を永続化するために使います。',
      '',
      '【重要】このツールはDBへの書き込みを行いません。',
      '登録内容を返すので、ユーザーが「確定する」を押した時だけ反映されます。',
      '',
      '【使用タイミング】',
      '- ユーザーが「資材マスターに登録して」と言ったとき',
      '- search_material_web の結果を保存したいとき',
      '- insert_catalog_item の候補を恒久登録したいとき',
      '',
      '【注意】',
      '- selling_price は参考単価（顧客向け）。cost_price は内部原価。',
      '- url には製品情報ページの URL を入れてください',
      '- すでに類似名称の品目が存在する場合は、登録前に確認すること',
    ].join('\n'),
    input_schema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: '品名（必須）',
        },
        spec: {
          type: ['string', 'null'],
          description: '仕様・型番など補足情報（省略可）',
        },
        selling_price: {
          type: ['number', 'null'],
          description: '参考単価（省略可）',
        },
        cost_price: {
          type: ['number', 'null'],
          description: '原価・仕入れ価格（省略可・内部専用）',
        },
        url: {
          type: ['string', 'null'],
          description: '製品情報ページ URL（省略可）',
        },
        category: {
          type: ['string', 'null'],
          description: 'カテゴリ（省略可）。例: "水回り", "外壁", "設備"',
        },
        unit: {
          type: 'string',
          description: '単位（省略時: 式）',
          default: '式',
        },
      },
      required: ['name'],
    },
  },

  // ── 7. update_cost_ledger ─────────────────────────────
  {
    name: TOOL_NAME.UPDATE_COST_LEDGER,
    description: [
      '原価台帳の実行予算・実績原価・業者名・メモを更新します。',
      '',
      '【重要】このツールはDBへの書き込みを行いません。',
      '変更内容（diff）を返すので、ユーザーが「確定する」を押した時だけ反映されます。',
      '',
      '【必須の手順】',
      '1. 先に search_cost_ledger で対象項目を検索する',
      '2. status が found の場合のみ、best_match.id を item_id に渡す',
      '',
      '【制約】',
      '- estimate_cost（見積原価スナップショット）は変更不可',
      '- 原価情報は顧客向け回答・提案に含めないこと',
    ].join('\n'),
    input_schema: {
      type: 'object' as const,
      properties: {
        item_id: {
          type: 'string',
          description: '更新対象のID（search_cost_ledger の best_match.id から取得）',
        },
        budget_cost: { type: ['number', 'null'], description: '実行予算' },
        actual_cost: { type: ['number', 'null'], description: '実績原価' },
        vendor_name: { type: ['string', 'null'], description: '業者名' },
        note:        { type: ['string', 'null'], description: 'メモ' },
      },
      required: ['item_id'],
    },
  },

]

// ─────────────────────────────────────────────────────────
// 会社全体モード用ツール定義（project_id 不要）
// chatTools（project-scoped）とは完全に分離する。
// route.ts 側で project_id の有無によりどちらかを選択する。
// ─────────────────────────────────────────────────────────

export const companyTools: Tool[] = [

  // ── C1. list_projects_status ──────────────────────────
  {
    name: TOOL_NAME.LIST_PROJECTS_STATUS,
    description: [
      '自社の全案件（または条件でフィルタ）の一覧とステータスを返します。',
      '',
      '【使用タイミング】',
      '- 「今進行中の案件は？」「完了済みの案件を教えて」',
      '- 「○○さんの案件はどうなっている？」（customer_name で検索する前の一覧確認）',
      '',
      '【制約】',
      '- 閲覧専用。変更を行いません',
      '- 原価・利益・見積金額は含みません（社内専用情報）',
    ].join('\n'),
    input_schema: {
      type: 'object' as const,
      properties: {
        status_filter: {
          type: 'string',
          description:
            'ステータスで絞り込む場合のみ指定。' +
            '"collecting" | "reviewing" | "estimating" | "scheduled" | "done"。' +
            '省略すると全ステータスを返します。',
          enum: ['collecting', 'reviewing', 'estimating', 'scheduled', 'done'],
        },
      },
      required: [],
    },
  },

  // ── C2. get_project_summary ───────────────────────────
  {
    name: TOOL_NAME.GET_PROJECT_SUMMARY,
    description: [
      '特定案件の概要（ステータス・見積合計・請求状況）を返します。',
      '案件 ID が分からない場合は先に list_projects_status を使ってください。',
      '',
      '【使用タイミング】',
      '- 「○○の案件の状況を教えて」',
      '- 「この案件の見積合計はいくら？」',
      '- 「請求はいくら済んでいる？」',
      '',
      '【制約】',
      '- 閲覧専用。変更を行いません',
      '- project_id は自社案件であることをサーバー側で確認します',
    ].join('\n'),
    input_schema: {
      type: 'object' as const,
      properties: {
        project_id: {
          type: 'string',
          description: '案件 UUID。list_projects_status の結果から取得してください。',
        },
      },
      required: ['project_id'],
    },
  },

  // ── C3. get_invoice_status ────────────────────────────
  {
    name: TOOL_NAME.GET_INVOICE_STATUS,
    description: [
      '指定案件の請求書（invoice_documents）の状況を返します。',
      '下書き・発行済み・入金済みなどのステータスを確認できます。',
      '',
      '【使用タイミング】',
      '- 「○○の請求書はどうなっている？」',
      '- 「請求書を作成済みかどうか確認したい」',
      '',
      '【制約】',
      '- 閲覧専用。変更を行いません',
    ].join('\n'),
    input_schema: {
      type: 'object' as const,
      properties: {
        project_id: {
          type: 'string',
          description: '案件 UUID。',
        },
      },
      required: ['project_id'],
    },
  },

  // ── C4. get_unpaid_milestones ─────────────────────────
  {
    name: TOOL_NAME.GET_UNPAID_MILESTONES,
    description: [
      '全案件の請求・入金状況を返します。',
      '支払いスケジュール（project_billing_milestones）と発行済み請求書（invoice_documents）の両方を統合して返します。',
      '',
      '【使用タイミング】',
      '- 「未入金の案件を教えて」',
      '- 「発行済みで入金確認が必要な案件は？」',
      '- 「請求が遅れている案件は？」',
      '- 「今月請求すべき案件は？」',
      '',
      '【重要な解釈ルール - 必ず守ること】',
      '- milestone_unset_count > 0 は「請求スケジュール未設定」を意味する。「入金済み」ではない。',
      '- milestone_unpaid_count = 0 でも invoice_issued_count > 0 なら未回収リスクがある。',
      '  → 「発行済み請求書があり、入金確認が必要です」と報告すること。',
      '- 「すべて入金済み」と断定できるのは milestone全入金 かつ invoice全paidのときのみ。',
      '- invoice_documents.status = issued は「発行したが入金はまだ確認されていない」状態。',
      '',
      '【制約】',
      '- 閲覧専用。変更を行いません',
      '- 返す情報に原価・利益は含まない',
    ].join('\n'),
    input_schema: {
      type: 'object' as const,
      properties: {
        overdue_only: {
          type: 'boolean',
          description:
            'true: 請求予定日が過ぎているもののみ。' +
            'false（省略時）: 未入金全件。',
          default: false,
        },
      },
      required: [],
    },
  },

  // ── C5. create_invoice_draft ──────────────────────────
  {
    name: TOOL_NAME.CREATE_INVOICE_DRAFT,
    description: [
      '請求書の下書きを作成することを提案します（Pending Change）。',
      '実際の DB 書き込みはユーザーが確認ボタンを押した後に行われます。',
      '',
      '【重要な制約】',
      '- このツールは「下書き作成の提案」のみ行います',
      '- 実際の発行・送付・メール送信は行いません',
      '- 同じ案件に既に請求書が存在する場合はサーバー側で拒否されます',
      '- 金額・内容の確定はユーザーが行います',
      '',
      '【使用タイミング】',
      '- 「○○の請求書を作りたい」「請求書の下書きを準備して」',
      '- ユーザーが見積内容を確認済みで、請求書作成の意図が明確な場合のみ使用',
    ].join('\n'),
    input_schema: {
      type: 'object' as const,
      properties: {
        project_id: {
          type: 'string',
          description: '請求書を作成する案件の UUID。',
        },
        note: {
          type: 'string',
          description: '備考・特記事項（省略可）。',
        },
      },
      required: ['project_id'],
    },
  },

]

// ─────────────────────────────────────────────────────────
// DB 側 RPC スタブ（実装時に Supabase SQL で作成する）
// ─────────────────────────────────────────────────────────
//
// ■ search_estimate_items(p_project_id, p_query, p_limit, p_threshold)
//   → estimate_items に similarity(name, p_query) を加えて返す
//   → SECURITY INVOKER（デフォルト）で RLS を有効にしたまま呼び出す
//
// ■ search_catalog_items(p_company_id, p_query, p_category, p_limit, p_threshold)
//   → company_estimate_items を pg_trgm 検索
//   → company_id は呼び出し側（API route）で auth.uid() から取得し渡す
//
// ■ search_cost_ledger_items(p_project_id, p_query, p_limit, p_threshold)
//   → cost_ledger_items を pg_trgm 検索
//
// すべて SECURITY INVOKER にすることで、呼び出しユーザーの RLS が適用され
// service_role キー（admin.ts）は一切使用しない。
//
// SQL イメージ（estimate_items 例）:
//
//   CREATE OR REPLACE FUNCTION search_estimate_items(
//     p_project_id       UUID,
//     p_query            TEXT,
//     p_limit            INT     DEFAULT 10,
//     p_threshold        FLOAT   DEFAULT 0.15
//   )
//   RETURNS TABLE (
//     id              UUID,
//     name            TEXT,
//     quantity        NUMERIC,
//     unit            TEXT,
//     selling_price   NUMERIC,
//     amount          NUMERIC,
//     cost_price      NUMERIC,
//     vendor_name     TEXT,
//     group_id        UUID,
//     group_label     TEXT,
//     source          TEXT,
//     memo            TEXT,
//     _similarity     FLOAT
//   )
//   LANGUAGE sql
//   AS $$
//     SELECT
//       ei.id, ei.name, ei.quantity, ei.unit,
//       ei.selling_price, ei.amount, ei.cost_price, ei.vendor_name,
//       ei.group_id, eg.label AS group_label,
//       ei.source, ei.memo,
//       similarity(ei.name, p_query) AS _similarity
//     FROM estimate_items ei
//     LEFT JOIN estimate_groups eg ON eg.id = ei.group_id
//     WHERE ei.project_id = p_project_id
//       AND ei.deleted_at IS NULL
//       AND similarity(ei.name, p_query) >= p_threshold
//     ORDER BY _similarity DESC
//     LIMIT p_limit;
//   $$;
//
// ─────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────
// ツールリザルトを Claude API の tool_result コンテンツに変換
// ─────────────────────────────────────────────────────────

import type { ToolResult, EstimateItemHit, CatalogItemHit, CostLedgerItemHit } from './types'

type AnyHit = EstimateItemHit | CatalogItemHit | CostLedgerItemHit

/**
 * ToolResult を Claude API の tool_result content（文字列JSON）に変換する。
 *
 * _similarity は LLM に渡さない（内部判定用のメタデータ）。
 * cost_price / vendor_name は結果に含まれるが、LLM への system prompt で
 * 顧客向け回答への転記を禁止すること。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function serializeToolResult(result: ToolResult<any>): string {
  if (result.status === 'not_found') {
    return JSON.stringify({
      status: 'not_found',
      query: result.query,
      message: '該当する項目が見つかりませんでした。',
      suggestions: result.suggestions,
      hint: result.hint,
    })
  }

  if (result.status === 'ambiguous') {
    return JSON.stringify({
      status: 'ambiguous',
      disambiguation_hint: result.disambiguation_hint,
      candidates: result.candidates.map(stripSimilarity),
    })
  }

  if (result.status === 'found') {
    return JSON.stringify({
      status: 'found',
      best_match: stripSimilarity(result.best_match),
      items: result.items.map(stripSimilarity),
      has_more: result.has_more,
    })
  }

  // pending_change（write系 — read系では到達しない）
  return JSON.stringify({
    status: 'pending_change',
    change_type: result.change_type,
    diff_summary: result.diff_summary,
    proposed: result.proposed,
    original: result.original,
    confirmation_required: true,
    message: 'この変更を実行してよいですか？確認後に適用されます。',
  })
}

/** _similarity を除いて LLM に渡す（メタデータは隠蔽） */
function stripSimilarity<T extends { _similarity: number }>(
  item: T,
): Omit<T, '_similarity'> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { _similarity, ...rest } = item
  return rest
}
