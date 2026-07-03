'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  DUE_THRESHOLDS,
  PAYMENT_PCTS,
  SHIP_METHODS,
  type DueCounts,
  type PaymentPct,
  type PoTrackingLine,
  type ShipMethod,
} from '../../lib/purchasing/types'

// 過濾後最多渲染筆數（防止一次畫上千列）
const RENDER_LIMIT = 500

const lineKey = (l: Pick<PoTrackingLine, 'doc_no' | 'sub_no'>) => `${l.doc_no}|${l.sub_no}`

const fmt = (v: string | null) => v ?? '—'

/** 到期分組：red = ≤2 天（含逾期）、amber = 3~5、yellow = 6~10 */
function dueBucket(l: PoTrackingLine): 'red' | 'amber' | 'yellow' | null {
  if (l.shipped_at || l.due_days == null || l.due_days > 10) return null
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
  poFrom: string
  poTo: string
  dueFrom: string
  dueTo: string
  orderFrom: string
  orderTo: string
}

const EMPTY_FILTERS: Filters = {
  vendorCode: '', vendorName: '', itemCode: '', prNo: '', buyer: '',
  poNo: '', poFrom: '', poTo: '', dueFrom: '', dueTo: '', orderFrom: '', orderTo: '',
}

const contains = (v: string | null, q: string) =>
  !q || (v ?? '').toLowerCase().includes(q.trim().toLowerCase())

function matchFilters(l: PoTrackingLine, f: Filters): boolean {
  if (!contains(l.vendor_code, f.vendorCode)) return false
  if (!contains(l.vendor_name, f.vendorName)) return false
  if (!contains(l.item_code, f.itemCode)) return false
  if (!contains(l.pr_no, f.prNo)) return false
  if (!contains(l.buyer, f.buyer)) return false
  if (!contains(l.doc_no, f.poNo)) return false
  if (f.poFrom && l.doc_no < f.poFrom.trim().toUpperCase()) return false
  if (f.poTo && l.doc_no > `${f.poTo.trim().toUpperCase()}￿`) return false
  if (f.dueFrom && (!l.due_date || l.due_date < f.dueFrom)) return false
  if (f.dueTo && (!l.due_date || l.due_date > f.dueTo)) return false
  if (f.orderFrom && (!l.order_date || l.order_date < f.orderFrom)) return false
  if (f.orderTo && (!l.order_date || l.order_date > f.orderTo)) return false
  return true
}

