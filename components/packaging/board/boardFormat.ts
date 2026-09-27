// 工作台畫面用的小格式工具（純函式）。

const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六']

/** 'YYYY-MM-DD' → '9/30' */
export function md(ymd: string | null | undefined): string {
  if (!ymd) return '—'
  const m = ymd.match(/^\d{4}-(\d{2})-(\d{2})/)
  return m ? `${Number(m[1])}/${Number(m[2])}` : ymd
}

/** 'YYYY-MM-DD' → '9/30（三）'；星期用 UTC 算（字串本身就是台北日曆日） */
export function mdw(ymd: string | null | undefined): string {
  if (!ymd) return '—'
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return ymd
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return `${Number(m[2])}/${Number(m[3])}（${WEEKDAY[d.getUTCDay()]}）`
}

export function weekdayOf(ymd: string): number {
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return -1
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay()
}

/** 日曆加天數（不看工作日） */
export function addDays(ymd: string, n: number): string {
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return ymd
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n))
  return d.toISOString().slice(0, 10)
}

/** ISO → 台北 'HH:mm'（跨日加 M/D） */
export function clock(iso: string | number | null | undefined, nowMs: number = Date.now()): string {
  if (iso == null) return '—'
  const t = typeof iso === 'number' ? new Date(iso) : new Date(iso)
  if (Number.isNaN(t.getTime())) return '—'
  const fmt = (x: Date, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', ...o }).format(x)
  const hm = fmt(t, { hour: '2-digit', minute: '2-digit', hour12: false })
  const sameDay = fmt(t, { month: 'numeric', day: 'numeric' }) === fmt(new Date(nowMs), { month: 'numeric', day: 'numeric' })
  return sameDay ? hm : `${fmt(t, { month: 'numeric', day: 'numeric' })} ${hm}`
}

/** 距今多久（'剛剛'、'3 分鐘前'） */
export function ago(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const mins = Math.max(0, Math.floor((nowMs - t) / 60000))
  if (mins < 1) return '剛剛'
  if (mins < 60) return `${mins} 分鐘前`
  if (mins < 1440) return `${Math.floor(mins / 60)} 小時前`
  return `${Math.floor(mins / 1440)} 天前`
}

/** 分鐘 → '38.5'（小時，一位小數） */
export function hours(min: number | null | undefined): string {
  if (min == null || !Number.isFinite(min)) return '—'
  return (Math.round(min / 6) / 10).toFixed(1)
}
