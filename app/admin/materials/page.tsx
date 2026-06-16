'use client'

import { useCallback, useEffect, useState } from 'react'
import * as XLSX from 'xlsx'
import Link from 'next/link'
import { supabase } from '../../../lib/supabaseClient'
import InventorySyncPanel, { type InventorySyncResult } from '../../../components/InventorySyncPanel'

interface MaterialItem {
  id: number
  sequence_no: number | null
  item_code: string
  item_name: string
  spec: string
  unit_of_measure: string | null
  physical_count: number
  book_count: number
  qisheng_sichuan_total: number
  updated_at: string
}

type ExcelRow = Array<string | number | null>

const normalizeHeader = (header: string) =>
  header
    .replace(/\s+/g, '')
    .replace(/[【\[]/g, '【')
    .replace(/[】\]]/g, '】')
    .trim()

const parseNumeric = (value: string | number | null | undefined) => {
  if (value === null || value === undefined || value === '') return 0
  const normalized = String(value).replace(/,/g, '').trim()
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : 0
}

export default function MaterialsPage() {
  const PAGE_SIZE = 50

  const [loading, setLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [rows, setRows] = useState<MaterialItem[]>([])
  const [logs, setLogs] = useState<string[]>([])
  const [keyword, setKeyword] = useState('')
  const [currentPage, setCurrentPage] = useState(1)
  const [totalCount, setTotalCount] = useState(0)

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE))

  const addLog = (message: string) => {
    setLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${message}`])
  }

  const fetchList = useCallback(async (page = currentPage, search = keyword) => {
    setLoading(true)
    const from = (page - 1) * PAGE_SIZE
    const to = from + PAGE_SIZE - 1
    const normalizedKeyword = search.trim()

    let query = supabase
      .from('material_inventory_list')
      .select('id, sequence_no, item_code, item_name, spec, unit_of_measure, physical_count, book_count, qisheng_sichuan_total, updated_at', { count: 'exact' })
      .order('sequence_no', { ascending: true, nullsFirst: false })
      .order('id', { ascending: true })
      .range(from, to)

    if (normalizedKeyword) {
      const escapedKeyword = normalizedKeyword.replace(/,/g, '\\,')
      const orConditions = [
        `item_code.ilike.%${escapedKeyword}%`,
        `item_name.ilike.%${escapedKeyword}%`,
        `spec.ilike.%${escapedKeyword}%`,
      ]

      const numericValue = Number(normalizedKeyword.replace(/,/g, ''))
      if (Number.isFinite(numericValue)) {
        orConditions.push(
          `sequence_no.eq.${numericValue}`,
          `physical_count.eq.${numericValue}`,
          `book_count.eq.${numericValue}`,
          `qisheng_sichuan_total.eq.${numericValue}`
        )
      }

      query = query.or(orConditions.join(','))
    }

    const { data, error, count } = await query

    if (error) {
      addLog(`❌ 讀取清單失敗：${error.message}`)
      setRows([])
      setTotalCount(0)
    } else {
      setRows((data as MaterialItem[]) || [])
      setTotalCount(count ?? 0)
    }
    setLoading(false)
  }, [PAGE_SIZE, currentPage, keyword])

  const handleInventorySynced = useCallback(async (result: InventorySyncResult) => {
    addLog(`🔄 已從 ARGO 同步 ${result.syncedCount} 筆庫存資料（來源：${result.table}）`)
    setCurrentPage(1)
    await fetchList(1, keyword)
  }, [fetchList, keyword])

  useEffect(() => {
    void fetchList(currentPage, keyword)
  }, [currentPage, keyword, fetchList])

  const processExcel = async (file: File) => {
    setUploading(true)
    setLogs([])

    try {
      addLog(`📖 讀取檔案：${file.name}`)
      const arrayBuffer = await file.arrayBuffer()
      const workbook = XLSX.read(arrayBuffer, { type: 'array' })
      const firstSheetName = workbook.SheetNames[0]

      if (!firstSheetName) {
        throw new Error('找不到可讀取的工作表')
      }

      const worksheet = workbook.Sheets[firstSheetName]
      const allRows = XLSX.utils.sheet_to_json<ExcelRow>(worksheet, {
        header: 1,
        defval: '',
        raw: false,
      })

      if (allRows.length < 3) {
        throw new Error('Excel 列數不足，至少需包含前兩列與資料列')
      }

      // 自動偵測格式：ERP 格式（含 MBP_PART）或自訂格式
      const row0Headers = (allRows[0] || []).map((v) => String(v || '').trim().toUpperCase())
      const row1Headers = (allRows[1] || []).map((v) => String(v || '').trim().toUpperCase())
      const isErpFormat = row0Headers.includes('MBP_PART') || row1Headers.includes('MBP_PART')

      let payload: Array<{
        sequence_no: number
        item_code: string
        item_name: string
        spec: string
        physical_count: number
        book_count: number
        qisheng_sichuan_total: number
        updated_at: string
      }>

      if (isErpFormat) {
        // ---- ERP 庫存余額匯出格式（IVCF001 Excel Dump）----
        // Header 在第 1 列（index 0），資料從第 2 列開始
        const headerRow = row0Headers
        const idx = {
          mbp_part: headerRow.indexOf('MBP_PART'),
          qty: headerRow.indexOf('QTY'),
          unit: headerRow.indexOf('UNIT_OF_MEAS'),
          lot_no: headerRow.indexOf('LOT_NO'),
          mbp_ver: headerRow.indexOf('MBP_VER'),
        }

        if (idx.mbp_part < 0) throw new Error('ERP 格式缺少 MBP_PART 欄位')
        if (idx.qty < 0) throw new Error('ERP 格式缺少 QTY 欄位')

        addLog('✅ 偵測到 ArgoERP IVCF001 格式，從第 2 列開始匯入')

        // 同一料號可能有多倉多批，加總 QTY
        const aggregated = new Map<string, number>()
        for (const row of allRows.slice(1)) {
          const partRaw = String(row[idx.mbp_part] || '').trim()
          if (!partRaw) continue
          const qty = parseNumeric(row[idx.qty])
          aggregated.set(partRaw, (aggregated.get(partRaw) ?? 0) + qty)
        }

        addLog(`📦 料號去重後共 ${aggregated.size} 筆（多倉/批次已加總）`)

        let seq = 1
        payload = Array.from(aggregated.entries()).map(([itemCode, totalQty]) => ({
          sequence_no: seq++,
          item_code: itemCode,
          item_name: '',
          spec: '',
          physical_count: 0,
          book_count: totalQty,
          qisheng_sichuan_total: 0,
          updated_at: new Date().toISOString(),
        }))
      } else {
        // ---- 原有自訂格式（序號 / 品項編碼 / 帳上數量 …）----
        addLog('✅ 已套用規則：跳過第 1 列，第 2 列為標題，從第 3 列開始匯入')

        const headerRow = (allRows[1] || []).map((value) => normalizeHeader(String(value || '')))
        const headerIndex = {
          sequence_no: headerRow.findIndex((value) => value === '序號'),
          item_code: headerRow.findIndex((value) => value === '品項編碼'),
          item_name: headerRow.findIndex((value) => value === '品項名稱'),
          spec: headerRow.findIndex((value) => value === '規格'),
          physical_count: headerRow.findIndex((value) => value === '盤點數量'),
          book_count: headerRow.findIndex((value) => value === '帳上數量'),
          qisheng_sichuan_total: headerRow.findIndex((value) => value === '啟盛【四川總倉】'),
        }

        const missingHeaders = Object.entries(headerIndex)
          .filter(([, index]) => index < 0)
          .map(([key]) => key)

        if (missingHeaders.length > 0) {
          throw new Error(`缺少必要欄位：${missingHeaders.join(', ')}。若要上傳 ERP 匯出請確認含有 MBP_PART 欄位。`)
        }

        payload = allRows.slice(2)
          .map((row) => {
            const itemCode = String(row[headerIndex.item_code] || '').trim()
            if (!itemCode) return null
            return {
              sequence_no: parseNumeric(row[headerIndex.sequence_no]),
              item_code: itemCode,
              item_name: String(row[headerIndex.item_name] || '').trim(),
              spec: String(row[headerIndex.spec] || '').trim(),
              physical_count: parseNumeric(row[headerIndex.physical_count]),
              book_count: parseNumeric(row[headerIndex.book_count]),
              qisheng_sichuan_total: parseNumeric(row[headerIndex.qisheng_sichuan_total]),
              updated_at: new Date().toISOString(),
            }
          })
          .filter((row): row is NonNullable<typeof row> => Boolean(row))
      }

      if (payload.length === 0) {
        throw new Error('沒有可匯入資料（品項編碼不可為空）')
      }

      addLog(`🧹 清空舊資料，共準備匯入 ${payload.length} 筆`)
      const { error: clearError } = await supabase.from('material_inventory_list').delete().neq('id', 0)
      if (clearError) {
        throw new Error(`清空舊資料失敗：${clearError.message}`)
      }

      const batchSize = 500
      for (let index = 0; index < payload.length; index += batchSize) {
        const chunk = payload.slice(index, index + batchSize)
        addLog(`⬆️ 寫入中：${Math.min(index + chunk.length, payload.length)}/${payload.length}`)
        const { error: insertError } = await supabase.from('material_inventory_list').insert(chunk)
        if (insertError) {
          throw new Error(`寫入失敗：${insertError.message}`)
        }
      }

      addLog('🎉 匯入完成')
      setCurrentPage(1)
      await fetchList(1, keyword)
      alert(`匯入成功，共 ${payload.length} 筆`) 
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知錯誤'
      addLog(`❌ ${message}`)
      alert(`匯入失敗：${message}`)
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="p-8 max-w-[1400px] mx-auto text-slate-300 min-h-screen space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-white tracking-tight">物料清單</h1>
        <p className="text-orange-500 mt-1 font-mono text-sm uppercase">MATERIAL MANAGEMENT // Excel 更新清單</p>
      </div>

      <div className="flex flex-wrap gap-3">
        <Link
          href="/admin/materials/bom"
          className="px-4 py-2 rounded border border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800 text-sm font-bold"
        >
          BOM表
        </Link>
        <Link
          href="/admin/materials/substitute"
          className="px-4 py-2 rounded border border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800 text-sm font-bold"
        >
          替代料號設定
        </Link>
      </div>

      <div className="bg-slate-900 border border-slate-700 rounded-xl p-6 space-y-4">
        <InventorySyncPanel
          title="同步 ARGO 庫存到物料清單"
          description="同步成功後會直接更新 material_inventory_list。Excel 匯入仍可保留做手動覆寫或備援。"
          initialConfig={{
            table: 'IVCF013',
            customColumn: '',
            sequenceNoField: '',
            itemCodeField: 'ITEM_CODE',
            itemNameField: 'ITEM_NAME',
            specField: 'SPEC',
            physicalCountField: '',
            bookCountField: 'BOOK_QTY',
            warehouseTotalField: '',
            groupByItemCode: false,
          }}
          onSynced={handleInventorySynced}
        />

        <div className="flex flex-col md:flex-row md:items-center gap-3">
          <input
            type="file"
            accept=".xlsx,.xls"
            disabled={uploading}
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void processExcel(file)
              event.currentTarget.value = ''
            }}
            className="text-sm text-slate-400 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-cyan-900/30 file:text-cyan-400 hover:file:bg-cyan-900/50"
          />

          <button
            onClick={() => void fetchList()}
            disabled={loading || uploading}
            className="px-4 py-2 rounded border border-slate-600 bg-slate-800 hover:bg-slate-700 text-sm font-bold disabled:opacity-50"
          >
            重新載入清單
          </button>
        </div>

        <div className="text-xs text-slate-500">
          上傳規則：跳過第 1 列，第 2 列必須是標題列，從第 3 列開始抓取資料。
        </div>

        {logs.length > 0 && (
          <div className="bg-black/40 border border-slate-800 rounded p-3 max-h-48 overflow-y-auto text-xs font-mono text-cyan-300 space-y-1">
            {logs.map((log) => (
              <div key={log}>{log}</div>
            ))}
          </div>
        )}
      </div>

      <div className="bg-slate-900/60 border border-slate-700 rounded-xl overflow-hidden">
        <div className="p-4 border-b border-slate-800 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div className="text-sm text-slate-400">
            顯示第 {currentPage} 頁，每頁 {PAGE_SIZE} 筆，總筆數 {totalCount}
          </div>
          <input
            type="text"
            value={keyword}
            onChange={(event) => {
              setKeyword(event.target.value)
              setCurrentPage(1)
            }}
            placeholder="搜尋任意關鍵字（編碼/名稱/規格/數量）"
            className="w-full md:w-[360px] bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-white focus:border-cyan-500 outline-none"
          />
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[1100px] text-sm">
            <thead className="bg-slate-950 text-slate-300">
              <tr>
                <th className="p-3 text-left">序號</th>
                <th className="p-3 text-left">品項編碼</th>
                <th className="p-3 text-left">品項名稱</th>
                <th className="p-3 text-left">規格</th>
                <th className="p-3 text-left">單位</th>
                <th className="p-3 text-right">盤點數量</th>
                <th className="p-3 text-right">帳上數量</th>
                <th className="p-3 text-right">啟盛【四川總倉】</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {loading ? (
                <tr>
                  <td colSpan={8} className="p-8 text-center text-slate-500">讀取中...</td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="p-8 text-center text-slate-500">
                    {totalCount === 0 ? '目前無資料，請先上傳 Excel' : '找不到符合關鍵字的資料'}
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.id} className="hover:bg-slate-800/30">
                    <td className="p-3">{row.sequence_no ?? '-'}</td>
                    <td className="p-3 font-mono text-cyan-300">{row.item_code}</td>
                    <td className="p-3">{row.item_name}</td>
                    <td className="p-3">{row.spec}</td>
                    <td className="p-3">{row.unit_of_measure ?? '-'}</td>
                    <td className="p-3 text-right font-mono">{row.physical_count}</td>
                    <td className="p-3 text-right font-mono">{row.book_count}</td>
                    <td className="p-3 text-right font-mono">{row.qisheng_sichuan_total}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="p-4 border-t border-slate-800 flex items-center justify-between gap-3">
          <button
            onClick={() => setCurrentPage((prev) => Math.max(1, prev - 1))}
            disabled={currentPage <= 1 || loading}
            className="px-4 py-2 rounded border border-slate-700 bg-slate-800 text-slate-300 text-sm disabled:opacity-40 disabled:cursor-not-allowed"
          >
            上一頁
          </button>

          <div className="text-sm text-slate-400">
            第 {currentPage} / {totalPages} 頁
          </div>

          <button
            onClick={() => setCurrentPage((prev) => Math.min(totalPages, prev + 1))}
            disabled={currentPage >= totalPages || loading}
            className="px-4 py-2 rounded border border-slate-700 bg-slate-800 text-slate-300 text-sm disabled:opacity-40 disabled:cursor-not-allowed"
          >
            下一頁
          </button>
        </div>
      </div>
    </div>
  )
}
