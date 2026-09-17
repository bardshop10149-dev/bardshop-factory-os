'use client'

/**
 * 後台 ② 材料價格表 /admin/quote/prices（設計書 §8-②）。
 *
 * GET /api/quote/admin/prices → AdminPriceRow[]；PUT 同路徑只送有改的列（id + 改過的欄位）。
 * 「抓 ERP 建議價」→ POST /api/quote/admin/erp-suggest（查 erp_pj_sync 最近採購單價）。
 * 幣別不同時只顯示換算值，一律要人工按「採用」才寫進單價，絕不自動覆寫。
 */
import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from 'react'
import type { AdminPriceRow, ErpSuggestion, QuoteSettingsMap } from '@/lib/quote/api'
import { adminFetch, cloneJson, fmtDate, fmtDateTime, fmtNum, fmtPct, pickArray, pickObject, todayISO } from '../_shared/api'
import { Btn, INPUT_SM_CLS, LoadingBlock, MONO, NotReadyBanner, Notice, PageHeader, SaveBar, TD_CLS, TH_CLS } from '../_shared/ui'

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

/** 板材類新增時要填的規格（存進 attrs；前台拼板靠 layout_w_cm／layout_h_cm） */
const BOARD_ATTR_FIELDS: { key: string; label: string; required?: boolean }[] = [
  { key: 'sheet_w_mm', label: '板寬 mm' },
  { key: 'sheet_h_mm', label: '板高 mm' },
  { key: 'thickness_mm', label: '厚度 mm' },
  { key: 'layout_w_cm', label: '套版寬 cm', required: true },
  { key: 'layout_h_cm', label: '套版高 cm', required: true },
]
const DEFAULT_UNIT: Record<string, string> = { 板材: '片', PET: '張', 五金: '個', 包材: '個', 工序: '盤', 人工: '小時', 設備: '月' }

/**
 * 單價欄：純文字框（inputMode=decimal），沒有上下箭頭——type=number 的箭頭在表格裡太容易誤點。
 * 空白或不是數字＝無效（紅框），交給頁面擋儲存；合法時才往上送數字。
 */
function PriceInput({ value, invalid, onChange, onInvalid, className = '' }: {
  value: number
  invalid: boolean
  onChange: (v: number) => void
  onInvalid: (bad: boolean) => void
  className?: string
}) {
  const [draft, setDraft] = useState(() => (Number.isFinite(value) ? String(value) : ''))
  // 外部改了值（例如按「採用」ERP 建議價）→ 同步顯示
  useEffect(() => {
    if (Number.isFinite(value) && Number(draft) !== value) setDraft(String(value))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])
  return (
    <input
      type="text"
      inputMode="decimal"
      autoComplete="off"
      className={`${INPUT_SM_CLS} ${MONO} text-right ${invalid ? 'border-red-500' : ''} ${className}`}
      value={draft}
      placeholder="必填"
      onChange={(e) => {
        const t = e.target.value.replace(/[，,\s]/g, '')
        setDraft(t)
        const n = Number(t)
        const ok = t !== '' && /^\d*\.?\d*$/.test(t) && Number.isFinite(n) && n >= 0
        onInvalid(!ok)
        if (ok) onChange(n)
      }}
    />
  )
}

