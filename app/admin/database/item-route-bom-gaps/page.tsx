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
          <input
            value={c.child_part}
            onChange={e => updateChild(i, 'child_part', e.target.value)}
            placeholder="子件料號"
            className="flex-1 min-w-0 px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-200 text-sm focus:outline-none focus:border-cyan-500"
          />
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

export default function ItemRouteBomGapsPage() {
  const [items, setItems] = useState<GapItem[]>([])
  const [routeOptions, setRouteOptions] = useState<RouteOption[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState<FilterMode>('all')
  const [search, setSearch] = useState('')
  const [openForm, setOpenForm] = useState<{ code: string; kind: 'route' | 'bom' } | null>(null)
  const [markingNoRoute, setMarkingNoRoute] = useState<string | null>(null)

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
      </div>
    </div>
  )
}
