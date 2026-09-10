'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'

/**
 * 商品開發 —— 新品項編碼建立申請
 *
 * 商開在這裡填申請，送出後由建檔人員在 ARGO（IFAF007 料件主檔）實際建立編碼，
 * 再回到「申請進度」回填實際編碼結案。本頁不會寫入 ARGO。
 *
 * 「引用類似品項」是本頁的重點：直接把既有品項的 ERP 設定原封不動複製過來，
 * 會計科目 / 庫存類型 / 預設倉這些一填錯就會出事的欄位，就不必靠商開自己判斷。
 */

// ── 型別 ─────────────────────────────────────────────
interface PartRow { [key: string]: string | number | null }

interface RequestRow {
  id: number
  request_no: string
  status: 'pending' | 'created' | 'rejected'
  requester_email: string
  requester_name: string | null
  requested_at: string
  template_part: string | null
  part_name: string
  part_desc: string | null
  unit_of_measure: string
  product_category: string
  product_category_2: string
  source_type: string | null
  inventory_type: string | null
  cost_category: string | null
  leadtime_flag: string | null
  bom_warehouse_id: string | null
  lot_no_flag: string | null
  expense_flag: string | null
  level_code_inv: string | null
  account_no_inv: string | null
  safety_qty: number | null
  validdate: string | null
  suggested_part: string | null
  note: string
  reference_url: string | null
  assigned_part: string | null
  handled_by: string | null
  handled_at: string | null
  reject_reason: string | null
}

type FormState = {
  template_part: string
  part_name: string
  part_desc: string
  unit_of_measure: string
  product_category: string
  product_category_2: string
  source_type: string
  inventory_type: string
  cost_category: string
  leadtime_flag: string
  bom_warehouse_id: string
  lot_no_flag: string
  expense_flag: string
  level_code_inv: string
  account_no_inv: string
  safety_qty: string
  validdate: string
  suggested_part: string
  note: string
  reference_url: string
}

const EMPTY_FORM: FormState = {
  template_part: '', part_name: '', part_desc: '', unit_of_measure: '',
  product_category: '', product_category_2: '',
  source_type: '', inventory_type: '', cost_category: '', leadtime_flag: '',
  bom_warehouse_id: '', lot_no_flag: '', expense_flag: '',
  level_code_inv: '', account_no_inv: '', safety_qty: '', validdate: '',
  suggested_part: '', note: '', reference_url: '',
}

// ── 選項（取自 ARGO 現有品項的實際用法統計）────────────
/**
 * 大類 = 料號第一碼 = ARGO PRODUCT_CATEGORY。
 * defaults 是該類「目前 ARGO 上最常見」的設定組合，只作參考預填；
 * 真正可靠的來源是引用既有品項 —— 例外不少（例如 S 類就有四種存貨科目）。
 */
const CATEGORIES: {
  code: string
  label: string
  hint: string
  defaults: Partial<FormState>
}[] = [
  {
    code: 'M', label: 'M — 材料', hint: '採購原料，進 FS100 倉',
    defaults: { source_type: 'B', inventory_type: 'M', cost_category: 'M', leadtime_flag: 'PURCHASE', bom_warehouse_id: 'FS100', lot_no_flag: 'N', expense_flag: 'N', level_code_inv: '1148', account_no_inv: '1315' },
  },
  {
    code: 'W', label: 'W — 耗材／輔料', hint: '消耗性物料，成本類別 M_MRO',
    defaults: { source_type: 'B', inventory_type: 'M', cost_category: 'M_MRO', leadtime_flag: 'PURCHASE', bom_warehouse_id: 'FS100', lot_no_flag: 'N', expense_flag: 'N', level_code_inv: '1148', account_no_inv: '1316' },
  },
  {
    code: 'P', label: 'P — 自製成品', hint: '本廠生產，批號控管',
    defaults: { source_type: 'B', inventory_type: 'FINSHED_GOODS', cost_category: 'FINSHED_GOODS', leadtime_flag: 'MANUFACTURE', bom_warehouse_id: 'FS100', lot_no_flag: 'Y', expense_flag: 'N', level_code_inv: '1143', account_no_inv: '1311' },
  },
  {
    code: 'C', label: 'C — 採購成品', hint: '外購成品／半成品，批號控管',
    defaults: { source_type: 'B', inventory_type: 'P', cost_category: 'P', leadtime_flag: 'PURCHASE', bom_warehouse_id: 'FS100', lot_no_flag: 'Y', expense_flag: 'N', level_code_inv: '1141', account_no_inv: '1301' },
  },
  {
    code: 'S', label: 'S — 費用（加工／服務）', hint: '費用類，進 FEXP 費用倉',
    defaults: { source_type: 'B', inventory_type: 'P', cost_category: 'P', leadtime_flag: 'PURCHASE', bom_warehouse_id: 'FEXP', lot_no_flag: 'N', expense_flag: 'Y', level_code_inv: '515', account_no_inv: '5736' },
  },
  {
    code: 'A', label: 'A — 費用（其他）', hint: '費用類，進 FEXP 費用倉',
    defaults: { source_type: 'P', inventory_type: 'P', cost_category: 'P', leadtime_flag: 'PURCHASE', bom_warehouse_id: 'FEXP', lot_no_flag: 'N', expense_flag: 'Y', level_code_inv: '62', account_no_inv: '6288' },
  },
  {
    code: 'O', label: 'O — 委外', hint: '委外生產品項',
    defaults: { source_type: 'P', inventory_type: 'FINSHED_GOODS', cost_category: 'FINSHED_GOODS', leadtime_flag: 'MANUFACTURE', bom_warehouse_id: '', lot_no_flag: 'N', expense_flag: 'N', level_code_inv: '1143', account_no_inv: '1311' },
  },
]

