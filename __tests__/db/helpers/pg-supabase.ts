/**
 * 隔離ローカル PostgreSQL に対して、API ルートが使う Supabase クライアントの一部（PostgREST 相当）を再現する。
 *
 * - user を渡すと、各クエリを `SET LOCAL ROLE authenticated` + request.jwt.claim.sub の中で実行する（RLS 有効）。
 *   user を省くと superuser のまま実行する（service_role / admin クライアント相当。RLS を通らない）。
 * - 対応するのはテスト対象のルート・サービスが使う範囲だけ：
 *     select（列・`*`・`projects!inner ( ... )` の埋め込み・count/head）、insert / update / delete、
 *     eq / neq / is / in / not(col,'is',null) / lt / lte / gt / gte（埋め込み列 `projects.xxx` も可）、
 *     order / limit / single / maybeSingle、auth.getUser()
 * - 本番・Preview の DB には接続しない（渡された pg Client = テストが起動したローカル DB のみ）。
 */

import { types as pgTypes, type Client } from 'pg'

type Result = { data: unknown; error: { message: string; code?: string } | null; count?: number | null }
type Filter = { col: string; op: string; value: unknown }

const IDENT = /^[a-z_][a-z0-9_]*$/

const NUMERIC_OID = 1700
const DATE_TIME_OIDS = new Set([1082, 1114, 1184]) // date / timestamp / timestamptz

/** PostgREST と同じく numeric は数値、日付・日時は文字列で返す（pg の既定は numeric=文字列・日付=Date） */
const PG_TYPES = {
  getTypeParser: (oid: number, format?: string) => {
    if (oid === NUMERIC_OID) return (v: string) => Number(v)
    if (DATE_TIME_OIDS.has(oid)) return (v: string) => v
    return pgTypes.getTypeParser(oid, format as 'text')
  },
}

function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`unsupported identifier: ${name}`)
  return `"${name}"`
}

/** select 文字列を「行の列」と「埋め込み（多対一・projects のみ）」に分ける */
function parseSelect(table: string, select: string) {
  const embedRe = /(\w+)!inner\s*\(([^)]*)\)/g
  const embeds: Array<{ rel: string; cols: string[] }> = []
  const rest = select.replace(embedRe, (_m, rel: string, cols: string) => {
    embeds.push({ rel, cols: cols.split(',').map(c => c.trim()).filter(Boolean) })
    return ''
  })
  const cols = rest.split(',').map(c => c.trim()).filter(Boolean)
  for (const e of embeds) {
    if (e.rel !== 'projects') throw new Error(`unsupported embed: ${e.rel} on ${table}`)
  }
  return { cols, embeds }
}

function selectList(table: string, select: string): { list: string; join: string } {
  const { cols, embeds } = parseSelect(table, select)
  const parts = cols.map(c => (c === '*' ? 't.*' : `t.${ident(c)}`))
  let join = ''
  for (const e of embeds) {
    join = ` JOIN projects e_projects ON e_projects.id = t.project_id`
    parts.push(`jsonb_build_object(${e.cols.map(c => `'${c}', e_projects.${ident(c)}`).join(', ')}) AS projects`)
  }
  return { list: parts.join(', ') || 't.*', join }
}

function toParam(v: unknown): unknown {
  if (v !== null && typeof v === 'object' && !(v instanceof Date)) return JSON.stringify(v)
  return v
}

class Query implements PromiseLike<Result> {
  private action: 'select' | 'insert' | 'update' | 'delete' = 'select'
  private selectCols: string | null = null
  private countMode = false
  private head = false
  private rows: Record<string, unknown>[] = []
  private patch: Record<string, unknown> = {}
  private filters: Filter[] = []
  private orders: Array<{ col: string; asc: boolean }> = []
  private lim: number | null = null
  private mode: 'many' | 'single' | 'maybeSingle' = 'many'

