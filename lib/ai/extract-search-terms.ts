import Anthropic from '@anthropic-ai/sdk'

// モジュールロード時ではなく初回呼び出し時にインスタンスを生成する。
// テストスクリプトなど、import より後に env 変数を設定するケースに対応するため。
let _client: Anthropic | null = null
function getClient(): Anthropic {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  return _client
}

// ──────────────────────────────────────────────────────────
// 型定義
// ──────────────────────────────────────────────────────────

export type SearchTerm = {
  term:     string           // company_estimate_items.name の検索キーワード
  quantity: number | null    // 発話中に数量が含まれていた場合のみセット
  unit:     string | null    // 発話中に単位が含まれていた場合のみセット（正規化済み）
  detail:   string | null    // メーカー名・型番・グレード・特記事項など付随情報
}

export type ExtractTermsResult = {
  terms:             SearchTerm[]  // 抽出された品目リスト（quantity/unit 付き）
  raw_transcription: string        // 入力テキストをそのまま保持（デバッグ・監査用）
}

// ──────────────────────────────────────────────────────────
// システムプロンプト
//
// キャッシュ設計：
//   SYSTEM_PROMPT は全リクエストで共通のため cache_control: ephemeral を付与。
//   Anthropic のプロンプトキャッシュ（5分TTL）が有効になりAPIコストを削減できる。
//   ユーザーからの文字起こしテキストのみが毎回変わる部分。
// ──────────────────────────────────────────────────────────

// 代表的な項目名を vocabulary として埋め込む。
// 全71件を入れるとトークンが増えるため、カテゴリごとに代表例のみ選定する。
// pg_trgm で類似検索するため「完全一致」でなくてよい。
// 近い語彙が出力されれば similarity スコアが上がる。
const VOCABULARY = `
【工事カテゴリと代表的な項目名】
仮設工事     : 足場施工、仮設トイレ設置、養生費、竣工クリーニング、工期内発生材処分費
解体工事     : 屋内改装範囲解体、屋外改装範囲解体、既設減築、発生残材処分、残材処分費
給排水設備工事: 給水・給湯・排水管移設及び一部新設、追い焚き配管新設、ガス配管新設
電気配線工事 : 照明配線移設及び新設、コンセント配線移設及び新設、弱電配線新設、
              排気ダクト新設、照明器具、分電盤・増設盤、壁換気扇・24時間換気
木工事       : 構造・羽柄材、断熱材、一般建具、収納建具、仕上げ建材、
              仕上げ床材（合板フロアー）、階段、造作施工費
左官工事     : 玄関土間タイル仕上げ、基礎巾木仕上げ、コンクリート打設
内装工事     : 化粧材木部塗装、天井・壁クロス張り、床塩ビタイル張り（フロアタイル）
設備機器     : システムバス、洗面化粧台、洋式トイレ、システムキッチン、洗濯パン
鋼製建具工事 : 裏西玄関ドア
屋根・外壁工事: 屋根下地材施工、軽量瓦葺き、外壁張替え（金属サイディング）、雨樋新設
`.trim()

