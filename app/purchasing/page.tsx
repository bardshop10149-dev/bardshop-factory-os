'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import {
  DUE_THRESHOLDS,
  PAYMENT_PCTS,
  SHIP_METHODS,
  arrivedFull,
  milestoneOf,
  type DueCounts,
  type PaymentPct,
  type PoTrackingLine,
  type ShipMethod,
} from '../../lib/purchasing/types'

// 過濾後最多渲染筆數（防止一次畫上千列）
const lineKey = (l: Pick<PoTrackingLine, 'doc_no' | 'sub_no'>) => `${l.doc_no}|${l.sub_no}`

const fmt = (v: string | null) => v ?? '—'

type LinePatch = { sent?: boolean; shipped?: boolean; ship_method?: ShipMethod | null; expected_ship_date?: string | null; note?: string | null }

/** 客戶端樂觀更新：已發單 / 已出貨為兩個獨立里程碑（各自 toggle），比照後端 status route */
function applyLineTransition(x: PoTrackingLine, patch: LinePatch): PoTrackingLine {
  const now = new Date().toISOString()
  let sent_at = x.sent_at
  let shipped_at = x.shipped_at
  if (patch.sent !== undefined) sent_at = patch.sent ? (sent_at ?? now) : null
  if (patch.shipped !== undefined) shipped_at = patch.shipped ? now : null
  return {
    ...x,
    sent_at,
    shipped_at,
    ship_method: patch.ship_method === undefined ? x.ship_method : patch.ship_method,
    expected_ship_date: patch.expected_ship_date === undefined ? x.expected_ship_date : patch.expected_ship_date,
    note: patch.note === undefined ? x.note : patch.note,
  }
}

/** 入庫狀態：null=無資料、none=未入庫、partial=部分入庫、full=已全數入庫 */
function receiveState(l: Pick<PoTrackingLine, 'qty' | 'received_qty'>): 'none' | 'partial' | 'full' | null {
  if (l.received_qty == null) return null
  if (l.received_qty <= 0) return 'none'
  if (l.qty != null && l.received_qty >= l.qty) return 'full'
  return 'partial'
}

/** 入庫欄（上排 已入庫/訂購 數字、下排狀態標籤） */
function ReceiveCell({ l }: { l: PoTrackingLine }) {
  const state = receiveState(l)
  if (state === null) return <span className="text-slate-600">—</span>
  const styles = {
    none:    ['未入庫',   'bg-slate-800 text-slate-500 border-slate-600'],
    partial: ['部分入庫', 'bg-sky-900/60 text-sky-300 border-sky-700/50'],
    full:    ['已全數入庫', 'bg-emerald-900/60 text-emerald-400 border-emerald-700/50'],
  } as const
  const [label, cls] = styles[state]
  return (
    <div>
      <span className={state === 'none' ? 'text-slate-500' : 'text-white font-medium'}>
        {(l.received_qty ?? 0).toLocaleString()}
        <span className="text-slate-500 font-normal"> / {l.qty != null ? l.qty.toLocaleString() : '—'}</span>
      </span>
      <span className={`block w-fit mt-0.5 text-[10px] px-1.5 py-0.5 rounded font-semibold border ${cls}`}>{label}</span>
    </div>
  )
}

/** 備註輸入格：手打、自動換行（textarea 原生換行）、右下角可拖拉調高度；
 *  失焦才儲存（打字中不打 API），Escape 還原成上次儲存值 */
function NoteCell({ value, saving, onSave }: { value: string | null; saving: boolean; onSave: (next: string) => void }) {
  const [draft, setDraft] = useState(value ?? '')
  // 重新查詢／他列儲存回寫後，同步外部值
  useEffect(() => { setDraft(value ?? '') }, [value])
  return (
    <textarea
      value={draft}
      onChange={e => setDraft(e.target.value)}
      onBlur={() => { if (draft.trim() !== (value ?? '').trim()) onSave(draft) }}
      onKeyDown={e => { if (e.key === 'Escape') setDraft(value ?? '') }}
      placeholder="輸入備註…"
      maxLength={500}
      rows={2}
      disabled={saving}
      title="失焦自動儲存；Escape 還原；右下角可拖拉調整高度"
      className="w-full min-h-[3em] px-2 py-1 rounded bg-slate-950/80 border border-slate-700/70 focus:border-cyan-600 focus:outline-none text-slate-200 text-xs leading-snug resize-y disabled:opacity-60 placeholder:text-slate-600"
    />
  )
}

/** 到期分組：red = ≤2 天（含逾期）、amber = 3~5、yellow = 6~10；已出貨或已到倉不再提醒 */
function dueBucket(l: PoTrackingLine): 'red' | 'amber' | 'yellow' | null {
  if (l.shipped_at || arrivedFull(l) || l.due_days == null || l.due_days > 10) return null
  if (l.due_days <= 2) return 'red'
  if (l.due_days <= 5) return 'amber'
  return 'yellow'
}

interface Filters {
  vendorCode: string
  vendorName: string
  itemCode: string
  prNo: string
  buyer: string
  poNo: string
  srcNo: string          // 來源單號（SO/RO/MO）→ 反查對應採購單
  poFrom: string
  poTo: string
  dueFrom: string
  dueTo: string
  orderFrom: string
  orderTo: string
}

const EMPTY_FILTERS: Filters = {
  vendorCode: '', vendorName: '', itemCode: '', prNo: '', buyer: '',
  poNo: '', srcNo: '', poFrom: '', poTo: '', dueFrom: '', dueTo: '', orderFrom: '', orderTo: '',
}

/** 追蹤列表欄位（w = 預設欄寬 px，可拖拉表頭右緣調整） */
// w = 標準寬、wc = 精簡（一屏）寬；sortable=交期可點表頭排序
const LIST_COLS = [
  { key: 'po',        label: '採購單號',   w: 118, wc: 92 },
  { key: 'sub',       label: '序',         w: 40,  wc: 32 },
  { key: 'item',      label: '料號/品名',   w: 220, wc: 150 },
  { key: 'qty',       label: '數量',       w: 84,  wc: 60, right: true },
  { key: 'buyer',     label: '承辦人',     w: 90,  wc: 66, center: true },
  { key: 'vendor',    label: '供應商',     w: 140, wc: 100 },
  { key: 'orderDate', label: '下單日',     w: 92,  wc: 74 },
  { key: 'due',       label: '交期',       w: 100, wc: 82, sortable: true },
  { key: 'so',        label: 'SO單號',     w: 110, wc: 88 },
  { key: 'pr',        label: '請購單號',   w: 118, wc: 92 },
  { key: 'progress',  label: '進度',       w: 150, wc: 122 },
  { key: 'received',  label: '入庫',       w: 104, wc: 82 },
  { key: 'payment',   label: '付款',       w: 88,  wc: 74 },
  { key: 'ship',      label: '貨運/預計出貨', w: 140, wc: 112 },
  { key: 'note',      label: '備註',       w: 200, wc: 140 },
]
const STD_W: Record<string, number> = Object.fromEntries(LIST_COLS.map(c => [c.key, c.w]))
const COMPACT_W: Record<string, number> = Object.fromEntries(LIST_COLS.map(c => [c.key, c.wc]))

