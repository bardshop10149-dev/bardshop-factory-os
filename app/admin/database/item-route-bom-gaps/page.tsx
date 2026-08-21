'use client'

// 工序/BOM 補登表——找出發單作業區出現過、但工序總表(item_routes)或BOM
// (mm_bom_structure)沒有對應資料的品項編碼，支援在系統內直接補登。

import { useCallback, useEffect, useMemo, useState } from 'react'

interface GapItem {
  item_code: string
  item_name: string
  missing_route: boolean
  missing_bom: boolean
  order_count: number
  last_seen_date: string
}

interface RouteOption {
  route_id: string
  op_count: number
}

type FilterMode = 'all' | 'route' | 'bom' | 'both'
type MainTab = 'gaps' | 'supplemented'

interface SupplementRow {
  id: number
  parent_part: string
  child_part: string
  child_qty: number
  note: string | null
  created_by: string | null
  created_by_email: string | null
  created_at: string
}

// 標記「這個品項不需要工序」用的 route_id 值——例如原物料買賣，進貨後直接出貨，
// 本來就不會經過任何生產工序。寫進 item_routes 之後，這個品項會自然不再出現在
// 缺工序清單裡（判斷邏輯只看 item_routes 有沒有這個品項的資料，不管 route_id 是什麼），
// 不需要另外加欄位或新表。
const NO_ROUTE_NEEDED = '（無需工序）'

function RouteForm({ item, routeOptions, onDone }: { item: GapItem; routeOptions: RouteOption[]; onDone: () => void }) {
  const [routeId, setRouteId] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  const submit = useCallback(async () => {
    const rid = routeId.trim()
    if (!rid) return
    setSaving(true)
    setMsg('')
    try {
      const res = await fetch('/api/production/item-routes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item_code: item.item_code, item_name: item.item_name, route_id: rid }),
      })
      const json = await res.json() as { success: boolean; error?: string }
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`)
      onDone()
    } catch (e) {
      setMsg(`❌ ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
  }, [routeId, item, onDone])

  const knownRoute = routeOptions.some(r => r.route_id === routeId.trim())

  return (
    <div className="mt-2 p-3 rounded-lg bg-slate-950 border border-slate-800 space-y-2">
      <div className="text-xs text-slate-400">選擇這個品項要套用的途程（可從既有清單挑選，或輸入新的途程名稱）</div>
      <div className="flex items-center gap-2">
        <input
          list="route-options"
          value={routeId}
          onChange={e => setRouteId(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void submit() }}
          placeholder="途程名稱"
          className="flex-1 min-w-0 px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-200 text-sm focus:outline-none focus:border-cyan-500"
        />
        <button
          onClick={() => void submit()}
          disabled={saving || !routeId.trim()}
          className="px-4 py-1.5 rounded-lg bg-cyan-700 hover:bg-cyan-600 disabled:opacity-40 text-white text-sm font-medium transition-colors shrink-0"
        >
          {saving ? '儲存中…' : '儲存'}
        </button>
      </div>
      {routeId.trim() && !knownRoute && (
        <div className="text-amber-400 text-xs">⚠ 這是一個全新的途程名稱，目前 route_operations 沒有對應工序，之後還需要另外設定該途程的工序內容</div>
      )}
      {msg && <div className="text-red-400 text-xs">{msg}</div>}
    </div>
  )
}

interface MaterialOption {
  item_code: string
  item_name: string | null
  unit_of_measure: string | null
  book_count: number | null
}

