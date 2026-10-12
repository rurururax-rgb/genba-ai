/**
 * アプリのソース（app / lib / components）から PostgREST の埋め込み（`rel!hint!inner ( ... )`）を集める。
 *
 * 2 テーブル間の外部キーが増えると、ヒントの無い埋め込みは PostgREST があいまい（PGRST201）として拒否する（KI-003）。
 * 静的テスト（postgrest-embeds.test.ts）と、実際の外部キーと照合する DB テスト（db/postgrest-embeds.db.test.ts）が使う。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

export const ROOT = path.resolve(__dirname, '../..')
const DIRS = ['app', 'lib', 'components']

export type EmbedRef = {
  file:  string        // ROOT からの相対パス
  base:  string        // .from('...') のテーブル
  rel:   string        // 埋め込むテーブル
  hint:  string | null // 外部キー名のヒント
  inner: boolean
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) return sourceFiles(p)
    return /\.(ts|tsx)$/.test(name) ? [p] : []
  })
}

// select 文字列の中の埋め込み: 識別子（!修飾子…）の直後に "("
const EMBED_RE = /(\w+)((?:!\w+)*)\s*\(/g
// .from('table') の直後に続く .select('...')（改行・空白のみを挟む）
const FROM_SELECT_RE = /\.from\(\s*['"](\w+)['"]\s*\)\s*\.select\(\s*(['"`])([\s\S]*?)\2/g
// すべての .select('...')（埋め込みの取りこぼし検出用）
const SELECT_RE = /\.select\(\s*(['"`])([\s\S]*?)\1/g

function embedsIn(select: string) {
  return [...select.matchAll(EMBED_RE)].map(m => {
    const mods = m[2].split('!').filter(Boolean)
    const hints = mods.filter(x => x !== 'inner' && x !== 'left')
    return { rel: m[1], hint: hints[0] ?? null, inner: mods.includes('inner'), hintCount: hints.length }
  })
}

/**
 * 埋め込みの一覧と、.from() と結び付けられなかった埋め込み付き select（取りこぼし）を返す。
 * 取りこぼしがあれば、このパーサーを直すか、クエリを `.from(x).select(...)` の形に書く。
 */
export function collectEmbeds(): { embeds: EmbedRef[]; unparsed: string[]; multiHint: string[] } {
  const embeds: EmbedRef[] = []
  const unparsed: string[] = []
  const multiHint: string[] = []
  for (const abs of DIRS.flatMap(d => sourceFiles(path.join(ROOT, d)))) {
    const file = path.relative(ROOT, abs)
    const src = readFileSync(abs, 'utf8')
    const parsedAt = new Set<number>()
    for (const m of src.matchAll(FROM_SELECT_RE)) {
      parsedAt.add(m.index! + m[0].indexOf('.select('))
      for (const e of embedsIn(m[3])) {
        if (e.hintCount > 1) multiHint.push(`${file}: ${m[1]} → ${e.rel}`)
        embeds.push({ file, base: m[1], rel: e.rel, hint: e.hint, inner: e.inner })
      }
    }
    for (const m of src.matchAll(SELECT_RE)) {
      if (embedsIn(m[2]).length > 0 && !parsedAt.has(m.index!)) unparsed.push(`${file}: ${m[0].slice(0, 80)}`)
    }
  }
  return { embeds, unparsed, multiHint }
}