export default function PurchasingPage() {
  const [lines, setLines]       = useState<PoTrackingLine[]>([])
  const [counts, setCounts]     = useState<DueCounts | null>(null)
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState<string | null>(null)
  const [forbidden, setForbidden] = useState(false)
  const [tab, setTab]           = useState<'list' | 'due'>('list')
  const [filters, setFilters]   = useState<Filters>(EMPTY_FILTERS)
  const [savingKeys, setSavingKeys] = useState<Set<string>>(new Set())
  const [msg, setMsg]           = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/purchasing/list')
      if (res.status === 403) { setForbidden(true); return }
      const json = await res.json()
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`)
      setLines(json.lines as PoTrackingLine[])
      setCounts(json.counts as DueCounts)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const flash = (text: string) => {
    setMsg(text)
    setTimeout(() => setMsg(''), 3000)
  }

  const markSaving = (key: string, on: boolean) => {
    setSavingKeys(prev => {
      const next = new Set(prev)
      if (on) next.add(key)
      else next.delete(key)
      return next
    })
  }

  /** 更新明細層級狀態（已出貨 / 出貨方式 / 預計出貨日），成功後就地更新列 */
  const updateLine = useCallback(async (
    l: PoTrackingLine,
    patch: { shipped?: boolean; ship_method?: ShipMethod | null; expected_ship_date?: string | null },
  ) => {
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
      setLines(prev => prev.map(x => lineKey(x) !== key ? x : {
        ...x,
        shipped_at: patch.shipped === undefined ? x.shipped_at : (patch.shipped ? new Date().toISOString() : null),
        ship_method: patch.ship_method === undefined ? x.ship_method : patch.ship_method,
        expected_ship_date: patch.expected_ship_date === undefined ? x.expected_ship_date : patch.expected_ship_date,
      }))
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
      setLines(prev => prev.map(x => x.doc_no === docNo ? { ...x, payment_pct: pct } : x))
    } catch (e) {
      flash(`❌ 更新失敗：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      markSaving(`pay|${docNo}`, false)
    }
  }, [])

  const filtered = useMemo(() => lines.filter(l => matchFilters(l, filters)), [lines, filters])

  const dueGroups = useMemo(() => {
    const groups = { red: [] as PoTrackingLine[], amber: [] as PoTrackingLine[], yellow: [] as PoTrackingLine[] }
    for (const l of lines) {
      const b = dueBucket(l)
      if (b) groups[b].push(l)
    }
    for (const g of Object.values(groups)) g.sort((a, b) => (a.due_days ?? 0) - (b.due_days ?? 0))
    return groups
  }, [lines])

  const dueTotal = dueGroups.red.length + dueGroups.amber.length + dueGroups.yellow.length

  const setF = (k: keyof Filters) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setFilters(prev => ({ ...prev, [k]: e.target.value }))

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
    const shipped = Boolean(l.shipped_at)
    return (
      <div className="flex flex-col gap-1 min-w-[130px]">
        <div className="flex items-center gap-2">
          <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold border whitespace-nowrap ${
            shipped
              ? 'bg-emerald-900/60 text-emerald-400 border-emerald-700/50'
              : 'bg-amber-900/60 text-amber-400 border-amber-700/50'
          }`} title={shipped ? `已出貨 ${l.shipped_at?.slice(0, 10)}（${l.updated_by ?? '—'}）` : '已發給廠商，排程製作中'}>
            {shipped ? '已出貨' : '排程製作中'}
          </span>
          {shipped ? (
            <button
              type="button"
              disabled={saving}
              onClick={() => { if (window.confirm(`撤銷 ${l.doc_no}-${l.sub_no} 的已出貨標記？`)) void updateLine(l, { shipped: false }) }}
              className="text-[10px] text-slate-500 hover:text-slate-300 underline disabled:opacity-50"
            >撤銷</button>
          ) : (
            <button
              type="button"
              disabled={saving}
              onClick={() => { if (window.confirm(`標記 ${l.doc_no}-${l.sub_no}（${l.item_code ?? ''}）已出貨？\n標記後不再出現在到期提醒。`)) void updateLine(l, { shipped: true }) }}
              className="text-[10px] px-2 py-0.5 rounded bg-emerald-800 hover:bg-emerald-700 text-white font-semibold disabled:opacity-50 whitespace-nowrap"
            >已出貨</button>
          )}
        </div>
        {/* 進度條：排程製作中 50%、已出貨 100% */}
        <div className="h-1 w-full rounded-full bg-slate-800 overflow-hidden">
          <div className={`h-full rounded-full transition-all ${shipped ? 'w-full bg-emerald-500' : 'w-1/2 bg-amber-500'}`} />
        </div>
      </div>
    )
  }

  const renderPaymentCell = (l: PoTrackingLine) => {
    const saving = savingKeys.has(`pay|${l.doc_no}`)
    return (
      <div className="flex items-center gap-1" title="付款進度為整張採購單共用（同單各行同步）；再點一次目前的百分比可取消">
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

  const COLS = 15

  return (
    <main className="min-h-screen bg-slate-950 text-white">
      {/* ─── Header ─── */}
      <div className="border-b border-slate-800 bg-slate-900/60 backdrop-blur-sm px-4 py-3 flex items-center gap-4">
        <Link href="/" className="text-xs text-slate-500 hover:text-slate-300 transition-colors shrink-0">← 回首頁</Link>
        <h1 className="text-sm font-bold text-white">採購專區</h1>
        <span className="text-[10px] text-slate-600">OPEN 採購單追蹤（每小時自 ARGO 同步）</span>
        <div className="ml-auto flex items-center gap-3">
          {msg && <span className="text-xs text-rose-300">{msg}</span>}
          <button
            type="button"
            onClick={() => void load()}
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
          onClick={() => setTab('due')}
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
              ['vendorCode', '廠商代碼', 'text', '部分輸入'],
              ['vendorName', '廠商名稱', 'text', '部分輸入'],
              ['itemCode', '料號', 'text', '部分輸入'],
              ['prNo', '請購單號', 'text', '部分輸入'],
              ['buyer', '承辦人', 'text', '姓名或代號'],
              ['poNo', '採購單號', 'text', '部分輸入'],
            ] as const).map(([key, label, type, ph]) => (
              <div key={key}>
                <label className="block text-[10px] text-slate-500 mb-0.5">{label}</label>
                <input
                  type={type}
                  value={filters[key]}
                  onChange={setF(key)}
                  placeholder={ph}
                  className="w-full rounded bg-slate-900 border border-slate-700 px-2 py-1.5 text-xs text-white placeholder-slate-700 focus:outline-none focus:border-cyan-600 font-mono"
                />
              </div>
            ))}
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
            <div className="flex items-end">
              <button
                type="button"
                onClick={() => setFilters(EMPTY_FILTERS)}
                className="px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-xs text-slate-400 transition-colors"
              >清除條件</button>
            </div>
          </div>

          {/* ─── 追蹤列表 ─── */}
          <div className="overflow-x-auto">
            <table className="w-full text-xs min-w-[1450px]">
              <thead>
                <tr className="border-b border-slate-800 bg-slate-900/70 text-slate-400 font-medium">
                  <th className="px-3 py-2.5 text-left whitespace-nowrap">採購單號</th>
                  <th className="px-2 py-2.5 text-left whitespace-nowrap">序</th>
                  <th className="px-3 py-2.5 text-left whitespace-nowrap">料號</th>
                  <th className="px-3 py-2.5 text-left whitespace-nowrap">品名/規格</th>
                  <th className="px-3 py-2.5 text-right whitespace-nowrap">數量</th>
                  <th className="px-3 py-2.5 text-left whitespace-nowrap">供應商</th>
                  <th className="px-3 py-2.5 text-left whitespace-nowrap">下單日</th>
                  <th className="px-3 py-2.5 text-left whitespace-nowrap">交期</th>
                  <th className="px-3 py-2.5 text-left whitespace-nowrap">SO單號</th>
                  <th className="px-3 py-2.5 text-left whitespace-nowrap">請購單號</th>
                  <th className="px-3 py-2.5 text-left whitespace-nowrap">MO製令</th>
                  <th className="px-3 py-2.5 text-left whitespace-nowrap">承辦人</th>
                  <th className="px-3 py-2.5 text-left whitespace-nowrap">進度</th>
                  <th className="px-3 py-2.5 text-left whitespace-nowrap">付款</th>
                  <th className="px-3 py-2.5 text-left whitespace-nowrap">出貨方式 / 預計出貨日</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr><td colSpan={COLS} className="px-3 py-8 text-center text-slate-600">載入中…</td></tr>
                )}
                {!loading && filtered.length === 0 && (
                  <tr><td colSpan={COLS} className="px-3 py-8 text-center text-slate-600">
                    {lines.length === 0 ? '目前沒有 OPEN 的採購單。' : '沒有符合查詢條件的明細。'}
                  </td></tr>
                )}
                {!loading && filtered.slice(0, RENDER_LIMIT).map(l => {
                  const bucket = dueBucket(l)
                  return (
                    <tr key={lineKey(l)} className="border-b border-slate-800/40 hover:bg-slate-900/50 transition-colors">
                      <td className="px-3 py-2 whitespace-nowrap font-mono text-cyan-300">{l.doc_no}</td>
                      <td className="px-2 py-2 text-slate-500">{l.sub_no}</td>
                      <td className="px-3 py-2 font-mono text-slate-300 whitespace-nowrap">{fmt(l.item_code)}</td>
                      <td className="px-3 py-2 text-slate-300 max-w-[200px] truncate" title={l.description ?? ''}>{fmt(l.description)}</td>
                      <td className="px-3 py-2 text-right text-white font-medium whitespace-nowrap">
                        {l.qty != null ? l.qty.toLocaleString() : '—'}
                        {l.unit ? <span className="text-slate-500 ml-1 font-normal">{l.unit}</span> : null}
                      </td>
                      <td className="px-3 py-2 max-w-[160px]">
                        <span className="font-mono text-slate-400">{fmt(l.vendor_code)}</span>
                        {l.vendor_name && (
                          <span className="block text-slate-300 truncate" title={l.vendor_name}>{l.vendor_name}</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-slate-400 whitespace-nowrap">{fmt(l.order_date)}</td>
                      <td className={`px-3 py-2 whitespace-nowrap font-medium ${
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
                      <td className="px-3 py-2 font-mono text-sky-400/90 whitespace-nowrap">{fmt(l.so_no)}</td>
                      <td className="px-3 py-2 font-mono text-violet-300/90 whitespace-nowrap">
                        {l.pr_no ? `${l.pr_no}${l.pr_sub ? `-${l.pr_sub}` : ''}` : '—'}
                      </td>
                      <td className="px-3 py-2 font-mono text-slate-400 whitespace-nowrap">{fmt(l.mo_no)}</td>
                      <td className="px-3 py-2 text-slate-400 whitespace-nowrap">{fmt(l.buyer)}</td>
                      <td className="px-3 py-2">{renderProgressCell(l)}</td>
                      <td className="px-3 py-2">{renderPaymentCell(l)}</td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1.5">
                          {renderShipMethodCell(l)}
                          {renderExpectedShipCell(l)}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {!loading && filtered.length > 0 && (
            <div className="px-4 py-3 border-t border-slate-800/60 text-xs text-slate-600">
              符合 {filtered.length.toLocaleString()} 筆（全部 OPEN 明細 {lines.length.toLocaleString()} 筆）
              {filtered.length > RENDER_LIMIT && (
                <span className="text-amber-500 ml-2">已達 {RENDER_LIMIT} 筆顯示上限，請加上查詢條件縮小範圍</span>
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
              <div className="overflow-x-auto">
                <table className="w-full text-xs min-w-[900px]">
                  <tbody>
                    {group.map(l => (
                      <tr key={lineKey(l)} className="border-b border-slate-800/40 last:border-0 hover:bg-slate-900/40">
                        <td className="px-4 py-2 font-mono text-cyan-300 whitespace-nowrap">{l.doc_no}-{l.sub_no}</td>
                        <td className="px-3 py-2 font-mono text-slate-300 whitespace-nowrap">{fmt(l.item_code)}</td>
                        <td className="px-3 py-2 text-slate-300 max-w-[240px] truncate" title={l.description ?? ''}>{fmt(l.description)}</td>
                        <td className="px-3 py-2 text-right text-white whitespace-nowrap">{l.qty != null ? l.qty.toLocaleString() : '—'}</td>
                        <td className="px-3 py-2 text-slate-400 whitespace-nowrap">{fmt(l.vendor_name ?? l.vendor_code)}</td>
                        <td className="px-3 py-2 whitespace-nowrap font-medium">
                          交期 {fmt(l.due_date)}
                          <span className="ml-1.5 opacity-80">
                            {l.due_days != null && (l.due_days < 0 ? `（逾期 ${-l.due_days} 天）` : l.due_days === 0 ? '（今天）' : `（剩 ${l.due_days} 天）`)}
                          </span>
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <button
                            type="button"
                            disabled={savingKeys.has(lineKey(l))}
                            onClick={() => { if (window.confirm(`標記 ${l.doc_no}-${l.sub_no}（${l.item_code ?? ''}）已出貨？\n標記後不再出現在到期提醒。`)) void updateLine(l, { shipped: true }) }}
                            className="text-[10px] px-2.5 py-1 rounded bg-emerald-800 hover:bg-emerald-700 text-white font-semibold disabled:opacity-50"
                          >已出貨</button>
                        </td>
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
    </main>
  )
}
