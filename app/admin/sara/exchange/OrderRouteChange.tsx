'use client'

// 改單面板——把「刪舊工序 → 產生新工序 → 寫回交換區」三步併成一個動作。
//
// 原本的流程是：在交換區用訂單號查出舊列逐一刪除 → 到工序產生器重新產生 →
// 再追加回交換區。三步之間漏一步或順序錯，塔台就會同時看到新舊兩套工序、
// 或整個品項憑空消失。這裡做成：
//
//   輸入 銷售單號(+序號) → 看到這個品項「目前在塔台的工序」→ 選新途程 → 一鍵改單
//
// 實際的置換由 /api/sara/exchange-csv/replace-order 在伺服器端一次完成，
// 前端不做「讀整包 → 改 → 整包寫回」，避免中途被 17:30/17:40 的排程寫入洗掉。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { buildSaraRow, type SaraRow } from '../../../../lib/sara/buildSaraRow'
import { DEFAULT_PRIORITY_RULES, type PriorityRule } from '../../../../lib/sara/priorityRules'
import {
  applyMachineAssignments,
  generateSaraRows,
  loadRouteMeta,
  parseSheetHits,
  FACTORY_LABEL,
  type SheetHitRow,
} from '../../../../lib/sara/clientRowGen'

/** 交換區裡屬於某個品項的一列（欄序同 CSV_H1） */
interface BufferRow {
  seq: string
  workcenter: string
  job_name: string
  job_qty: string
  est_time: string
  due: string
  priority: string
}

/**
 * prefill：由「塔台異常回報」面板按下「帶入改單」時傳進來。
 * token 每次都要換一個新值（用時間戳），否則同一筆連按兩次不會重新觸發查詢。
 */
export interface RouteChangePrefill { order: string; seq: string; token: number }

