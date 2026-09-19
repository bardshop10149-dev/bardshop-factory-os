'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ImportApplyRequest, ImportGoldenProposal, ImportPreviewResponse, ImportPriceDiff } from '@/lib/quote/api'

// 後台「報價系統 › Excel 匯入」（設計書 §8-④）
//   上傳 报价模板 v1.5.x → 預覽：版本與 notes → 價格差異表（勾選套用）→ golden 提案表（選品項、勾選）→ 套用
//   預設勾 new/up/down、不勾 same/invalid；golden 預設全勾、品項預設第一個 published/draft 品項

type ProductOption = { id: string; name: string; category?: string; status?: string }
type ApplyResult = { pricesUpdated: number; pricesInserted: number; goldenInserted: number; goldenSkipped: string[]; productCreated?: { id: string; name: string } | null }

const STATUS_LABEL: Record<ImportPriceDiff['status'], string> = {
  new: '新增',
  up: '漲價',
  down: '降價',
  same: '相同',
  invalid: '異常',
}
const STATUS_CLASS: Record<ImportPriceDiff['status'], string> = {
  new: 'bg-cyan-900/30 text-cyan-300 border-cyan-700',
  up: 'bg-rose-900/30 text-rose-300 border-rose-700',
  down: 'bg-green-900/30 text-green-300 border-green-700',
  same: 'bg-slate-800 text-slate-400 border-slate-600',
  invalid: 'bg-yellow-900/30 text-yellow-300 border-yellow-600',
}
const DEFAULT_CHECKED = new Set<ImportPriceDiff['status']>(['new', 'up', 'down'])

