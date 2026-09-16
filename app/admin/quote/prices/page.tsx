'use client'

/**
 * 後台 ② 材料價格表 /admin/quote/prices（設計書 §8-②）。
 *
 * GET /api/quote/admin/prices → AdminPriceRow[]；PUT 同路徑只送有改的列（id + 改過的欄位）。
 * 「抓 ERP 建議價」→ POST /api/quote/admin/erp-suggest（查 erp_pj_sync 最近採購單價）。
 * 幣別不同時只顯示換算值，一律要人工按「採用」才寫進單價，絕不自動覆寫。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AdminPriceRow, ErpSuggestion, QuoteSettingsMap } from '@/lib/quote/api'
import { adminFetch, cloneJson, fmtDate, fmtDateTime, fmtNum, fmtPct, pickArray, pickObject, todayISO } from '../_shared/api'
import { Btn, INPUT_SM_CLS, LoadingBlock, MONO, NotReadyBanner, Notice, NumInput, PageHeader, SaveBar, TD_CLS, TH_CLS } from '../_shared/ui'

const API = '/api/quote/admin/prices'
const API_SUGGEST = '/api/quote/admin/erp-suggest'
const API_SETTINGS = '/api/quote/admin/settings'

/** 可在表格直接改的欄位（其他欄位由匯入／系統維護） */
type EditableKey = 'display_name' | 'price' | 'argo_part_code' | 'effective_from' | 'note'
const EDITABLE: EditableKey[] = ['display_name', 'price', 'argo_part_code', 'effective_from', 'note']

/** 分區排序：設計書 §6 的 group 順序；沒列到的排最後 */
const GROUP_ORDER = ['板材', 'PET', '五金', '包材', '工序', '人工', '設備']
const groupRank = (g: string) => {
  const i = GROUP_ORDER.indexOf(g)
  return i < 0 ? 999 : i
}

type FxInfo = { rate: number; as_of: string } | null

/** 把 ERP 建議價換成該列幣別；同幣別直接回；跨幣別靠匯率（1 RMB = rate TWD） */
function convert(price: number, from: string, to: string, fx: FxInfo): number | null {
  const f = from.toUpperCase()
  const t = to.toUpperCase()
  const isRmb = (c: string) => c === 'RMB' || c === 'CNY'
  const isTwd = (c: string) => c === 'TWD' || c === 'NTD'
  if (f === t || (isRmb(f) && isRmb(t)) || (isTwd(f) && isTwd(t))) return price
  if (!fx || !(fx.rate > 0)) return null
  if (isTwd(f) && isRmb(t)) return price / fx.rate
  if (isRmb(f) && isTwd(t)) return price * fx.rate
  return null
}

function diffOf(row: AdminPriceRow, converted: number | null): { pct: number | null; changed: boolean } {
  if (converted == null || !(row.price > 0)) return { pct: null, changed: false }
  const pct = (converted - row.price) / row.price
  return { pct, changed: Math.abs(pct) > 1e-6 }
}

