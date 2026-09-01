'use client'

// 美編天地「每日出單表」——試算表式編輯介面，取代貼 Excel 到生管出單表的前段流程。
// 每天 16:00 由排程（/api/cron/design-sheet-transfer）整批轉入生管的每日出單表；
// 16:00 之後新增資料一律鎖定進隔天（見 /api/design/daily-sheet 的 autoTargetDate）。

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'

interface Row {
  _key: string // 前端編輯識別用（跟轉入後產生的 row_key 無關）
  order_number: string
  line_no_input: string
  doc_type: string
  receiver: string
  is_sample: string
  has_material: string
  designer: string
  customer: string
  line_nickname: string
  handler: string
  issuer: string
  item_code: string
  item_name: string
  note: string
  packing: string
  quantity: string
  delivery_date: string
  plate_count: string
  upload_ro: string
  order_status: string
  pm_note: string
  assigned_machine: string
}

const FIELDS: { key: keyof Row; label: string; width: string }[] = [
  { key: 'order_number', label: '工單編號', width: 'w-32' },
  { key: 'line_no_input', label: '序號', width: 'w-16' },
  { key: 'doc_type', label: '單據種類', width: 'w-28' },
  { key: 'receiver', label: '簽收人員', width: 'w-20' },
  { key: 'is_sample', label: '打樣/追加', width: 'w-24' },
  { key: 'has_material', label: '附素材', width: 'w-20' },
  { key: 'designer', label: '美編', width: 'w-20' },
  { key: 'customer', label: '客戶', width: 'w-32' },
  { key: 'line_nickname', label: 'LINE暱稱', width: 'w-24' },
  { key: 'handler', label: '承辦人', width: 'w-20' },
  { key: 'issuer', label: '開單人員', width: 'w-20' },
  { key: 'item_code', label: '品項編碼', width: 'w-36' },
  { key: 'item_name', label: '品名/規格', width: 'w-64' },
  { key: 'note', label: '備註', width: 'w-40' },
  { key: 'packing', label: 'PACKING', width: 'w-24' },
  { key: 'quantity', label: '數量', width: 'w-20' },
  { key: 'delivery_date', label: '交付日期', width: 'w-28' },
  { key: 'plate_count', label: '版數', width: 'w-16' },
  { key: 'upload_ro', label: '上傳RO', width: 'w-20' },
  { key: 'order_status', label: '訂單狀態', width: 'w-24' },
  { key: 'pm_note', label: '生管備註', width: 'w-32' },
  { key: 'assigned_machine', label: '指定機台', width: 'w-24' },
]

const EMPTY_ROW = (): Row => ({
  _key: crypto.randomUUID(),
  order_number: '', line_no_input: '', doc_type: '', receiver: '', is_sample: '',
  has_material: '', designer: '', customer: '', line_nickname: '', handler: '',
  issuer: '', item_code: '', item_name: '', note: '', packing: '', quantity: '',
  delivery_date: '', plate_count: '', upload_ro: '', order_status: '', pm_note: '',
  assigned_machine: '',
})

