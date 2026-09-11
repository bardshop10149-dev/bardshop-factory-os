/**
 * 日期工具（全站單一實作）
 *
 * 2026-09 結構健檢：同功能的日期 helper 在 40 個位置各寫一份。這裡只收「逐字相同、
 * 語意已比對過」的幾組；名稱刻意寫出「時區」與「格式」，因為舊名稱（todayStr、fmtDate、
 * getTodayDateInput）看不出彼此其實不等價：
 *
 *   todayLocalYmd()      本機時區今天 → YYYY-MM-DD          （原 todayStr ×3）
 *   todayIsoDateInput()  UTC 今天 → YYYY-MM-DD              （原 getTodayDateInput ×3）
 *   toIsoDateInput(d)    UTC 日期 → YYYY-MM-DD              （原 toDateInputValue ×2）
 *   taipeiYmd(d)         Asia/Taipei 日期 → YYYY-MM-DD      （原 taipeiDateStr ×2，Intl 版）
 *   formatYmdSlash(d)    本機時區 → YYYY/MM/DD（ARGO 格式）  （原 fmtDate/formatDate ×7）
 *   normDate(v)          任意日期文字 → YYYY-MM-DD 或 ''     （原 normDate ×3）
 *   parseYmd(s)          YYYY/MM/DD、YYYY-MM-DD、YYYYMMDD → Date（原 -pr / standalone-pr 版）
 *   clampDueDate(...)    ARGO 規則：交期必須晚於開立日       （同上）
 *
 * ⚠ 地雷：todayIsoDateInput / toIsoDateInput 走 toISOString()，是 UTC 日期——台北時間
 *   00:00–08:00 之間會得到「昨天」。既有頁面本來就是這樣，遷移時保留原行為；
 *   新程式請一律用 todayLocalYmd() 或 taipeiYmd()。
 */

const pad2 = (n: number) => String(n).padStart(2, '0')

/** 本機時區的今天，YYYY-MM-DD（給 <input type="date"> 或當日期鍵用） */
export function todayLocalYmd(): string {
  const d = new Date()
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** UTC 日期 → YYYY-MM-DD（沿用 toISOString().slice(0,10) 的既有行為，見檔頭地雷） */
export function toIsoDateInput(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** UTC 今天 → YYYY-MM-DD（沿用既有 getTodayDateInput 行為，見檔頭地雷） */
export function todayIsoDateInput(): string {
  return toIsoDateInput(new Date())
}

/** 以 Asia/Taipei 時區取日期 YYYY-MM-DD——不受伺服器或瀏覽器所在時區影響 */
export function taipeiYmd(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d)
  const get = (type: string) => parts.find((p) => p.type === type)!.value
  return `${get('year')}-${get('month')}-${get('day')}`
}

/** 本機時區 → YYYY/MM/DD（ARGO 匯入介面的日期格式） */
export function formatYmdSlash(d: Date): string {
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`
}

/**
 * 把各種日期文字（'2026/8/5'、'2026-08-05 10:00'、'2026-08-05T10:00:00Z'…）
 * 正規化成 YYYY-MM-DD；解析不出來回 ''。只處理字串，不做時區換算。
 */
export function normDate(d: unknown): string {
  if (!d) return ''
  const s = String(d).split(/[ T]/)[0].replace(/\//g, '-').split('-')
  if (s.length !== 3) return ''
  return `${s[0]}-${s[1].padStart(2, '0')}-${s[2].padStart(2, '0')}`
}

/**
 * 解析 YYYY/MM/DD、YYYY-MM-DD、YYYYMMDD 為本機時區 Date；失敗回 null。
 * 帶時間的字串（'2026/08/05 10:00'）只取前 10 碼。
 */
export function parseYmd(s: string): Date | null {
  const t = (s ?? '').trim()
  if (!t) return null
  let y: number, m: number, d: number
  if (/^\d{8}$/.test(t)) {
    y = +t.slice(0, 4); m = +t.slice(4, 6); d = +t.slice(6, 8)
  } else if (/^\d{4}[/-]\d{1,2}[/-]\d{1,2}/.test(t)) {
    const p = t.slice(0, 10).split(/[/-]/); y = +p[0]; m = +p[1]; d = +p[2]
  } else return null
  const dt = new Date(y, m - 1, d)
  return Number.isNaN(dt.getTime()) ? null : dt
}

/**
 * ARGO 規則：DUEDATE 必須晚於 APPLY_DATE。
 * 交期為空、解析失敗或 <= 開立日時，clamp 為開立日 + 1 天；回傳 YYYY/MM/DD。
 */
export function clampDueDate(deliveryDate: string, applyDate: string): string {
  const apply = parseYmd(applyDate)
  if (!apply) return (deliveryDate ?? '').trim()
  const minDue = new Date(apply.getTime())
  minDue.setDate(minDue.getDate() + 1)
  const due = parseYmd(deliveryDate)
  if (due && due.getTime() >= minDue.getTime()) return formatYmdSlash(due)
  return formatYmdSlash(minDue)
}
