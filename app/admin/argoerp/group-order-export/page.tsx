'use client'

import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../../../../lib/supabaseClient'

// ==================== 型別 ====================
interface GroupRow {
  row_key: string
  order_number: string
  doc_type: string
  factory: 'T' | 'C' | 'O'
  customer: string
  item_code: string
  item_name: string
  note: string
  quantity: string
  delivery_date: string
  plate_count: string
  handler: string
  issuer: string
  is_sample: string
  has_material: string
  designer: string
  line_nickname: string
  upload_ro: string
  order_status: string
  pm_note: string
  receiver: string
  mo_status: '已匯入製令' | '暫緩區' | null
  mo_number?: string
  sheet_date: string  // 來源出單日期（本地注入）
}

// ==================== 工具函式 ====================
function fmtDate(d: Date): string {
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

function nextBizDay(from: Date): Date {
  const d = new Date(from)
  d.setDate(d.getDate() + 1)
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1)
  return d
}

function truncateToBytes(text: string, maxBytes: number): string {
  const enc = new TextEncoder()
  const bytes = enc.encode(text)
  if (bytes.length <= maxBytes) return text
  const dec = new TextDecoder('utf-8')
  let cut = maxBytes
  while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) cut--
  return dec.decode(bytes.slice(0, cut))
}