const UNITS = ['個', '片', 'PCS', '張', '次', '罐', '包', '支', '瓶', '條', '串', '組', '盒', '卷', '式', '版', '箱', '桶', '公斤', 'M', '碼', '才', '幅']

/** 各大類目前在用的次類別（PRODUCT_CATEGORY_2）；可自行輸入新的 */
const SUBCATEGORIES: Record<string, string[]> = {
  M: ['MACR', 'M3C', 'MBG'],
  W: ['WMT', 'WPR', 'WPAC', 'WPA', 'WACR', 'WGL', 'WCL', 'WAC', 'WPEGE', 'W3C', 'WEPSO', 'WNOMA', 'WBG', 'WFAB', 'WLEA'],
  P: ['PACR', 'P3C', 'PAC', 'PBG', 'PCOM'],
  C: ['CACR', 'C3C', 'CBG', 'CCL', 'CBOT', 'CAC', 'CFAB', 'CAD', 'CCUS', 'CCOA', 'CCOM', 'CEE', 'CPR', 'CCAN', 'CUP', 'CEMK'],
  S: ['SSC', 'SSE', 'SAF', 'S'],
  A: ['ADC', 'SV'],
  O: ['OSSC'],
}

/** 表單上的 ERP 設定欄位；label 給人看，erp 給建檔人員對照 ARGO 欄位 */
const ERP_FIELDS: { key: keyof FormState; label: string; erp: string; options?: string[]; placeholder?: string }[] = [
  { key: 'source_type', label: '來源型態', erp: 'SOURCE_TYPE', options: ['B', 'P'] },
  { key: 'inventory_type', label: '庫存類型', erp: 'INVENTORY_TYPE', options: ['M', 'P', 'FINSHED_GOODS'] },
  { key: 'cost_category', label: '成本類別', erp: 'COST_CATEGORY', options: ['M', 'M_MRO', 'P', 'FINSHED_GOODS'] },
  { key: 'leadtime_flag', label: '前置時間類別', erp: 'LEADTIME_FLAG', options: ['PURCHASE', 'MANUFACTURE'] },
  { key: 'bom_warehouse_id', label: '預設倉', erp: 'BOM_WAREHOUSE_ID', options: ['FS100', 'FEXP'] },
  { key: 'lot_no_flag', label: '批號控管', erp: 'LOT_NO_FLAG', options: ['Y', 'N'] },
  { key: 'expense_flag', label: '費用類', erp: 'EXPENSE_FLAG', options: ['Y', 'N'] },
  { key: 'level_code_inv', label: '存貨科目層級', erp: 'LEVEL_CODE_INV', placeholder: '1148' },
  { key: 'account_no_inv', label: '存貨會計科目', erp: 'ACCOUNT_NO_INV', placeholder: '1315' },
  { key: 'safety_qty', label: '安全庫存', erp: 'SAFETY_QTY', placeholder: '留空＝不設' },
  { key: 'validdate', label: '生效日', erp: 'VALIDDATE', placeholder: '2026/09/10' },
]

const STATUS_META: Record<RequestRow['status'], { label: string; cls: string }> = {
  pending: { label: '待建檔', cls: 'bg-amber-900/50 text-amber-300 border-amber-700/60' },
  created: { label: '已建檔', cls: 'bg-emerald-900/50 text-emerald-300 border-emerald-700/60' },
  rejected: { label: '已退回', cls: 'bg-rose-900/50 text-rose-300 border-rose-700/60' },
}

const s = (v: string | number | null | undefined) => (v === null || v === undefined ? '' : String(v).trim())

/** 今天（台灣），ARGO 的日期是 YYYY/MM/DD 斜線字串 */
function todayTW(): string {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, '/')
}