export default function QuotePricesPage() {
  const [loading, setLoading] = useState(true)
  const [notReady, setNotReady] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [okMsg, setOkMsg] = useState<string | null>(null)
  const [orig, setOrig] = useState<AdminPriceRow[]>([])
  const [rows, setRows] = useState<AdminPriceRow[]>([])
  const [fx, setFx] = useState<FxInfo>(null)
  /** 本次「抓 ERP 建議價」回來的建議（含 convertedPrice），以 itemId 為鍵 */
  const [suggestions, setSuggestions] = useState<Record<string, ErpSuggestion>>({})
  const [touchedDate, setTouchedDate] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const [suggesting, setSuggesting] = useState(false)
  const [filter, setFilter] = useState('')
  const [onlyDirty, setOnlyDirty] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const [r, s] = await Promise.all([
      adminFetch<Record<string, unknown>>(API),
      adminFetch<Record<string, unknown>>(API_SETTINGS),
    ])
    if (!r.ok) {
      if (r.notReady) setNotReady(r.error)
      else setError(r.error)
      setLoading(false)
      return
    }
    const list = pickArray<AdminPriceRow>(r.data, ['items', 'prices', 'rows', 'data'])
    setOrig(cloneJson(list))
    setRows(cloneJson(list))
    setTouchedDate(new Set())
    setNotReady(null)
    if (s.ok) {
      const map = pickObject<QuoteSettingsMap>(s.data, ['settings', 'values', 'map']) ?? (s.data as unknown as QuoteSettingsMap)
      setFx(map?.fx_rmb_twd ?? null)
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    const t = setTimeout(() => { void load() }, 0)
    return () => clearTimeout(t)
  }, [load])

  const origById = useMemo(() => new Map(orig.map((r) => [r.id, r])), [orig])

  const changedFields = useCallback((row: AdminPriceRow): Partial<Pick<AdminPriceRow, EditableKey>> => {
    const o = origById.get(row.id)
    if (!o) return {}
    const patch: Partial<Pick<AdminPriceRow, EditableKey>> = {}
    for (const k of EDITABLE) {
      const a = row[k] ?? null
      const b = o[k] ?? null
      if (k === 'price') {
        if (Number(a) !== Number(b)) patch.price = row.price
      } else if ((a === '' ? null : a) !== (b === '' ? null : b)) {
        ;(patch as Record<string, unknown>)[k] = a === '' ? null : a
      }
    }
    return patch
  }, [origById])

  const dirtyRows = useMemo(() => rows.filter((r) => Object.keys(changedFields(r)).length > 0), [rows, changedFields])
  const dirty = dirtyRows.length > 0

  const update = (id: string, patch: Partial<AdminPriceRow>) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }

  /** 改單價時，若使用者這次沒動過生效日，自動帶今天（設計書：改價要記 effective_from） */
  const setPrice = (row: AdminPriceRow, v: number) => {
    const patch: Partial<AdminPriceRow> = { price: v }
    const o = origById.get(row.id)
    if (!touchedDate.has(row.id) && o && Number(v) !== Number(o.price)) patch.effective_from = todayISO()
    if (!touchedDate.has(row.id) && o && Number(v) === Number(o.price)) patch.effective_from = o.effective_from
    update(row.id, patch)
  }

  const fetchSuggestions = async () => {
    const withCode = rows.filter((r) => (r.argo_part_code ?? '').trim())
    if (withCode.length === 0) {
      alert('沒有任何列填了 ARGO 料號，先填料號再抓。')
      return
    }
    if (dirty && !confirm('目前有未儲存的變更（含剛填的料號）。抓建議價會以「已儲存」的料號為準，要先儲存嗎？\n\n按「取消」先去儲存；按「確定」直接抓。')) return
    setSuggesting(true)
    setError(null)
    setOkMsg(null)
    const r = await adminFetch<Record<string, unknown>>(API_SUGGEST, { method: 'POST', body: { itemIds: withCode.map((x) => x.id) } })
    setSuggesting(false)
    if (!r.ok) {
      if (r.notReady) setNotReady(r.error)
      else setError(`抓 ERP 建議價失敗：${r.error}`)
      return
    }
    const list = pickArray<ErpSuggestion>(r.data, ['suggestions', 'items', 'results', 'data'])
    const map: Record<string, ErpSuggestion> = {}
    for (const s of list) map[s.itemId] = s
    setSuggestions(map)
    // 同步把建議價顯示到表格（route 通常也會寫回 erp_suggested_*；這裡先在畫面上反映）
    setRows((prev) => prev.map((row) => {
      const s = map[row.id]
      if (!s) return row
      return { ...row, erp_suggested_price: s.price, erp_suggested_currency: s.currency, erp_suggested_at: new Date().toISOString() }
    }))
    setOrig((prev) => prev.map((row) => {
      const s = map[row.id]
      if (!s) return row
      return { ...row, erp_suggested_price: s.price, erp_suggested_currency: s.currency, erp_suggested_at: new Date().toISOString() }
    }))
    setOkMsg(`已抓到 ${list.length} 筆 ERP 建議價（共送 ${withCode.length} 個料號）。請逐列檢查後按「採用」，再按「儲存變更」。`)
  }

  const save = async () => {
    if (!dirty) return
    const bad = dirtyRows.filter((r) => !Number.isFinite(r.price) || r.price < 0)
    if (bad.length) {
      alert(`有 ${bad.length} 列單價不是有效數字：\n${bad.map((r) => r.display_name || r.name).join('\n')}`)
      return
    }
    const badDate = dirtyRows.filter((r) => r.effective_from && !/^\d{4}-\d{2}-\d{2}$/.test(r.effective_from))
    if (badDate.length) {
      alert('生效日格式需為 YYYY-MM-DD')
      return
    }
    setSaving(true)
    setError(null)
    setOkMsg(null)
    const updates = dirtyRows.map((r) => ({ id: r.id, ...changedFields(r) }))
    const r = await adminFetch(API, { method: 'PUT', body: { rows: updates } })
    setSaving(false)
    if (!r.ok) {
      if (r.notReady) setNotReady(r.error)
      else setError(`儲存失敗：${r.error}`)
      return
    }
    setOkMsg(`已儲存 ${updates.length} 列。已發布品項的前台下一次試算即用新價；記得到「全域參數」更新費率版本字串。`)
    await load()
  }

  /* ---------------------------------------------------------------- 分區 */
  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const visible = rows.filter((r) => {
      if (onlyDirty && !dirtyRows.some((d) => d.id === r.id)) return false
      if (!q) return true
      return [r.name, r.display_name ?? '', r.group, r.argo_part_code ?? '', r.note ?? ''].some((s) => s.toLowerCase().includes(q))
    })
    const byGroup = new Map<string, AdminPriceRow[]>()
    for (const r of visible) {
      const g = r.group || '（未分組）'
      if (!byGroup.has(g)) byGroup.set(g, [])
      byGroup.get(g)!.push(r)
    }
    return [...byGroup.entries()]
      .sort((a, b) => groupRank(a[0]) - groupRank(b[0]) || a[0].localeCompare(b[0], 'zh-Hant'))
      .map(([g, list]) => [g, list.sort((a, b) => (a.display_name ?? a.name).localeCompare(b.display_name ?? b.name, 'zh-Hant'))] as const)
  }, [rows, filter, onlyDirty, dirtyRows])

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1700px] mx-auto text-slate-300 min-h-screen font-sans">
      <PageHeader
        title="材料價格表"
        subtitle="quote_price_items // 板材、PET、五金、包材、工序"
        current="/admin/quote/prices"
        actions={
          <>
            <span className="text-xs text-slate-500">
              匯率：{fx ? <span className={MONO}>1 RMB = {fx.rate} TWD（{fx.as_of}）</span> : <span className="text-yellow-300">未設定，跨幣別無法換算</span>}
            </span>
            <Btn onClick={() => { void fetchSuggestions() }} disabled={suggesting || loading || !!notReady}>{suggesting ? '查詢 ERP 中…' : '抓 ERP 建議價'}</Btn>
          </>
        }
      />

      {notReady && <NotReadyBanner message={notReady} />}
      {error && <Notice kind="error">{error}</Notice>}
      {okMsg && <Notice kind="ok">{okMsg}</Notice>}

      {loading ? (
        <LoadingBlock />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <input className={`${INPUT_SM_CLS} w-72`} placeholder="搜尋名稱／分組／料號／備註…" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <label className="inline-flex items-center gap-2 text-sm text-slate-400 cursor-pointer">
              <input type="checkbox" className="accent-amber-500" checked={onlyDirty} onChange={(e) => setOnlyDirty(e.target.checked)} />
              只看有改的（{dirtyRows.length}）
            </label>
            <span className="text-xs text-slate-500">共 {rows.length} 項 · {groups.length} 組</span>
          </div>

          {rows.length === 0 && <Notice kind="info">價格表是空的。可用「Excel 匯入」把 报价模板 v1.5.6 的 价格表 帶進來。</Notice>}

          {groups.map(([g, list]) => (
            <section key={g} className="bg-slate-900/50 border border-slate-700 rounded-xl mb-5 overflow-hidden">
              <div className="px-4 py-2 border-b border-slate-700 flex items-center gap-3">
                <h2 className="text-sm font-bold text-amber-500 uppercase tracking-wider">{g}</h2>
                <span className="text-xs text-slate-500">{list.length} 項</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1200px]">
                  <thead>
                    <tr>
                      <th className={TH_CLS}>名稱（顯示名 / Excel 原名）</th>
                      <th className={TH_CLS}>單位</th>
                      <th className={`${TH_CLS} text-right`}>單價</th>
                      <th className={TH_CLS}>幣別</th>
                      <th className={TH_CLS}>ARGO 料號</th>
                      <th className={TH_CLS}>ERP 建議價</th>
                      <th className={TH_CLS}>生效日</th>
                      <th className={TH_CLS}>備註</th>
                      <th className={TH_CLS}>更新</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((row) => {
                      const patch = changedFields(row)
                      const isDirty = Object.keys(patch).length > 0
                      const sug = suggestions[row.id]
                      const sugPrice = sug?.price ?? row.erp_suggested_price
                      const sugCur = sug?.currency ?? row.erp_suggested_currency ?? row.currency
                      const converted = sugPrice == null ? null
                        : sug?.convertedPrice != null ? sug.convertedPrice
                        : convert(sugPrice, sugCur, row.currency, fx)
                      const sameCur = sugPrice != null && convert(sugPrice, sugCur, row.currency, null) != null
                      const { pct, changed } = diffOf(row, converted)
                      const attrs = row.attrs ?? {}
                      const attrText = Object.entries(attrs).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}=${String(v)}`).join(' · ')
                      return (
                        <tr key={row.id} className={isDirty ? 'bg-yellow-950/20' : 'hover:bg-slate-800/40'}>
                          <td className={`${TD_CLS} min-w-[260px]`}>
                            <input
                              className={`${INPUT_SM_CLS} w-full ${'display_name' in patch ? 'border-yellow-600' : ''}`}
                              value={row.display_name ?? ''}
                              placeholder={row.name}
                              onChange={(e) => update(row.id, { display_name: e.target.value })}
                            />
                            <div className="text-[11px] text-slate-500 mt-0.5 truncate" title={row.name}>{row.name}{attrText ? ` ｜ ${attrText}` : ''}</div>
                          </td>
                          <td className={`${TD_CLS} whitespace-nowrap text-slate-400`}>{row.unit}</td>
                          <td className={`${TD_CLS} w-32`}>
                            <NumInput
                              className={`${INPUT_SM_CLS} w-full text-right ${'price' in patch ? 'border-yellow-600' : ''}`}
                              value={row.price}
                              onChange={(v) => setPrice(row, v)}
                            />
                          </td>
                          <td className={`${TD_CLS} ${MONO} text-slate-400`}>{row.currency}</td>
                          <td className={`${TD_CLS} w-40`}>
                            <input
                              className={`${INPUT_SM_CLS} w-full ${MONO} ${'argo_part_code' in patch ? 'border-yellow-600' : ''}`}
                              value={row.argo_part_code ?? ''}
                              placeholder="例 WMTKEYB-S"
                              onChange={(e) => update(row.id, { argo_part_code: e.target.value.trim().toUpperCase() })}
                            />
                          </td>
                          <td className={`${TD_CLS} min-w-[220px]`}>
                            {sugPrice == null ? (
                              <span className="text-xs text-slate-600">{(row.argo_part_code ?? '').trim() ? '尚未抓取' : '—'}</span>
                            ) : (
                              <div className="flex items-center gap-2 flex-wrap">
                                <div className="text-xs leading-tight">
                                  <div className={`${MONO} text-white`}>
                                    {fmtNum(sugPrice)} {sugCur}
                                    {!sameCur && converted != null && <span className="text-slate-400"> ≈ {fmtNum(converted)} {row.currency}</span>}
                                    {!sameCur && converted == null && <span className="text-yellow-300"> （無匯率，無法換算）</span>}
                                  </div>
                                  <div className="text-slate-500">
                                    {pct != null && (
                                      <span className={`${MONO} ${!changed ? 'text-slate-500' : pct > 0 ? 'text-red-300' : 'text-emerald-300'}`}>
                                        {pct > 0 ? '▲' : pct < 0 ? '▼' : '='} {fmtPct(pct)}
                                      </span>
                                    )}
                                    {sug?.docNo && <span> · {sug.docNo}{sug.date ? ` ${fmtDate(sug.date)}` : ''}</span>}
                                    {!sug && row.erp_suggested_at && <span> · 抓於 {fmtDate(row.erp_suggested_at)}</span>}
                                  </div>
                                </div>
                                <Btn
                                  size="sm"
                                  variant="ok"
                                  disabled={converted == null || !changed}
                                  title={converted == null ? '幣別不同且未設匯率，無法換算' : !changed ? '與現價相同' : `把單價改成 ${fmtNum(converted)} ${row.currency}`}
                                  onClick={() => {
                                    if (converted == null) return
                                    const v = Math.round(converted * 10000) / 10000
                                    if (!sameCur && !confirm(`ERP 是 ${sugCur}，將以匯率換算後的 ${v} ${row.currency} 填入單價，確定？`)) return
                                    setPrice(row, v)
                                  }}
                                >
                                  採用
                                </Btn>
                              </div>
                            )}
                          </td>
                          <td className={`${TD_CLS} w-36`}>
                            <input
                              type="date"
                              className={`${INPUT_SM_CLS} w-full ${MONO} ${'effective_from' in patch ? 'border-yellow-600' : ''}`}
                              value={row.effective_from ?? ''}
                              onChange={(e) => {
                                setTouchedDate((prev) => new Set(prev).add(row.id))
                                update(row.id, { effective_from: e.target.value || null })
                              }}
                            />
                          </td>
                          <td className={`${TD_CLS} min-w-[160px]`}>
                            <input
                              className={`${INPUT_SM_CLS} w-full ${'note' in patch ? 'border-yellow-600' : ''}`}
                              value={row.note ?? ''}
                              onChange={(e) => update(row.id, { note: e.target.value })}
                            />
                          </td>
                          <td className={`${TD_CLS} text-[11px] text-slate-500 whitespace-nowrap`} title={row.source_file ?? ''}>
                            {row.updated_by ?? '—'}<br />{fmtDateTime(row.updated_at)}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          ))}

          <SaveBar
            dirty={dirty}
            saving={saving}
            onSave={() => { void save() }}
            onReset={() => { setRows(cloneJson(orig)); setTouchedDate(new Set()) }}
            extra={dirty ? <span className="text-xs text-slate-400">{dirtyRows.length} 列待儲存（只送有改的欄位）</span> : undefined}
          />
        </>
      )}
    </div>
  )
}
