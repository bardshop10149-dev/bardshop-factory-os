
'use client'

import React from 'react'

import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'


import { supabase } from '../../../../lib/supabaseClient'
import Papa from 'papaparse'
import * as XLSX from 'xlsx'




interface BomRow {
  id?: number
  product_code: string
  product_name: string
  production_quantity?: number
  production_unit?: string
  note?: string
  material_code: string
  material_name: string
  quantity: number
  unit: string
}

function parseCSV(text: string) {
  // 使用 papaparse 解析
  const result = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: h => h.trim(),
    dynamicTyping: false
  })
  return result.data
}

export default function MaterialsBomPage() {
    // 物料清單快取
    const [materialMap, setMaterialMap] = useState<Record<string, number>>({})
    // 替代料號規則快取
    const [substituteMap, setSubstituteMap] = useState<Record<string, { substitute_item_code: string, priority: number }[]>>({})
    // 替代料號的庫存快取
    const [substituteInventoryMap, setSubstituteInventoryMap] = useState<Record<string, number>>({})

    // 讀取物料清單帳上數量
    async function fetchMaterialBookCount() {
      const { data, error } = await supabase
        .from('material_inventory_list')
        .select('item_code, book_count')
      if (!error && data) {
        const map: Record<string, number> = {}
        data.forEach(row => {
          map[row.item_code] = row.book_count
        })
        setMaterialMap(map)
      }
    }

    // 讀取替代料號規則
    async function fetchSubstituteRules() {
      const { data, error } = await supabase
        .from('material_substitute_rules')
        .select('source_item_code, substitute_item_code, priority')
      if (!error && data) {
        // group by source_item_code
        const map: Record<string, { substitute_item_code: string, priority: number }[]> = {}
        data.forEach(row => {
          if (!map[row.source_item_code]) map[row.source_item_code] = []
          map[row.source_item_code].push({ substitute_item_code: row.substitute_item_code, priority: row.priority })
        })
        // sort by priority
        Object.values(map).forEach(list => list.sort((a, b) => a.priority - b.priority))
        setSubstituteMap(map)
      }
    }

    // 讀取所有替代料號的庫存
    async function fetchSubstituteInventory(substituteCodes: string[]) {
      if (substituteCodes.length === 0) return
      const { data, error } = await supabase
        .from('material_inventory_list')
        .select('item_code, book_count')
        .in('item_code', substituteCodes)
      if (!error && data) {
        const map: Record<string, number> = {}
        data.forEach(row => {
          map[row.item_code] = row.book_count
        })
        setSubstituteInventoryMap(map)
      }
    }
  const fileInput = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [downloadingCsv, setDownloadingCsv] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  // === 欄寬調整 ===
  const COL_KEYS = ['prod_code','prod_name','prod_qty','prod_unit','mat_code','mat_name','qty','mat_unit','note','stock','substitute'] as const
  const COL_LABELS = ['生產品項編碼','生產品項名稱','生產數量','生產單位','消耗品項編碼','消耗品項名稱','消耗數量','消耗單位','備註','庫存','替代料號/庫存']
  const DEFAULT_WIDTHS: Record<string, number> = { prod_code: 160, prod_name: 260, prod_qty: 70, prod_unit: 60, mat_code: 160, mat_name: 200, qty: 60, mat_unit: 60, note: 80, stock: 70, substitute: 180 }
  const [colWidths, setColWidths] = useState<Record<string, number>>(() => {
    if (typeof window !== 'undefined') {
      try {
        const saved = localStorage.getItem('bom_col_widths')
        if (saved) return JSON.parse(saved)
      } catch {}
    }
    return { ...DEFAULT_WIDTHS }
  })
  const [resizeMode, setResizeMode] = useState(false)
  const dragRef = useRef<{ key: string; startX: number; startW: number } | null>(null)

  const saveWidths = useCallback((widths: Record<string, number>) => {
    try { localStorage.setItem('bom_col_widths', JSON.stringify(widths)) } catch {}
  }, [])

  const onMouseDown = useCallback((key: string, e: React.MouseEvent) => {
    if (!resizeMode) return
    e.preventDefault()
    dragRef.current = { key, startX: e.clientX, startW: colWidths[key] }
    const onMouseMove = (ev: MouseEvent) => {
      if (!dragRef.current) return
      const diff = ev.clientX - dragRef.current.startX
      const newW = Math.max(40, dragRef.current.startW + diff)
      setColWidths(prev => {
        const next = { ...prev, [dragRef.current!.key]: newW }
        saveWidths(next)
        return next
      })
    }
    const onMouseUp = () => {
      dragRef.current = null
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [resizeMode, colWidths, saveWidths])

  const resetWidths = useCallback(() => {
    setColWidths({ ...DEFAULT_WIDTHS })
    saveWidths({ ...DEFAULT_WIDTHS })
  }, [saveWidths])
  const [bomData, setBomData] = useState<BomRow[]>([])
  const [loadingBom, setLoadingBom] = useState(false)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [search, setSearch] = useState('')
  const PAGE_SIZE = 100

  // 讀取 BOM 資料
  async function fetchBomData() {
    setLoadingBom(true)
    // 查詢條件
    let query = supabase.from('bom').select('id, product_code, product_name, production_quantity, production_unit, note, material_code, material_name, quantity, unit', { count: 'exact' })
    if (search.trim()) {
      query = query.ilike('product_code', `%${search.trim()}%`)
    }
    query = query.order('id', { ascending: false })
      .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1)
    const { data, error, count } = await query
    if (!error) {
      setBomData(data || [])
      setTotal(count || 0)
    }
    setLoadingBom(false)
  }

  // 初次載入與上傳成功後都會重新撈資料
  React.useEffect(() => {
    fetchBomData();
    fetchMaterialBookCount();
    fetchSubstituteRules();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, search])

  // 當substituteMap更新時，批量查詢所有替代料號的庫存
  React.useEffect(() => {
    // 收集所有出現過的substitute_item_code
    const codes = Object.values(substituteMap).flat().map(x => x.substitute_item_code)
    // 去重
    const uniqueCodes = Array.from(new Set(codes))
    fetchSubstituteInventory(uniqueCodes)
  }, [substituteMap])

  // 新增: 處理自動觸發 file input 並自動上傳
  function handleSelectAndUpload() {
    fileInput.current?.click()
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setMessage(null)
    setUploading(true)
    try {
      const isXlsx = file.name.endsWith('.xlsx') || file.name.endsWith('.xls')
      let rows: Record<string, string>[]
      if (isXlsx) {
        const buffer = await file.arrayBuffer()
        const workbook = XLSX.read(buffer, { type: 'array' })
        const sheetName = workbook.SheetNames[0]
        const sheet = workbook.Sheets[sheetName]
        rows = XLSX.utils.sheet_to_json<Record<string, string>>(sheet, { defval: '' })
        // trim header keys
        rows = rows.map(row => {
          const trimmed: Record<string, string> = {}
          for (const [k, v] of Object.entries(row)) {
            trimmed[k.trim()] = String(v ?? '').trim()
          }
          return trimmed
        })
      } else {
        const text = await file.text()
        rows = parseCSV(text)
      }
      const headers = rows.length > 0 ? Object.keys(rows[0]) : []
      // 顯示實際解析到的 header
      if (rows.length > 0) {
        setMessage('解析到的欄位：' + headers.join(' , '))
        console.log('解析 headers:', headers)
      }
      // 欄位自動對應
      // 支援兩種格式：
      // 1. 生產品項編碼/名稱、消耗品項編碼/名稱、消耗數量
      // 2. 成品編號/名稱、原料編碼/名稱、數量
      // 先判斷是哪一種
      let col = {
        product_code: '',
        product_name: '',
        production_quantity: '',
        production_unit: '',
        note: '',
        material_code: '',
        material_name: '',
        quantity: '',
        unit: ''
      }
      if (headers.includes('生產品項編碼')) {
        col = {
          product_code: '生產品項編碼',
          product_name: '生產品項名稱',
          production_quantity: '生產數量',
          production_unit: '生產單位',
          note: '備註',
          material_code: '消耗品項編碼',
          material_name: '消耗品項名稱',
          quantity: '消耗數量',
          unit: '消耗單位'
        }
      } else if (headers.includes('成品編號')) {
        col = {
          product_code: '成品編號',
          product_name: '成品名稱',
          production_quantity: '生產數量',
          production_unit: '生產單位',
          note: '備註',
          material_code: '原料編碼',
          material_name: '原料名稱',
          quantity: '數量',
          unit: '消耗單位'
        }
      }
      // 必要欄位檢查
      const required = [col.product_code, col.material_code, col.quantity]
      const missing = required.filter(x => !x)
      if (missing.length > 0) {
        setMessage('❌ 上傳失敗：找不到必要欄位，請檢查標題。\n必須包含：生產品項編碼、生產品項名稱、生產數量、生產單位、消耗品項編碼、消耗品項名稱、消耗數量、消耗單位、備註\n（或：成品編號、成品名稱、生產數量、生產單位、原料編碼、原料名稱、數量、消耗單位、備註）')
        setUploading(false)
        if (fileInput.current) fileInput.current.value = ''
        return
      }

      // 過濾掉 product_code 為空的資料，並記錄問題行
      const bomRows: BomRow[] = []
      const errorRows: { row: number; content: Record<string, string>; msg?: string }[] = []
      rows.forEach((row, idx) => {
        const product_code = row[col.product_code]?.trim()
        const material_code = row[col.material_code]?.trim()
        const material_name = row[col.material_name]?.trim()
        const quantity = row[col.quantity]
        // 檢查是否所有欄位都為空
        const allEmpty = Object.values(row).every(v => !v || v.trim() === '')
        // debug log
        console.log(`[BOM上傳][第${idx+2}行]`, row, { product_code, material_code, material_name, quantity })
        if (allEmpty) {
          // 完全空白行自動忽略，不顯示錯誤
          return
        }
        if (!product_code) {
          errorRows.push({ row: idx + 2, content: row }) // +2: 1 for header, 1 for 0-index
        } else if (!material_code) {
          errorRows.push({ row: idx + 2, content: row, msg: 'material_code 欄位為空' })
        } else {
          bomRows.push({
            product_code,
            product_name: row[col.product_name],
            production_quantity: col.production_quantity ? Number(row[col.production_quantity]) || 1 : 1,
            production_unit: col.production_unit ? (row[col.production_unit]?.trim() || '') : '',
            note: col.note ? (row[col.note]?.trim() || '') : '',
            material_code,
            material_name,
            quantity: Number(quantity),
            unit: col.unit ? row[col.unit] : ''
          })
        }
      })
      if (errorRows.length > 0) {
        setMessage(
          `❌ 上傳失敗：第 ${errorRows.map(r => r.row).join(', ')} 行「成品編號」為空，請檢查資料。\n` +
          `實際解析到的欄位：${headers.join(' , ')}` +
          (errorRows.length < 5 ? `\n內容：${JSON.stringify(errorRows.map(r => r.content))}` : '')
        )
        return
      }
      if (bomRows.length === 0) {
        setMessage('❌ 上傳失敗：沒有有效資料。\n實際解析到的欄位：' + headers.join(' , '))
        return
      }
      const { error } = await supabase.from('bom').insert(bomRows)
      if (error) {
        console.error('Supabase insert error:', error)
        setMessage('❌ 上傳失敗: ' + (error.message || JSON.stringify(error)))
        return
      }
      setMessage('✅ 上傳成功！')
      setPage(1)
      fetchBomData()
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('Upload exception:', err)
      setMessage('❌ 上傳失敗: ' + message)
    } finally {
      setUploading(false)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async function handleUpload(e: React.FormEvent) {
    e.preventDefault()
    setMessage(null)
    const file = fileInput.current?.files?.[0]
    if (!file) return setMessage('請選擇CSV檔案')
    setUploading(true)
    try {
      const text = await file.text()
      const rows = parseCSV(text)
      // 轉成符合資料表格式
      const bomRows = rows.map(row => ({
        product_code: row['成品編號'],
        product_name: row['成品名稱'],
        material_code: row['原料編號'],
        material_name: row['原料名稱'],
        quantity: Number(row['數量']),
        unit: row['單位']
      }))
      // 批次寫入
      const { error } = await supabase.from('bom').insert(bomRows)
      if (error) {
        console.error('Supabase insert error:', error)
        setMessage('❌ 上傳失敗: ' + (error.message || JSON.stringify(error)))
        return
      }
      setMessage('✅ 上傳成功！')
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('Upload exception:', err)
      setMessage('❌ 上傳失敗: ' + message)
    } finally {
      setUploading(false)
    }
  }

  // 下載全部BOM資料為CSV（含替代料號）
  async function downloadBomCsv() {
    setDownloadingCsv(true)
    try {
      // 1. 撈取全部 BOM 資料
      const PAGE = 1000
      let allRows: BomRow[] = []
      let from = 0
      while (true) {
        const { data, error } = await supabase
          .from('bom')
          .select('product_code, product_name, production_quantity, production_unit, note, material_code, material_name, quantity, unit')
          .order('product_code', { ascending: true })
          .order('id', { ascending: true })
          .range(from, from + PAGE - 1)
        if (error) throw new Error(error.message)
        const chunk = (data ?? []) as BomRow[]
        allRows = allRows.concat(chunk)
        if (chunk.length < PAGE) break
        from += PAGE
      }

      // 2. 撈取替代料號規則
      const { data: subData, error: subError } = await supabase
        .from('material_substitute_rules')
        .select('source_item_code, substitute_item_code, priority')
        .order('source_item_code', { ascending: true })
        .order('priority', { ascending: true })
      if (subError) throw new Error(subError.message)
      // group by source_item_code, sorted by priority
      const subMap: Record<string, string[]> = {}
      ;(subData ?? []).forEach((r: { source_item_code: string; substitute_item_code: string; priority: number }) => {
        if (!subMap[r.source_item_code]) subMap[r.source_item_code] = []
        subMap[r.source_item_code].push(r.substitute_item_code)
      })

      // 3. 收集所有替代料號編碼，查詢中文名稱
      const allSubCodes = Array.from(new Set(Object.values(subMap).flat()))
      const nameMap: Record<string, string> = {}
      if (allSubCodes.length > 0) {
        // 分批查詢避免超過 URL 長度限制
        for (let i = 0; i < allSubCodes.length; i += 500) {
          const batch = allSubCodes.slice(i, i + 500)
          const { data: nameData } = await supabase
            .from('material_inventory_list')
            .select('item_code, item_name')
            .in('item_code', batch)
          ;(nameData ?? []).forEach((r: { item_code: string; item_name: string }) => {
            nameMap[r.item_code] = r.item_name
          })
        }
      }

      // 4. 計算最大替代料號順位數
      const maxSub = Math.max(0, ...Object.values(subMap).map(arr => arr.length))

      // 5. 組合 CSV
      const baseHeaders = ['生產品項編碼','生產品項名稱','生產數量','生產單位','消耗品項編碼','消耗品項名稱','消耗數量','消耗單位','備註']
      const subHeaders: string[] = []
      for (let i = 1; i <= maxSub; i++) {
        subHeaders.push(`替代料號第${i}順位編碼`, `替代料號第${i}順位名稱`)
      }
      const header = [...baseHeaders, ...subHeaders].join(',')

      const csvContent = [
        header,
        ...allRows.map(r => {
          const baseCols = [r.product_code, r.product_name, r.production_quantity ?? 1, r.production_unit ?? '', r.material_code, r.material_name, r.quantity, r.unit, r.note ?? '']
          const subs = subMap[r.material_code] || []
          const subCols: string[] = []
          for (let i = 0; i < maxSub; i++) {
            const code = subs[i] || ''
            const name = code ? (nameMap[code] || '') : ''
            subCols.push(code, name)
          }
          return [...baseCols, ...subCols]
            .map(v => `"${String(v ?? '').replace(/"/g, '""')}"`)
            .join(',')
        }),
      ].join('\n')

      const bom = '\uFEFF'
      const blob = new Blob([bom + csvContent], { type: 'text/csv;charset=utf-8;' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `BOM表_${new Date().toISOString().slice(0, 10)}.csv`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      alert(`下載失敗：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setDownloadingCsv(false)
    }
  }

  // 下載範例檔（XLSX）
  function downloadTemplate() {
    const templateData = [
      {
        '生產品項編碼': 'PROD-001',
        '生產品項名稱': '範例產品A',
        '生產數量': 1,
        '生產單位': '組',
        '消耗品項編碼': 'MAT-001',
        '消耗品項名稱': '範例原料A',
        '消耗數量': 1,
        '消耗單位': '個',
        '備註': ''
      },
      {
        '生產品項編碼': 'PROD-001',
        '生產品項名稱': '範例產品A',
        '生產數量': 1,
        '生產單位': '組',
        '消耗品項編碼': 'MAT-002',
        '消耗品項名稱': '範例原料B',
        '消耗數量': 2,
        '消耗單位': 'kg',
        '備註': '測試備註'
      }
    ]
    const ws = XLSX.utils.json_to_sheet(templateData)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'BOM範例')
    XLSX.writeFile(wb, 'BOM範例檔.xlsx')
  }

  // 清空BOM資料表
  async function handleClearBom() {
    if (!window.confirm('確定要清空所有BOM資料嗎？此動作無法復原！')) return;
    setMessage(null)
    setUploading(true)
    try {
      const { error } = await supabase.from('bom').delete().neq('id', 0)
      if (error) {
        setMessage('❌ 清空失敗: ' + (error.message || JSON.stringify(error)))
        return
      }
      setMessage('✅ 已清空所有BOM資料')
      setPage(1)
      fetchBomData()
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="p-4 md:p-8 mx-auto min-h-screen text-slate-300 space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl md:text-3xl font-bold text-white tracking-tight">BOM表</h1>
          <p className="text-orange-500 mt-1 font-mono text-sm uppercase">MATERIAL MANAGEMENT // BOM</p>
        </div>
        <div className="flex gap-2">
          <Link
            href="/admin/argoerp/erp-db/inventory"
            className="px-4 py-2 rounded border border-slate-700 text-slate-300 hover:bg-slate-800 text-sm"
          >
            返回倉庫庫存表
          </Link>
          <button
            type="button"
            className="px-4 py-2 rounded border border-green-700 text-green-300 hover:bg-green-900/30 text-sm font-bold disabled:opacity-50"
            disabled={downloadingCsv}
            onClick={downloadBomCsv}
          >
            {downloadingCsv ? '下載中...' : '下載CSV'}
          </button>
          <button
            type="button"
            className="px-4 py-2 rounded border border-amber-700 text-amber-300 hover:bg-amber-900/30 text-sm font-bold"
            onClick={downloadTemplate}
          >
            下載範例檔
          </button>
          <button
            type="button"
            className="px-4 py-2 rounded border border-rose-700 text-rose-300 hover:bg-rose-900/30 text-sm font-bold disabled:opacity-50"
            disabled={uploading}
            onClick={handleClearBom}
          >
            清空BOM資料
          </button>
        </div>
      </div>

      <div className="bg-slate-900/60 border border-slate-700 rounded-xl p-4 md:p-8 text-slate-400 space-y-4">
        <div className="space-y-2">
          <label className="block font-bold">上傳BOM檔案（CSV / XLSX）：</label>
          <input
            type="file"
            accept=".csv,.xlsx,.xls"
            ref={fileInput}
            className="hidden"
            onChange={handleFileChange}
            disabled={uploading}
          />
        </div>
        <button
          type="button"
          className="px-4 py-2 rounded bg-cyan-700 text-white font-bold disabled:opacity-60"
          disabled={uploading}
          onClick={handleSelectAndUpload}
        >
          {uploading ? '上傳中...' : '選擇檔案並上傳'}
        </button>
        {message && <div className="mt-2 text-yellow-400 font-mono">{message}</div>}
      </div>

        {/* 顯示目前已上傳的 BOM 資料 */}
        <div className="mt-10">
          <h2 className="text-xl font-bold mb-2 text-white">已上傳BOM資料</h2>
          {/* 搜尋生產品項編碼 */}
          <div className="mb-4 flex flex-col md:flex-row md:items-center gap-2">
            <label className="text-slate-300">搜尋生產品項編碼：</label>
            <input
              type="text"
              value={search}
              onChange={e => { setPage(1); setSearch(e.target.value) }}
              className="px-2 py-1 rounded border border-slate-600 bg-slate-900 text-white"
              placeholder="輸入編碼關鍵字..."
              style={{ minWidth: 180 }}
            />
          </div>
          {loadingBom ? (
            <div className="text-slate-400">載入中...</div>
          ) : (
            <>
              {/* 欄寬調整開關 */}
              <div className="flex items-center gap-3 mb-2">
                <button
                  type="button"
                  onClick={() => setResizeMode(m => !m)}
                  className={`px-3 py-1 rounded text-xs font-bold border transition-all ${
                    resizeMode
                      ? 'border-yellow-500 text-yellow-300 bg-yellow-900/30'
                      : 'border-slate-600 text-slate-400 hover:bg-slate-800'
                  }`}
                >
                  {resizeMode ? '🔓 編輯欄寬中（拖曳欄位邊緣）' : '🔒 調整欄寬'}
                </button>
                {resizeMode && (
                  <button
                    type="button"
                    onClick={resetWidths}
                    className="px-3 py-1 rounded text-xs border border-slate-600 text-slate-400 hover:bg-slate-800"
                  >
                    重設預設寬度
                  </button>
                )}
              </div>
              <div className="w-full overflow-x-auto">
                <table className="border border-slate-700 text-sm" style={{ tableLayout: 'fixed', width: Object.values(colWidths).reduce((a, b) => a + b, 0) }}>
                  <colgroup>
                    {COL_KEYS.map(key => (
                      <col key={key} style={{ width: colWidths[key] }} />
                    ))}
                  </colgroup>
                  <thead>
                    <tr className="bg-slate-800 text-slate-200">
                      {COL_KEYS.map((key, i) => (
                        <th
                          key={key}
                          className="border border-slate-700 px-2 py-1 whitespace-nowrap relative select-none"
                          style={{ width: colWidths[key] }}
                        >
                          {COL_LABELS[i]}
                          {resizeMode && (
                            <span
                              onMouseDown={(e) => onMouseDown(key, e)}
                              className="absolute top-0 right-0 w-2 h-full cursor-col-resize bg-yellow-500/40 hover:bg-yellow-400/70 transition-colors"
                              style={{ zIndex: 10 }}
                            />
                          )}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      if (bomData.length === 0) {
                        return <tr><td colSpan={11} className="text-center py-4 text-slate-500">尚無資料</td></tr>;
                      }
                      // 合併相同生產品項編碼
                      const grouped: Record<string, { product_name: string; production_quantity?: number; production_unit?: string; materials: { material_code: string; material_name: string; note?: string; quantity: number; unit: string }[] }> = {};
                      bomData.forEach(row => {
                        if (!grouped[row.product_code]) {
                          grouped[row.product_code] = {
                            product_name: row.product_name,
                            production_quantity: row.production_quantity,
                            production_unit: row.production_unit,
                            materials: []
                          };
                        }
                        grouped[row.product_code].materials.push({
                          material_code: row.material_code,
                          material_name: row.material_name,
                          note: row.note,
                          quantity: row.quantity,
                          unit: row.unit
                        });
                      });
                      // 展開為每個原料一行，品項名稱與編碼僅在第一行顯示
                      return Object.entries(grouped).flatMap(([product_code, info]) => {
                        const rowSpan = info.materials.length;
                        return info.materials.map((mat, idx: number) => {
                          const stock = materialMap[mat.material_code] ?? '-';
                          return (
                            <tr key={product_code + '-' + idx} className="odd:bg-slate-900 even:bg-slate-800">
                              {idx === 0 && (
                                <td
                                  className="border border-slate-700 px-2 py-0.5 font-mono bg-slate-950/80 text-base align-middle text-center break-all"
                                  rowSpan={rowSpan}
                                  style={{ verticalAlign: 'middle', fontWeight: 700, borderRightWidth: 3 }}
                                >
                                  {product_code}
                                </td>
                              )}
                              {idx === 0 && (
                                <td
                                  className="border border-slate-700 px-2 py-0.5 bg-slate-950/80 align-middle text-center break-words"
                                  rowSpan={rowSpan}
                                  style={{ verticalAlign: 'middle', fontWeight: 500, borderRightWidth: 3 }}
                                >
                                  {info.product_name}
                                </td>
                              )}
                              {idx === 0 && (
                                <td
                                  className="border border-slate-700 px-2 py-0.5 bg-slate-950/80 align-middle text-center text-orange-300"
                                  rowSpan={rowSpan}
                                  style={{ verticalAlign: 'middle', borderRightWidth: 1 }}
                                >
                                  {info.production_quantity ?? 1}
                                </td>
                              )}
                              {idx === 0 && (
                                <td
                                  className="border border-slate-700 px-2 py-0.5 bg-slate-950/80 align-middle text-center text-slate-400 text-xs"
                                  rowSpan={rowSpan}
                                  style={{ verticalAlign: 'middle', borderRightWidth: 3 }}
                                >
                                  {info.production_unit || ''}
                                </td>
                              )}
                              <td className="border border-slate-700 px-2 py-0.5 font-mono text-cyan-300 break-all">{mat.material_code}</td>
                              <td className="border border-slate-700 px-2 py-0.5 break-words">{mat.material_name}</td>
                              <td className="border border-slate-700 px-2 py-0.5 text-orange-300 text-right">{mat.quantity}</td>
                              <td className="border border-slate-700 px-2 py-0.5 text-slate-400">{mat.unit}</td>
                              <td className="border border-slate-700 px-2 py-0.5 text-slate-400 text-xs">{mat.note || ''}</td>
                              <td className="border border-slate-700 px-2 py-0.5 font-mono text-green-400 text-right">{stock}</td>
                              {/* 替代料號及庫存顯示 */}
                              <td className="border border-slate-700 px-2 py-1">
                                {substituteMap[mat.material_code]?.length ? (
                                  <div className="flex flex-col gap-1">
                                    {substituteMap[mat.material_code].map((sub) => (
                                      <div key={sub.substitute_item_code} className="flex items-center gap-2">
                                        <span className="font-mono text-emerald-400">{sub.substitute_item_code}</span>
                                        <span className="text-xs text-slate-400">(庫存: <span className="font-mono text-green-400">{substituteInventoryMap[sub.substitute_item_code] ?? '-'}</span>)</span>
                                        <span className="text-xs text-slate-500">優先:{sub.priority}</span>
                                      </div>
                                    ))}
                                  </div>
                                ) : (
                                  <span className="text-slate-500">-</span>
                                )}
                              </td>
                            </tr>
                          )
                        })
                      });
                    })()}
                  </tbody>
                </table>
              </div>
              {/* 分頁控制 */}
              <div className="flex items-center gap-4 mt-4">
                <button
                  className="px-3 py-1 rounded bg-slate-700 text-white disabled:opacity-50"
                  disabled={page === 1}
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                >上一頁</button>
                <span className="text-slate-300">第 {page} 頁 / 共 {Math.ceil(total / PAGE_SIZE) || 1} 頁</span>
                <button
                  className="px-3 py-1 rounded bg-slate-700 text-white disabled:opacity-50"
                  disabled={page >= Math.ceil(total / PAGE_SIZE)}
                  onClick={() => setPage(p => p + 1)}
                >下一頁</button>
                <span className="text-slate-400">（每頁顯示 100 筆，共 {total} 筆）</span>
              </div>
            </>
          )}
        </div>
    </div>
  )
}