/** 預設查詢條件：下單日往前兩個月 ~ 今天 */
function defaultFilters(): Filters {
  const today = new Date()
  const from = new Date(today)
  from.setMonth(from.getMonth() - 2)
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  return { ...EMPTY_FILTERS, orderFrom: iso(from), orderTo: iso(today) }
}

/** 每頁筆數 */
const PAGE_SIZE = 100

// 查詢條件已全部改由伺服器端（loadPoPage）過濾；前端只剩兩個當頁精修：
// 「排除已到倉」與「請購單號」（PR 為比對結果，資料庫無此欄）
const contains = (v: string | null, q: string) =>
  !q || (v ?? '').toLowerCase().includes(q.trim().toLowerCase())

/** 相對時間標籤（上次更新顯示用）：HH:mm（N 分鐘前） */
function fmtSyncTime(iso: string): { clock: string; ago: string; staleMins: number } {
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return { clock: iso, ago: '', staleMins: 0 }
  const mins = Math.max(0, Math.floor((Date.now() - t.getTime()) / 60000))
  const clock = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
  let ago: string
  if (mins < 1) ago = '剛剛'
  else if (mins < 60) ago = `${mins} 分鐘前`
  else if (mins < 1440) ago = `${Math.floor(mins / 60)} 小時 ${mins % 60} 分前`
  else ago = `${Math.floor(mins / 1440)} 天前`
  return { clock, ago, staleMins: mins }
}