export default function OrderRouteChange(
  { onChanged, prefill }: { onChanged: () => void; prefill?: RouteChangePrefill | null }
) {
  const prioRulesRef = useRef<PriorityRule[]>(DEFAULT_PRIORITY_RULES)
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/sara/priority-rules', { cache: 'no-store' })
        const j = await res.json() as { success: boolean; rules?: PriorityRule[] }
        if (j.success && Array.isArray(j.rules)) prioRulesRef.current = j.rules
      } catch { /* 載入失敗沿用預設規則 */ }
    })()
  }, [])

  const [orderInput, setOrderInput] = useState('')
  const [seqInput, setSeqInput] = useState('')
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState('')

  // 查到的候選品項（序號沒填時可能不只一個，讓使用者點選）
  const [candidates, setCandidates] = useState<SheetHitRow[]>([])
  const [picked, setPicked] = useState<SheetHitRow | null>(null)

  // 這個品項目前在交換區（＝塔台下次會拉到）的工序
  const [currentRows, setCurrentRows] = useState<BufferRow[]>([])
  const [routeOptions, setRouteOptions] = useState<string[]>([])
  const [defaultRoute, setDefaultRoute] = useState('')
  const [newRoute, setNewRoute] = useState('')

  const [preview, setPreview] = useState<SaraRow[]>([])
  const [warns, setWarns] = useState<string[]>([])
  const [generating, setGenerating] = useState(false)
  const [applying, setApplying] = useState(false)
  const [doneMsg, setDoneMsg] = useState('')
  const searchRef = useRef<(() => void) | null>(null)

  const reset = () => {
    setCandidates([]); setPicked(null); setCurrentRows([])
    setNewRoute(''); setPreview([]); setWarns([]); setDoneMsg('')
  }

  // ── 選定品項：撈出它目前在交換區的工序 ─────────────────────────
  const pick = useCallback(async (row: SheetHitRow, defRoute: string) => {
    setPicked(row); setDefaultRoute(defRoute); setNewRoute(''); setPreview([]); setWarns([]); setDoneMsg('')
    if (!row.ref_number) { setCurrentRows([]); return }
    try {
      const res = await fetch('/api/sara/exchange-csv', { cache: 'no-store' })
      const j = await res.json() as { success: boolean; rows?: string[][] }
      // 比對鍵＝訂單號+工單號+品號，與 replace-order API 一致
      //（只比訂單號+工單號會把同一張採購單底下的其他品項也算進來，見該 API 的說明）
      const mine = (j.rows ?? []).filter(r =>
        String(r[0] ?? '').trim() === row.order_number &&
        String(r[1] ?? '').trim() === row.ref_number &&
        String(r[2] ?? '').trim() === row.item_code
      )
      setCurrentRows(mine.map(r => ({
        seq: r[9] ?? '', workcenter: r[10] ?? '', job_name: r[11] ?? '',
        job_qty: r[12] ?? '', est_time: r[14] ?? '', due: r[6] ?? '', priority: r[7] ?? '',
      })).sort((a, b) => Number(a.seq) - Number(b.seq)))
    } catch {
      setCurrentRows([])
    }
  }, [])

  // ── 查詢：出單表找品項 + 交換區找目前工序 ──────────────────────
  const handleSearch = useCallback(async () => {
    const q = orderInput.trim()
    if (!q) return
    setSearching(true); setError(''); reset()
    try {
      const res = await fetch(`/api/argoerp/daily-order-sheet?search=${encodeURIComponent(q)}`, { cache: 'no-store' })
      const json = await res.json() as { success: boolean; error?: string; results?: Array<{ sheet_date: string; rows: Record<string, unknown>[] }> }
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`)

      let hits = parseSheetHits(json.results ?? [])
      const seq = seqInput.trim()
      if (seq) {
        // 序號比對容忍前導 0（出單表有時填 01、有時填 1）
        const norm = (v: string) => String(Number(v)) === 'NaN' ? v : String(Number(v))
        hits = hits.filter(h => h.line_seq && norm(h.line_seq) === norm(seq))
      }
      if (hits.length === 0) {
        setError(seq ? `出單表裡找不到「${q}」序號 ${seq} 的品項` : `出單表裡找不到符合「${q}」的訂單`)
        return
      }
      await applyMachineAssignments(hits)
      const meta = await loadRouteMeta([...new Set(hits.map(h => h.item_code))])
      setRouteOptions(meta.routeOptions)
      setCandidates(hits)
      // 只有一個就直接選起來，省一次點擊
      if (hits.length === 1) await pick(hits[0], meta.defaultRoutes[hits[0].item_code] ?? '')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSearching(false)
    }
  }, [orderInput, seqInput, pick])

  // 異常回報「帶入改單」：把單號/序號填進來並自動查詢，
  // 生管不用再手動抄一次（用 ref 追 token，避免把 handleSearch 放進 deps 造成迴圈）
  const lastTokenRef = useRef(0)
  useEffect(() => {
    if (!prefill || prefill.token === lastTokenRef.current) return
    lastTokenRef.current = prefill.token
    setOrderInput(prefill.order)
    setSeqInput(prefill.seq)
    void (async () => {
      // 等 state 寫進去再查，直接沿用 handleSearch 會讀到舊值
      await new Promise(r => setTimeout(r, 0))
      searchRef.current?.()
    })()
  }, [prefill])

  useEffect(() => { searchRef.current = () => { void handleSearch() } }, [handleSearch])

  // ── 產生新工序預覽 ─────────────────────────────────────────────
  const handlePreview = useCallback(async () => {
    if (!picked || !newRoute) return
    setGenerating(true); setWarns([]); setPreview([]); setDoneMsg('')
    try {
      const { rows, warns: w } = await generateSaraRows([picked], () => newRoute, prioRulesRef.current)
      setPreview(rows); setWarns(w)
    } catch (e) {
      setWarns([`錯誤：${e instanceof Error ? e.message : String(e)}`])
    } finally {
      setGenerating(false)
    }
  }, [picked, newRoute])

  // ── 確定改單：伺服器端一次完成「刪舊 + 寫新」 ───────────────────
  const handleApply = useCallback(async () => {
    if (!picked?.ref_number || preview.length === 0) return
    const ok = confirm(
      `確定改單？\n\n${picked.order_number}／${picked.ref_number}\n${picked.item_code}\n\n` +
      `交換區目前的 ${currentRows.length} 道工序會被刪除，換成新途程「${newRoute}」的 ${preview.length} 道。\n` +
      `塔台下次（每天 18:00）來拉就會看到新的工序。`
    )
    if (!ok) return
    setApplying(true); setDoneMsg('')
    try {
      const res = await fetch('/api/sara/exchange-csv/replace-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          order_number: picked.order_number,
          mfg_order_number: picked.ref_number,
          product_name: picked.item_code,
          rows: preview.map(buildSaraRow),
        }),
      })
      const j = await res.json() as { success: boolean; removed?: number; added?: number; count?: number; error?: string }
      if (!j.success) throw new Error(j.error)
      setDoneMsg(`✅ 改單完成：刪除舊工序 ${j.removed} 道、寫入新工序 ${j.added} 道（交換區共 ${j.count} 列）`)
      onChanged()
      // 重新讀一次目前工序，畫面直接反映改完的狀態
      await pick(picked, defaultRoute)
      setPreview([])
    } catch (e) {
      setDoneMsg(`❌ 改單失敗：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setApplying(false)
    }
  }, [picked, preview, currentRows.length, newRoute, onChanged, pick, defaultRoute])

  const input = 'px-3 py-2 rounded bg-slate-800 border border-slate-700 text-white text-sm focus:outline-none focus:border-rose-500'
  const sameRoute = useMemo(() => !!newRoute && newRoute === defaultRoute, [newRoute, defaultRoute])

  return (
    <div className="mb-6 rounded-xl border border-rose-800/40 bg-rose-950/20 p-5 space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-rose-300">🔁 改單（換工序）</h2>
        <p className="text-xs text-slate-400 mt-0.5">
          輸入銷售單號＋序號 → 看到該品項目前在塔台的工序 → 選新途程 →
          一鍵完成「刪舊＋寫新」，不用再分三步手動處理。
        </p>
      </div>

      {/* 查詢 */}
      <div className="flex items-end gap-2 flex-wrap">
        <div>
          <label className="block text-[11px] text-slate-500 mb-1">銷售單號</label>
          <input value={orderInput} onChange={e => setOrderInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void handleSearch() }}
            placeholder="例：SO260901015" className={`${input} w-52 font-mono`} />
        </div>
        <div>
          <label className="block text-[11px] text-slate-500 mb-1">序號（項號，可留空）</label>
          <input value={seqInput} onChange={e => setSeqInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void handleSearch() }}
            placeholder="例：2" className={`${input} w-28 font-mono`} />
        </div>
        <button onClick={() => void handleSearch()} disabled={searching || !orderInput.trim()}
          className="px-4 py-2 rounded bg-rose-700 hover:bg-rose-600 disabled:bg-slate-700 disabled:text-slate-500 text-white text-sm font-medium transition-colors">
          {searching ? '查詢中…' : '查詢'}
        </button>
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>

      {/* 候選品項（序號沒填、或一張單有多個品項時） */}
      {candidates.length > 1 && (
        <div>
          <div className="text-[11px] text-slate-500 mb-1.5">這張單有 {candidates.length} 個品項，選一個要改的：</div>
          <div className="flex flex-col gap-1.5">
            {candidates.map((c, i) => (
              <button key={`${c.order_number}-${c.line_seq}-${c.item_code}-${i}`}
                onClick={() => void pick(c, '')}
                className={`text-left px-3 py-2 rounded border text-xs transition-colors ${
                  picked === c ? 'bg-rose-900/40 border-rose-600 text-white' : 'bg-slate-900 border-slate-700 text-slate-300 hover:border-slate-500'
                }`}>
                <span className="font-mono">序號 {c.line_seq || '—'}</span>
                <span className="mx-2 text-slate-500">|</span>
                <span className="font-mono">{c.item_code}</span>
                <span className="mx-2 text-slate-500">|</span>
                <span>數量 {c.quantity}</span>
                <span className="mx-2 text-slate-500">|</span>
                <span className="text-slate-400">{FACTORY_LABEL[c.factory ?? ''] ?? '—'}廠・{c.ref_number || '未轉單'}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {picked && (
        <div className="rounded-lg border border-slate-700 bg-slate-900/60 p-4 space-y-4">
          {/* 品項資訊 */}
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
            <span className="text-slate-400">訂單號 <span className="text-white font-mono ml-1">{picked.order_number}</span></span>
            <span className="text-slate-400">序號 <span className="text-white font-mono ml-1">{picked.line_seq || '—'}</span></span>
            <span className="text-slate-400">工單號 <span className="text-white font-mono ml-1">{picked.ref_number || '（尚未轉單）'}</span></span>
            <span className="text-slate-400">品號 <span className="text-white font-mono ml-1">{picked.item_code}</span></span>
            <span className="text-slate-400">數量 <span className="text-white ml-1">{picked.quantity}</span></span>
            <span className="text-slate-400">需求日 <span className="text-white ml-1">{picked.due || '—'}</span></span>
            <span className="text-slate-400">廠區 <span className="text-white ml-1">{FACTORY_LABEL[picked.factory ?? ''] ?? '—'}</span></span>
          </div>

          {!picked.ref_number && (
            <div className="text-xs text-amber-400 bg-amber-950/30 border border-amber-800/40 rounded px-3 py-2">
              ⚠️ 這一列還沒有製令／採購／請購單號，無法對應到塔台的工單，請先完成轉單。
            </div>
          )}

          {/* 目前在塔台的工序 */}
          <div>
            <div className="text-[11px] text-slate-500 mb-1.5">
              目前在交換區的工序（塔台下次拉取會看到的內容）：
              <span className="text-slate-300 ml-1">{currentRows.length} 道</span>
            </div>
            {currentRows.length === 0 ? (
              <div className="text-xs text-slate-600 border border-slate-800 rounded px-3 py-2">
                交換區裡沒有這個品項的工序——按下改單會直接寫入新的一組。
              </div>
            ) : (
              <div className="rounded border border-slate-800 overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-slate-900/80 text-slate-500">
                    <tr>
                      <th className="text-left px-3 py-1.5 w-16">工序</th>
                      <th className="text-left px-3 py-1.5 w-32">站點</th>
                      <th className="text-left px-3 py-1.5">製程名稱</th>
                      <th className="text-right px-3 py-1.5 w-20">數量</th>
                      <th className="text-right px-3 py-1.5 w-24">預估工時</th>
                    </tr>
                  </thead>
                  <tbody>
                    {currentRows.map((r, i) => (
                      <tr key={i} className="border-t border-slate-800">
                        <td className="px-3 py-1.5 font-mono text-slate-400">{r.seq}</td>
                        <td className="px-3 py-1.5 text-slate-300">{r.workcenter}</td>
                        <td className="px-3 py-1.5 text-white">{r.job_name}</td>
                        <td className="px-3 py-1.5 text-right font-mono text-slate-400">{r.job_qty}</td>
                        <td className="px-3 py-1.5 text-right font-mono text-slate-400">{r.est_time}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* 選新途程 */}
          <div className="flex items-end gap-2 flex-wrap">
            <div className="flex-1 min-w-[16rem]">
              <label className="block text-[11px] text-slate-500 mb-1">
                換成新途程{defaultRoute && <span className="ml-1 text-slate-600">（品項預設：{defaultRoute}）</span>}
              </label>
              <select value={newRoute} onChange={e => { setNewRoute(e.target.value); setPreview([]) }}
                className={`${input} w-full`}>
                <option value="">— 請選擇途程 —</option>
                {routeOptions.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <button onClick={() => void handlePreview()} disabled={!newRoute || generating || !picked.ref_number}
              className="px-4 py-2 rounded bg-slate-700 hover:bg-slate-600 disabled:bg-slate-800 disabled:text-slate-600 text-white text-sm font-medium transition-colors">
              {generating ? '產生中…' : '產生新工序'}
            </button>
          </div>
          {sameRoute && (
            <div className="text-[11px] text-amber-400">
              提醒：選的途程跟品項目前的預設途程相同，改完內容可能跟現在一樣。
            </div>
          )}

          {warns.length > 0 && (
            <div className="text-xs text-amber-400 bg-amber-950/30 border border-amber-800/40 rounded px-3 py-2 space-y-1">
              {warns.map((w, i) => <div key={i}>⚠️ {w}</div>)}
            </div>
          )}

          {/* 新工序預覽 + 確定改單 */}
          {preview.length > 0 && (
            <div>
              <div className="text-[11px] text-slate-500 mb-1.5">
                改單後的工序（<span className="text-emerald-400">{preview.length} 道</span>）：
              </div>
              <div className="rounded border border-emerald-800/40 overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-emerald-950/30 text-emerald-400/70">
                    <tr>
                      <th className="text-left px-3 py-1.5 w-16">工序</th>
                      <th className="text-left px-3 py-1.5 w-32">站點</th>
                      <th className="text-left px-3 py-1.5">製程名稱</th>
                      <th className="text-right px-3 py-1.5 w-20">數量</th>
                      <th className="text-right px-3 py-1.5 w-24">預估工時</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.map((r, i) => (
                      <tr key={i} className="border-t border-slate-800">
                        <td className="px-3 py-1.5 font-mono text-slate-400">{r.job_seq}</td>
                        <td className="px-3 py-1.5 text-slate-300">{r.workcenter}</td>
                        <td className="px-3 py-1.5 text-white">{r.job_name}</td>
                        <td className="px-3 py-1.5 text-right font-mono text-slate-400">{r.job_qty}</td>
                        <td className="px-3 py-1.5 text-right font-mono text-slate-400">{r.est_time}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex items-center gap-3 mt-3 flex-wrap">
                <button onClick={() => void handleApply()} disabled={applying}
                  className="px-5 py-2 rounded bg-rose-600 hover:bg-rose-500 disabled:bg-slate-700 text-white text-sm font-bold transition-colors">
                  {applying ? '改單中…' : `✔ 確定改單（刪 ${currentRows.length} 道 → 寫 ${preview.length} 道）`}
                </button>
                <span className="text-[11px] text-slate-500">
                  按下後立即生效於交換區；塔台每天 18:00 來拉，18:00 前改完都來得及。
                </span>
              </div>
            </div>
          )}

          {doneMsg && (
            <div className={`text-xs ${doneMsg.startsWith('✅') ? 'text-emerald-400' : 'text-red-400'}`}>{doneMsg}</div>
          )}
        </div>
      )}
    </div>
  )
}