// 子件料號輸入框——輸入關鍵字（料號或品名）即時搜尋 ERP 同步區的庫存名單
// （material_inventory_list），跟工序補登的途程挑選一樣是「打字就看到符合項目」，
// 但庫存名單有 7 千多筆，不適合像途程清單那樣一次全部塞進 datalist，改成打字時
// 才去查、只顯示前 20 筆符合的。
function MaterialPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [options, setOptions] = useState<MaterialOption[]>([])
  const [open, setOpen] = useState(false)
  const [searching, setSearching] = useState(false)

  useEffect(() => {
    const q = value.trim()
    if (!q) return
    let cancelled = false
    const timer = setTimeout(() => {
      setSearching(true)
      fetch(`/api/production/material-inventory-search?q=${encodeURIComponent(q)}`, { cache: 'no-store' })
        .then(res => res.json())
        .then((json: { success: boolean; items?: MaterialOption[] }) => {
          if (!cancelled && json.success) setOptions(json.items ?? [])
        })
        .catch(() => {})
        .finally(() => { if (!cancelled) setSearching(false) })
    }, 250)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [value])

  return (
    <div className="relative flex-1 min-w-0">
      <input
        value={value}
        onChange={e => { onChange(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="子件料號（輸入關鍵字搜尋庫存名單）"
        className="w-full px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-200 text-sm focus:outline-none focus:border-cyan-500"
      />
      {open && value.trim() && (searching || options.length > 0) && (
        <div className="absolute z-20 mt-1 w-full max-h-64 overflow-y-auto rounded-lg bg-slate-900 border border-slate-700 shadow-xl">
          {searching && options.length === 0 && (
            <div className="px-3 py-2 text-xs text-slate-500">搜尋中…</div>
          )}
          {options.map(opt => (
            <button
              key={opt.item_code}
              onMouseDown={e => e.preventDefault()}
              onClick={() => { onChange(opt.item_code); setOpen(false) }}
              className="w-full text-left px-3 py-1.5 hover:bg-slate-800 transition-colors border-b border-slate-800/60 last:border-b-0"
            >
              <div className="text-xs font-mono text-slate-100">{opt.item_code}</div>
              {opt.item_name && <div className="text-[11px] text-slate-400 truncate">{opt.item_name}</div>}
              <div className="text-[10px] text-slate-500">
                {opt.unit_of_measure ?? '—'}・庫存 {opt.book_count ?? 0}
              </div>
            </button>
          ))}
          {!searching && options.length === 0 && (
            <div className="px-3 py-2 text-xs text-slate-500">查無符合的料號</div>
          )}
        </div>
      )}
    </div>
  )
}

function BomForm({ item, onDone }: { item: GapItem; onDone: () => void }) {
  const [children, setChildren] = useState([{ child_part: '', child_qty: '1' }])
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  const updateChild = (i: number, field: 'child_part' | 'child_qty', value: string) => {
    setChildren(prev => prev.map((c, idx) => idx === i ? { ...c, [field]: value } : c))
  }

  const submit = useCallback(async () => {
    const valid = children.filter(c => c.child_part.trim())
    if (valid.length === 0) return
    setSaving(true)
    setMsg('')
    try {
      const res = await fetch('/api/production/bom-manual-supplement', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parent_part: item.item_code,
          children: valid.map(c => ({ child_part: c.child_part.trim(), child_qty: Number(c.child_qty) || 0 })),
        }),
      })
      const json = await res.json() as { success: boolean; error?: string }
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`)
      onDone()
    } catch (e) {
      setMsg(`❌ ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
  }, [children, item, onDone])

  return (
    <div className="mt-2 p-3 rounded-lg bg-slate-950 border border-slate-800 space-y-2">
      <div className="text-xs text-slate-400">新增這個品項的 BOM 子件（料號＋用量）</div>
      <div className="text-[11px] text-amber-400/80">
        ⚠ 這是系統內部的暫時記錄，不會寫回 ARGO——批備料會一併讀取比對，但正式的 BOM 還是要在 ARGO 那邊建立
      </div>
      {children.map((c, i) => (
        <div key={i} className="flex items-center gap-2">
          <MaterialPicker value={c.child_part} onChange={v => updateChild(i, 'child_part', v)} />
          <input
            value={c.child_qty}
            onChange={e => updateChild(i, 'child_qty', e.target.value)}
            placeholder="用量"
            className="w-20 px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-200 text-sm focus:outline-none focus:border-cyan-500"
          />
          {children.length > 1 && (
            <button onClick={() => setChildren(prev => prev.filter((_, idx) => idx !== i))} className="text-slate-500 hover:text-red-400 shrink-0">✕</button>
          )}
        </div>
      ))}
      <div className="flex items-center gap-2">
        <button
          onClick={() => setChildren(prev => [...prev, { child_part: '', child_qty: '1' }])}
          className="px-3 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs"
        >
          + 新增子件
        </button>
        <button
          onClick={() => void submit()}
          disabled={saving}
          className="px-4 py-1.5 rounded-lg bg-cyan-700 hover:bg-cyan-600 disabled:opacity-40 text-white text-sm font-medium transition-colors"
        >
          {saving ? '儲存中…' : '儲存'}
        </button>
      </div>
      {msg && <div className="text-red-400 text-xs">{msg}</div>}
    </div>
  )
}

function SupplementedBomList() {
  const [rows, setRows] = useState<SupplementRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [deletingId, setDeletingId] = useState<number | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/production/bom-manual-supplement', { cache: 'no-store' })
      const json = await res.json() as { success: boolean; error?: string; rows?: SupplementRow[] }
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`)
      setRows(json.rows ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const remove = useCallback(async (id: number) => {
    setDeletingId(id)
    try {
      const res = await fetch(`/api/production/bom-manual-supplement?id=${id}`, { method: 'DELETE' })
      const json = await res.json() as { success: boolean; error?: string }
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setDeletingId(null)
    }
  }, [load])

  const filtered = useMemo(() => {
    if (!search.trim()) return rows
    const q = search.trim().toLowerCase()
    return rows.filter(r => r.parent_part.toLowerCase().includes(q) || r.child_part.toLowerCase().includes(q))
  }, [rows, search])

  // 依 parent_part 分組顯示，同一品項的多筆子件放在一起
  const grouped = useMemo(() => {
    const map = new Map<string, SupplementRow[]>()
    for (const r of filtered) {
      const list = map.get(r.parent_part) ?? []
      list.push(r)
      map.set(r.parent_part, list)
    }
    return [...map.entries()].sort((a, b) => b[1][0].created_at.localeCompare(a[1][0].created_at))
  }, [filtered])

  return (
    <div className="space-y-4">
      <div className="px-3 py-2 rounded-lg bg-amber-950/20 border border-amber-800/40 text-amber-300 text-xs">
        這些是透過補登表新增的 BOM，存在獨立的暫時記錄裡，不會被 ARGO 同步覆蓋，但也還沒有真正寫回 ARGO——正式的 BOM 還是要在 ARGO 那邊建立。
      </div>
      <div className="flex items-center gap-2">
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="搜尋品號…"
          className="flex-1 min-w-[160px] px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-200 text-sm focus:outline-none focus:border-cyan-500"
        />
        <button
          onClick={() => void load()}
          disabled={loading}
          className="px-4 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 disabled:opacity-40 text-white text-sm transition-colors"
        >
          {loading ? '載入中…' : '重新整理'}
        </button>
      </div>

      {error && <div className="px-3 py-2 rounded-lg bg-red-900/30 border border-red-700/40 text-red-300 text-xs">❌ {error}</div>}

      {loading ? (
        <div className="py-16 text-center text-slate-400 text-sm">載入中…</div>
      ) : grouped.length === 0 ? (
        <div className="py-16 text-center text-slate-400 text-sm">目前沒有補登過的 BOM 資料</div>
      ) : (
        <div className="space-y-2">
          {grouped.map(([parentPart, childRows]) => (
            <div key={parentPart} className="rounded-xl bg-slate-900 border border-slate-800 p-4">
              <div className="font-mono text-sm text-slate-100 mb-2">{parentPart}</div>
              <div className="space-y-1">
                {childRows.map(r => (
                  <div key={r.id} className="flex items-center justify-between gap-3 text-xs">
                    <span className="text-slate-300">
                      {r.child_part} <span className="text-emerald-300/80">× {r.child_qty}</span>
                      {r.created_by && <span className="text-slate-500"> ・{r.created_by}</span>}
                      <span className="text-slate-600"> ・{new Date(r.created_at).toLocaleString('zh-TW')}</span>
                    </span>
                    <button
                      onClick={() => void remove(r.id)}
                      disabled={deletingId === r.id}
                      className="text-slate-500 hover:text-red-400 disabled:opacity-40 transition-colors shrink-0"
                    >
                      {deletingId === r.id ? '刪除中…' : '✕ 刪除'}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function ItemRouteBomGapsPage() {
  const [items, setItems] = useState<GapItem[]>([])
  const [routeOptions, setRouteOptions] = useState<RouteOption[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState<FilterMode>('all')
  const [search, setSearch] = useState('')
  const [openForm, setOpenForm] = useState<{ code: string; kind: 'route' | 'bom' } | null>(null)
  const [markingNoRoute, setMarkingNoRoute] = useState<string | null>(null)
  const [mainTab, setMainTab] = useState<MainTab>('gaps')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [gapsRes, routesRes] = await Promise.all([
        fetch('/api/production/item-route-bom-gaps', { cache: 'no-store' }),
        fetch('/api/production/item-routes', { cache: 'no-store' }),
      ])
      const gapsJson = await gapsRes.json() as { success: boolean; error?: string; items?: GapItem[] }
      if (!gapsRes.ok || !gapsJson.success) throw new Error(gapsJson.error || `HTTP ${gapsRes.status}`)
      setItems(gapsJson.items ?? [])
      const routesJson = await routesRes.json() as { success: boolean; routes?: RouteOption[] }
      if (routesJson.success) setRouteOptions(routesJson.routes ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const filtered = useMemo(() => {
    let list = items
    if (filter === 'route') list = list.filter(i => i.missing_route)
    else if (filter === 'bom') list = list.filter(i => i.missing_bom)
    else if (filter === 'both') list = list.filter(i => i.missing_route && i.missing_bom)
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      list = list.filter(i => i.item_code.toLowerCase().includes(q) || i.item_name.toLowerCase().includes(q))
    }
    return list
  }, [items, filter, search])

  const counts = useMemo(() => ({
    route: items.filter(i => i.missing_route).length,
    bom: items.filter(i => i.missing_bom).length,
    both: items.filter(i => i.missing_route && i.missing_bom).length,
  }), [items])

  const closeFormAndReload = useCallback(() => {
    setOpenForm(null)
    void load()
  }, [load])

  const markNoRouteNeeded = useCallback(async (item: GapItem) => {
    setMarkingNoRoute(item.item_code)
    try {
      const res = await fetch('/api/production/item-routes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item_code: item.item_code, item_name: item.item_name, route_id: NO_ROUTE_NEEDED }),
      })
      const json = await res.json() as { success: boolean; error?: string }
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setMarkingNoRoute(null)
    }
  }, [load])

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 p-4 md:p-6">
      <div className="max-w-5xl mx-auto space-y-4">
        <div>
          <h1 className="text-xl font-bold text-white">🧩 工序/BOM 補登表</h1>
          <p className="text-slate-400 text-sm mt-0.5">
            發單作業區出現過、但工序總表（品項關聯）或 BOM 沒有對應資料的品項編碼，可直接在這裡補登。
          </p>
        </div>

        <div className="flex gap-1 border-b border-slate-800">
          {([['gaps', '⚠ 缺項清單'], ['supplemented', '📋 已補登BOM清單']] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setMainTab(key)}
              className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors border-b-2 ${
                mainTab === key ? 'border-cyan-500 text-cyan-300 bg-slate-900' : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {mainTab === 'supplemented' && <SupplementedBomList />}

        {mainTab === 'gaps' && (<>
        <div className="flex flex-wrap items-center gap-2">
          {([
            ['all', `全部 (${items.length})`],
            ['route', `缺工序 (${counts.route})`],
            ['bom', `缺BOM (${counts.bom})`],
            ['both', `兩者都缺 (${counts.both})`],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                filter === key ? 'bg-cyan-700 text-white' : 'bg-slate-800 text-slate-400 hover:text-slate-200'
              }`}
            >
              {label}
            </button>
          ))}
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="搜尋品號/品名…"
            className="flex-1 min-w-[160px] px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-200 text-sm focus:outline-none focus:border-cyan-500"
          />
          <button
            onClick={() => void load()}
            disabled={loading}
            className="px-4 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 disabled:opacity-40 text-white text-sm transition-colors"
          >
            {loading ? '載入中…' : '重新整理'}
          </button>
        </div>

        {error && <div className="px-3 py-2 rounded-lg bg-red-900/30 border border-red-700/40 text-red-300 text-xs">❌ {error}</div>}

        <datalist id="route-options">
          {routeOptions.map(r => <option key={r.route_id} value={r.route_id} />)}
        </datalist>

        {loading ? (
          <div className="py-16 text-center text-slate-400 text-sm">載入中…</div>
        ) : filtered.length === 0 ? (
          <div className="py-16 text-center text-slate-400 text-sm">
            {items.length === 0 ? '✅ 目前沒有缺工序/BOM 的品項' : '沒有符合篩選條件的品項'}
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map(item => (
              <div key={item.item_code} className="rounded-xl bg-slate-900 border border-slate-800 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-mono text-sm text-slate-100">{item.item_code}</div>
                    {item.item_name && <div className="text-xs text-slate-400 mt-0.5">{item.item_name}</div>}
                    <div className="text-[11px] text-slate-500 mt-1">
                      出現 {item.order_count} 次・最近一次 {item.last_seen_date}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    {item.missing_route && (
                      <>
                        <button
                          onClick={() => setOpenForm(prev => prev?.code === item.item_code && prev.kind === 'route' ? null : { code: item.item_code, kind: 'route' })}
                          className="px-2.5 py-1 rounded-full text-[11px] font-semibold bg-amber-900/40 text-amber-300 border border-amber-700/40 hover:bg-amber-900/60 transition-colors"
                        >
                          ⚠ 缺工序・補登
                        </button>
                        <button
                          onClick={() => void markNoRouteNeeded(item)}
                          disabled={markingNoRoute === item.item_code}
                          title="這個品項本來就不需要工序（例如原物料買賣，可直接出貨）"
                          className="px-2.5 py-1 rounded-full text-[11px] font-semibold bg-slate-800 text-slate-400 border border-slate-700 hover:bg-slate-700 hover:text-slate-300 disabled:opacity-40 transition-colors"
                        >
                          {markingNoRoute === item.item_code ? '處理中…' : '🚫 無工序'}
                        </button>
                      </>
                    )}
                    {item.missing_bom && (
                      <button
                        onClick={() => setOpenForm(prev => prev?.code === item.item_code && prev.kind === 'bom' ? null : { code: item.item_code, kind: 'bom' })}
                        className="px-2.5 py-1 rounded-full text-[11px] font-semibold bg-orange-900/40 text-orange-300 border border-orange-700/40 hover:bg-orange-900/60 transition-colors"
                      >
                        ⚠ 缺BOM・補登
                      </button>
                    )}
                  </div>
                </div>

                {openForm?.code === item.item_code && openForm.kind === 'route' && (
                  <RouteForm item={item} routeOptions={routeOptions} onDone={closeFormAndReload} />
                )}
                {openForm?.code === item.item_code && openForm.kind === 'bom' && (
                  <BomForm item={item} onDone={closeFormAndReload} />
                )}
              </div>
            ))}
          </div>
        )}
        </>)}
      </div>
    </div>
  )
}