  constructor(private run: (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>, private table: string) {
    ident(table)
  }

  select(cols = '*', opts?: { count?: string; head?: boolean }) {
    this.selectCols = cols
    if (opts?.count) this.countMode = true
    if (opts?.head) this.head = true
    return this
  }
  insert(v: Record<string, unknown> | Record<string, unknown>[]) { this.action = 'insert'; this.rows = Array.isArray(v) ? v : [v]; return this }
  update(v: Record<string, unknown>) { this.action = 'update'; this.patch = v; return this }
  delete() { this.action = 'delete'; return this }
  eq(col: string, value: unknown) { this.filters.push({ col, op: '=', value }); return this }
  neq(col: string, value: unknown) { this.filters.push({ col, op: '<>', value }); return this }
  lt(col: string, value: unknown) { this.filters.push({ col, op: '<', value }); return this }
  lte(col: string, value: unknown) { this.filters.push({ col, op: '<=', value }); return this }
  gt(col: string, value: unknown) { this.filters.push({ col, op: '>', value }); return this }
  gte(col: string, value: unknown) { this.filters.push({ col, op: '>=', value }); return this }
  is(col: string, value: null) { this.filters.push({ col, op: 'IS NULL', value }); return this }
  in(col: string, values: unknown[]) { this.filters.push({ col, op: 'IN', value: values }); return this }
  not(col: string, op: string, value: unknown) {
    if (op !== 'is' || value !== null) throw new Error(`unsupported not(${op})`)
    this.filters.push({ col, op: 'IS NOT NULL', value: null })
    return this
  }
  order(col: string, opts?: { ascending?: boolean }) { this.orders.push({ col, asc: opts?.ascending ?? true }); return this }
  limit(n: number) { this.lim = n; return this }
  single() { this.mode = 'single'; return this }
  maybeSingle() { this.mode = 'maybeSingle'; return this }

  private colRef(col: string): string {
    const [a, b] = col.split('.')
    return b ? `e_${ident(a).slice(1, -1)}.${ident(b)}` : `t.${ident(a)}`
  }

  private where(params: unknown[]): string {
    if (this.filters.length === 0) return ''
    return ' WHERE ' + this.filters.map(f => {
      const ref = this.colRef(f.col)
      if (f.op === 'IS NULL' || f.op === 'IS NOT NULL') return `${ref} ${f.op}`
      if (f.op === 'IN') { params.push(f.value); return `${ref} = ANY($${params.length})` }
      params.push(f.value)
      return `${ref} ${f.op} $${params.length}`
    }).join(' AND ')
  }

  private async execute(): Promise<Result> {
    const params: unknown[] = []
    let sql: string
    const sel = this.selectCols ?? '*'
    if (this.action === 'select') {
      const { list, join } = selectList(this.table, sel)
      sql = `SELECT ${this.countMode && this.head ? 'count(*)::int AS n' : list} FROM ${ident(this.table)} t${join}${this.where(params)}`
      if (!(this.countMode && this.head)) {
        if (this.orders.length) sql += ' ORDER BY ' + this.orders.map(o => `${this.colRef(o.col)} ${o.asc ? 'ASC' : 'DESC'}`).join(', ')
        if (this.lim != null) sql += ` LIMIT ${Number(this.lim)}`
      }
    } else if (this.action === 'insert') {
      const cols = [...new Set(this.rows.flatMap(r => Object.keys(r)))]
      const values = this.rows.map(r => '(' + cols.map(c => {
        if (!(c in r)) return 'DEFAULT'
        params.push(toParam(r[c]))
        return `$${params.length}`
      }).join(', ') + ')')
      sql = `INSERT INTO ${ident(this.table)} AS t (${cols.map(ident).join(', ')}) VALUES ${values.join(', ')} RETURNING ${selectList(this.table, sel).list}`
    } else if (this.action === 'update') {
      const sets = Object.entries(this.patch).map(([k, v]) => { params.push(toParam(v)); return `${ident(k)} = $${params.length}` })
      sql = `UPDATE ${ident(this.table)} AS t SET ${sets.join(', ')}${this.where(params)} RETURNING ${selectList(this.table, sel).list}`
    } else {
      sql = `DELETE FROM ${ident(this.table)} AS t${this.where(params)} RETURNING t.*`
    }

    let rows: Record<string, unknown>[]
    try {
      rows = (await this.run(sql, params)).rows
    } catch (e) {
      const err = e as { message: string; code?: string }
      return { data: null, error: { message: err.message, code: err.code }, count: null }
    }
    if (this.countMode && this.head) return { data: null, error: null, count: Number(rows[0]?.n ?? 0) }
    if (this.action !== 'select' && this.orders.length) {
      const o = this.orders[0]
      rows = [...rows].sort((a, b) => (Number(a[o.col]) - Number(b[o.col])) * (o.asc ? 1 : -1))
    }
    if (this.mode === 'many') return { data: this.selectCols == null && this.action !== 'select' ? null : rows, error: null, count: this.countMode ? rows.length : null }
    if (rows.length === 1) return { data: rows[0], error: null }
    if (rows.length === 0 && this.mode === 'maybeSingle') return { data: null, error: null }
    return { data: null, error: { message: `JSON object requested, ${rows.length} rows returned`, code: 'PGRST116' } }
  }

  then<T1 = Result, T2 = never>(ok?: ((v: Result) => T1 | PromiseLike<T1>) | null, ng?: ((e: unknown) => T2 | PromiseLike<T2>) | null) {
    return this.execute().then(ok, ng)
  }
}

/**
 * pg Client を Supabase クライアント風に包む。user を渡すとその利用者として RLS 付きで実行する。
 * 同じ Client を並列に使うため、クエリは1本ずつ直列に流す（Promise.all でも順に実行される）。
 */
export function pgSupabase(client: Client, user?: string) {
  let chain: Promise<unknown> = Promise.resolve()
  const run = (sql: string, params: unknown[]) => {
    const job = chain.then(async () => {
      await client.query('BEGIN')
      try {
        if (user) {
          await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [user])
          await client.query('SET LOCAL ROLE authenticated')
        }
        const r = await client.query({ text: sql, values: params, types: PG_TYPES })
        await client.query('COMMIT')
        return r
      } catch (e) {
        await client.query('ROLLBACK')
        throw e
      }
    })
    chain = job.catch(() => undefined)
    return job
  }
  return {
    from: (table: string) => new Query(run, table),
    auth: { getUser: async () => ({ data: { user: user ? { id: user } : null }, error: null }) },
  }
}