const SYSTEM_PROMPT = `あなたは日本の工務店向けの建材・工事項目抽出アシスタントです。

職人や担当者が音声で残したメモの文字起こしテキストを受け取り、
見積書データベースの検索キーワードとなる建材・工事の名詞を抽出してください。
さらに、発話中に数量・単位が含まれている場合はそれも一緒に抽出します。

## 抽出ルール
1. 動詞・助詞・敬語表現・接続詞・副詞は完全に除去する
2. 口語・略語・俗称は標準的な建設業用語に変換する
   （例: お風呂→システムバス、ユニットバス→システムバス、台所→システムキッチン、
         壁紙→天井・壁クロス張り、床→仕上げ床材、屋根→軽量瓦葺き）
3. 複数の建材・工事が言及されている場合は、それぞれ別のオブジェクトとして配列に格納する
4. 施工費・取付費は本体項目と分けず、本体名のみを返す
   （pg_trgmが「システムバス施工費」も自動的に候補に含める）
5. 場所名・日付・人名は除外する
6. 建材・工事が一切含まれない場合は items を空配列 [] で返す

## 数量・単位の抽出ルール
- 発話中に数量・単位が含まれていれば quantity と unit を埋める
  （例: 「配管は12メートル」→ quantity: 12, unit: "m"）
- 数量・単位が含まれない、または数量の概念がない項目は null のままにする
  （例: 「システムバス交換して」→ quantity: null, unit: null）
- unit は以下の表記に正規化すること:
  「メートル」「ｍ」→ "m"
  「平米」「平方メートル」「m2」→ "㎡"
  「立方メートル」「m3」「立米」→ "㎥"
  「坪」→ "坪"
  「式」→ "式"
  「本」→ "本"
  「枚」→ "枚"
  「個」→ "個"
  「台」→ "台"
  「ヶ所」「ヵ所」「カ所」→ "ヶ所"

## detail（付随情報）の抽出ルール
- 発話にメーカー名・型番・グレード・特記事項が含まれていれば detail に抽出する
  （例: 「TOTOのVP管」→ detail: "TOTO VP管"、「LIXILのアライズ」→ detail: "LIXIL アライズ"）
- term（品目名そのもの）と detail を混同しないこと。
  term は company_estimate_items.name と類似検索するための核となる品目名のみ。
  メーカー名・型番・「〜製」「〜仕様」などの付随情報は detail に入れる
- 含まれていなければ null のままにする

## 参照語彙（このリストに近い表現を優先して使う）
${VOCABULARY}

## 出力形式
必ず以下のJSONだけを返す。説明文・前置き・コードブロック記法は不要。
{"items": [{"term": "項目名", "quantity": 数値またはnull, "unit": "単位文字列またはnull", "detail": "付随情報またはnull"}]}

## 変換例
入力: 「お風呂を交換してください」
出力: {"items": [{"term": "システムバス", "quantity": null, "unit": null, "detail": null}]}

入力: 「配管は12メートル使って」
出力: {"items": [{"term": "給水・給湯・排水管移設及び一部新設", "quantity": 12, "unit": "m", "detail": null}]}

入力: 「配管はTOTOのVP管使って、12メートル」
出力: {"items": [{"term": "給水・給湯・排水管移設及び一部新設", "quantity": 12, "unit": "m", "detail": "TOTO VP管"}]}

入力: 「システムバスはLIXILのアライズにします」
出力: {"items": [{"term": "システムバス", "quantity": null, "unit": null, "detail": "LIXIL アライズ"}]}

入力: 「壁の材木は8平米くらい」
出力: {"items": [{"term": "構造・羽柄材", "quantity": 8, "unit": "㎡", "detail": null}]}

入力: 「洗面台も新しくしたい」
出力: {"items": [{"term": "洗面化粧台", "quantity": null, "unit": null, "detail": null}]}

入力: 「トイレとお風呂と台所を全部リフォームしたい」
出力: {"items": [{"term": "洋式トイレ", "quantity": null, "unit": null, "detail": null}, {"term": "システムバス", "quantity": null, "unit": null, "detail": null}, {"term": "システムキッチン", "quantity": null, "unit": null, "detail": null}]}

入力: 「クロスを50平米張って」
出力: {"items": [{"term": "天井・壁クロス張り", "quantity": 50, "unit": "㎡", "detail": null}]}

入力: 「今日はよろしくお願いします」
出力: {"items": []}`

// ──────────────────────────────────────────────────────────
// メイン関数
// ──────────────────────────────────────────────────────────

export async function extractSearchTerms(
  transcription: string
): Promise<ExtractTermsResult> {
  const trimmed = transcription.trim()

  // 空文字はAPI呼び出しせずに即返す
  if (!trimmed) return { terms: [], raw_transcription: '' }

  const message = await getClient().messages.create({
    model: process.env.ANTHROPIC_MODEL!,
    max_tokens: 512,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        // システムプロンプトはリクエスト間で不変のためキャッシュする（5分TTL）
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: trimmed }],
  })

  const raw = message.content[0].type === 'text' ? message.content[0].text.trim() : ''

  return {
    terms: parseTerms(raw),
    raw_transcription: trimmed,
  }
}

// ──────────────────────────────────────────────────────────
// JSONパーサー（Claudeが余分なテキストを返した場合も安全に処理）
// ──────────────────────────────────────────────────────────

function parseTerms(text: string): SearchTerm[] {
  try {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}') + 1
    if (start === -1 || end === 0) return []

    const parsed: unknown = JSON.parse(text.slice(start, end))
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('items' in parsed) ||
      !Array.isArray((parsed as { items: unknown }).items)
    ) {
      return []
    }

    return (parsed as { items: unknown[] }).items.flatMap((item): SearchTerm[] => {
      if (typeof item !== 'object' || item === null) return []
      const { term, quantity, unit, detail } = item as Record<string, unknown>
      if (typeof term !== 'string' || !term.trim()) return []
      return [{
        term:     term.trim(),
        quantity: typeof quantity === 'number' && isFinite(quantity) ? quantity : null,
        unit:     typeof unit   === 'string' && unit.trim()   ? unit.trim()   : null,
        detail:   typeof detail === 'string' && detail.trim() ? detail.trim() : null,
      }]
    })
  } catch {
    return []
  }
}