/** 新品項代碼：p-YYYYMMDD-hhmm（建立後不可改；Snow 不想自己想英文代碼） */
function suggestProductId(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `p-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

const fmtPrice = (v: number | null) => (v == null || !Number.isFinite(v) ? '—' : v.toLocaleString('zh-TW', { maximumFractionDigits: 4 }))

export default function QuoteImportPage() {
  const [file, setFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<ImportPreviewResponse | null>(null)
  const [priceChecked, setPriceChecked] = useState<Set<number>>(new Set())
  const [goldenChecked, setGoldenChecked] = useState<Set<number>>(new Set())
  const [goldenProduct, setGoldenProduct] = useState<Record<number, string>>({})
  const [products, setProducts] = useState<ProductOption[]>([])
  const [productsError, setProductsError] = useState<string | null>(null)
  const [result, setResult] = useState<ApplyResult | null>(null)
  const [filter, setFilter] = useState<'changed' | 'all'>('changed')
  const [expandedGolden, setExpandedGolden] = useState<Set<number>>(new Set())
  /** 「用這份 Excel 建立新品項」 */
  const [createProduct, setCreateProduct] = useState(false)
  const [newProductId, setNewProductId] = useState('')
  const [newProductName, setNewProductName] = useState('')
  const [newProductCategory, setNewProductCategory] = useState('壓克力')

  // 品項清單（給 golden 提案選 productId）；讀不到就退回手打
  const loadProducts = useCallback(async () => {
    try {
      const res = await fetch('/api/quote/admin/products')
      const json = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string; products?: unknown; rows?: unknown }
      if (!res.ok || json.success === false) {
        setProductsError(json.error || `HTTP ${res.status}`)
        return
      }
      const list = (Array.isArray(json.products) ? json.products : Array.isArray(json.rows) ? json.rows : []) as ProductOption[]
      setProducts(list.filter((p) => p && typeof p.id === 'string'))
    } catch (e) {
      setProductsError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    const t = setTimeout(() => void loadProducts(), 0)
    return () => clearTimeout(t)
  }, [loadProducts])

  const defaultProductId = products[0]?.id ?? 'keyring'

  const handleUpload = async () => {
    if (!file || uploading) return
    setUploading(true)
    setError(null)
    setResult(null)
    setPreview(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch('/api/quote/admin/import', { method: 'POST', body: fd })
      const json = (await res.json().catch(() => ({}))) as ({ success: true } & ImportPreviewResponse) | { success: false; error: string }
      if (!res.ok || !json.success) {
        setError(('error' in json && json.error) || `上傳失敗（HTTP ${res.status}）`)
        return
      }
      setPreview(json)
      setPriceChecked(new Set(json.priceDiff.map((d, i) => (DEFAULT_CHECKED.has(d.status) ? i : -1)).filter((i) => i >= 0)))
      setGoldenChecked(new Set(json.goldenProposals.map((_, i) => i)))
      setGoldenProduct(Object.fromEntries(json.goldenProposals.map((_, i) => [i, defaultProductId])))
      setExpandedGolden(new Set())
      setCreateProduct(false)
      setNewProductName(json.productProposal?.suggestedName ?? '')
      setNewProductId(suggestProductId())
      setNewProductCategory('壓克力')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setUploading(false)
    }
  }

  const visibleDiff = useMemo(() => {
    if (!preview) return []
    return preview.priceDiff
      .map((d, i) => ({ d, i }))
      .filter(({ d }) => filter === 'all' || d.status !== 'same')
  }, [preview, filter])

  const diffStat = useMemo(() => {
    const s: Record<string, number> = {}
    for (const d of preview?.priceDiff ?? []) s[d.status] = (s[d.status] ?? 0) + 1
    return s
  }, [preview])

  const togglePrice = (i: number) => {
    setPriceChecked((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }
  const setPriceBulk = (statuses: ImportPriceDiff['status'][], on: boolean) => {
    if (!preview) return
    setPriceChecked((prev) => {
      const next = new Set(prev)
      preview.priceDiff.forEach((d, i) => {
        if (statuses.includes(d.status)) {
          if (on) next.add(i)
          else next.delete(i)
        }
      })
      return next
    })
  }
  const toggleGolden = (i: number) => {
    setGoldenChecked((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }
  const toggleExpanded = (i: number) => {
    setExpandedGolden((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }

  const selectedPriceCount = priceChecked.size
  const selectedGoldenCount = goldenChecked.size
  const proposal = preview?.productProposal ?? null
  const missingPrices = useMemo(() => (proposal?.referencedPrices ?? []).filter((r) => !r.exists), [proposal])
  const newIdOk = /^[a-z0-9][a-z0-9-]{1,39}$/.test(newProductId) && !products.some((p) => p.id === newProductId)
  const goldenTarget = (i: number) => (createProduct && newIdOk ? newProductId : (goldenProduct[i] ?? defaultProductId))

  const handleApply = async () => {
    if (!preview || applying) return
    const priceUpdates: ImportApplyRequest['priceUpdates'] = preview.priceDiff
      .filter((d, i) => priceChecked.has(i) && d.status !== 'invalid')
      .map((d) => ({ name: d.name, group: d.group, price: d.incoming }))
    const goldenCases: ImportApplyRequest['goldenCases'] = preview.goldenProposals
      .map((g, i) => ({ g, i }))
      .filter(({ i }) => goldenChecked.has(i))
      .map(({ g, i }) => ({ ...g, productId: goldenTarget(i).trim() }))
    if (createProduct) {
      if (!newIdOk) { setError('新品項代碼格式不對或已存在（小寫英數與連字號，2～40 字）'); return }
      if (!newProductName.trim()) { setError('請填新品項名稱'); return }
      // 這個品項會查到但價格表沒有的品名：一併新增（用 Excel 上的價），否則前台一算就「價格表找不到」
      const have = new Set(priceUpdates.map((p) => p.name))
      for (const r of missingPrices) if (!have.has(r.name)) priceUpdates.push({ name: r.name, group: r.group, price: r.price, unit: r.unit, attrs: r.attrs })
    }
    if (priceUpdates.length === 0 && goldenCases.length === 0 && !createProduct) {
      setError('沒有勾選任何要套用的項目')
      return
    }
    const missing = goldenCases.filter((g) => !g.productId)
    if (missing.length > 0) {
      setError(`有 ${missing.length} 筆驗證案例沒有選品項`)
      return
    }
    if (!confirm(`${createProduct ? `將建立新品項「${newProductName.trim()}」（${newProductId}，草稿）、` : '將'}套用 ${priceUpdates.length} 筆價格、寫入 ${goldenCases.length} 筆驗證案例（proposed），是否繼續？`)) return

    setApplying(true)
    setError(null)
    try {
      const body: ImportApplyRequest = {
        fileName: preview.fileName,
        priceUpdates,
        goldenCases,
        ...(createProduct && proposal ? { newProduct: { id: newProductId, name: newProductName.trim(), category: newProductCategory.trim() || '壓克力', config: proposal.config } } : {}),
      }
      const res = await fetch('/api/quote/admin/import?apply=1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = (await res.json().catch(() => ({}))) as ({ success: true } & ApplyResult) | { success: false; error: string }
      if (!res.ok || !json.success) {
        setError(('error' in json && json.error) || `套用失敗（HTTP ${res.status}）`)
        return
      }
      setResult({ pricesUpdated: json.pricesUpdated, pricesInserted: json.pricesInserted, goldenInserted: json.goldenInserted, goldenSkipped: json.goldenSkipped ?? [], productCreated: json.productCreated ?? null })
      if (json.productCreated) void loadProducts()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setApplying(false)
    }
  }

  const inputClass = 'bg-slate-800 border border-slate-700 rounded px-3 py-2 text-white focus:border-orange-500 focus:outline-none text-sm'

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1600px] mx-auto text-slate-300 min-h-screen font-sans">
      {/* 標題區 */}
      <div className="flex flex-col md:flex-row justify-between items-end mb-6 md:mb-8 gap-4">
        <div>
          <h1 className="text-xl md:text-3xl font-bold text-white tracking-tight">Excel 匯入</h1>
          <p className="text-orange-500/80 mt-1 font-mono text-sm uppercase">QUOTE SYSTEM // 报价模板 v1.5.x → 價格差異 + 驗證案例</p>
        </div>
      </div>

      {/* 上傳區 */}
      <div className="bg-slate-900/50 rounded-xl border border-slate-700 p-6 mb-6">
        <h2 className="text-sm font-bold text-orange-500 uppercase tracking-wider border-b border-slate-700 pb-2 mb-4">1. 上傳檔案</h2>
        <div className="flex flex-col md:flex-row md:items-center gap-4">
          <input
            type="file"
            accept=".xlsx"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="text-sm text-slate-300 file:mr-4 file:px-4 file:py-2 file:rounded file:border file:border-slate-600 file:bg-slate-800 file:text-slate-200 file:font-bold file:cursor-pointer hover:file:bg-slate-700"
          />
          <button
            onClick={handleUpload}
            disabled={!file || uploading}
            className={`px-6 py-2 rounded font-bold text-sm transition-all ${!file || uploading ? 'bg-slate-800 border border-slate-700 text-slate-500 cursor-not-allowed' : 'bg-orange-600 hover:bg-orange-500 text-white'}`}
          >
            {uploading ? '解析中...' : '解析預覽'}
          </button>
          <span className="text-xs text-slate-500">只收 .xlsx、5MB 以內；只解析不寫入，按「套用」才會寫資料庫。</span>
        </div>
        {productsError && (
          <p className="mt-3 text-xs text-yellow-400">品項清單讀取失敗（{productsError}），驗證案例的品項請手動輸入代碼（例如 keyring）。</p>
        )}
      </div>

      {error && (
        <div className="mb-6 rounded border border-red-800 bg-red-900/30 px-4 py-3 text-sm text-red-300">{error}</div>
      )}

      {result && (
        <div className="mb-6 rounded border border-green-800 bg-green-900/30 px-4 py-3 text-sm text-green-300">
          套用完成：{result.productCreated && <span>已建立品項「{result.productCreated.name}」（{result.productCreated.id}，草稿）；</span>}價格更新 {result.pricesUpdated} 筆、新增 {result.pricesInserted} 筆；驗證案例寫入 {result.goldenInserted} 筆（proposed）
          {result.goldenSkipped.length > 0 && (
            <span className="text-yellow-300">；同名已存在略過 {result.goldenSkipped.length} 筆：{result.goldenSkipped.join('、')}</span>
          )}
          。請到「品項維護」核可驗證案例。
        </div>
      )}

      {preview && (
        <>
          {/* 版本與 notes */}
          <div className="bg-slate-900/50 rounded-xl border border-slate-700 p-6 mb-6">
            <h2 className="text-sm font-bold text-orange-500 uppercase tracking-wider border-b border-slate-700 pb-2 mb-4">2. 檔案資訊</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
              <div>
                <div className="text-xs text-slate-500 mb-1">檔名</div>
                <div className="text-white font-mono text-xs break-all">{preview.fileName}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500 mb-1">模板版本</div>
                <div className="text-white font-bold">{preview.templateVersion}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500 mb-1">解析結果</div>
                <div className="text-white">價格 {preview.priceDiff.length} 項 · 成本分頁 {preview.goldenProposals.length} 頁</div>
              </div>
            </div>
            {preview.notes.length > 0 && (
              <ul className="mt-4 space-y-1 text-xs text-yellow-300/90 list-disc list-inside">
                {preview.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            )}
          </div>

          {/* 建立新品項 */}
          {proposal && (
            <div className={`rounded-xl border p-6 mb-6 ${createProduct ? 'bg-amber-950/20 border-amber-700' : 'bg-slate-900/50 border-slate-700'}`}>
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 border-b border-slate-700 pb-2 mb-4">
                <h2 className="text-sm font-bold text-orange-500 uppercase tracking-wider">2b. 用這份 Excel 建立新品項</h2>
                <label className="flex items-center gap-2 text-sm text-slate-200 cursor-pointer">
                  <input type="checkbox" checked={createProduct} onChange={(e) => setCreateProduct(e.target.checked)} className="accent-orange-500" />
                  建立新品項（設定從「{proposal.fromSheet}」分頁反推；建好是草稿，驗證案例會掛在它底下）
                </label>
              </div>

              {createProduct && (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
                  <label className="text-xs text-slate-400">品項名稱（台灣叫法）*
                    <input value={newProductName} onChange={(e) => setNewProductName(e.target.value)} placeholder="例 搖搖樂" className={`${inputClass} w-full mt-1`} />
                  </label>
                  <label className="text-xs text-slate-400">品項代碼（網址／log 用，建立後不可改）*
                    <input value={newProductId} onChange={(e) => setNewProductId(e.target.value.trim().toLowerCase())} className={`${inputClass} w-full mt-1 font-mono ${newIdOk ? '' : 'border-red-500'}`} />
                    {!newIdOk && <span className="text-red-300">小寫英數與連字號，2～40 字，且不能跟既有品項重複</span>}
                  </label>
                  <label className="text-xs text-slate-400">分類
                    <input value={newProductCategory} onChange={(e) => setNewProductCategory(e.target.value)} className={`${inputClass} w-full mt-1`} />
                  </label>
                </div>
              )}

              {/* 反推出來的設定摘要 */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 text-sm">
                <div className="bg-slate-900/60 rounded-lg border border-slate-800 p-4">
                  <div className="text-xs font-bold text-slate-400 mb-2">反推的品項設定</div>
                  <dl className="grid grid-cols-[110px_1fr] gap-y-1 text-xs">
                    <dt className="text-slate-500">主板</dt><dd className="text-slate-200">{proposal.config.boards.defaultItem}</dd>
                    <dt className="text-slate-500">第二板</dt><dd className="text-slate-200">{proposal.config.extraBoards.length ? proposal.config.extraBoards.map((b) => `${b.item}${b.nPerSheet ? `（每盤 ${b.nPerSheet}${b.roundup ? '' : '，不進位'}）` : ''}${b.printed ? '・印' : ''}${b.laminated ? '・貼' : ''}`).join('；') : '無'}</dd>
                    <dt className="text-slate-500">印刷</dt><dd className="text-slate-200">{proposal.config.defaultPrintMethod}・{proposal.config.defaultPrintSides === 2 ? '雙面' : '單面'}{proposal.config.petSides === 1 && proposal.config.defaultPrintSides === 2 ? '（彩白彩單張 PET）' : ''}</dd>
                    <dt className="text-slate-500">PET</dt><dd className="text-slate-200">{proposal.config.petByMethod[proposal.config.defaultPrintMethod] ?? '—'}{proposal.config.defaultPrintMethod === 'koshi' ? `・k_pet ${proposal.config.kPet}` : ''}</dd>
                    <dt className="text-slate-500">貼合／清洗</dt><dd className="text-slate-200">{proposal.config.laminate.map((l) => `${l.item}（${l.platesFrom.join('+')}）`).join('、') || '無'}；清洗 {typeof proposal.config.wash.platesFrom === 'string' ? proposal.config.wash.platesFrom : proposal.config.wash.platesFrom.join('+')}{proposal.config.wash.multiplier ? ` ×${proposal.config.wash.multiplier}` : ''}</dd>
                    <dt className="text-slate-500">切割時間</dt><dd className="text-slate-200 font-mono">t1 {proposal.config.cut.t1}・t2 {proposal.config.cut.t2}・t3 {proposal.config.cut.t3} 分／板</dd>
                    <dt className="text-slate-500">耗損／成本率</dt><dd className="text-slate-200 font-mono">{proposal.config.scrapPct}%・{proposal.config.costRatio}（毛利 {Math.round((1 - proposal.config.costRatio) * 100)}%）</dd>
                    <dt className="text-slate-500">包裝產能</dt><dd className="text-slate-200 font-mono">{proposal.config.packCapacityPerHour} 個／人時</dd>
                    <dt className="text-slate-500">配件</dt><dd className="text-slate-200">{proposal.config.accessories.length ? proposal.config.accessories.map((a) => `${a.item} ×${a.k}`).join('、') : '無'}</dd>
                    <dt className="text-slate-500">包裝</dt><dd className="text-slate-200">{proposal.config.packing.length ? proposal.config.packing.map((k) => `${k.item}（${k.mode}${k.n ? ` n=${k.n}` : ''}${k.k && k.k !== 1 ? ` ×${k.k}` : ''}）`).join('、') : '無'}</dd>
                  </dl>
                  {missingPrices.length > 0 && (
                    <div className="mt-3 text-xs text-cyan-300">價格表缺 {missingPrices.length} 個品名，勾「建立新品項」套用時會一併新增（用 Excel 上的價）：{missingPrices.map((r) => `${r.name}＝${r.price}`).join('、')}</div>
                  )}
                  {proposal.notes.length > 0 && (
                    <ul className="mt-3 space-y-0.5 text-xs text-slate-400 list-disc list-inside">
                      {proposal.notes.map((n, i) => <li key={i}>{n}</li>)}
                    </ul>
                  )}
                </div>

                <div className="bg-slate-900/60 rounded-lg border border-slate-800 p-4">
                  <div className="text-xs font-bold text-slate-400 mb-2">參考與核對</div>
                  <div className="text-xs mb-3">
                    <span className="text-slate-500">類似品項：</span>
                    {proposal.similar.length ? proposal.similar.map((sp) => <span key={sp.id} className="inline-block mr-2 px-2 py-0.5 rounded border border-slate-600 bg-slate-800 text-slate-200" title={sp.why}>{sp.name}<span className="text-slate-500">（{sp.why}）</span></span>) : <span className="text-slate-500">沒有結構相近的既有品項，以下用全部品項當參考</span>}
                  </div>
                  {proposal.checks.length === 0 ? (
                    <div className="text-xs text-emerald-300">沒有發現異常</div>
                  ) : (
                    <ul className="space-y-1 text-xs">
                      {proposal.checks.map((c, i) => (
                        <li key={i} className={`flex gap-2 ${c.level === 'warn' ? 'text-yellow-300' : 'text-slate-400'}`}>
                          <span className={`shrink-0 px-1.5 rounded border text-[10px] ${c.level === 'warn' ? 'border-yellow-600 bg-yellow-900/30' : 'border-slate-600 bg-slate-800'}`}>{c.level === 'warn' ? '異常' : '提醒'}</span>
                          <span><span className="text-slate-500">{c.field}：</span>{c.message}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* 價格差異 */}
          <div className="bg-slate-900/50 rounded-xl border border-slate-700 p-6 mb-6">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 border-b border-slate-700 pb-2 mb-4">
              <h2 className="text-sm font-bold text-orange-500 uppercase tracking-wider">3. 價格差異（已勾 {selectedPriceCount} 筆）</h2>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                {(['new', 'up', 'down', 'same', 'invalid'] as const).map((s) => (
                  <span key={s} className={`px-2 py-0.5 rounded border ${STATUS_CLASS[s]}`}>
                    {STATUS_LABEL[s]} {diffStat[s] ?? 0}
                  </span>
                ))}
                <button onClick={() => setFilter(filter === 'all' ? 'changed' : 'all')} className="ml-2 px-3 py-1 rounded border border-slate-600 bg-slate-800 hover:bg-slate-700 text-slate-300">
                  {filter === 'all' ? '只看有差異' : '顯示全部'}
                </button>
                <button onClick={() => setPriceBulk(['new', 'up', 'down'], true)} className="px-3 py-1 rounded border border-slate-600 bg-slate-800 hover:bg-slate-700 text-slate-300">
                  勾選全部差異
                </button>
                <button onClick={() => setPriceBulk(['new', 'up', 'down', 'same', 'invalid'], false)} className="px-3 py-1 rounded border border-slate-600 bg-slate-800 hover:bg-slate-700 text-slate-300">
                  全部取消
                </button>
              </div>
            </div>
            {visibleDiff.length === 0 ? (
              <p className="text-sm text-slate-500 py-6 text-center">沒有差異項目</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-slate-500 border-b border-slate-700">
                      <th className="text-left py-2 pr-2 w-8"></th>
                      <th className="text-left py-2 pr-2">品名（Excel 原名）</th>
                      <th className="text-left py-2 pr-2">分類</th>
                      <th className="text-right py-2 pr-2">現價</th>
                      <th className="text-right py-2 pr-2">Excel 價</th>
                      <th className="text-left py-2 pr-2">狀態</th>
                      <th className="text-left py-2">備註</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleDiff.map(({ d, i }) => {
                      const disabled = d.status === 'invalid'
                      const checked = priceChecked.has(i) && !disabled
                      return (
                        <tr key={i} className={`border-b border-slate-800 hover:bg-slate-800/40 ${disabled ? 'opacity-70' : ''}`}>
                          <td className="py-1.5 pr-2">
                            <input type="checkbox" checked={checked} disabled={disabled} onChange={() => togglePrice(i)} className="accent-orange-500" />
                          </td>
                          <td className="py-1.5 pr-2 text-slate-200">{d.name}</td>
                          <td className="py-1.5 pr-2 text-slate-400 text-xs">{d.group}</td>
                          <td className="py-1.5 pr-2 text-right font-mono text-slate-400">{fmtPrice(d.current)}</td>
                          <td className={`py-1.5 pr-2 text-right font-mono ${d.status === 'invalid' ? 'text-slate-500' : 'text-white'}`}>{d.status === 'invalid' ? '—' : fmtPrice(d.incoming)}</td>
                          <td className="py-1.5 pr-2">
                            <span className={`px-2 py-0.5 rounded border text-[10px] ${STATUS_CLASS[d.status]}`}>{STATUS_LABEL[d.status]}</span>
                          </td>
                          <td className="py-1.5 text-xs text-yellow-300/80">{d.note ?? ''}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* golden 提案 */}
          <div className="bg-slate-900/50 rounded-xl border border-slate-700 p-6 mb-6">
            <h2 className="text-sm font-bold text-orange-500 uppercase tracking-wider border-b border-slate-700 pb-2 mb-4">
              4. 驗證案例提案（已勾 {selectedGoldenCount} / {preview.goldenProposals.length} 筆，寫入後狀態 proposed）
            </h2>
            {preview.goldenProposals.length === 0 ? (
              <p className="text-sm text-slate-500 py-6 text-center">這份檔案沒有可解析的成本分頁</p>
            ) : (
              <div className="space-y-3">
                {preview.goldenProposals.map((g, i) => (
                  <GoldenCard
                    key={i}
                    proposal={g}
                    checked={goldenChecked.has(i)}
                    onToggle={() => toggleGolden(i)}
                    productId={goldenTarget(i)}
                    onProductChange={(v) => { if (!createProduct) setGoldenProduct((prev) => ({ ...prev, [i]: v })) }}
                    products={products}
                    expanded={expandedGolden.has(i)}
                    onToggleExpanded={() => toggleExpanded(i)}
                    inputClass={inputClass}
                  />
                ))}
              </div>
            )}
          </div>

          {/* 套用 */}
          <div className="flex items-center justify-end gap-4 mb-10">
            <span className="text-xs text-slate-500">價格 {selectedPriceCount} 筆 · 驗證案例 {selectedGoldenCount} 筆</span>
            <button
              onClick={handleApply}
              disabled={applying || (selectedPriceCount === 0 && selectedGoldenCount === 0 && !createProduct)}
              className={`px-6 py-2 rounded font-bold text-sm transition-all ${applying || (selectedPriceCount === 0 && selectedGoldenCount === 0 && !createProduct) ? 'bg-slate-800 border border-slate-700 text-slate-500 cursor-not-allowed' : 'bg-orange-600 hover:bg-orange-500 text-white shadow-lg shadow-orange-900/50'}`}
            >
              {applying ? '套用中...' : createProduct ? '建立品項並套用' : '套用勾選項目'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function GoldenCard(props: {
  proposal: ImportGoldenProposal
  checked: boolean
  onToggle: () => void
  productId: string
  onProductChange: (v: string) => void
  products: ProductOption[]
  expanded: boolean
  onToggleExpanded: () => void
  inputClass: string
}) {
  const { proposal: g, checked, onToggle, productId, onProductChange, products, expanded, onToggleExpanded, inputClass } = props
  const margin = g.expected_price > 0 ? (1 - g.expected_cost / g.expected_price) * 100 : 0
  return (
    <div className={`rounded-lg border p-4 ${checked ? 'border-slate-600 bg-slate-900/60' : 'border-slate-800 bg-slate-900/20 opacity-70'}`}>
      <div className="flex flex-col lg:flex-row lg:items-center gap-3">
        <label className="flex items-center gap-3 flex-1 cursor-pointer">
          <input type="checkbox" checked={checked} onChange={onToggle} className="accent-orange-500" />
          <div>
            <div className="text-white font-bold text-sm">{g.name}</div>
            <div className="text-xs text-slate-500 font-mono mt-0.5">
              分頁 {g.sheet} · {g.template_version} · {g.qty.toLocaleString('zh-TW')} pcs
            </div>
          </div>
        </label>
        <div className="flex items-center gap-4 text-sm font-mono">
          <div className="text-right">
            <div className="text-[10px] text-slate-500">成本 B5</div>
            <div className="text-white">{g.expected_cost.toFixed(4)}</div>
          </div>
          <div className="text-right">
            <div className="text-[10px] text-slate-500">報價 D5</div>
            <div className="text-white">{g.expected_price.toFixed(4)}</div>
          </div>
          <div className="text-right">
            <div className="text-[10px] text-slate-500">毛利</div>
            <div className="text-slate-300">{margin.toFixed(1)}%</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500">品項</span>
          {products.length > 0 ? (
            <select value={productId} onChange={(e) => onProductChange(e.target.value)} className={inputClass}>
              {!products.some((p) => p.id === productId) && <option value={productId}>{productId || '（請選擇）'}</option>}
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.category ? `（${p.category}）` : ''}
                  {p.status ? ` · ${p.status}` : ''}
                </option>
              ))}
            </select>
          ) : (
            <input type="text" value={productId} onChange={(e) => onProductChange(e.target.value)} placeholder="品項代碼，例如 keyring" className={`${inputClass} w-44`} />
          )}
        </div>
        <button onClick={onToggleExpanded} className="text-xs px-3 py-1 rounded border border-slate-600 bg-slate-800 hover:bg-slate-700 text-slate-300">
          {expanded ? '收合' : '看內容'}
        </button>
      </div>
      {g.warnings.length > 0 && (
        <ul className="mt-3 space-y-0.5 text-xs text-yellow-300/90 list-disc list-inside">
          {g.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
      {expanded && (
        <div className="mt-3 grid grid-cols-1 lg:grid-cols-2 gap-3">
          <div>
            <div className="text-[10px] text-slate-500 mb-1">input（引擎輸入）</div>
            <pre className="text-[11px] leading-4 text-slate-300 bg-slate-950/60 border border-slate-800 rounded p-3 overflow-auto max-h-80 custom-scrollbar">{JSON.stringify(g.input, null, 2)}</pre>
          </div>
          <div>
            <div className="text-[10px] text-slate-500 mb-1">settings_snapshot（該檔實際讀到的完整常數；驗證時用它覆蓋現行參數）</div>
            <pre className="text-[11px] leading-4 text-slate-300 bg-slate-950/60 border border-slate-800 rounded p-3 overflow-auto max-h-80 custom-scrollbar">{JSON.stringify(g.settings_snapshot, null, 2)}</pre>
          </div>
        </div>
      )}
    </div>
  )
}