function taipeiTodayStr(): string {
  const d = new Date(Date.now() + 8 * 3600 * 1000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}
function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
/** 現在（台北時間）是否已過 16:00 */
function isPastCutoff(): boolean {
  return new Date(Date.now() + 8 * 3600 * 1000).getUTCHours() >= 16
}

export default function DesignDailySheetPage() {
  const [selectedDate, setSelectedDate] = useState(() => isPastCutoff() ? addDays(taipeiTodayStr(), 1) : taipeiTodayStr())
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState('')
  const [transferredAt, setTransferredAt] = useState<string | null>(null)

  const load = useCallback(async (date: string) => {
    setLoading(true)
    try {
      const res = await fetch(`/api/design/daily-sheet?date=${date}`, { cache: 'no-store' })
      const json = await res.json()
      if (!json.success) throw new Error(json.error || '載入失敗')
      const stored = Array.isArray(json.sheet?.rows) ? json.sheet.rows as Partial<Row>[] : []
      setRows(stored.length > 0
        ? stored.map(r => ({ ...EMPTY_ROW(), ...r, _key: crypto.randomUUID() }))
        : [EMPTY_ROW()])
      setTransferredAt(json.sheet?.transferred_at ?? null)
    } catch (e) {
      setSaveMsg(`❌ 載入失敗：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load(selectedDate) }, [selectedDate, load])

  const updateCell = (key: string, field: keyof Row, value: string) => {
    setRows(prev => prev.map(r => r._key === key ? { ...r, [field]: value } : r))
  }
  const addRow = () => setRows(prev => [...prev, EMPTY_ROW()])
  const removeRow = (key: string) => setRows(prev => prev.length > 1 ? prev.filter(r => r._key !== key) : prev)

  const handleSave = useCallback(async () => {
    setSaving(true)
    setSaveMsg('')
    try {
      const cleanRows = rows
        .filter(r => r.order_number.trim() || r.item_code.trim())
        .map(({ _key, ...rest }) => { void _key; return rest })
      const res = await fetch('/api/design/daily-sheet', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: selectedDate, rows: cleanRows }),
      })
      const json = await res.json()
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`)
      setSaveMsg(`✅ 已儲存（${cleanRows.length} 筆）`)
      setTimeout(() => setSaveMsg(''), 4000)
    } catch (e) {
      setSaveMsg(`❌ 儲存失敗：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
  }, [rows, selectedDate])

  const isToday = selectedDate === taipeiTodayStr()
  const locked = isToday && isPastCutoff()
  const filledCount = useMemo(() => rows.filter(r => r.order_number.trim() || r.item_code.trim()).length, [rows])

  return (
    <main className="min-h-screen bg-slate-950 text-white">
      <div className="border-b border-slate-800 bg-slate-900/60 backdrop-blur-sm px-4 py-3 flex items-center gap-4">
        <Link href="/design-studio" className="text-xs text-slate-500 hover:text-slate-300 transition-colors shrink-0">
          ← 美編天地
        </Link>
        <h1 className="text-sm font-bold text-white">每日出單表</h1>
        <input
          type="date"
          value={selectedDate}
          onChange={e => setSelectedDate(e.target.value)}
          className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-white"
        />
        {locked && (
          <span className="text-[11px] px-2 py-0.5 rounded bg-amber-900/40 text-amber-300 border border-amber-700/50">
            🔒 已過 16:00，今天的資料已鎖定{transferredAt ? '（已轉入生管出單表）' : '（等待轉入生管出單表）'}
          </span>
        )}
        {!locked && transferredAt && (
          <span className="text-[11px] px-2 py-0.5 rounded bg-emerald-900/40 text-emerald-300 border border-emerald-700/50">
            ✅ 已轉入生管出單表
          </span>
        )}
        <div className="ml-auto flex items-center gap-3">
          {saveMsg && <span className="text-xs text-slate-300">{saveMsg}</span>}
          <span className="text-xs text-slate-500">共 {filledCount} 筆</span>
          <button
            onClick={addRow}
            className="px-3 py-1.5 rounded bg-slate-800 border border-slate-700 hover:border-cyan-600 text-xs font-semibold text-slate-200 transition-colors"
          >
            ＋ 新增列
          </button>
          <button
            onClick={() => void handleSave()}
            disabled={saving || loading}
            className="px-4 py-1.5 rounded bg-cyan-700 hover:bg-cyan-600 disabled:bg-slate-700 disabled:text-slate-500 text-xs font-semibold text-white transition-colors"
          >
            {saving ? '儲存中…' : '💾 儲存'}
          </button>
        </div>
      </div>

      <p className="px-4 py-2 text-[11px] text-slate-500 border-b border-slate-800/60">
        每天 16:00 自動把當天資料整批轉入生管的每日出單表；16:00 之後新增的資料一律進到隔天的出單表。
        銷售訂單查詢頁的「傳送到出單表」也會把資料送到這裡。
      </p>

      {loading ? (
        <div className="p-8 text-center text-slate-500 text-sm">載入中…</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="text-xs border-collapse w-max">
            <thead>
              <tr className="bg-slate-900 sticky top-0 z-10">
                <th className="w-8 border-b border-slate-800"></th>
                {FIELDS.map(f => (
                  <th key={f.key} className={`${f.width} px-1.5 py-2 text-left font-semibold text-slate-400 border-b border-slate-800 whitespace-nowrap`}>
                    {f.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row._key} className="hover:bg-slate-900/40 group">
                  <td className="text-center border-b border-slate-800/60">
                    <button
                      onClick={() => removeRow(row._key)}
                      className="text-slate-700 group-hover:text-red-400 transition-colors px-1"
                      title="刪除此列"
                    >
                      ✕
                    </button>
                  </td>
                  {FIELDS.map(f => (
                    <td key={f.key} className="border-b border-slate-800/60 p-0">
                      <input
                        value={row[f.key] as string}
                        onChange={e => updateCell(row._key, f.key, e.target.value)}
                        className={`${f.width} bg-transparent px-1.5 py-1.5 text-slate-200 focus:outline-none focus:bg-slate-800/80 placeholder-slate-700`}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  )
}
