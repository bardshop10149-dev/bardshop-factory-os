'use client'

import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../../../lib/supabaseClient'
import SoOrderModal from '../../../../components/SoOrderModal'

// ── 型別 ──────────────────────────────────────────────────────────────────────
interface SoChangeNotice {
  id: string
  project_id: string
  line_no: string
  changed_fields: string[]
  old_values: Record<string, string | number | null>
  new_values: Record<string, string | number | null>
  detected_at: string
  confirmed_at: string | null
  confirmed_by: string | null
}

const SO_CHANGE_FIELD_LABELS: Record<string, string> = {
  mbp_part: '料號', duedate: '交期', order_qty_oru: '數量', description: '品名/規格',
  hold_status: '狀態', partner_name: '客戶', packing: '包裝', sales_name: '業務',
}

function fmtDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('zh-TW', {
    year: '2-digit', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

// ── 主元件 ────────────────────────────────────────────────────────────────────
export default function SoChangeNoticesPage() {
  // 密碼鎖
  const [locked, setLocked] = useState(true)
  const [pw, setPw]         = useState('')
  const [pwError, setPwError] = useState('')

  // 資料
  const [notices, setNotices]         = useState<SoChangeNotice[]>([])
  const [loading, setLoading]         = useState(false)
  const [sheetDateMap, setSheetDateMap] = useState<Map<string, string[]>>(new Map())

  // UI 篩選
  const [showConfirmed, setShowConfirmed] = useState(false)
  const [filterProject, setFilterProject] = useState('')

  // Modal
  const [soModalId, setSoModalId] = useState<string | null>(null)

  // ── 載入 ────────────────────────────────────────────────────────────────────
  const loadNotices = useCallback(async () => {
    setLoading(true)
    try {
      const { data: noticeData, error } = await supabase
        .from('so_change_notices')
        .select('*')
        .order('detected_at', { ascending: false })
        .limit(500)
      if (error) throw error

      const list = (noticeData ?? []) as SoChangeNotice[]
      setNotices(list)

      // 建立 project_id → sheet_date[] 對照表
      const projectIds = new Set(list.map(n => n.project_id))
      if (projectIds.size > 0) {
        const { data: sheetData } = await supabase
          .from('daily_order_sheets')
          .select('sheet_date, rows')
          .order('sheet_date', { ascending: false })
          .limit(180)

        const map = new Map<string, string[]>()
        for (const sheet of (sheetData ?? []) as Array<{ sheet_date: string; rows: unknown }>) {
          const rows = Array.isArray(sheet.rows) ? sheet.rows as Record<string, unknown>[] : []
          for (const row of rows) {
            const orderNo = String(row.order_number ?? '').trim()
            if (projectIds.has(orderNo)) {
              if (!map.has(orderNo)) map.set(orderNo, [])
              const dates = map.get(orderNo)!
              if (!dates.includes(sheet.sheet_date)) dates.push(sheet.sheet_date)
            }
          }
        }
        setSheetDateMap(map)
      }
    } catch (e) {
      alert(`載入失敗：${e}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!locked) void loadNotices()
  }, [locked, loadNotices])

  // ── 確認 ────────────────────────────────────────────────────────────────────
  const handleConfirm = useCallback(async (id: string) => {
    const { error } = await supabase
      .from('so_change_notices')
      .update({ confirmed_at: new Date().toISOString() })
      .eq('id', id)
    if (error) { alert(`確認失敗：${error.message}`); return }
    setNotices(prev => prev.map(n =>
      n.id === id ? { ...n, confirmed_at: new Date().toISOString() } : n
    ))
  }, [])

  // ── 全部確認 ─────────────────────────────────────────────────────────────────
  const handleConfirmAll = useCallback(async () => {
    const unconfirmed = notices.filter(n => !n.confirmed_at)
    if (unconfirmed.length === 0) return
    if (!confirm(`確定將 ${unconfirmed.length} 筆未確認改單全部標為已確認？`)) return
    const ids = unconfirmed.map(n => n.id)
    const { error } = await supabase
      .from('so_change_notices')
      .update({ confirmed_at: new Date().toISOString() })
      .in('id', ids)
    if (error) { alert(`操作失敗：${error.message}`); return }
    const ts = new Date().toISOString()
    setNotices(prev => prev.map(n => ids.includes(n.id) ? { ...n, confirmed_at: ts } : n))
  }, [notices])

  // ── 篩選 ────────────────────────────────────────────────────────────────────
  const filtered = notices.filter(n => {
    if (!showConfirmed && n.confirmed_at) return false
    if (filterProject && !n.project_id.toLowerCase().includes(filterProject.toLowerCase())) return false
    return true
  })

  const unconfirmedCount = notices.filter(n => !n.confirmed_at).length

  // ── 密碼頁面 ────────────────────────────────────────────────────────────────
  if (locked) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
        <div className="text-6xl">🔒</div>
        <h1 className="text-lg font-bold text-slate-300">改單提示</h1>
        <p className="text-slate-500 text-sm">此頁面已鎖定，請輸入密碼解鎖</p>
        <div className="flex gap-2 mt-2">
          <input
            type="password"
            value={pw}
            onChange={e => { setPw(e.target.value); setPwError('') }}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                if (pw === '666') { setLocked(false); setPw('') }
                else setPwError('密碼錯誤')
              }
            }}
            placeholder="請輸入密碼"
            className="px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm w-40 focus:outline-none focus:border-cyan-500"
          />
          <button
            onClick={() => {
              if (pw === '666') { setLocked(false); setPw('') }
              else setPwError('密碼錯誤')
            }}
            className="px-4 py-2 rounded-lg bg-cyan-700 hover:bg-cyan-600 text-white text-sm font-medium"
          >解鎖</button>
        </div>
        {pwError && <p className="text-red-400 text-sm">{pwError}</p>}
      </div>
    )
  }

  // ── 主頁面 ──────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-4 p-1">

      {/* ── Header ── */}
      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-xl font-bold text-red-300">⚠️ 改單提示</h1>
        <span className="text-slate-500 text-sm">ERP 同步時偵測到的銷售訂單欄位變動，請逐筆確認</span>
        {unconfirmedCount > 0 && (
          <span className="px-2 py-0.5 rounded-full bg-red-500 text-white text-xs font-bold">
            {unconfirmedCount} 筆未確認
          </span>
        )}
        <div className="ml-auto flex items-center gap-2 flex-wrap">
          {unconfirmedCount > 0 && (
            <button
              onClick={() => void handleConfirmAll()}
              className="px-3 py-1.5 rounded-lg bg-emerald-800 hover:bg-emerald-700 text-white text-xs font-medium"
            >✅ 全部確認</button>
          )}
          <button
            onClick={() => void loadNotices()} disabled={loading}
            className="px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-xs font-medium disabled:opacity-50"
          >{loading ? '載入中…' : '🔄 重新載入'}</button>
          <button
            onClick={() => setLocked(true)}
            className="px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-300 text-xs"
          >🔒 鎖定</button>
        </div>
      </div>

      {/* ── 篩選列 ── */}
      <div className="flex items-center gap-3 flex-wrap">
        <input
          type="text"
          value={filterProject}
          onChange={e => setFilterProject(e.target.value)}
          placeholder="篩選訂單號…"
          className="px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-white text-xs w-44 focus:outline-none focus:border-cyan-500"
        />
        <label className="flex items-center gap-1.5 text-sm text-slate-400 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showConfirmed}
            onChange={e => setShowConfirmed(e.target.checked)}
            className="accent-cyan-500"
          />
          顯示已確認
        </label>
        <span className="text-slate-600 text-xs ml-auto">
          共 {filtered.length} 筆{showConfirmed ? `（全部 ${notices.length} 筆）` : ''}
        </span>
      </div>

      {/* ── 主體 ── */}
      {loading ? (
        <div className="text-center py-24 text-slate-500">載入中…</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-24 text-slate-600">
          <div className="text-5xl mb-3">{notices.length === 0 ? '✅' : '🎉'}</div>
          <p className="text-sm">
            {notices.length === 0
              ? '目前無改單記錄'
              : filterProject
              ? '無符合搜尋的記錄'
              : '所有改單已確認完畢'}
          </p>
        </div>
      ) : (
        <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left border-collapse">
              <thead>
                <tr className="bg-slate-800/80 text-slate-400 text-[11px] uppercase tracking-wider">
                  <th className="px-3 py-2.5 whitespace-nowrap">狀態</th>
                  <th className="px-3 py-2.5 whitespace-nowrap">訂單號</th>
                  <th className="px-3 py-2.5 whitespace-nowrap">行號</th>
                  <th className="px-3 py-2.5 whitespace-nowrap">出單表日期</th>
                  <th className="px-3 py-2.5 whitespace-nowrap">偵測日期</th>
                  <th className="px-3 py-2.5 whitespace-nowrap">確認日期</th>
                  <th className="px-3 py-2.5">變動內容（舊值 → 新值）</th>
                  <th className="px-3 py-2.5 whitespace-nowrap"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {filtered.map(n => {
                  const sheetDates = sheetDateMap.get(n.project_id) ?? []
                  return (
                    <tr
                      key={n.id}
                      className={`hover:bg-slate-800/30 transition-colors ${n.confirmed_at ? 'opacity-40' : ''}`}
                    >
                      {/* 狀態 */}
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        {n.confirmed_at
                          ? <span className="px-1.5 py-0.5 rounded text-[10px] bg-slate-700 text-slate-400 border border-slate-600">已確認</span>
                          : <span className="px-1.5 py-0.5 rounded text-[10px] bg-red-700/50 text-red-200 border border-red-600/40 animate-pulse">未確認</span>}
                      </td>

                      {/* 訂單號 */}
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        <button
                          onClick={() => setSoModalId(n.project_id)}
                          className="font-mono text-cyan-300 hover:text-cyan-100 hover:underline"
                        >{n.project_id}</button>
                      </td>

                      {/* 行號 */}
                      <td className="px-3 py-2.5 whitespace-nowrap font-mono text-slate-400">{n.line_no}</td>

                      {/* 出單表日期 */}
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        {sheetDates.length > 0 ? (
                          <div className="flex flex-col gap-0.5">
                            {sheetDates.slice(0, 4).map(d => (
                              <span key={d} className="font-mono text-emerald-400 text-[11px]">{d}</span>
                            ))}
                            {sheetDates.length > 4 && (
                              <span className="text-slate-500 text-[10px]">+{sheetDates.length - 4} 天</span>
                            )}
                          </div>
                        ) : (
                          <span className="text-slate-600 text-[11px]">查無出單表</span>
                        )}
                      </td>

                      {/* 偵測日期 */}
                      <td className="px-3 py-2.5 whitespace-nowrap font-mono text-slate-400 text-[11px]">
                        {fmtDate(n.detected_at)}
                      </td>

                      {/* 確認日期 */}
                      <td className="px-3 py-2.5 whitespace-nowrap font-mono text-[11px]">
                        {n.confirmed_at
                          ? <span className="text-emerald-500">{fmtDate(n.confirmed_at)}</span>
                          : <span className="text-slate-600">—</span>}
                      </td>

                      {/* 變動內容 */}
                      <td className="px-3 py-2.5">
                        <div className="space-y-0.5">
                          {n.changed_fields.map(f => (
                            <div key={f} className="flex items-center gap-1.5 text-[11px]">
                              <span className="text-slate-500 w-16 shrink-0 font-medium">
                                {SO_CHANGE_FIELD_LABELS[f] ?? f}:
                              </span>
                              <span className="text-red-300 line-through max-w-[120px] truncate" title={String(n.old_values[f] ?? '')}>
                                {String(n.old_values[f] ?? '—')}
                              </span>
                              <span className="text-slate-500">→</span>
                              <span className="text-emerald-300 max-w-[120px] truncate" title={String(n.new_values[f] ?? '')}>
                                {String(n.new_values[f] ?? '—')}
                              </span>
                            </div>
                          ))}
                        </div>
                      </td>

                      {/* 確認按鈕 */}
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        {!n.confirmed_at && (
                          <button
                            onClick={() => void handleConfirm(n.id)}
                            className="px-3 py-1 rounded bg-emerald-700 hover:bg-emerald-600 text-white text-[11px] font-medium"
                          >確認</button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <SoOrderModal projectId={soModalId} onClose={() => setSoModalId(null)} />
    </div>
  )
}