function fmtTime(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

// ── 頁面 ─────────────────────────────────────────────
export default function ItemCodeRequestPage() {
  const [tab, setTab] = useState<'form' | 'list'>('form')
  const [forbidden, setForbidden] = useState(false)

  // 申請表單
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [formMsg, setFormMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  // 引用範本
  const [keyword, setKeyword] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchMsg, setSearchMsg] = useState('')
  const [results, setResults] = useState<PartRow[]>([])
  const [template, setTemplate] = useState<PartRow | null>(null)

  // 申請清單
  const [rows, setRows] = useState<RequestRow[]>([])
  const [me, setMe] = useState('')
  const [loadingList, setLoadingList] = useState(false)
  const [statusFilter, setStatusFilter] = useState<'' | RequestRow['status']>('')
  const [mineOnly, setMineOnly] = useState(false)
  const [expanded, setExpanded] = useState<number | null>(null)
  const [listMsg, setListMsg] = useState('')

  const set = useCallback(<K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm(prev => ({ ...prev, [key]: value }))
  }, [])

  const currentCategory = useMemo(
    () => CATEGORIES.find(c => c.code === form.product_category) ?? null,
    [form.product_category],
  )

  // ── 引用：搜尋既有品項 ──
  const runSearch = useCallback(async () => {
    const q = keyword.trim()
    if (q.length < 2) { setSearchMsg('請輸入至少 2 個字元'); return }
    setSearching(true); setSearchMsg(''); setResults([])
    try {
      const res = await fetch('/api/product-dev/part-lookup?q=' + encodeURIComponent(q))
      if (res.status === 403) { setForbidden(true); return }
      const json = await res.json()
      if (!res.ok || !json.success) throw new Error(json.error || '查詢失敗')
      setResults(json.parts ?? [])
      if (!json.parts?.length) setSearchMsg('查無符合的品項，可直接往下手動填寫')
    } catch (err) {
      setSearchMsg(err instanceof Error ? err.message : '查詢失敗')
    } finally {
      setSearching(false)
    }
  }, [keyword])

  // ── 引用：把範本的 ERP 設定整組帶進表單 ──
  const applyTemplate = useCallback(async (part: string) => {
    setSearchMsg('')
    try {
      const res = await fetch('/api/product-dev/part-lookup?part=' + encodeURIComponent(part))
      if (res.status === 403) { setForbidden(true); return }
      const json = await res.json()
      if (!res.ok || !json.success) throw new Error(json.error || '取得品項設定失敗')
      const p = json.part as PartRow
      setTemplate(p)
      setForm(prev => ({
        ...prev,
        template_part: s(p.PART),
        // 品名／規格只在還沒填時帶入：新品項通常要改，但空白時給個起點比較好改
        part_name: prev.part_name || s(p.PART_NAME),
        part_desc: prev.part_desc || s(p.PART_DESC),
        unit_of_measure: s(p.UNIT_OF_MEASURE),
        product_category: s(p.PRODUCT_CATEGORY),
        product_category_2: s(p.PRODUCT_CATEGORY_2),
        source_type: s(p.SOURCE_TYPE),
        inventory_type: s(p.INVENTORY_TYPE),
        cost_category: s(p.COST_CATEGORY),
        leadtime_flag: s(p.LEADTIME_FLAG),
        bom_warehouse_id: s(p.BOM_WAREHOUSE_ID),
        lot_no_flag: s(p.LOT_NO_FLAG) || 'N',
        expense_flag: s(p.EXPENSE_FLAG),
        level_code_inv: s(p.LEVEL_CODE_INV),
        account_no_inv: s(p.ACCOUNT_NO_INV),
        // 安全庫存與生效日刻意不沿用範本：
        // 安全庫存是該品項專屬的營運數字，照抄會讓 MRP 依別人的量補料；
        // 生效日照抄會帶進一個過去的日期。兩者都改成「這個新品項自己的值」。
        safety_qty: '',
        validdate: todayTW(),
      }))
      setResults([])
      setFormMsg({ kind: 'ok', text: '已引用 ' + s(p.PART) + ' 的設定，請改成新品項的名稱與規格' })
    } catch (err) {
      setSearchMsg(err instanceof Error ? err.message : '取得品項設定失敗')
    }
  }, [])

  const clearTemplate = useCallback(() => {
    setTemplate(null)
    set('template_part', '')
  }, [set])

  /** 沒有範本可引用時的備援：套用該大類目前最常見的設定 */
  const applyCategoryDefaults = useCallback(() => {
    if (!currentCategory) return
    setForm(prev => ({ ...prev, ...currentCategory.defaults }))
    setFormMsg({ kind: 'ok', text: currentCategory.code + ' 類常見設定已套用，請確認是否符合這個品項' })
  }, [currentCategory])

  // ── 送出申請 ──
  const submit = useCallback(async () => {
    setFormMsg(null)
    const missing = [
      ['part_name', '品項名稱'], ['unit_of_measure', '單位'],
      ['product_category', '產品大類'], ['product_category_2', '產品次類別'], ['note', '用途說明'],
    ].filter(([k]) => !form[k as keyof FormState].trim())
    if (missing.length) {
      setFormMsg({ kind: 'err', text: '尚未填寫：' + missing.map(m => m[1]).join('、') })
      return
    }
    setSubmitting(true)
    try {
      const res = await fetch('/api/product-dev/item-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      if (res.status === 403) { setForbidden(true); return }
      const json = await res.json()
      if (!res.ok || !json.success) throw new Error(json.error || '送出失敗')
      setFormMsg({ kind: 'ok', text: '已送出，申請單號 ' + json.row.request_no + '。建檔完成後會在「申請進度」看到品項編碼。' })
      setForm(EMPTY_FORM)
      setTemplate(null)
      setKeyword('')
    } catch (err) {
      setFormMsg({ kind: 'err', text: err instanceof Error ? err.message : '送出失敗' })
    } finally {
      setSubmitting(false)
    }
  }, [form])

  // ── 申請清單 ──
  const loadList = useCallback(async () => {
    setLoadingList(true); setListMsg('')
    try {
      const params = new URLSearchParams()
      if (statusFilter) params.set('status', statusFilter)
      if (mineOnly) params.set('mine', '1')
      const res = await fetch('/api/product-dev/item-request?' + params.toString())
      if (res.status === 403) { setForbidden(true); return }
      const json = await res.json()
      if (!res.ok || !json.success) throw new Error(json.error || '讀取失敗')
      setRows(json.rows ?? [])
      setMe(json.me ?? '')
    } catch (err) {
      setListMsg(err instanceof Error ? err.message : '讀取失敗')
    } finally {
      setLoadingList(false)
    }
  }, [statusFilter, mineOnly])

  useEffect(() => { if (tab === 'list') loadList() }, [tab, loadList])

  const patchRequest = useCallback(async (body: Record<string, unknown>) => {
    setListMsg('')
    try {
      const res = await fetch('/api/product-dev/item-request', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json()
      if (!res.ok || !json.success) throw new Error(json.error || '更新失敗')
      setRows(prev => prev.map(r => (r.id === json.row.id ? json.row : r)))
    } catch (err) {
      setListMsg(err instanceof Error ? err.message : '更新失敗')
    }
  }, [])

  if (forbidden) {
    return (
      <main className="min-h-screen bg-slate-950 text-white flex flex-col items-center justify-center gap-4">
        <div className="text-4xl">🔒</div>
        <p className="text-slate-300 text-sm">此功能僅開放商品開發人員使用，請聯絡管理員開通「商品開發」權限。</p>
        <Link href="/" className="text-emerald-400 text-sm hover:underline">← 回首頁</Link>
      </main>
    )
  }

  const inputCls = 'w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-emerald-500 focus:outline-none'
  const labelCls = 'block text-xs text-slate-400 mb-1'

  return (
    <main className="min-h-screen bg-slate-950 text-white">
      {/* ─── Header ─── */}
      <div className="border-b border-slate-800 bg-slate-900/60 backdrop-blur-sm px-4 py-3 flex items-center gap-4 sticky top-0 z-20">
        <Link href="/" className="text-xs text-slate-500 hover:text-slate-300 transition-colors shrink-0">← 回首頁</Link>
        <h1 className="text-sm font-bold text-white">新品項編碼申請</h1>
        <span className="hidden md:inline text-[10px] text-slate-600">商品開發專區 · 送出後由建檔人員在 ARGO 建立編碼</span>
        <div className="ml-auto flex gap-1">
          {([['form', '填寫申請'], ['list', '申請進度']] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={'px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ' + (
                tab === key ? 'bg-emerald-700/40 text-emerald-300 border border-emerald-600' : 'text-slate-400 border border-transparent hover:text-slate-200'
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'form' ? (
        <div className="max-w-4xl mx-auto px-4 py-6 flex flex-col gap-5">

          {/* 對照 ARGO-TOOL 建請購單的說明框：講清楚對應哪支 ARGO 作業、送出後會發生什麼 */}
          <div className="bg-sky-950/40 border border-sky-800/60 rounded-xl px-4 py-3 text-xs text-slate-300 leading-relaxed">
            對應 ARGO 料件主檔 <span className="font-mono text-sky-300">IFAF007 ／ BOMF027</span>。
            標 <span className="text-rose-400">＊</span> 為必填。
            送出後<span className="text-white">不會直接寫入 ARGO</span> —— 由建檔人員照這張申請單在 ARGO 建立編碼，
            再回「申請進度」填入實際編碼結案。
          </div>

          {/* ── 1. 引用類似品項 ── */}
          <section className="bg-slate-900/60 border border-slate-800 rounded-2xl p-5">
            <div className="flex items-center gap-2 mb-1">
              <span className="w-6 h-6 rounded-full bg-emerald-700/40 border border-emerald-600 text-emerald-300 text-xs flex items-center justify-center font-bold">1</span>
              <h2 className="text-sm font-bold text-white">引用類似品項</h2>
              <span className="text-[10px] text-slate-500">選填，但強烈建議</span>
            </div>
            <p className="text-xs text-slate-500 mb-3">
              找一個性質最接近的既有品項，把它的 ERP 設定整組複製過來。會計科目、庫存類型、預設倉這些欄位就不必自己判斷。
            </p>

            <div className="flex gap-2">
              <input
                value={keyword}
                onChange={e => setKeyword(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') runSearch() }}
                placeholder="輸入品項編碼前幾碼，或品名關鍵字（例：M3CACC、手機支架）"
                className={inputCls}
              />
              <button
                onClick={runSearch}
                disabled={searching}
                className="shrink-0 px-4 py-2 rounded-lg bg-emerald-700/30 border border-emerald-600 text-emerald-300 text-sm font-semibold hover:bg-emerald-700/50 disabled:opacity-50"
              >
                {searching ? '查詢中…' : '搜尋'}
              </button>
            </div>
            {searchMsg && <p className="text-xs text-amber-400 mt-2">{searchMsg}</p>}

            {results.length > 0 && (
              <div className="mt-3 border border-slate-800 rounded-xl overflow-hidden max-h-72 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="bg-slate-900 sticky top-0">
                    <tr className="text-slate-500">
                      <th className="text-left px-3 py-2 font-medium">品項編碼</th>
                      <th className="text-left px-3 py-2 font-medium">品項名稱</th>
                      <th className="text-left px-3 py-2 font-medium">規格</th>
                      <th className="text-left px-3 py-2 font-medium">單位</th>
                      <th className="text-left px-3 py-2 font-medium">類別</th>
                      <th className="px-3 py-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.map(r => (
                      <tr key={s(r.PART)} className="border-t border-slate-800 hover:bg-slate-800/40">
                        <td className="px-3 py-2 font-mono text-emerald-300 whitespace-nowrap">{s(r.PART)}</td>
                        <td className="px-3 py-2 text-slate-200">{s(r.PART_NAME) || '—'}</td>
                        <td className="px-3 py-2 text-slate-400">{s(r.PART_DESC) || '—'}</td>
                        <td className="px-3 py-2 text-slate-400 whitespace-nowrap">{s(r.UNIT_OF_MEASURE) || '—'}</td>
                        <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{s(r.PRODUCT_CATEGORY)}/{s(r.PRODUCT_CATEGORY_2)}</td>
                        <td className="px-3 py-2 text-right">
                          <button
                            onClick={() => applyTemplate(s(r.PART))}
                            className="px-2.5 py-1 rounded border border-emerald-600 text-emerald-300 hover:bg-emerald-700/30 whitespace-nowrap"
                          >
                            引用
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {template && (
              <div className="mt-3 bg-emerald-950/40 border border-emerald-800/60 rounded-xl p-3 flex items-start gap-3">
                <span className="text-lg">📋</span>
                <div className="flex-1 text-xs">
                  <div className="text-emerald-300 font-semibold">
                    已引用 <span className="font-mono">{s(template.PART)}</span>
                    <span className="text-slate-400 font-normal">　{s(template.PART_NAME)}</span>
                  </div>
                  <div className="text-slate-500 mt-1">
                    {[
                      '類別 ' + s(template.PRODUCT_CATEGORY) + '/' + s(template.PRODUCT_CATEGORY_2),
                      '單位 ' + (s(template.UNIT_OF_MEASURE) || '—'),
                      '倉 ' + (s(template.BOM_WAREHOUSE_ID) || '—'),
                      '科目 ' + s(template.LEVEL_CODE_INV) + '/' + s(template.ACCOUNT_NO_INV),
                    ].join(' · ')}
                  </div>
                  <div className="text-amber-500/90 mt-1">
                    安全庫存與生效日不沿用範本，請依這個新品項自己填。
                  </div>
                </div>
                <button onClick={clearTemplate} className="text-slate-500 hover:text-slate-300 text-xs">清除</button>
              </div>
            )}
          </section>

          {/* ── 2. 品項基本資料 ── */}
          <section className="bg-slate-900/60 border border-slate-800 rounded-2xl p-5">
            <div className="flex items-center gap-2 mb-4">
              <span className="w-6 h-6 rounded-full bg-emerald-700/40 border border-emerald-600 text-emerald-300 text-xs flex items-center justify-center font-bold">2</span>
              <h2 className="text-sm font-bold text-white">品項基本資料</h2>
              <span className="text-[10px] text-rose-400">＊為必填</span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="md:col-span-2">
                <label className={labelCls}>品項名稱 ＊<span className="text-slate-600 ml-1">PART_NAME</span></label>
                <input value={form.part_name} onChange={e => set('part_name', e.target.value)} placeholder="例：手機氣囊支架" className={inputCls} />
              </div>
              <div className="md:col-span-2">
                <label className={labelCls}>規格 / 顏色 / 尺寸<span className="text-slate-600 ml-1">PART_DESC</span></label>
                <input value={form.part_desc} onChange={e => set('part_desc', e.target.value)} placeholder="例：黑、5.8cm * 2.2cm" className={inputCls} />
              </div>

              <div>
                <label className={labelCls}>單位 ＊<span className="text-slate-600 ml-1">UNIT_OF_MEASURE</span></label>
                <input list="unit-options" value={form.unit_of_measure} onChange={e => set('unit_of_measure', e.target.value)} placeholder="個" className={inputCls} />
                <datalist id="unit-options">{UNITS.map(u => <option key={u} value={u} />)}</datalist>
              </div>

              <div>
                <label className={labelCls}>產品大類 ＊<span className="text-slate-600 ml-1">PRODUCT_CATEGORY</span></label>
                <select value={form.product_category} onChange={e => set('product_category', e.target.value)} className={inputCls}>
                  <option value="">請選擇</option>
                  {CATEGORIES.map(c => <option key={c.code} value={c.code}>{c.label}</option>)}
                </select>
                {currentCategory && (
                  <p className="text-[10px] text-slate-500 mt-1">
                    {currentCategory.hint}
                    {!template && (
                      <button onClick={applyCategoryDefaults} className="ml-2 text-emerald-400 hover:underline">套用此類常見設定</button>
                    )}
                  </p>
                )}
              </div>

              <div>
                <label className={labelCls}>產品次類別 ＊<span className="text-slate-600 ml-1">PRODUCT_CATEGORY_2</span></label>
                <input
                  list="subcat-options"
                  value={form.product_category_2}
                  onChange={e => set('product_category_2', e.target.value.toUpperCase())}
                  placeholder={form.product_category ? (SUBCATEGORIES[form.product_category]?.[0] ?? '') : '先選大類'}
                  className={inputCls}
                />
                <datalist id="subcat-options">
                  {(SUBCATEGORIES[form.product_category] ?? []).map(v => <option key={v} value={v} />)}
                </datalist>
              </div>

              <div>
                <label className={labelCls}>建議品項編碼<span className="text-slate-600 ml-1">選填</span></label>
                <input
                  value={form.suggested_part}
                  onChange={e => set('suggested_part', e.target.value.toUpperCase())}
                  placeholder="有想法就填，最終由建檔人員決定"
                  className={inputCls + ' font-mono'}
                />
              </div>
            </div>
          </section>

          {/* ── 3. ERP 設定 ── */}
          <section className="bg-slate-900/60 border border-slate-800 rounded-2xl p-5">
            <div className="flex items-center gap-2 mb-1">
              <span className="w-6 h-6 rounded-full bg-emerald-700/40 border border-emerald-600 text-emerald-300 text-xs flex items-center justify-center font-bold">3</span>
              <h2 className="text-sm font-bold text-white">ERP 設定</h2>
              <span className="text-[10px] text-slate-500">建檔人員照這裡填進 ARGO</span>
            </div>
            <p className="text-xs text-slate-500 mb-4">
              引用品項後會自動帶入。<span className="text-amber-400">不確定的欄位就別改</span>，沿用引用來源比自己猜安全。
            </p>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {ERP_FIELDS.map(f => (
                <div key={f.key}>
                  <label className={labelCls}>{f.label}<span className="block text-[9px] text-slate-600 font-mono">{f.erp}</span></label>
                  {f.options ? (
                    <select value={form[f.key]} onChange={e => set(f.key, e.target.value)} className={inputCls}>
                      <option value="">—</option>
                      {f.options.map(o => <option key={o} value={o}>{o}</option>)}
                    </select>
                  ) : (
                    <input value={form[f.key]} onChange={e => set(f.key, e.target.value)} placeholder={f.placeholder} className={inputCls} />
                  )}
                </div>
              ))}
            </div>
          </section>

          {/* ── 4. 用途說明 ── */}
          <section className="bg-slate-900/60 border border-slate-800 rounded-2xl p-5">
            <div className="flex items-center gap-2 mb-4">
              <span className="w-6 h-6 rounded-full bg-emerald-700/40 border border-emerald-600 text-emerald-300 text-xs flex items-center justify-center font-bold">4</span>
              <h2 className="text-sm font-bold text-white">用途說明</h2>
              <span className="text-[10px] text-rose-400">＊必填</span>
            </div>
            <textarea
              value={form.note}
              onChange={e => set('note', e.target.value)}
              rows={3}
              placeholder="這個品項要用在哪張訂單／哪個客戶？為什麼現有編碼不能用？"
              className={inputCls + ' resize-y'}
            />
            <div className="mt-3">
              <label className={labelCls}>參考連結 / 圖片位置<span className="text-slate-600 ml-1">選填</span></label>
              <input value={form.reference_url} onChange={e => set('reference_url', e.target.value)} placeholder="供應商網址、規格書或圖檔路徑" className={inputCls} />
            </div>
          </section>

          {/* ── 送出 ── */}
          <div className="flex items-center gap-4 pb-10">
            <button
              onClick={submit}
              disabled={submitting}
              className="px-6 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-bold disabled:opacity-50 transition-colors"
            >
              {submitting ? '送出中…' : '送出申請'}
            </button>
            <button
              onClick={() => { setForm(EMPTY_FORM); setTemplate(null); setFormMsg(null) }}
              className="text-xs text-slate-500 hover:text-slate-300"
            >
              清空表單
            </button>
            {formMsg && (
              <span className={'text-xs ' + (formMsg.kind === 'ok' ? 'text-emerald-400' : 'text-rose-400')}>{formMsg.text}</span>
            )}
          </div>
        </div>
      ) : (
        // ─── 申請進度 ───
        <div className="max-w-6xl mx-auto px-4 py-6">
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <div className="flex gap-1">
              {([['', '全部'], ['pending', '待建檔'], ['created', '已建檔'], ['rejected', '已退回']] as const).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setStatusFilter(key as '' | RequestRow['status'])}
                  className={'px-3 py-1.5 rounded-lg text-xs transition-colors ' + (
                    statusFilter === key ? 'bg-emerald-700/40 text-emerald-300 border border-emerald-600' : 'text-slate-400 border border-slate-800 hover:text-slate-200'
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer">
              <input type="checkbox" checked={mineOnly} onChange={e => setMineOnly(e.target.checked)} className="accent-emerald-500" />
              只看我送出的
            </label>
            <button onClick={loadList} className="text-xs text-slate-500 hover:text-slate-300">重新整理</button>
            {loadingList && <span className="text-xs text-slate-500">讀取中…</span>}
            {listMsg && <span className="text-xs text-rose-400">{listMsg}</span>}
          </div>

          {rows.length === 0 && !loadingList ? (
            <p className="text-sm text-slate-500 py-10 text-center">目前沒有符合條件的申請單。</p>
          ) : (
            <div className="border border-slate-800 rounded-2xl overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-slate-900">
                  <tr className="text-slate-500">
                    <th className="text-left px-3 py-2.5 font-medium">申請單號</th>
                    <th className="text-left px-3 py-2.5 font-medium">狀態</th>
                    <th className="text-left px-3 py-2.5 font-medium">品項名稱</th>
                    <th className="text-left px-3 py-2.5 font-medium">規格</th>
                    <th className="text-left px-3 py-2.5 font-medium">類別</th>
                    <th className="text-left px-3 py-2.5 font-medium">單位</th>
                    <th className="text-left px-3 py-2.5 font-medium">申請人</th>
                    <th className="text-left px-3 py-2.5 font-medium">申請時間</th>
                    <th className="text-left px-3 py-2.5 font-medium">品項編碼</th>
                    <th className="px-3 py-2.5"></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <RequestRowView
                      key={r.id}
                      row={r}
                      me={me}
                      expanded={expanded === r.id}
                      onToggle={() => setExpanded(expanded === r.id ? null : r.id)}
                      onPatch={patchRequest}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </main>
  )
}

// ── 清單列（含展開後的完整內容與處理動作）────────────
function RequestRowView({
  row, me, expanded, onToggle, onPatch,
}: {
  row: RequestRow
  me: string
  expanded: boolean
  onToggle: () => void
  onPatch: (body: Record<string, unknown>) => Promise<void>
}) {
  const [assigned, setAssigned] = useState(row.assigned_part ?? '')
  const [reason, setReason] = useState(row.reject_reason ?? '')
  const [busy, setBusy] = useState(false)
  const meta = STATUS_META[row.status]

  const act = async (body: Record<string, unknown>) => {
    setBusy(true)
    await onPatch({ id: row.id, ...body })
    setBusy(false)
  }

  const cell = (label: string, value: string | number | null) => (
    <div>
      <div className="text-[10px] text-slate-600">{label}</div>
      <div className="text-slate-300">{value === null || value === '' ? '—' : String(value)}</div>
    </div>
  )

  return (
    <>
      <tr className="border-t border-slate-800 hover:bg-slate-900/50">
        <td className="px-3 py-2.5 font-mono text-slate-300 whitespace-nowrap">{row.request_no}</td>
        <td className="px-3 py-2.5">
          <span className={'px-2 py-0.5 rounded border text-[10px] font-semibold whitespace-nowrap ' + meta.cls}>{meta.label}</span>
        </td>
        <td className="px-3 py-2.5 text-white">{row.part_name}</td>
        <td className="px-3 py-2.5 text-slate-400">{row.part_desc || '—'}</td>
        <td className="px-3 py-2.5 text-slate-400 whitespace-nowrap">{row.product_category}/{row.product_category_2}</td>
        <td className="px-3 py-2.5 text-slate-400 whitespace-nowrap">{row.unit_of_measure}</td>
        <td className="px-3 py-2.5 text-slate-400 whitespace-nowrap">
          {row.requester_name || row.requester_email}
          {row.requester_email === me && <span className="ml-1 text-[9px] text-emerald-500">我</span>}
        </td>
        <td className="px-3 py-2.5 text-slate-500 whitespace-nowrap">{fmtTime(row.requested_at)}</td>
        <td className="px-3 py-2.5 font-mono text-emerald-300 whitespace-nowrap">{row.assigned_part || '—'}</td>
        <td className="px-3 py-2.5 text-right">
          <button onClick={onToggle} className="text-slate-500 hover:text-slate-300 whitespace-nowrap">
            {expanded ? '收合' : '展開'}
          </button>
        </td>
      </tr>

      {expanded && (
        <tr className="border-t border-slate-800 bg-slate-900/40">
          <td colSpan={10} className="px-4 py-4">
            <div className="grid grid-cols-2 md:grid-cols-6 gap-3 mb-4">
              {cell('引用來源', row.template_part)}
              {cell('建議編碼', row.suggested_part)}
              {cell('來源型態 SOURCE_TYPE', row.source_type)}
              {cell('庫存類型 INVENTORY_TYPE', row.inventory_type)}
              {cell('成本類別 COST_CATEGORY', row.cost_category)}
              {cell('前置時間 LEADTIME_FLAG', row.leadtime_flag)}
              {cell('預設倉 BOM_WAREHOUSE_ID', row.bom_warehouse_id)}
              {cell('批號控管 LOT_NO_FLAG', row.lot_no_flag)}
              {cell('費用類 EXPENSE_FLAG', row.expense_flag)}
              {cell('存貨科目 LEVEL/ACCOUNT', row.level_code_inv || row.account_no_inv ? (row.level_code_inv ?? '') + ' / ' + (row.account_no_inv ?? '') : null)}
              {cell('安全庫存 SAFETY_QTY', row.safety_qty)}
              {cell('生效日 VALIDDATE', row.validdate)}
            </div>

            <div className="mb-4">
              <div className="text-[10px] text-slate-600">用途說明</div>
              <div className="text-slate-300 whitespace-pre-wrap">{row.note}</div>
              {row.reference_url && <div className="text-slate-500 mt-1 break-all">參考：{row.reference_url}</div>}
            </div>

            {row.status === 'rejected' && row.reject_reason && (
              <div className="mb-4 text-rose-300">退回原因：{row.reject_reason}</div>
            )}
            {row.handled_by && (
              <div className="mb-4 text-[10px] text-slate-600">處理：{row.handled_by}　{fmtTime(row.handled_at)}</div>
            )}

            {/* 處理動作 */}
            {row.status === 'pending' ? (
              <div className="flex flex-wrap items-center gap-2 pt-3 border-t border-slate-800">
                <input
                  value={assigned}
                  onChange={e => setAssigned(e.target.value.toUpperCase())}
                  placeholder="ARGO 建好的品項編碼"
                  className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-xs font-mono text-white placeholder:text-slate-600 focus:border-emerald-500 focus:outline-none"
                />
                <button
                  onClick={() => act({ action: 'created', assigned_part: assigned })}
                  disabled={busy || !assigned.trim()}
                  className="px-3 py-1.5 rounded-lg bg-emerald-700/40 border border-emerald-600 text-emerald-300 hover:bg-emerald-700/60 disabled:opacity-40"
                >
                  標記已建檔
                </button>
                <span className="text-slate-700">|</span>
                <input
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                  placeholder="退回原因"
                  className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-white placeholder:text-slate-600 focus:border-rose-500 focus:outline-none"
                />
                <button
                  onClick={() => act({ action: 'rejected', reject_reason: reason })}
                  disabled={busy || !reason.trim()}
                  className="px-3 py-1.5 rounded-lg bg-rose-900/40 border border-rose-700 text-rose-300 hover:bg-rose-900/60 disabled:opacity-40"
                >
                  退回
                </button>
              </div>
            ) : (
              <div className="pt-3 border-t border-slate-800">
                <button
                  onClick={() => act({ action: 'reopen' })}
                  disabled={busy}
                  className="px-3 py-1.5 rounded-lg border border-slate-700 text-slate-400 hover:text-slate-200 disabled:opacity-40"
                >
                  改回待建檔
                </button>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  )
}