/** 分組底下的「新增項目」表單（每個分組都能手動新增） */
function AddRowForm({ group, fx, onDone, onCancel }: {
  group: string
  fx: FxInfo
  onDone: (row: AdminPriceRow, devSeed: boolean) => void
  onCancel: () => void
}) {
  const isBoard = group === '板材'
  const [f, setF] = useState({ name: '', display_name: '', unit: DEFAULT_UNIT[group] ?? '個', price: '', currency: 'RMB', argo_part_code: '', note: '' })
  const [attrs, setAttrs] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const priceNum = Number(f.price)
  const priceOk = f.price.trim() !== '' && /^\d*\.?\d*$/.test(f.price.trim()) && Number.isFinite(priceNum) && priceNum >= 0
  const boardOk = !isBoard || BOARD_ATTR_FIELDS.filter((x) => x.required).every((x) => Number(attrs[x.key]) > 0)
  const canSubmit = f.name.trim() !== '' && priceOk && boardOk && !busy
  const set = (k: keyof typeof f) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF((prev) => ({ ...prev, [k]: e.target.value }))
  const submit = async () => {
    if (!canSubmit) return
    setBusy(true)
    setErr(null)
    const attrsOut: Record<string, number> = {}
    for (const [k, v] of Object.entries(attrs)) { const n = Number(v); if (v.trim() !== '' && Number.isFinite(n)) attrsOut[k] = n }
    const r = await adminFetch<{ row: AdminPriceRow; devSeed?: boolean }>(API, {
      method: 'POST',
      body: { row: { group, name: f.name.trim(), display_name: f.display_name.trim() || null, unit: f.unit.trim() || '個', price: priceNum, currency: f.currency, argo_part_code: f.argo_part_code.trim() || null, note: f.note.trim() || null, attrs: Object.keys(attrsOut).length ? attrsOut : null } },
    })
    setBusy(false)
    if (!r.ok) { setErr(r.error); return }
    const row = (r.data as { row?: AdminPriceRow }).row
    if (!row) { setErr('伺服器沒有回傳新增的列'); return }
    onDone(row, !!(r.data as { devSeed?: boolean }).devSeed)
  }
  const cls = `${INPUT_SM_CLS} w-full`
  return (
    <div className="px-4 py-3 border-b border-amber-900/60 bg-amber-950/20">
      <div className="text-xs text-amber-300 font-bold mb-2">新增「{group}」項目</div>
      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-2">
        <label className="xl:col-span-2 text-[11px] text-slate-400">名稱 *（引擎鍵，品項設定引用這個）<input className={cls} value={f.name} onChange={set('name')} placeholder={isBoard ? '例 亚克力板【挤压型】 [300mm * 400mm * 2.0]' : '例 银色D字扣'} /></label>
        <label className="text-[11px] text-slate-400">顯示名（選填）<input className={cls} value={f.display_name} onChange={set('display_name')} /></label>
        <label className="text-[11px] text-slate-400">單位<input className={cls} value={f.unit} onChange={set('unit')} /></label>
        <label className="text-[11px] text-slate-400">單價 *<input type="text" inputMode="decimal" className={`${cls} ${MONO} text-right ${f.price && !priceOk ? 'border-red-500' : ''}`} value={f.price} onChange={set('price')} placeholder="必填" /></label>
        <label className="text-[11px] text-slate-400">幣別<select className={cls} value={f.currency} onChange={set('currency')}><option value="RMB">RMB</option><option value="TWD">TWD{fx ? '' : '（未設匯率）'}</option></select></label>
        <label className="text-[11px] text-slate-400">ARGO 料號<input className={`${cls} ${MONO}`} value={f.argo_part_code} onChange={set('argo_part_code')} placeholder="例 WMTKEYB-S" /></label>
        <label className="text-[11px] text-slate-400">備註<input className={cls} value={f.note} onChange={set('note')} /></label>
        {isBoard && BOARD_ATTR_FIELDS.map((x) => (
          <label key={x.key} className="text-[11px] text-slate-400">{x.label}{x.required ? ' *' : ''}<input type="text" inputMode="decimal" className={`${cls} ${MONO}`} value={attrs[x.key] ?? ''} onChange={(e) => setAttrs((prev) => ({ ...prev, [x.key]: e.target.value }))} /></label>
        ))}
      </div>
      {isBoard && <div className="text-[11px] text-slate-500 mt-1">套版可用範圍＝板材扣邊後能排版的區域（300×400 板是 29×39 cm），前台拼板靠這兩格；沒填不能新增。</div>}
      {err && <div className="text-xs text-red-300 mt-2">※ {err}</div>}
      <div className="flex gap-2 mt-2">
        <Btn size="sm" variant="primary" disabled={!canSubmit} onClick={() => { void submit() }}>{busy ? '新增中…' : '新增'}</Btn>
        <Btn size="sm" onClick={onCancel} disabled={busy}>取消</Btn>
        {!priceOk && f.price && <span className="text-xs text-red-300 self-center">單價必須是 ≥ 0 的數字</span>}
      </div>
    </div>
  )
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
  /** 單價欄空白或不是數字的列（擋儲存） */
  const [invalidPrice, setInvalidPrice] = useState<Set<string>>(new Set())
  /** 正在展開「新增項目」表單的分組 */
  const [adding, setAdding] = useState<string | null>(null)
  const markInvalid = (id: string, bad: boolean) => setInvalidPrice((prev) => {
    if (prev.has(id) === bad) return prev
    const next = new Set(prev)
    if (bad) next.add(id); else next.delete(id)
    return next
  })
  /** 新增成功：同時放進 orig 與 rows（不算未儲存變更） */
  const appendRow = (row: AdminPriceRow, devSeed: boolean) => {
    setOrig((prev) => [...prev, row])
    setRows((prev) => [...prev, row])
    setAdding(null)
    setOkMsg(devSeed ? `已新增「${row.display_name || row.name}」（開發 seed 模式：只在畫面上，未寫入資料庫）` : `已新增「${row.display_name || row.name}」，生效日 ${row.effective_from ?? ''}。要讓品項用得到，記得到「品項維護」把它加進該品項的選項。`)
  }

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
    if (invalidPrice.size > 0) {
      const names = rows.filter((r) => invalidPrice.has(r.id)).map((r) => r.display_name || r.name)
      alert(`有 ${invalidPrice.size} 列單價空白或不是數字（單價為必填）：\n${names.join('\n')}`)
      return
    }
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
                <div className="flex-1" />
                <Btn size="sm" onClick={() => setAdding(adding === g ? null : g)}>{adding === g ? '收起新增' : '＋ 新增項目'}</Btn>
              </div>
              {adding === g && <AddRowForm group={g} fx={fx} onDone={appendRow} onCancel={() => setAdding(null)} />}
              <div className="overflow-x-auto">
                {/* 欄寬用 colgroup 釘死：名稱夠用就好、單價要看得到整個數字、料號要放得下 WMTKEYB-S 這種、ERP 建議價不用太寬 */}
                <table className="w-full min-w-[1360px] table-fixed">
                  <colgroup>
                    <col className="w-[24%]" />
                    <col className="w-[52px]" />
                    <col className="w-[118px]" />
                    <col className="w-[56px]" />
                    <col className="w-[210px]" />
                    <col className="w-[170px]" />
                    <col className="w-[150px]" />
                    <col className="w-[160px]" />
                    <col className="w-[120px]" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th className={TH_CLS}>名稱（顯示名 / Excel 原名）</th>
                      <th className={TH_CLS}>單位</th>
                      <th className={`${TH_CLS} text-right`}>單價 *</th>
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
                          <td className={TD_CLS}>
                            <input
                              className={`${INPUT_SM_CLS} w-full ${'display_name' in patch ? 'border-yellow-600' : ''}`}
                              value={row.display_name ?? ''}
                              placeholder={row.name}
                              onChange={(e) => update(row.id, { display_name: e.target.value })}
                            />
                            <div className="text-[11px] text-slate-500 mt-0.5 truncate" title={row.name}>{row.name}{attrText ? ` ｜ ${attrText}` : ''}</div>
                          </td>
                          <td className={`${TD_CLS} whitespace-nowrap text-slate-400`}>{row.unit}</td>
                          <td className={TD_CLS}>
                            <PriceInput
                              className={`w-full ${'price' in patch ? 'border-yellow-600' : ''}`}
                              value={row.price}
                              invalid={invalidPrice.has(row.id)}
                              onChange={(v) => setPrice(row, v)}
                              onInvalid={(bad) => markInvalid(row.id, bad)}
                            />
                          </td>
                          <td className={`${TD_CLS} ${MONO} text-slate-400`}>{row.currency}</td>
                          <td className={TD_CLS}>
                            <input
                              className={`${INPUT_SM_CLS} w-full ${MONO} ${'argo_part_code' in patch ? 'border-yellow-600' : ''}`}
                              value={row.argo_part_code ?? ''}
                              placeholder="例 WMTKEYB-S"
                              onChange={(e) => update(row.id, { argo_part_code: e.target.value.trim().toUpperCase() })}
                            />
                          </td>
                          <td className={TD_CLS}>
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
                          <td className={TD_CLS}>
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
                          <td className={TD_CLS}>
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
            extra={invalidPrice.size > 0 ? <span className="text-xs text-red-300">{invalidPrice.size} 列單價空白或不是數字，儲存前請補上</span> : dirty ? <span className="text-xs text-slate-400">{dirtyRows.length} 列待儲存（只送有改的欄位）</span> : undefined}
          />
        </>
      )}
    </div>
  )
}