export default function PurchasingPage() {
  const [lines, setLines]       = useState<PoTrackingLine[]>([])   // 追蹤列表當頁（伺服器已分頁）
  const [total, setTotal]       = useState(0)                       // 追蹤列表總筆數（伺服器回傳）
  const [dueLines, setDueLines] = useState<PoTrackingLine[]>([])   // 到期提醒分頁（全量 OPEN）
  const [dueLoaded, setDueLoaded] = useState(false)
  const [counts, setCounts]     = useState<DueCounts | null>(null)
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState<string | null>(null)
  const [forbidden, setForbidden] = useState(false)
  const [tab, setTab]           = useState<'list' | 'due'>('list')
  const [filters, setFilters]   = useState<Filters>(defaultFilters)
  const [appliedFilters, setAppliedFilters] = useState<Filters>(defaultFilters)
  const [searched, setSearched] = useState(false)   // 按過「開始查詢」才撈資料
  const [page, setPage]         = useState(1)        // 追蹤列表分頁（每頁 PAGE_SIZE 筆）
  const [compact, setCompact]   = useState(false)    // 精簡（一屏）模式：較窄欄寬 + 較小字
  const [sortDue, setSortDue]   = useState<'asc' | 'desc' | null>(null)  // 依交期排序
  const [hideArrived, setHideArrived] = useState(false)  // 排除已全部到倉
  const [cpFilter, setCpFilter] = useState<'all' | 'only' | 'exclude'>('all')  // 常平／非常平
  const [poStatus, setPoStatus] = useState<'OPEN' | 'CLOSE' | 'VOID'>('OPEN')  // 單據狀態（伺服器端過濾，切換即重查）
  const [savingKeys, setSavingKeys] = useState<Set<string>>(new Set())
  const [msg, setMsg]           = useState('')
  const [buyerOptions, setBuyerOptions] = useState<{ id: string; name: string | null }[]>([])
  const [itemOptions, setItemOptions]   = useState<{ code: string; name: string | null }[]>([])
  const [itemPickerOpen, setItemPickerOpen] = useState(false)   // 料號查詢視窗：點欄位打字/按 Enter 才開
  const [poDetailNo, setPoDetailNo] = useState<string | null>(null)  // 點採購單號 → 整張單明細
  const [dbSyncing, setDbSyncing]   = useState(false)  // 「更新資料庫」（sync_po）執行中
  const [lastSync, setLastSync]     = useState<{ at: string; ok: boolean } | null>(null)  // 上次 sync_po 時間
  const [lastSyncErr, setLastSyncErr] = useState(false)  // sync-status 讀取失敗
  const [queryMs, setQueryMs]       = useState<{ client: number; server: number | null } | null>(null)  // 查詢耗時（診斷）

  // 上次更新時間（erp_sync_logs 最近一次 sync_po；進頁面載入，手動更新後刷新）
  const loadSyncStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/purchasing/sync-status')
      const json = await res.json().catch(() => null)
      if (!res.ok || !json?.success) { setLastSyncErr(true); return }
      setLastSyncErr(false)
      setLastSync(json.last ? { at: json.last.created_at, ok: json.last.ok !== false } : null)
    } catch {
      setLastSyncErr(true)
    }
  }, [])

  useEffect(() => { void loadSyncStatus() }, [loadSyncStatus])

  // 建議清單（承辦人/料號 datalist）：進頁面先載，查詢前就能用
  useEffect(() => {
    fetch('/api/purchasing/lookups')
      .then(res => (res.ok ? res.json() : null))
      .then(json => {
        if (!json?.success) return
        setBuyerOptions(json.buyers ?? [])
        setItemOptions(json.items ?? [])
      })
      .catch(() => {})
  }, [])

  // 追蹤列表：伺服器端過濾/排序/分頁（mode=page），一次只撈當頁 100 筆 → 次秒級
  const fetchPage = useCallback(async (pageNum: number, f: Filters, opts: { sort: 'asc' | 'desc' | null; cp: 'all' | 'only' | 'exclude'; status: string }) => {
    setLoading(true)
    setError(null)
    const t0 = performance.now()
    try {
      const qs = new URLSearchParams({ mode: 'page', page: String(pageNum), pageSize: String(PAGE_SIZE), status: opts.status })
      const set = (k: string, v: string) => { if (v && v.trim()) qs.set(k, v.trim()) }
      set('orderFrom', f.orderFrom); set('orderTo', f.orderTo)
      set('dueFrom', f.dueFrom); set('dueTo', f.dueTo)
      set('vendorCode', f.vendorCode); set('vendorName', f.vendorName)
      set('itemCode', f.itemCode); set('poNo', f.poNo)
      set('poFrom', f.poFrom); set('poTo', f.poTo)
      set('srcNo', f.srcNo)
      // 承辦人：datalist 選「姓名（工號）」時取括號內工號
      const buyerTerm = f.buyer.match(/（([^）]+)）\s*$/)?.[1] ?? f.buyer
      set('buyer', buyerTerm)
      if (opts.cp !== 'all') qs.set('cp', opts.cp)
      if (opts.sort) qs.set('sortDue', opts.sort)
      const res = await fetch(`/api/purchasing/list?${qs}`)
      if (res.status === 403) { setForbidden(true); return }
      const json = await res.json()
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`)
      setLines(json.lines as PoTrackingLine[])
      setTotal(Number(json.total) || 0)
      setPage(pageNum)
      // 耗時診斷：client=按下到資料進畫面；server=後端組裝（差值≈網路傳輸+解析）
      setQueryMs({ client: Math.round(performance.now() - t0), server: json.timings?.total_ms ?? null })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  // 到期提醒分頁：全量 OPEN 載入（提醒統計需看整體，不分頁）
  const fetchDue = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/purchasing/list?status=OPEN')
      if (res.status === 403) { setForbidden(true); return }
      const json = await res.json()
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`)
      setDueLines(json.lines as PoTrackingLine[])
      setCounts(json.counts as DueCounts)
      setDueLoaded(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  /** 按「開始查詢」：套用目前條件並從第 1 頁撈（進頁面不自動查） */
  const handleSearch = useCallback(() => {
    setAppliedFilters(filters)
    setSearched(true)
    void fetchPage(1, filters, { sort: sortDue, cp: cpFilter, status: poStatus })
  }, [filters, sortDue, cpFilter, poStatus, fetchPage])

  const flash = (text: string) => {
    setMsg(text)
    setTimeout(() => setMsg(''), 3000)
  }

  /** 「更新資料庫」：手動觸發 sync_po（同每小時排程做的事），完成後刷新上次更新時間與列表 */
  const handleDbSync = useCallback(async () => {
    if (dbSyncing) return
    setDbSyncing(true)
    try {
      const res = await fetch('/api/argoerp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'sync_po' }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || (json.status !== 'ok' && json.success !== true)) {
        throw new Error(json.error || `HTTP ${res.status}`)
      }
      const changed = (json.inserted ?? 0) + (json.updated ?? 0) + (json.deleted ?? 0)
      flash(`✅ 採購單資料庫已更新（新增 ${json.inserted ?? 0}／更新 ${json.updated ?? 0}／刪除 ${json.deleted ?? 0}）`)
      void loadSyncStatus()
      // 已查詢過且有變動才重撈，避免多打一次重 API
      if (changed > 0) {
        if (tab === 'due' && dueLoaded) void fetchDue()
        else if (searched) void fetchPage(page, appliedFilters, { sort: sortDue, cp: cpFilter, status: poStatus })
      }
    } catch (e) {
      flash(`❌ 更新失敗：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setDbSyncing(false)
    }
  }, [dbSyncing, searched, tab, dueLoaded, page, appliedFilters, sortDue, cpFilter, poStatus, fetchPage, fetchDue, loadSyncStatus])

  const markSaving = (key: string, on: boolean) => {
    setSavingKeys(prev => {
      const next = new Set(prev)
      if (on) next.add(key)
      else next.delete(key)
      return next
    })
  }

  /** 更新明細層級狀態（發出 / 出貨 / 出貨方式 / 預計出貨日），成功後就地更新列 */
  const updateLine = useCallback(async (l: PoTrackingLine, patch: LinePatch) => {
    const key = lineKey(l)
    markSaving(key, true)
    try {
      const res = await fetch('/api/purchasing/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'line', doc_no: l.doc_no, sub_no: l.sub_no, ...patch }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`)
      const apply = (arr: PoTrackingLine[]) => arr.map(x => lineKey(x) !== key ? x : applyLineTransition(x, patch))
      setLines(apply); setDueLines(apply)
    } catch (e) {
      flash(`❌ 更新失敗：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      markSaving(key, false)
    }
  }, [])

  /** 更新付款進度（表頭層級：同 doc_no 所有列同步） */
  const updatePayment = useCallback(async (docNo: string, pct: PaymentPct) => {
    markSaving(`pay|${docNo}`, true)
    try {
      const res = await fetch('/api/purchasing/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'payment', doc_no: docNo, payment_pct: pct }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`)
      const apply = (arr: PoTrackingLine[]) => arr.map(x => x.doc_no === docNo ? { ...x, payment_pct: pct } : x)
      setLines(apply); setDueLines(apply)
    } catch (e) {
      flash(`❌ 更新失敗：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      markSaving(`pay|${docNo}`, false)
    }
  }, [])

  // 伺服器已過濾/排序/分頁；前端只做兩個當頁精修：排除已到倉、請購單號（PR 為比對結果，DB 無此欄）
  const paged = useMemo(() => lines.filter(l =>
    !(hideArrived && arrivedFull(l))
    && contains(l.pr_no, appliedFilters.prNo)
  ), [lines, hideArrived, appliedFilters.prNo])
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)

  const goToPage = useCallback((n: number) => {
    void fetchPage(n, appliedFilters, { sort: sortDue, cp: cpFilter, status: poStatus })
  }, [appliedFilters, sortDue, cpFilter, poStatus, fetchPage])

  const dueGroups = useMemo(() => {
    const groups = { red: [] as PoTrackingLine[], amber: [] as PoTrackingLine[], yellow: [] as PoTrackingLine[] }
    for (const l of dueLines) {
      const b = dueBucket(l)
      if (b) groups[b].push(l)
    }
    for (const g of Object.values(groups)) g.sort((a, b) => (a.due_days ?? 0) - (b.due_days ?? 0))
    return groups
  }, [dueLines])

  const dueTotal = dueGroups.red.length + dueGroups.amber.length + dueGroups.yellow.length

  const setF = (k: keyof Filters) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setFilters(prev => ({ ...prev, [k]: e.target.value }))

  /** 料號查詢視窗的候選（部分比對料號或品名，最多列 50 筆） */
  const itemMatches = useMemo(() => {
    const q = filters.itemCode.trim().toLowerCase()
    const all = q
      ? itemOptions.filter(it => it.code.toLowerCase().includes(q) || (it.name ?? '').toLowerCase().includes(q))
      : itemOptions
    return { shown: all.slice(0, 50), total: all.length }
  }, [filters.itemCode, itemOptions])

  /** 整張採購單的明細（點單號開視窗用）：從追蹤列表與到期提醒已載資料中找 */
  const poDetailLines = useMemo(() => {
    if (!poDetailNo) return []
    const seen = new Set<string>()
    const out: PoTrackingLine[] = []
    for (const l of [...lines, ...dueLines]) {
      if (l.doc_no !== poDetailNo) continue
      const k = lineKey(l)
      if (seen.has(k)) continue
      seen.add(k)
      out.push(l)
    }
    return out
  }, [poDetailNo, lines, dueLines])

  // ── 欄寬拖拉調整：拖曳期間直接改 DOM（避免整表重繪卡頓），放開才寫回 state ──
  const [colW, setColW] = useState<Record<string, number>>(STD_W)
  const colWRef = useRef<Record<string, number>>({ ...STD_W })
  const colRefs = useRef<Record<string, HTMLTableColElement | null>>({})
  const tableRef = useRef<HTMLTableElement | null>(null)

  // 切換精簡/標準時，套用對應的欄寬預設
  useEffect(() => {
    const preset = compact ? COMPACT_W : STD_W
    colWRef.current = { ...preset }
    setColW({ ...preset })
  }, [compact])

  const startResize = useCallback((key: string, e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = colWRef.current[key] ?? STD_W[key]
    const onMove = (ev: MouseEvent) => {
      const w = Math.max(32, startW + ev.clientX - startX)
      colWRef.current[key] = w
      const col = colRefs.current[key]
      if (col) col.style.width = `${w}px`
      if (tableRef.current) {
        tableRef.current.style.width = `${Object.values(colWRef.current).reduce((a, b) => a + b, 0)}px`
      }
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      setColW({ ...colWRef.current })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  if (forbidden) {
    return (
      <main className="min-h-screen bg-slate-950 text-white flex flex-col items-center justify-center gap-4">
        <div className="text-4xl">🔒</div>
        <p className="text-slate-300 text-sm">此專區僅開放採購人員使用，請聯絡管理員開通「採購專區」權限。</p>
        <Link href="/" className="text-cyan-400 text-sm hover:underline">← 回首頁</Link>
      </main>
    )
  }

  const renderProgressCell = (l: PoTrackingLine) => {
    const key = lineKey(l)
    const saving = savingKeys.has(key)
    // ARGO 單據狀態 OPEN＝採購單已成立發出 → 「發單」自動亮（Snow 2026-07-14），不再手動點
    const autoSent = (l.po_status ?? '').trim().toUpperCase() === 'OPEN'
    const sent = autoSent || Boolean(l.sent_at)
    const shipped = Boolean(l.shipped_at)
    const arrived = arrivedFull(l)   // 入庫量滿足採購量 → 自動亮

    // 三個里程碑晶片（短標籤節省寬度）：發單 / 出貨（採購手動點）＋ 到倉（自動）
    const chip = (active: boolean, activeCls: string) =>
      `text-[10px] px-1 py-0.5 rounded font-semibold border whitespace-nowrap transition-colors ${
        active ? activeCls : 'bg-slate-800 text-slate-500 border-slate-700'
      }`
    // 連續光條：發單→出貨→到倉 三個里程碑，一個亮就往右填 1/3；全到倉整條填滿
    const level = arrived ? 3 : shipped ? 2 : sent ? 1 : 0
    const pct = (level / 3) * 100
    const fillCls =
      level >= 3 ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.85)]'
      : level === 2 ? 'bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.75)]'
      : level === 1 ? 'bg-sky-400 shadow-[0_0_8px_rgba(56,189,248,0.75)]'
      : ''
    return (
      <div className="flex flex-col gap-1 w-fit">
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            disabled={saving || autoSent}
            onClick={() => void updateLine(l, { sent: !sent })}
            title={autoSent
              ? 'ARGO 單據狀態 OPEN，自動視為已發單'
              : sent ? `已發單 ${l.sent_at?.slice(0, 10)}（點一下取消）` : '點一下標記已發單'}
            className={`${chip(sent, 'bg-sky-900/60 text-sky-300 border-sky-600/60')} ${saving ? 'opacity-50' : ''} ${autoSent ? 'cursor-default' : 'cursor-pointer'}`}
          >發單</button>
          <button
            type="button"
            disabled={saving}
            onClick={() => void updateLine(l, { shipped: !shipped })}
            title={shipped ? `已出貨 ${l.shipped_at?.slice(0, 10)}（點一下取消）` : '點一下標記已出貨'}
            className={`${chip(shipped, 'bg-amber-900/60 text-amber-300 border-amber-600/60')} disabled:opacity-50 cursor-pointer`}
          >出貨</button>
          <span
            title={arrived ? '入庫量已滿足採購量（自動）' : '入庫量未滿足採購量；到倉後自動亮'}
            className={chip(arrived, 'bg-emerald-900/60 text-emerald-300 border-emerald-600/60')}
          >到倉</span>
        </div>
        {/* 連續光條：寬度＝三顆晶片總寬，由左往右填，帶前進動感 */}
        <div className="h-[3px] w-full rounded-full bg-slate-800 overflow-hidden">
          <div className={`h-full rounded-full transition-[width] duration-500 ease-out ${fillCls}`} style={{ width: `${pct}%` }} />
        </div>
      </div>
    )
  }

  const renderPaymentCell = (l: PoTrackingLine) => {
    const saving = savingKeys.has(`pay|${l.doc_no}`)
    return (
      <div className="grid grid-cols-2 gap-1 w-fit" title="付款進度為整張採購單共用（同單各行同步）；再點一次目前的百分比可取消">
        {PAYMENT_PCTS.filter(p => p !== 0).map(p => (
          <button
            key={p}
            type="button"
            disabled={saving}
            onClick={() => void updatePayment(l.doc_no, l.payment_pct === p ? 0 : p as PaymentPct)}
            className={`text-[10px] px-1.5 py-0.5 rounded border font-semibold transition-colors disabled:opacity-50 ${
              l.payment_pct === p
                ? 'bg-cyan-700 border-cyan-500 text-white'
                : 'bg-slate-900 border-slate-700 text-slate-500 hover:border-cyan-700 hover:text-slate-300'
            }`}
          >{p}%</button>
        ))}
      </div>
    )
  }

  const renderShipMethodCell = (l: PoTrackingLine) => (
    <select
      value={l.ship_method ?? ''}
      disabled={savingKeys.has(lineKey(l))}
      onChange={e => void updateLine(l, { ship_method: (e.target.value || null) as ShipMethod | null })}
      className="rounded bg-slate-900 border border-slate-700 px-1.5 py-1 text-[11px] text-slate-300 focus:outline-none focus:border-cyan-600"
    >
      <option value="">—</option>
      {SHIP_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
    </select>
  )

  const renderExpectedShipCell = (l: PoTrackingLine) => (
    <input
      type="date"
      value={l.expected_ship_date ?? ''}
      disabled={savingKeys.has(lineKey(l))}
      onChange={e => void updateLine(l, { expected_ship_date: e.target.value || null })}
      className="rounded bg-slate-900 border border-slate-700 px-1.5 py-1 text-[11px] text-slate-300 focus:outline-none focus:border-cyan-600 w-[125px]"
    />
  )

  const COLS = LIST_COLS.length

  return (
    <main className="min-h-screen bg-slate-950 text-white">
      {/* ─── Header ─── */}
      <div className="border-b border-slate-800 bg-slate-900/60 backdrop-blur-sm px-4 py-3 flex items-center gap-4">
        <Link href="/" className="text-xs text-slate-500 hover:text-slate-300 transition-colors shrink-0">← 回首頁</Link>
        <h1 className="text-sm font-bold text-white">採購專區</h1>
        <span className="text-[10px] text-slate-600">OPEN 採購單追蹤（每小時自 ARGO 同步）</span>
        <div className="ml-auto flex items-center gap-3">
          {msg && <span className="text-xs text-rose-300">{msg}</span>}
          {/* 查詢耗時（診斷用）：client=按下到上畫面、伺服器=後端組裝；差值大代表卡在網路傳輸 */}
          {queryMs && (
            <span className="text-[10px] text-slate-600 whitespace-nowrap" title="上次查詢耗時：總（伺服器組裝）">
              查詢 {(queryMs.client / 1000).toFixed(1)}s{queryMs.server != null ? `（伺服器 ${(queryMs.server / 1000).toFixed(1)}s）` : ''}
            </span>
          )}
          {/* 上次更新時間（erp_sync_logs 最近一次 sync_po；排程每小時自動跑，>75 分鐘未跑標黃提醒） */}
          <span className="text-[10px] text-slate-500 whitespace-nowrap" title="採購單資料庫（erp_pj_sync）最近一次自 ARGO 同步的時間；排程每小時自動執行">
            {lastSyncErr
              ? '上次更新：無法取得'
              : lastSync
                ? (() => {
                    const { clock, ago, staleMins } = fmtSyncTime(lastSync.at)
                    return (
                      <>
                        上次更新：{clock}（{ago}）
                        {!lastSync.ok && <span className="text-rose-400 ml-1">⚠ 上次同步失敗</span>}
                        {lastSync.ok && staleMins > 75 && <span className="text-amber-400 ml-1">⚠ 逾時，排程可能未跑</span>}
                      </>
                    )
                  })()
                : '上次更新：—'}
          </span>
          <button
            type="button"
            onClick={() => void handleDbSync()}
            disabled={dbSyncing}
            title="立即從 ARGO 重新同步採購單資料庫（與每小時排程相同動作）"
            className="px-3 py-1.5 rounded bg-emerald-800 hover:bg-emerald-700 disabled:bg-slate-800 disabled:text-slate-600 text-xs font-semibold text-emerald-100 transition-colors"
          >{dbSyncing ? '⏳ 同步中…' : '⬇ 更新資料庫'}</button>
          <button
            type="button"
            onClick={() => { if (tab === 'due') void fetchDue(); else if (searched) void fetchPage(safePage, appliedFilters, { sort: sortDue, cp: cpFilter, status: poStatus }) }}
            disabled={loading}
            className="px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 disabled:text-slate-600 text-xs font-semibold text-slate-300 transition-colors"
          >{loading ? '載入中…' : '🔄 重新整理'}</button>
        </div>
      </div>

      {/* ─── Tabs ─── */}
      <div className="px-4 pt-3 flex items-center gap-2 border-b border-slate-800/60">
        <button
          type="button"
          onClick={() => setTab('list')}
          className={`px-4 py-2 rounded-t text-xs font-semibold transition-colors border-b-2 ${
            tab === 'list' ? 'text-cyan-300 border-cyan-500' : 'text-slate-500 border-transparent hover:text-slate-300'
          }`}
        >追蹤列表</button>
        <button
          type="button"
          onClick={() => {
            setTab('due')
            // 到期提醒有獨立全量 OPEN 資料，與追蹤列表分頁互不干擾
            if (!dueLoaded) void fetchDue()
          }}
          className={`px-4 py-2 rounded-t text-xs font-semibold transition-colors border-b-2 flex items-center gap-1.5 ${
            tab === 'due' ? 'text-cyan-300 border-cyan-500' : 'text-slate-500 border-transparent hover:text-slate-300'
          }`}
        >
          到期提醒
          {dueTotal > 0 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-rose-800 text-rose-200 font-bold">{dueTotal}</span>
          )}
        </button>
        <span className="ml-auto pb-2 text-[10px] text-slate-600">
          交期前 {DUE_THRESHOLDS.join(' / ')} 日提醒；標記已出貨後不再提醒
        </span>
      </div>

      {error && (
        <div className="px-4 py-3 bg-red-900/40 border-b border-red-800 text-red-300 text-xs">⚠ 載入失敗：{error}</div>
      )}

      {tab === 'list' && (
        <>
          {/* ─── 查詢列 ─── */}
          <div className="px-4 py-3 border-b border-slate-800/60 grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-x-3 gap-y-2">
            {([
              ['vendorCode', '廠商代碼', '部分輸入', undefined],
              ['vendorName', '廠商名稱', '部分輸入', undefined],
              ['itemCode', '料號', '點此輸入或按 Enter 開查詢', undefined],
              ['prNo', '請購單號', '部分輸入', undefined],
              ['buyer', '承辦人', '姓名或工號', 'purchasing-buyer-list'],
              ['poNo', '採購單號', '部分輸入', undefined],
              ['srcNo', '來源單號', 'SO/RO/MO 單號查採購單', undefined],
            ] as const).map(([key, label, ph, listId]) => (
              <div key={key} className={key === 'itemCode' ? 'relative' : undefined}>
                <label className="block text-[10px] text-slate-500 mb-0.5">{label}</label>
                <input
                  type="text"
                  value={filters[key]}
                  onChange={e => { setF(key)(e); if (key === 'itemCode') setItemPickerOpen(e.target.value.trim().length > 0) }}
                  onKeyDown={key === 'itemCode' ? (e => {
                    if (e.key === 'Enter') { e.preventDefault(); setItemPickerOpen(true) }
                    else if (e.key === 'Escape') setItemPickerOpen(false)
                  }) : undefined}
                  onBlur={key === 'itemCode' ? (() => { window.setTimeout(() => setItemPickerOpen(false), 150) }) : undefined}
                  placeholder={ph}
                  list={listId}
                  className="w-full rounded bg-slate-900 border border-slate-700 px-2 py-1.5 text-xs text-white placeholder-slate-700 focus:outline-none focus:border-cyan-600 font-mono"
                />
                {/* 料號查詢視窗：空欄不跳，打字或按 Enter 才開 */}
                {key === 'itemCode' && itemPickerOpen && (
                  <div className="eip-scrollbar absolute z-30 mt-1 w-[340px] max-h-64 overflow-y-auto rounded-lg border border-slate-600 bg-slate-900 shadow-2xl">
                    {itemMatches.shown.length === 0 && (
                      <p className="px-3 py-2 text-[11px] text-slate-500">沒有符合的料號</p>
                    )}
                    {itemMatches.shown.map(it => (
                      <button
                        key={it.code}
                        type="button"
                        onMouseDown={e => { e.preventDefault(); setFilters(prev => ({ ...prev, itemCode: it.code })); setItemPickerOpen(false) }}
                        className="w-full text-left px-3 py-1.5 hover:bg-slate-800 transition-colors"
                      >
                        <span className="font-mono text-xs text-cyan-300">{it.code}</span>
                        {it.name && <span className="block text-[10px] text-slate-400 truncate">{it.name}</span>}
                      </button>
                    ))}
                    {itemMatches.total > itemMatches.shown.length && (
                      <p className="px-3 py-1.5 text-[10px] text-slate-600 border-t border-slate-800">
                        還有 {itemMatches.total - itemMatches.shown.length} 筆，請輸入更完整料號縮小範圍
                      </p>
                    )}
                  </div>
                )}
              </div>
            ))}
            {/* 承辦人建議（EIP 採購部門成員）：有對到工號顯示「姓名（工號）」，沒有就純姓名 */}
            <datalist id="purchasing-buyer-list">
              {buyerOptions.map(b => (
                <option
                  key={b.id || b.name || ''}
                  value={b.name ? (b.id ? `${b.name}（${b.id}）` : b.name) : b.id}
                  label={b.name ? undefined : `工號 ${b.id}`}
                />
              ))}
            </datalist>
            {([
              ['poFrom', 'poTo', '單號區間'],
              ['dueFrom', 'dueTo', '交期區間'],
              ['orderFrom', 'orderTo', '下單日區間'],
            ] as const).map(([fromKey, toKey, label]) => (
              <div key={label} className="col-span-2">
                <label className="block text-[10px] text-slate-500 mb-0.5">{label}</label>
                <div className="flex items-center gap-1.5">
                  <input
                    type={label === '單號區間' ? 'text' : 'date'}
                    value={filters[fromKey]}
                    onChange={setF(fromKey)}
                    placeholder="起"
                    className="flex-1 rounded bg-slate-900 border border-slate-700 px-2 py-1.5 text-xs text-white placeholder-slate-700 focus:outline-none focus:border-cyan-600 font-mono"
                  />
                  <span className="text-slate-600 text-xs">~</span>
                  <input
                    type={label === '單號區間' ? 'text' : 'date'}
                    value={filters[toKey]}
                    onChange={setF(toKey)}
                    placeholder="迄"
                    className="flex-1 rounded bg-slate-900 border border-slate-700 px-2 py-1.5 text-xs text-white placeholder-slate-700 focus:outline-none focus:border-cyan-600 font-mono"
                  />
                </div>
              </div>
            ))}
            <div className="col-span-2 md:col-span-4 lg:col-span-6 flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setFilters(EMPTY_FILTERS)}
                className="px-3 py-2 rounded bg-slate-800 hover:bg-slate-700 text-xs text-slate-400 transition-colors"
              >清除條件</button>
              <button
                type="button"
                onClick={handleSearch}
                disabled={loading}
                className="px-6 py-2 rounded bg-cyan-400 hover:bg-cyan-300 disabled:bg-slate-700 disabled:text-slate-500 text-sm font-bold text-slate-950 transition-colors shadow-[0_0_16px_rgba(34,211,238,0.35)]"
              >{loading ? '查詢中…' : '🔍 開始查詢'}</button>
            </div>
          </div>

          {/* ─── 工具列：精簡模式切換 ─── */}
          <div className="px-4 py-1.5 flex items-center gap-3 text-[11px] text-slate-500 border-b border-slate-800/60">
            <button
              type="button"
              onClick={() => setCompact(c => !c)}
              className={`px-2.5 py-1 rounded border transition-colors ${compact ? 'bg-cyan-900/50 border-cyan-600/60 text-cyan-300' : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-slate-200'}`}
            >{compact ? '✓ 精簡模式（一屏）' : '精簡模式（一屏）'}</button>
            <button
              type="button"
              onClick={() => setHideArrived(v => !v)}
              className={`px-2.5 py-1 rounded border transition-colors ${hideArrived ? 'bg-emerald-900/50 border-emerald-600/60 text-emerald-300' : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-slate-200'}`}
            >{hideArrived ? '✓ 排除已全部到倉' : '排除已全部到倉'}</button>
            <span className="w-px h-4 bg-slate-700" />
            <button
              type="button"
              onClick={() => {
                const next = cpFilter === 'only' ? 'all' : 'only'
                setCpFilter(next)
                if (searched) void fetchPage(1, appliedFilters, { sort: sortDue, cp: next, status: poStatus })
              }}
              className={`px-2.5 py-1 rounded border transition-colors ${cpFilter === 'only' ? 'bg-orange-900/50 border-orange-600/60 text-orange-300' : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-slate-200'}`}
            >{cpFilter === 'only' ? '✓ 只看常平' : '只看常平'}</button>
            <button
              type="button"
              onClick={() => {
                const next = cpFilter === 'exclude' ? 'all' : 'exclude'
                setCpFilter(next)
                if (searched) void fetchPage(1, appliedFilters, { sort: sortDue, cp: next, status: poStatus })
              }}
              className={`px-2.5 py-1 rounded border transition-colors ${cpFilter === 'exclude' ? 'bg-fuchsia-900/50 border-fuchsia-600/60 text-fuchsia-300' : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-slate-200'}`}
            >{cpFilter === 'exclude' ? '✓ 只看非常平' : '只看非常平'}</button>
            <span className="w-px h-4 bg-slate-700" />
            {/* 單據狀態（ARGO HOLD_STATUS）：伺服器端過濾，切換立即重查 */}
            {(['OPEN', 'CLOSE', 'VOID'] as const).map(s => (
              <button
                key={s}
                type="button"
                onClick={() => {
                  if (poStatus === s || loading) return
                  setPoStatus(s)
                  if (searched) void fetchPage(1, appliedFilters, { sort: sortDue, cp: cpFilter, status: s })
                }}
                title={`查詢 ${s} 狀態的採購單（切換後立即重新查詢）`}
                className={`px-2.5 py-1 rounded border transition-colors font-mono ${
                  poStatus === s
                    ? s === 'OPEN' ? 'bg-emerald-900/50 border-emerald-600/60 text-emerald-300'
                    : s === 'CLOSE' ? 'bg-slate-700 border-slate-500 text-slate-200'
                    : 'bg-rose-900/50 border-rose-600/60 text-rose-300'
                    : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-slate-200'
                }`}
              >{poStatus === s ? `✓ ${s}` : s}</button>
            ))}
            <span>點「交期」表頭可排序；拖表頭右緣調欄寬</span>
          </div>

          {/* ─── 追蹤列表（欄寬可拖拉表頭右緣調整、表頭固定、垂直/水平捲軸都在表格內常駐） ─── */}
          <div className="eip-scrollbar overflow-auto max-h-[calc(100vh-330px)] min-h-[260px]">
            <table ref={tableRef} className={`table-fixed ${compact ? 'text-[10px]' : 'text-xs'}`} style={{ width: Object.values(colW).reduce((a, b) => a + b, 0) }}>
              <colgroup>
                {LIST_COLS.map(c => (
                  <col key={c.key} ref={el => { colRefs.current[c.key] = el }} style={{ width: colW[c.key] }} />
                ))}
              </colgroup>
              <thead>
                <tr>
                  {LIST_COLS.map(c => {
                    const isSort = c.sortable
                    return (
                    <th
                      key={c.key}
                      onClick={isSort ? () => {
                        const next = sortDue === 'asc' ? 'desc' : sortDue === 'desc' ? null : 'asc'
                        setSortDue(next)
                        if (searched) void fetchPage(1, appliedFilters, { sort: next, cp: cpFilter, status: poStatus })
                      } : undefined}
                      className={`sticky top-0 z-10 bg-slate-900 border-b border-slate-700 border-r border-r-slate-700/80 px-2 py-2 whitespace-nowrap overflow-hidden text-slate-400 font-medium select-none ${c.right ? 'text-right' : c.center ? 'text-center' : 'text-left'} ${isSort ? 'cursor-pointer hover:text-cyan-300' : ''}`}
                      title={isSort ? '點擊依交期排序（升冪 / 降冪 / 取消）' : undefined}
                    >
                      {c.label}{isSort && (sortDue === 'asc' ? ' ▲' : sortDue === 'desc' ? ' ▼' : ' ⇅')}
                      <span
                        onMouseDown={e => { e.stopPropagation(); startResize(c.key, e) }}
                        title="拖拉調整欄寬"
                        className="absolute right-0 top-0 h-full w-2 cursor-col-resize hover:bg-cyan-500/60"
                      />
                    </th>
                    )
                  })}
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr><td colSpan={COLS} className="px-3 py-8 text-center text-slate-600">載入中…</td></tr>
                )}
                {!loading && !searched && (
                  <tr><td colSpan={COLS} className="px-3 py-8 text-center text-slate-600">
                    已預設帶入近兩個月下單日，請確認條件後點查詢列右下角的「🔍 開始查詢」。
                  </td></tr>
                )}
                {!loading && searched && paged.length === 0 && (
                  <tr><td colSpan={COLS} className="px-3 py-8 text-center text-slate-600">
                    {total === 0 ? '沒有符合查詢條件的採購單。' : '本頁明細已被「排除已到倉／請購單號」條件濾掉，請翻頁或調整條件。'}
                  </td></tr>
                )}
                {!loading && paged.map(l => {
                  const bucket = dueBucket(l)
                  return (
                    <tr key={lineKey(l)} className="border-b border-slate-800/40 hover:bg-slate-900/50 transition-colors align-top">
                      <td className="px-2 py-2 whitespace-nowrap overflow-hidden text-ellipsis">
                        <button
                          type="button"
                          onClick={() => setPoDetailNo(l.doc_no)}
                          title="點擊查看整張採購單明細"
                          className="font-mono text-cyan-300 hover:text-cyan-200 hover:underline"
                        >{l.doc_no}</button>
                      </td>
                      <td className="px-2 py-2 text-slate-500">{l.sub_no}</td>
                      <td className="px-2 py-2 overflow-hidden">
                        <span className="font-mono text-slate-200 break-all">{fmt(l.item_code)}</span>
                        {l.description && (
                          <span className="block text-slate-400 whitespace-normal break-words leading-snug">{l.description}</span>
                        )}
                      </td>
                      <td className="px-2 py-2 text-right text-white font-medium whitespace-nowrap overflow-hidden text-ellipsis">
                        {l.qty != null ? l.qty.toLocaleString() : '—'}
                        {l.unit ? <span className="text-slate-500 ml-1 font-normal">{l.unit}</span> : null}
                      </td>
                      <td className="px-2 py-2 text-slate-300 whitespace-nowrap overflow-hidden text-ellipsis text-center text-[13px]">
                        {l.buyer_id ?? l.buyer ?? '—'}
                        {l.buyer_id && l.buyer && <span className="block text-xs text-slate-200 mt-0.5">{l.buyer}</span>}
                      </td>
                      <td className="px-2 py-2 overflow-hidden">
                        <span className="font-mono text-slate-400">{fmt(l.vendor_code)}</span>
                        {l.vendor_name && (
                          <span className="block text-slate-300 whitespace-normal break-words leading-snug" title={l.vendor_name}>{l.vendor_name}</span>
                        )}
                      </td>
                      <td className="px-2 py-2 text-slate-400 whitespace-nowrap overflow-hidden text-ellipsis">{fmt(l.order_date)}</td>
                      <td className={`px-2 py-2 whitespace-nowrap overflow-hidden font-medium ${
                        l.shipped_at ? 'text-slate-500' :
                        bucket === 'red' ? 'text-red-400' :
                        bucket === 'amber' ? 'text-amber-400' :
                        bucket === 'yellow' ? 'text-yellow-300' : 'text-emerald-400'
                      }`}>
                        {fmt(l.due_date)}
                        {!l.shipped_at && l.due_days != null && l.due_days <= 10 && (
                          <span className="block text-[10px] font-normal opacity-80">
                            {l.due_days < 0 ? `逾期 ${-l.due_days} 天` : l.due_days === 0 ? '今天到期' : `剩 ${l.due_days} 天`}
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-2 font-mono text-sky-400/90 whitespace-nowrap overflow-hidden text-ellipsis">{fmt(l.so_no)}</td>
                      <td className="px-2 py-2 font-mono text-violet-300/90 whitespace-nowrap overflow-hidden text-ellipsis">
                        {l.pr_no ? `${l.pr_no}${l.pr_sub ? `-${l.pr_sub}` : ''}` : '—'}
                      </td>
                      <td className="px-2 py-2 overflow-hidden">{renderProgressCell(l)}</td>
                      <td className="px-2 py-2 overflow-hidden"><ReceiveCell l={l} /></td>
                      <td className="px-2 py-2 overflow-hidden">{renderPaymentCell(l)}</td>
                      <td className="px-2 py-2 overflow-hidden">
                        <div className="flex flex-col gap-1 items-start">
                          {renderShipMethodCell(l)}
                          {renderExpectedShipCell(l)}
                        </div>
                      </td>
                      <td className="px-2 py-2 overflow-hidden">
                        <NoteCell
                          value={l.note}
                          saving={savingKeys.has(lineKey(l))}
                          onSave={(next) => void updateLine(l, { note: next.trim() || null })}
                        />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {!loading && searched && total > 0 && (
            <div className="px-4 py-3 border-t border-slate-800/60 flex items-center gap-3 text-xs text-slate-500">
              <span>共 {total.toLocaleString()} 筆，本頁顯示 {paged.length} 筆（下單日 {appliedFilters.orderFrom || '—'} ~ {appliedFilters.orderTo || '—'}）</span>
              {totalPages > 1 && (
                <div className="ml-auto flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => goToPage(1)}
                    disabled={loading || safePage <= 1}
                    className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-300"
                  >« 第一頁</button>
                  <button
                    type="button"
                    onClick={() => goToPage(safePage - 1)}
                    disabled={loading || safePage <= 1}
                    className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-300"
                  >‹ 上一頁</button>
                  <span className="px-2 text-slate-400">第 {safePage} / {totalPages} 頁</span>
                  <button
                    type="button"
                    onClick={() => goToPage(safePage + 1)}
                    disabled={loading || safePage >= totalPages}
                    className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-300"
                  >下一頁 ›</button>
                  <button
                    type="button"
                    onClick={() => goToPage(totalPages)}
                    disabled={loading || safePage >= totalPages}
                    className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-300"
                  >最後頁 »</button>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {tab === 'due' && (
        <div className="px-4 py-4 flex flex-col gap-5">
          {loading && <p className="text-slate-600 text-xs py-8 text-center">載入中…</p>}
          {!loading && dueTotal === 0 && (
            <p className="text-slate-600 text-xs py-8 text-center">🎉 沒有 10 天內到期且未出貨的採購明細。</p>
          )}
          {!loading && ([
            ['red',    '⚠ 2 天內到期／已逾期', dueGroups.red,    'border-red-800 bg-red-950/30 text-red-300'],
            ['amber',  '5 天內到期',            dueGroups.amber,  'border-amber-800 bg-amber-950/30 text-amber-300'],
            ['yellow', '10 天內到期',           dueGroups.yellow, 'border-yellow-800 bg-yellow-950/20 text-yellow-200'],
          ] as const).map(([key, title, group, cls]) => group.length > 0 && (
            <section key={key} className={`rounded-lg border ${cls.split(' ').slice(0, 2).join(' ')}`}>
              <h2 className={`px-4 py-2.5 text-xs font-bold border-b border-inherit ${cls.split(' ')[2]}`}>
                {title}（{group.length}）
              </h2>
              <div className="eip-scrollbar overflow-x-auto">
                <table className="w-full text-xs min-w-[900px]">
                  <tbody>
                    {group.map(l => (
                      <tr key={lineKey(l)} className="border-b border-slate-800/40 last:border-0 hover:bg-slate-900/40">
                        <td className="px-4 py-2 whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => setPoDetailNo(l.doc_no)}
                            title="點擊查看整張採購單明細"
                            className="font-mono text-cyan-300 hover:text-cyan-200 hover:underline"
                          >{l.doc_no}-{l.sub_no}</button>
                        </td>
                        <td className="px-3 py-2 font-mono text-slate-300 whitespace-nowrap">{fmt(l.item_code)}</td>
                        <td className="px-3 py-2 text-slate-300 max-w-[240px] whitespace-normal break-words leading-snug">{fmt(l.description)}</td>
                        <td className="px-3 py-2 text-right text-white whitespace-nowrap">{l.qty != null ? l.qty.toLocaleString() : '—'}</td>
                        <td className="px-3 py-2 text-slate-400 whitespace-nowrap">{fmt(l.vendor_name ?? l.vendor_code)}</td>
                        <td className="px-3 py-2 whitespace-nowrap font-medium">
                          交期 {fmt(l.due_date)}
                          <span className="ml-1.5 opacity-80">
                            {l.due_days != null && (l.due_days < 0 ? `（逾期 ${-l.due_days} 天）` : l.due_days === 0 ? '（今天）' : `（剩 ${l.due_days} 天）`)}
                          </span>
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">{renderProgressCell(l)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
          {counts && !loading && (
            <p className="text-[10px] text-slate-600">
              統計：2 天內 {counts.due2}、3~5 天 {counts.due5}、6~10 天 {counts.due10}（未出貨明細）
            </p>
          )}
        </div>
      )}

      {/* ─── 整張採購單明細視窗（點單號開啟） ─── */}
      {poDetailNo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => setPoDetailNo(null)}>
          <div className="eip-scrollbar w-[900px] max-w-[96vw] max-h-[85vh] overflow-y-auto rounded-2xl bg-slate-900 border border-slate-700 shadow-2xl p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3 mb-1">
              <h3 className="text-lg font-semibold">採購單明細</h3>
              <span className="font-mono text-sm text-cyan-300">{poDetailNo}</span>
              <button
                onClick={() => setPoDetailNo(null)}
                className="ml-auto px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-xs"
              >關閉</button>
            </div>

            {poDetailLines.length === 0 ? (
              <p className="text-sm text-slate-500 py-6 text-center">此單目前沒有 OPEN 明細（可能已結案或未在查詢結果內）。</p>
            ) : (
              <>
                {/* 表頭資訊 */}
                <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-slate-400 mb-4">
                  <span>供應商：<span className="font-mono text-slate-300">{poDetailLines[0].vendor_code ?? '—'}</span>
                    {poDetailLines[0].vendor_name && <span className="text-slate-300">（{poDetailLines[0].vendor_name}）</span>}
                  </span>
                  <span>承辦人：<span className="text-slate-300">{poDetailLines[0].buyer_id ?? '—'}{poDetailLines[0].buyer ? ` ${poDetailLines[0].buyer}` : ''}</span></span>
                  <span>下單日：<span className="text-slate-300">{poDetailLines[0].order_date ?? '—'}</span></span>
                  <span>付款進度：<span className="text-cyan-300 font-semibold">{poDetailLines[0].payment_pct > 0 ? `已付 ${poDetailLines[0].payment_pct}%` : '未記錄'}</span></span>
                  <span>共 {poDetailLines.length} 條明細</span>
                </div>

                <div className="eip-scrollbar overflow-x-auto">
                  <table className="w-full text-xs min-w-[780px]">
                    <thead>
                      <tr className="border-b border-slate-700 text-slate-400">
                        <th className="px-2 py-2 text-left whitespace-nowrap">序</th>
                        <th className="px-2 py-2 text-left whitespace-nowrap">料號</th>
                        <th className="px-2 py-2 text-left">品名/規格</th>
                        <th className="px-2 py-2 text-right whitespace-nowrap">數量</th>
                        <th className="px-2 py-2 text-left whitespace-nowrap">交期</th>
                        <th className="px-2 py-2 text-left whitespace-nowrap">SO單號</th>
                        <th className="px-2 py-2 text-left whitespace-nowrap">請購單號</th>
                        <th className="px-2 py-2 text-left whitespace-nowrap">進度</th>
                        <th className="px-2 py-2 text-left whitespace-nowrap">入庫</th>
                        <th className="px-2 py-2 text-left whitespace-nowrap">出貨方式</th>
                        <th className="px-2 py-2 text-left whitespace-nowrap">預計出貨日</th>
                      </tr>
                    </thead>
                    <tbody>
                      {poDetailLines.map(l => (
                        <tr key={lineKey(l)} className="border-b border-slate-800/60 last:border-0">
                          <td className="px-2 py-2 text-slate-500">{l.sub_no}</td>
                          <td className="px-2 py-2 font-mono text-slate-300 whitespace-nowrap">{fmt(l.item_code)}</td>
                          <td className="px-2 py-2 text-slate-300 max-w-[220px] whitespace-normal break-words leading-snug">{fmt(l.description)}</td>
                          <td className="px-2 py-2 text-right text-white whitespace-nowrap">
                            {l.qty != null ? l.qty.toLocaleString() : '—'}
                            {l.unit ? <span className="text-slate-500 ml-1">{l.unit}</span> : null}
                          </td>
                          <td className="px-2 py-2 text-slate-300 whitespace-nowrap">{fmt(l.due_date)}</td>
                          <td className="px-2 py-2 font-mono text-sky-400/90 whitespace-nowrap">{fmt(l.so_no)}</td>
                          <td className="px-2 py-2 font-mono text-violet-300/90 whitespace-nowrap">{l.pr_no ? `${l.pr_no}${l.pr_sub ? `-${l.pr_sub}` : ''}` : '—'}</td>
                          <td className="px-2 py-2 whitespace-nowrap">
                            {(() => {
                              const m = milestoneOf(l)
                              const cls = m === '已到倉' ? 'bg-emerald-900/60 text-emerald-300 border-emerald-600/60'
                                : m === '已出貨' ? 'bg-amber-900/60 text-amber-300 border-amber-600/60'
                                : m === '已發單' ? 'bg-sky-900/60 text-sky-300 border-sky-600/60'
                                : 'bg-slate-800 text-slate-500 border-slate-700'
                              return <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold border ${cls}`}>{m}</span>
                            })()}
                          </td>
                          <td className="px-2 py-2 whitespace-nowrap"><ReceiveCell l={l} /></td>
                          <td className="px-2 py-2 text-slate-300 whitespace-nowrap">{l.ship_method ?? '—'}</td>
                          <td className="px-2 py-2 text-slate-300 whitespace-nowrap">{l.expected_ship_date ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-3 text-[10px] text-slate-600">狀態調整請回列表操作；此視窗僅供檢視整張單。</p>
              </>
            )}
          </div>
        </div>
      )}
    </main>
  )
}