// 建立送往 ERP IFAF028 介面的 payload record
function buildErpRecord(row: GroupRow, moNumber: string): Record<string, string> {
  const today = new Date()
  const rec: Record<string, string> = {}
  rec['PROJECT_ID'] = moNumber
  rec['BEGIN_DATE'] = fmtDate(nextBizDay(today))
  if (row.delivery_date) rec['END_DATE'] = row.delivery_date.replace(/\//g, '-')
  rec['HOLD_STATUS'] = 'OPEN'
  rec['SEG_SEGMENT_NO_DEPARTMENT'] = 'M1100'
  rec['PJT_SEG_SEGMENT_NO'] = 'M1000'
  rec['LINE_NO'] = '1'
  if (row.item_code) rec['MBP_PART'] = row.item_code
  rec['MBP_VER'] = '1'
  if (row.order_number) rec['MBP_LOT_NO'] = truncateToBytes(row.order_number, 30)
  if (row.quantity) rec['ORDER_QTY'] = row.quantity
  rec['BOM_LEVELS'] = '99'
  rec['EQUIVALENT_RATIO'] = '1'
  rec['EQUIVALENT_RATIO_M'] = '1'
  if (row.order_number) rec['PJT_PROJECT_ID_MO_SO'] = row.order_number
  const noteStr = [row.item_name, row.note].filter(Boolean).join(' ')
  if (noteStr) rec['REMARK_LINE'] = noteStr
  rec['MO_BEGIN_DATE'] = fmtDate(today)
  rec['AUTO_PREPARE'] = 'N'
  return rec
}

function FactoryBadge({ factory }: { factory: 'T' | 'C' | 'O' }) {
  const map: Record<string, string> = {
    T: 'bg-blue-900/40 text-blue-300',
    C: 'bg-orange-900/40 text-orange-300',
    O: 'bg-purple-900/40 text-purple-300',
  }
  const label: Record<string, string> = { T: '台北', C: '常平', O: '委外' }
  return (
    <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${map[factory]}`}>
      {label[factory]}
    </span>
  )
}

// ==================== 頁面元件 ====================
export default function GroupOrderExportPage() {
  const [rows, setRows] = useState<GroupRow[]>([])
  const [loading, setLoading] = useState(false)
  const [manualMo, setManualMo] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [importing, setImporting] = useState(false)
  const [saveMsg, setSaveMsg] = useState('')
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  const [filterStatus, setFilterStatus] = useState<'all' | 'pending' | 'imported'>('all')
  const [searchQuery, setSearchQuery] = useState('')

  // ---- 從 Supabase 載入所有含「集單」的列 ----
  const loadRows = useCallback(async () => {
    setLoading(true)
    setSaveMsg('')
    try {
      const { data: sheets, error } = await supabase
        .from('daily_order_sheets')
        .select('sheet_date, rows')
        .order('sheet_date', { ascending: false })
      if (error) throw error

      const allRows: GroupRow[] = []
      for (const sheet of (sheets ?? [])) {
        const sheetRows = Array.isArray(sheet.rows) ? (sheet.rows as GroupRow[]) : []
        for (const row of sheetRows) {
          if ((row.doc_type ?? '').includes('集單')) {
            allRows.push({ ...row, sheet_date: sheet.sheet_date })
          }
        }
      }
      setRows(allRows)

      // 預填已有的製令單號
      const mo: Record<string, string> = {}
      for (const r of allRows) {
        if (r.mo_number) mo[r.row_key] = r.mo_number
      }
      setManualMo(mo)
    } catch (e) {
      setSaveMsg(`❌ 載入失敗：${e}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadRows() }, [loadRows])

  // ---- 計算顯示列 ----
  const displayRows = rows.filter(r => {
    if (filterStatus === 'pending' && r.mo_status === '已匯入製令') return false
    if (filterStatus === 'imported' && r.mo_status !== '已匯入製令') return false
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase()
      return (
        r.order_number?.toLowerCase().includes(q) ||
        r.item_code?.toLowerCase().includes(q) ||
        r.item_name?.toLowerCase().includes(q) ||
        r.customer?.toLowerCase().includes(q) ||
        r.doc_type?.toLowerCase().includes(q) ||
        (manualMo[r.row_key] ?? '').toLowerCase().includes(q)
      )
    }
    return true
  })

  const allSelected = displayRows.length > 0 && displayRows.every(r => selectedKeys.has(r.row_key))
  const toggleAll = () => {
    if (allSelected) setSelectedKeys(new Set())
    else setSelectedKeys(new Set(displayRows.map(r => r.row_key)))
  }

  function getTargetRows(requireMo: boolean): GroupRow[] {
    const base = selectedKeys.size > 0
      ? displayRows.filter(r => selectedKeys.has(r.row_key))
      : displayRows
    if (requireMo) return base.filter(r => (manualMo[r.row_key] ?? '').trim() !== '')
    return base
  }

  // ---- 儲存製令單號至出單表（不匯入 ERP）----
  const handleSaveMo = useCallback(async () => {
    const targets = getTargetRows(true).filter(r => r.mo_status !== '已匯入製令')
    if (targets.length === 0) {
      setSaveMsg('ℹ️ 沒有可儲存的列（請確認已填寫製令單號）')
      setTimeout(() => setSaveMsg(''), 3000)
      return
    }
    setSaving(true)
    setSaveMsg('')
    try {
      const byDate = new Map<string, Array<{ row_key: string; mo_number: string }>>()
      for (const r of targets) {
        const arr = byDate.get(r.sheet_date) ?? []
        arr.push({ row_key: r.row_key, mo_number: (manualMo[r.row_key] ?? '').trim() })
        byDate.set(r.sheet_date, arr)
      }
      for (const [date, updates] of byDate) {
        const res = await fetch('/api/argoerp/daily-order-sheet', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sheet_date: date,
            updates: updates.map(u => ({ row_key: u.row_key, mo_number: u.mo_number })),
          }),
        })
        const json = await res.json()
        if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`)
      }
      setRows(prev => prev.map(r => {
        const hit = targets.find(t => t.row_key === r.row_key)
        if (!hit) return r
        return { ...r, mo_number: manualMo[r.row_key] }
      }))
      setSaveMsg(`✅ 已儲存 ${targets.length} 筆製令單號`)
      setTimeout(() => setSaveMsg(''), 4000)
    } catch (e) {
      setSaveMsg(`❌ 儲存失敗：${e}`)
      setTimeout(() => setSaveMsg(''), 6000)
    } finally {
      setSaving(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, selectedKeys, displayRows, manualMo])

  // ---- 匯入 ERP 製令工單 ----
  const handleImport = useCallback(async () => {
    const targets = getTargetRows(true).filter(r => r.mo_status !== '已匯入製令')
    if (targets.length === 0) {
      alert('⚠️ 沒有可匯入的列（請確認已填寫製令單號且尚未匯入）')
      return
    }
    setImporting(true)
    setSaveMsg('')
    try {
      const payload = targets.map(r => buildErpRecord(r, (manualMo[r.row_key] ?? '').trim()))
      const response = await fetch('/api/argoerp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'import', interfaceId: 'IFAF028', data: payload }),
      })
      const result = await response.json()
      const isSuccess = response.ok && result?.success === true

      const argoResults: Record<string, unknown>[] = Array.isArray(result?.apiResult?.RESULT)
        ? (result.apiResult.RESULT as Record<string, unknown>[])
        : []

      let successRows: GroupRow[] = []
      const failedRows: Array<{ row: GroupRow; error: string }> = []

      if (argoResults.length > 0) {
        const failedSlips = new Map<string, string[]>()
        const seenSlips = new Set<string>()
        for (const r of argoResults) {
          const slip = String(r.SLIP_NO ?? '').trim()
          if (!slip) continue
          seenSlips.add(slip)
          if (String(r.CHECK_FLAG ?? '').toUpperCase() === 'N') {
            const err = String(r.ERROR_CODE ?? r.ERROR ?? '未知錯誤').trim()
            if (!failedSlips.has(slip)) failedSlips.set(slip, [])
            failedSlips.get(slip)!.push(err)
          }
        }
        for (const r of targets) {
          const mo = (manualMo[r.row_key] ?? '').trim()
          if (failedSlips.has(mo)) {
            failedRows.push({ row: r, error: failedSlips.get(mo)!.join(' / ') })
          } else if (seenSlips.has(mo)) {
            successRows.push(r)
          } else {
            failedRows.push({ row: r, error: 'ARGO 未回報此筆狀態' })
          }
        }
      } else if (isSuccess) {
        successRows = targets
      } else {
        throw new Error(result?.error || result?.message || `HTTP ${response.status}`)
      }

      if (successRows.length > 0) {
        const byDate = new Map<string, Array<{ row_key: string; mo_number: string }>>()
        for (const r of successRows) {
          const arr = byDate.get(r.sheet_date) ?? []
          arr.push({ row_key: r.row_key, mo_number: (manualMo[r.row_key] ?? '').trim() })
          byDate.set(r.sheet_date, arr)
        }
        for (const [date, updates] of byDate) {
          await fetch('/api/argoerp/daily-order-sheet', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sheet_date: date,
              updates: updates.map(u => ({
                row_key: u.row_key,
                mo_status: '已匯入製令',
                mo_number: u.mo_number,
              })),
            }),
          }).catch(() => {})
        }

        const now = new Date()
        fetch('/api/argoerp/mo-upload-log', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            rows: successRows.map(r => ({
              mo_number: (manualMo[r.row_key] ?? '').trim(),
              factory: r.factory,
              product_code: r.item_code,
              planned_qty: r.quantity,
              source_order: r.order_number,
              lot_number: truncateToBytes(r.order_number, 30),
              mo_note: [r.item_name, r.note].filter(Boolean).join(' '),
              planned_start_date: fmtDate(nextBizDay(now)),
              planned_end_date: r.delivery_date,
              create_date: fmtDate(now),
              interface_id: 'IFAF028',
            })),
          }),
        }).catch(() => {})

        const successKeys = new Set(successRows.map(r => r.row_key))
        setRows(prev => prev.map(r => {
          if (!successKeys.has(r.row_key)) return r
          return { ...r, mo_status: '已匯入製令', mo_number: manualMo[r.row_key] }
        }))
      }

      const msg = `✅ 成功 ${successRows.length} 筆${failedRows.length > 0 ? `，❌ 失敗 ${failedRows.length} 筆` : ''}`
      setSaveMsg(msg)
      if (failedRows.length > 0) {
        alert(`${msg}\n\n失敗明細：\n${failedRows.slice(0, 10).map(f => `${f.row.order_number} [${f.row.item_code}]: ${f.error}`).join('\n')}`)
      }
      setTimeout(() => setSaveMsg(''), 8000)
    } catch (e) {
      setSaveMsg(`❌ 匯入失敗：${e}`)
      setTimeout(() => setSaveMsg(''), 8000)
    } finally {
      setImporting(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, selectedKeys, displayRows, manualMo])

  const importedCount = rows.filter(r => r.mo_status === '已匯入製令').length
  const pendingCount = rows.length - importedCount

  return (
    <div className="min-h-screen bg-slate-950 text-white p-4 md:p-6">
      <div className="max-w-[1600px] mx-auto space-y-4">

        {/* 標題區 */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-white">集合單 ➜ 製令工單</h1>
            <p className="text-xs text-slate-400 mt-0.5">
              顯示所有出單表中單據種類含「集單」的項目，不限日期。手動填入製令單號後可匯入 ERP。
            </p>
          </div>
          <div className="flex flex-wrap gap-2 items-center">
            <button
              onClick={loadRows}
              disabled={loading}
              className="px-3 py-1.5 rounded bg-slate-700 hover:bg-slate-600 text-white text-xs disabled:opacity-50"
            >
              {loading ? '載入中…' : '🔄 重新載入'}
            </button>
            <button
              onClick={handleSaveMo}
              disabled={saving || importing || loading}
              className="px-4 py-1.5 rounded bg-slate-600 hover:bg-slate-500 text-white text-xs font-semibold disabled:opacity-50"
            >
              {saving ? '儲存中…' : '💾 儲存製令單號'}
            </button>
            <button
              onClick={handleImport}
              disabled={importing || saving || loading}
              className="px-4 py-1.5 rounded bg-cyan-700 hover:bg-cyan-600 text-white text-xs font-semibold disabled:opacity-50"
            >
              {importing ? '匯入中…' : '⬆ 匯入 ERP 製令工單'}
            </button>
          </div>
        </div>

        {/* 訊息 */}
        {saveMsg && (
          <div className={`px-4 py-2 rounded text-sm border ${
            saveMsg.startsWith('✅') ? 'bg-emerald-900/50 text-emerald-300 border-emerald-700/50'
            : saveMsg.startsWith('ℹ️') ? 'bg-slate-800 text-slate-300 border-slate-700'
            : 'bg-red-900/50 text-red-300 border-red-700/50'
          }`}>
            {saveMsg}
          </div>
        )}

        {/* 統計 + 篩選 */}
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-slate-300">
            共 <span className="text-cyan-300 font-bold">{rows.length}</span> 筆・
            已匯入：<span className="text-emerald-400">{importedCount}</span>・
            待匯入：<span className="text-amber-400">{pendingCount}</span>
          </span>
          <div className="flex gap-1 text-xs">
            {(['all', 'pending', 'imported'] as const).map(f => (
              <button
                key={f}
                onClick={() => setFilterStatus(f)}
                className={`px-2.5 py-1 rounded border transition-colors ${
                  filterStatus === f
                    ? 'bg-cyan-800 border-cyan-600 text-cyan-200'
                    : 'bg-slate-800 border-slate-700 text-slate-400 hover:bg-slate-700'
                }`}
              >
                {f === 'all' ? '全部' : f === 'pending' ? '待匯入' : '已匯入'}
              </button>
            ))}
          </div>
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="搜尋工單、品項、客戶、製令…"
            className="bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded px-3 py-1.5 w-56 focus:outline-none focus:border-cyan-500 placeholder-slate-500"
          />
          {selectedKeys.size > 0 && (
            <span className="text-xs text-cyan-400">已選 {selectedKeys.size} 筆</span>
          )}
        </div>

        {/* 表格 */}
        {loading ? (
          <div className="text-center py-20 text-slate-500 text-sm">載入中…</div>
        ) : displayRows.length === 0 ? (
          <div className="text-center py-20 text-slate-500 text-sm">
            {rows.length === 0 ? '所有出單表中目前無「集單」類型的資料' : '篩選條件下無符合的列'}
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-slate-800">
            <table className="w-full text-xs text-left border-collapse">
              <thead>
                <tr className="bg-slate-900 text-slate-400 uppercase text-[11px]">
                  <th className="px-2 py-2 border-b border-slate-800 w-8 text-center">
                    <input type="checkbox" checked={allSelected} onChange={toggleAll} className="accent-cyan-500 cursor-pointer" />
                  </th>
                  <th className="px-3 py-2 border-b border-slate-800 w-8">#</th>
                  <th className="px-3 py-2 border-b border-slate-800 whitespace-nowrap text-slate-500">出單日期</th>
                  <th className="px-3 py-2 border-b border-slate-800 text-cyan-400">工單編號</th>
                  <th className="px-3 py-2 border-b border-slate-800">單據種類</th>
                  <th className="px-3 py-2 border-b border-slate-800">廠別</th>
                  <th className="px-3 py-2 border-b border-slate-800">客戶</th>
                  <th className="px-3 py-2 border-b border-slate-800 text-purple-300 min-w-[260px]">品項編碼 / 品名規格</th>
                  <th className="px-3 py-2 border-b border-slate-800">備註</th>
                  <th className="px-3 py-2 border-b border-slate-800 text-right">數量</th>
                  <th className="px-3 py-2 border-b border-slate-800 whitespace-nowrap">交付日</th>
                  <th className="px-3 py-2 border-b border-slate-800 text-yellow-400 text-center">盤數</th>
                  <th className="px-3 py-2 border-b border-slate-800">承辦人</th>
                  <th className="px-3 py-2 border-b border-slate-800">開單人員</th>
                  <th className="px-3 py-2 border-b border-slate-800">打樣</th>
                  <th className="px-3 py-2 border-b border-slate-800">附素材</th>
                  <th className="px-3 py-2 border-b border-slate-800">訂單狀態</th>
                  <th className="px-3 py-2 border-b border-slate-800">生管備註</th>
                  <th className="px-3 py-2 border-b border-slate-800 text-cyan-300 min-w-[160px]">製令單號（手動填入）</th>
                  <th className="px-3 py-2 border-b border-slate-800 w-24">狀態</th>
                </tr>
              </thead>
              <tbody>
                {displayRows.map((row, idx) => {
                  const isImported = row.mo_status === '已匯入製令'
                  const hasMo = !!(manualMo[row.row_key] ?? '').trim()
                  return (
                    <tr
                      key={row.row_key}
                      className={`border-b border-slate-800/60 transition-colors ${
                        isImported ? 'bg-emerald-950/20' : hasMo ? 'bg-cyan-950/10' : 'hover:bg-slate-900/50'
                      }`}
                    >
                      <td className="px-2 py-2 text-center">
                        <input
                          type="checkbox"
                          checked={selectedKeys.has(row.row_key)}
                          onChange={() => setSelectedKeys(prev => {
                            const next = new Set(prev)
                            next.has(row.row_key) ? next.delete(row.row_key) : next.add(row.row_key)
                            return next
                          })}
                          className="accent-cyan-500 cursor-pointer"
                        />
                      </td>
                      <td className="px-3 py-2 text-slate-600">{idx + 1}</td>
                      <td className="px-3 py-2 font-mono text-slate-500 whitespace-nowrap">{row.sheet_date}</td>
                      <td className="px-3 py-2 font-mono text-cyan-300 whitespace-nowrap">{row.order_number}</td>
                      <td className="px-3 py-2 text-slate-300 whitespace-nowrap">{row.doc_type}</td>
                      <td className="px-3 py-2"><FactoryBadge factory={row.factory} /></td>
                      <td className="px-3 py-2 text-slate-300">{row.customer}</td>
                      <td className="px-3 py-2">
                        <div className="text-purple-300 font-mono">{row.item_code}</div>
                        {row.item_name && <div className="text-slate-400 mt-0.5">{row.item_name}</div>}
                      </td>
                      <td className="px-3 py-2 text-slate-400 max-w-[160px] truncate" title={row.note}>{row.note}</td>
                      <td className="px-3 py-2 text-right text-white whitespace-nowrap">{row.quantity}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-slate-300">{row.delivery_date}</td>
                      <td className="px-3 py-2 text-center text-yellow-400">{row.plate_count}</td>
                      <td className="px-3 py-2 text-slate-400">{row.handler}</td>
                      <td className="px-3 py-2 text-slate-400">{row.issuer}</td>
                      <td className="px-3 py-2 text-slate-400">{row.is_sample}</td>
                      <td className="px-3 py-2 text-slate-400">{row.has_material}</td>
                      <td className="px-3 py-2 text-slate-400">{row.order_status}</td>
                      <td className="px-3 py-2 text-slate-500 max-w-[140px] truncate" title={row.pm_note}>{row.pm_note}</td>
                      <td className="px-3 py-2">
                        {isImported ? (
                          <span className="font-mono text-emerald-400">{row.mo_number}</span>
                        ) : (
                          <input
                            type="text"
                            value={manualMo[row.row_key] ?? ''}
                            onChange={e => setManualMo(prev => ({ ...prev, [row.row_key]: e.target.value }))}
                            placeholder="MOT…"
                            className="w-full bg-slate-800 border border-slate-600 text-slate-200 text-xs rounded px-2 py-1 focus:outline-none focus:border-cyan-500 font-mono placeholder-slate-600"
                          />
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {isImported ? (
                          <span className="px-2 py-0.5 rounded text-xs bg-emerald-900/50 text-emerald-300 border border-emerald-700/50 whitespace-nowrap">已匯入製令</span>
                        ) : hasMo ? (
                          <span className="px-2 py-0.5 rounded text-xs bg-cyan-900/50 text-cyan-300 border border-cyan-700/50 whitespace-nowrap">待匯入</span>
                        ) : (
                          <span className="text-slate-600 text-xs">— —</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* 說明 */}
        <div className="text-xs text-slate-600 space-y-1 pt-2">
          <p>・「儲存製令單號」：僅將手動輸入的製令單號存回出單表資料庫，不呼叫 ERP API（適合補登已在 ERP 建立的製令）。</p>
          <p>・「匯入 ERP 製令工單」：呼叫 IFAF028 介面將製令送入 ERP，成功後自動更新出單表狀態為「已匯入製令」。</p>
          <p>・若僅勾選部分列，操作只影響勾選的列；未勾選時則操作全部顯示中的列。</p>
        </div>
      </div>
    </div>
  )
}

