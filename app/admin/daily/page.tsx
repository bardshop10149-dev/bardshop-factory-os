'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { supabase } from '../../../lib/supabaseClient'
import Papa from 'papaparse'

// 定義完整的資料介面
interface OrderData {
  id?: number
  order_number: string
  doc_type: string
  designer: string
  customer: string
  handler: string
  issuer: string
  item_code: string
  item_name: string
  quantity: number
  delivery_date: string
  plate_count: string
  matched_route_id: string | null
  total_time_min: number
  status: string
  log_msg: string
  error_reason?: string 
}

// 母資料快取介面
interface MasterDataCache {
  itemMap: Map<string, string>
  ready: boolean
}

interface ItemRouteRow {
  item_code: string
  route_id: string
}

// --- 輔助函式：清除 Excel ="" 格式 ---
const stripExcelFormula = (val: string | undefined | null): string => {
  if (!val) return ''
  const s = val.trim()
  const match = s.match(/^="(.*)"$/)
  return match ? match[1] : s
}

// --- 輔助函式：建立資料指紋 (用於嚴格比對) ---
const createFingerprint = (row: Partial<OrderData>) => {
  return JSON.stringify({
    order_number: (row.order_number || '').toString().trim(),
    item_code: (row.item_code || '').toString().trim().toUpperCase(),
    item_name: (row.item_name || '').toString().trim(),
    quantity: Number(row.quantity) || 0,
    plate_count: (row.plate_count || '').toString().trim(),
    customer: (row.customer || '').toString().trim(),
    doc_type: (row.doc_type || '').toString().trim(),
    delivery_date: (row.delivery_date || '').toString().trim(),
    designer: (row.designer || '').toString().trim(),
    handler: (row.handler || '').toString().trim(),
    issuer: (row.issuer || '').toString().trim(),
  })
}

export default function DailyOperationsPage() {
  const [loading, setLoading] = useState(false)
  const [tempData, setTempData] = useState<OrderData[]>([])
  const [logs, setLogs] = useState<string[]>([])
  const [showLogs, setShowLogs] = useState(false)
  
  const masterDataRef = useRef<MasterDataCache>({
    itemMap: new Map(),
    ready: false
  })

  const addLog = (msg: string, type = 'info') => {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false })
    const prefix = type === 'error' ? '[ERROR]' : type === 'success' ? '[SUCCESS]' : type === 'warning' ? '[WARN]' : '[INFO]'
    setLogs(prev => [`${time} ${prefix} ${msg}`, ...prev])
    if (type === 'error' || type === 'warning') setShowLogs(true)
  }

  // --- 自動排序邏輯：Error 置頂 ---
  const sortData = useCallback((data: OrderData[]) => {
    return [...data].sort((a, b) => {
      const getWeight = (status: string) => {
        if (status === 'Error') return 0
        if (status !== 'OK') return 1 
        return 2
      }
      return getWeight(a.status) - getWeight(b.status)
    })
  }, [])

  // 通用型「抓取所有資料」函式
  const fetchAllRows = useCallback(async (tableName: string, selectQuery: string) => {
    let allData: unknown[] = []
    let page = 0
    const pageSize = 1000
    let hasMore = true

    while (hasMore) {
      const { data, error } = await supabase
        .from(tableName)
        .select(selectQuery)
        .range(page * pageSize, (page + 1) * pageSize - 1)
      
      if (error) throw error
      
      if (data && data.length > 0) {
        allData = [...allData, ...data]
        if (data.length < pageSize) hasMore = false
        page++
      } else {
        hasMore = false
      }
    }
    return allData
  }, [])

  // --- 讀取母資料 ---
  const loadMasterData = useCallback(async () => {
    try {
      const itemRoutes = await fetchAllRows('item_routes', 'item_code, route_id')
      if (!itemRoutes) return

      const normalize = (str: string) => str ? str.toString().trim().toUpperCase() : ''
      const typedItemRoutes = itemRoutes as ItemRouteRow[]
      const itemMap = new Map(typedItemRoutes.map((i) => [normalize(i.item_code), i.route_id]))
      
      masterDataRef.current = { itemMap, ready: true }
      console.log('Master Data Loaded (Validation Only):', itemMap.size)

    } catch (err) {
      console.error('Master Data Load Error', err)
    }
  }, [fetchAllRows])

  // --- 抓取暫存資料並排序 ---
  const fetchTempData = useCallback(async () => {
    const { data, error } = await supabase.from('temp_orders').select('*')
    if (error) {
      console.error(error)
    } else {
      const sorted = sortData(data || [])
      setTempData(sorted)
    }
  }, [sortData])

  const initData = useCallback(async () => {
    setLoading(true)
    await Promise.all([fetchTempData(), loadMasterData()])
    setLoading(false)
  }, [fetchTempData, loadMasterData])

  useEffect(() => {
    const timer = setTimeout(() => {
      void initData()
    }, 0)
    return () => clearTimeout(timer)
  }, [initData])

  // --- 單列驗證邏輯 ---
  const calculateRow = (row: OrderData, mData: MasterDataCache): OrderData => {
    if (!mData.ready) return row 

    const normalize = (str: string) => str ? str.toString().trim().toUpperCase() : ''
    const itemCodeNormalized = normalize(row.item_code)
    const qty = parseFloat(row.quantity?.toString()) || 0
    const docType = row.doc_type || ''
    
    let status = 'OK'
    const logMsgParts: string[] = []

    const exemptKeywords = ['素材單', '包裝單', '改單', '示意圖']
    const isExempt = exemptKeywords.some(keyword => docType.includes(keyword))

    if (!isExempt) {
      if (!itemCodeNormalized) { 
        status = 'Error'; logMsgParts.push('缺少品項編碼'); 
      } else if (!mData.itemMap.has(itemCodeNormalized)) { 
        status = 'Error'; logMsgParts.push(`資料庫無此品項 [${row.item_code}]`); 
      }
      if (!qty || qty <= 0) { status = 'Error'; logMsgParts.push('數量必須大於 0'); }
      if (!row.delivery_date) { status = 'Error'; logMsgParts.push('交付日期不可空白'); }
      
      if (itemCodeNormalized.startsWith('C')) {
          const isOutsourced = docType.includes('委外');
          const isChangping = docType.includes('常平');
          
          if (!isOutsourced && !isChangping) {
             status = 'Error'; 
             logMsgParts.push('C開頭需為委外單或常平單');
          }
      }

      if (row.item_name.includes('壓克力') && !row.plate_count) {
          if (!itemCodeNormalized.startsWith('C')) {
             status = 'Error'; logMsgParts.push('壓克力需填寫盤數');
          }
      }
    } else {
       if (status === 'OK') logMsgParts.push(`[${docType}] 規則豁免`)
    }

    const routeId = mData.itemMap.get(itemCodeNormalized)
    const totalTime = 0 

    if (!routeId && !isExempt && status === 'OK') {
        status = 'Miss_Route'; logMsgParts.push('無對應途程');
    }

    return {
      ...row,
      matched_route_id: routeId || 'N/A',
      total_time_min: totalTime,
      status: status,
      log_msg: logMsgParts.join('; '),
      error_reason: status === 'Error' ? logMsgParts.join('; ') : '' 
    }
  }

  // --- 編輯功能 ---
  const handleCellChange = (id: number, field: keyof OrderData, value: string | number) => {
    setTempData(prev => prev.map(row => {
      if (row.id !== id) return row
      let updatedRow = { ...row, [field]: value }
      if (['item_code', 'quantity', 'doc_type', 'item_name', 'plate_count'].includes(field)) {
        updatedRow = calculateRow(updatedRow, masterDataRef.current)
      }
      return updatedRow
    }))
  }

  const handleCellBlur = async (row: OrderData) => {
    const { error } = await supabase
      .from('temp_orders')
      .update({
        order_number: row.order_number,
        doc_type: row.doc_type,
        item_code: row.item_code,
        item_name: row.item_name,
        quantity: row.quantity,
        delivery_date: row.delivery_date,
        plate_count: row.plate_count,
        designer: row.designer,
        customer: row.customer,
        handler: row.handler,
        issuer: row.issuer,
        matched_route_id: row.matched_route_id,
        total_time_min: row.total_time_min,
        status: row.status,
        log_msg: row.log_msg
      })
      .eq('id', row.id)

    if (error) {
      addLog(`更新失敗: ${error.message}`, 'error')
    } else {
      setTempData(prev => sortData(prev))
    }
  }

  // --- 上傳 CSV (含重複檢查) ---
  const handleOrderUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setLoading(true)
    setLogs([])
    setShowLogs(true)
    addLog(`開始讀取檔案: ${file.name}`)

    try {
      const csvData: Record<string, string>[] = await new Promise((resolve, reject) => {
        Papa.parse(file, { header: true, skipEmptyLines: true, complete: (res) => resolve(res.data as Record<string, string>[]), error: reject })
      })

      if (!masterDataRef.current.ready) {
        addLog('等待母資料載入...')
        await loadMasterData()
      }
      
      if (!masterDataRef.current.ready) throw new Error('母資料載入失敗，無法驗證。')

      const rawResults = csvData.map((row) => {
        return {
          order_number: stripExcelFormula(row['工單編號']),
          doc_type: stripExcelFormula(row['單據種類']),
          designer: stripExcelFormula(row['美編']),
          customer: stripExcelFormula(row['客戶/供應商名']),
          handler: stripExcelFormula(row['承辦人']),
          issuer: stripExcelFormula(row['開單人員']),
          item_code: stripExcelFormula(row['品項編碼']),
          item_name: stripExcelFormula(row['品名/規格']),
          quantity: parseFloat(stripExcelFormula(row['數量'])) || 0,
          delivery_date: stripExcelFormula(row['交付日期']),
          plate_count: stripExcelFormula(row['盤數']),
          matched_route_id: null,
          total_time_min: 0,
          status: 'Pending',
          log_msg: '',
          error_reason: ''
        } as OrderData
      }).filter(r => r.order_number || r.item_code)

      addLog(`讀取到 ${rawResults.length} 筆資料，正在進行重複檢核...`)

      // 重複資料檢核
      const orderNumbersToCheck = Array.from(new Set(rawResults.map(r => r.order_number))).filter(n => n)

      const { data: existingRows, error: checkError } = await supabase
        .from('daily_orders')
        .select('order_number, doc_type, item_code, item_name, quantity, plate_count, customer, delivery_date, designer, handler, issuer')
        .in('order_number', orderNumbersToCheck)

      if (checkError) throw checkError

      const existingFingerprints = new Set(existingRows?.map(r => createFingerprint(r)))

      const newUniqueResults: OrderData[] = []
      let skippedCount = 0

      rawResults.forEach(row => {
        const fingerprint = createFingerprint(row)
        if (existingFingerprints.has(fingerprint)) {
          skippedCount++
        } else {
          newUniqueResults.push(row)
        }
      })

      if (skippedCount > 0) {
        addLog(`🔍 比對完成：發現 ${skippedCount} 筆資料與總表完全一致，已自動略過。`, 'warning')
      }

      if (newUniqueResults.length === 0) {
        addLog('⚠️ 所有上傳資料均為重複資料，無需匯入。', 'warning')
        setLoading(false)
        e.target.value = ''
        return
      }

      addLog(`🚀 準備匯入 ${newUniqueResults.length} 筆新資料...`)

      const results = newUniqueResults.map(r => calculateRow(r, masterDataRef.current))

      const totalCount = results.length
      const errorCount = results.filter(r => r.status === 'Error').length
      const successCount = totalCount - errorCount
      const accuracy = totalCount > 0 ? ((successCount / totalCount) * 100).toFixed(1) : '0.0'
      
      if (results.length > 0) {
         await supabase.from('temp_orders').delete().neq('id', 0)
         const { error } = await supabase.from('temp_orders').insert(results)
         if (error) throw error
         
         const statsMsg = `📊 本次匯入準確率: ${accuracy}% (成功: ${successCount} / 總數: ${totalCount})`

         if (errorCount > 0) {
           addLog(`⚠️ 匯入完成，有 ${errorCount} 筆錯誤 (已自動置頂)。`, 'warning')
           addLog(statsMsg, 'warning') 
         } else {
           addLog(`🎉 成功匯入 ${results.length} 筆資料，全數驗證通過！`, 'success')
           addLog(statsMsg, 'success') 
           setTimeout(() => setShowLogs(false), 5000) 
         }
         fetchTempData()
      }

    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      addLog(`錯誤: ${errorMessage}`, 'error')
    } finally {
      setLoading(false)
      e.target.value = ''
    }
  }

  const handleDeleteTemp = async (id: number) => {
    const { error } = await supabase.from('temp_orders').delete().eq('id', id)
    if (!error) {
      setTempData(prev => prev.filter(item => item.id !== id))
    }
  }

  const handleClearTemp = async () => {
    if(!confirm('確定要清空所有暫存資料嗎？')) return
    const { error } = await supabase.from('temp_orders').delete().neq('id', 0)
    if (!error) {
      setTempData([])
      addLog('暫存區已清空。')
    }
  }

  // 🔥 關鍵修改：確認並發單邏輯
  const handleCommit = async () => {
    if (tempData.length === 0) return

    const errorCount = tempData.filter(d => d.status === 'Error').length
    const successCount = tempData.length - errorCount

    // 提示使用者
    const confirmMsg = errorCount > 0 
      ? `⚠️ 注意：有 ${errorCount} 筆資料狀態為 Error！\n\n這些資料將會被送入「待處理資料表」進行修正。\n另外 ${successCount} 筆正常資料將直接發單。\n\n確定要繼續嗎？`
      : `確定要發送這 ${tempData.length} 筆工單嗎？`

    if (!confirm(confirmMsg)) return

    setLoading(true)
    try {
      // 準備要寫入的資料 (移除 id，避免主鍵衝突)
      const dataToMove = tempData.map((row) => {
        const rest = Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'id')) as Omit<OrderData, 'id'>
        return {
          ...rest,
          error_reason: rest.status === 'Error' ? rest.log_msg : null
        }
      })

      const { error: insertError } = await supabase.from('daily_orders').insert(dataToMove)
      if (insertError) throw insertError

      const { error: clearError } = await supabase.from('temp_orders').delete().neq('id', 0)
      if (clearError) throw clearError

      addLog(`🎉 發單成功！ (成功: ${successCount} / 待修正: ${errorCount})`, 'success')
      if (errorCount > 0) {
        addLog('⚠️ 請前往「待處理資料表」修正錯誤訂單。', 'warning')
      }

      setTempData([])
      alert('發單成功！請至「訂單查詢表」或「待處理資料表」查看。')
      setShowLogs(false)

    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      addLog(`提交失敗: ${errorMessage}`, 'error')
    } finally {
      setLoading(false)
    }
  }

  const TableInput = ({ 
    value, onChange, onBlur, type = "text", className = "" 
  }: { value: string | number | null | undefined, onChange: (val: string) => void, onBlur: () => void, type?: string, className?: string }) => (
    <input 
      type={type}
      className={`w-full bg-transparent border-b border-transparent hover:border-slate-600 focus:border-cyan-500 focus:bg-slate-800 focus:outline-none px-1 py-0.5 transition-colors ${className}`}
      value={value === null || value === undefined ? '' : value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      onKeyDown={(e) => e.key === 'Enter' && onBlur()}
    />
  )

  return (
    <div className="text-slate-300 font-sans relative">
      
      <div className="flex flex-col md:flex-row justify-between items-end mb-4 gap-4 px-1">
        <div>
          <h1 className="text-xl md:text-3xl font-bold text-white tracking-tight">訂單更新表</h1>
          <p className="text-cyan-500/80 mt-1 font-mono text-sm uppercase">
            DAILY OPERATIONS // 完整資料檢核 (NO TIME CALC)
          </p>
        </div>
        
        <div className="flex flex-wrap gap-3">
           <label className={`flex items-center gap-2 px-5 py-2 rounded-md shadow cursor-pointer transition-all ${loading ? 'bg-slate-700' : 'bg-cyan-700 hover:bg-cyan-600 text-white'}`}>
             <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
             <span>上傳 CSV</span>
             <input type="file" accept=".csv" className="hidden" onChange={handleOrderUpload} disabled={loading} />
           </label>

           <button onClick={handleClearTemp} className="px-5 py-2 bg-red-900/50 text-red-400 border border-red-800 rounded-md hover:bg-red-900 transition-all" disabled={tempData.length === 0 || loading}>
             清空
           </button>

           <button onClick={handleCommit} className={`flex items-center gap-2 px-6 py-2 rounded-md shadow-lg transition-all font-bold text-white ${tempData.length > 0 && !loading ? 'bg-emerald-600 hover:bg-emerald-500 animate-pulse' : 'bg-slate-700 cursor-not-allowed'}`} disabled={tempData.length === 0 || loading}>
             <span>確認並發單</span>
             <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" /></svg>
           </button>
        </div>
      </div>

      <div className="w-full bg-slate-900/50 rounded-xl border border-slate-700 overflow-hidden flex flex-col h-[75vh] relative z-0">
        <div className="p-3 bg-slate-950/50 border-b border-slate-800 flex justify-between items-center">
            <h2 className="font-bold text-white flex items-center gap-2 text-sm">
              <span className="w-2 h-2 rounded-full bg-yellow-500"></span>
              暫存區資料
            </h2>
            <div className="flex gap-4 text-xs font-mono text-slate-500">
              <span>Count: {tempData.length}</span>
              <span className={tempData.some(x => x.status === 'Error') ? 'text-red-400 font-bold' : ''}>
                Errors: {tempData.filter(x => x.status === 'Error').length}
              </span>
            </div>
        </div>
        
        <div className="flex-1 overflow-auto custom-scrollbar">
<table className="w-full text-left text-[11px] border-collapse table-fixed min-w-[900px]">
            {/* 🔥 修正 1: 加入 whitespace-nowrap 防止表頭文字換行 */}
            <thead className="bg-slate-950 text-slate-400 uppercase font-mono sticky top-0 z-10 shadow-lg whitespace-nowrap">
              <tr>
                <th className="p-2 w-8 text-center border-b border-slate-700">Del</th>
                <th className="p-2 w-14 text-center border-b border-slate-700">狀態</th>
                <th className="p-2 w-20 border-b border-slate-700 text-cyan-400">工單編號</th>
                <th className="p-2 w-14 border-b border-slate-700">種類</th>
                <th className="p-2 w-20 border-b border-slate-700 text-purple-300">品項編碼</th>
                <th className="p-2 w-32 border-b border-slate-700">品名/規格</th>
                <th className="p-2 w-12 text-right border-b border-slate-700"> 數量</th>
                <th className="p-2 w-20 border-b border-slate-700">交付日</th>
                <th className="p-2 w-12 border-b border-slate-700">美編</th>
                <th className="p-2 w-16 border-b border-slate-700">客戶</th>
                <th className="p-2 w-12 border-b border-slate-700">承辦</th>
                <th className="p-2 w-12 border-b border-slate-700">開單</th>
                <th className="p-2 w-10 text-center border-b border-slate-700">盤數</th>
                <th className="p-2 w-24 border-b border-slate-700 text-red-400">訊息</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/50">
              {tempData.map((row) => (
                <tr key={row.id} className={`hover:bg-slate-800/60 transition-colors group ${row.status === 'Error' ? 'bg-red-900/10' : ''}`}>
                  <td className="p-2 text-center">
                    <button onClick={() => handleDeleteTemp(row.id!)} className="text-slate-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all">×</button>
                  </td>
                  <td className="p-2 text-center">
                    <span className={`px-1 py-0.5 rounded text-[10px] font-bold block w-full truncate ${
                      row.status === 'OK' ? 'bg-emerald-900/30 text-emerald-400 border border-emerald-800' : 
                      row.status === 'Error' ? 'bg-red-900/30 text-red-400 border border-red-800' : 'bg-yellow-900/30 text-yellow-400 border border-yellow-800'
                    }`}>
                      {row.status}
                    </span>
                  </td>
                  <td className="p-2 font-mono text-cyan-300 font-bold"><TableInput value={row.order_number} onChange={v => handleCellChange(row.id!, 'order_number', v)} onBlur={() => handleCellBlur(row)} /></td>
                  <td className="p-2 text-slate-400"><TableInput value={row.doc_type} onChange={v => handleCellChange(row.id!, 'doc_type', v)} onBlur={() => handleCellBlur(row)} /></td>
                  <td className="p-2 font-mono text-purple-300"><TableInput value={row.item_code} onChange={v => handleCellChange(row.id!, 'item_code', v)} onBlur={() => handleCellBlur(row)} /></td>
                  <td className="p-2 text-slate-300 break-words whitespace-normal leading-tight text-[10px]">
                    <textarea className="w-full bg-transparent border-none resize-none focus:bg-slate-800 focus:outline-none rounded px-1" rows={2} value={row.item_name} onChange={e => handleCellChange(row.id!, 'item_name', e.target.value)} onBlur={() => handleCellBlur(row)} />
                  </td>
                  <td className="p-2 text-right font-mono font-bold text-white"><TableInput type="number" className="text-right" value={row.quantity} onChange={v => handleCellChange(row.id!, 'quantity', v)} onBlur={() => handleCellBlur(row)} /></td>
                  <td className="p-2 font-mono text-slate-400"><TableInput value={row.delivery_date} onChange={v => handleCellChange(row.id!, 'delivery_date', v)} onBlur={() => handleCellBlur(row)} /></td>
                  <td className="p-2 text-slate-500"><TableInput value={row.designer} onChange={v => handleCellChange(row.id!, 'designer', v)} onBlur={() => handleCellBlur(row)} /></td>
                  <td className="p-2 text-slate-500"><TableInput value={row.customer} onChange={v => handleCellChange(row.id!, 'customer', v)} onBlur={() => handleCellBlur(row)} /></td>
                  <td className="p-2 text-slate-500"><TableInput value={row.handler} onChange={v => handleCellChange(row.id!, 'handler', v)} onBlur={() => handleCellBlur(row)} /></td>
                  <td className="p-2 text-slate-500"><TableInput value={row.issuer} onChange={v => handleCellChange(row.id!, 'issuer', v)} onBlur={() => handleCellBlur(row)} /></td>
                  <td className="p-2 text-center text-slate-400"><TableInput className="text-center" value={row.plate_count} onChange={v => handleCellChange(row.id!, 'plate_count', v)} onBlur={() => handleCellBlur(row)} /></td>
                  <td className={`p-2 text-[10px] break-words leading-tight ${row.status === 'Error' ? 'text-red-400 font-bold' : 'text-slate-600'}`}>{row.log_msg}</td>
                </tr>
              ))}
              {tempData.length === 0 && (
                // 🔥 修正 2: colSpan 修正為 14 (對應表頭數量)
                <tr><td colSpan={14} className="p-20 text-center text-slate-600">暫存區是空的，請上傳 CSV</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className={`fixed top-24 right-0 h-[calc(100vh-6rem)] bg-[#0b1120] border-l border-slate-700 shadow-2xl transition-all duration-300 ease-in-out z-50 flex flex-col ${showLogs ? 'w-96 translate-x-0' : 'w-10 translate-x-0 bg-slate-900/50 hover:bg-slate-800 border-none'}`}>
        <button onClick={() => setShowLogs(!showLogs)} className={`absolute -left-0 top-1/2 -translate-y-1/2 w-10 h-24 flex items-center justify-center text-slate-500 hover:text-cyan-400 transition-colors ${!showLogs ? 'w-full h-full' : ''}`} title={showLogs ? "收起日誌" : "展開系統日誌"}>
          {showLogs ? (<svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>) : (<div className="flex flex-col items-center gap-4"><svg className="w-5 h-5 animate-pulse" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg><span className="writing-vertical-rl text-xs font-mono tracking-widest opacity-50 uppercase">Logs</span></div>)}
        </button>
        {showLogs && (
          <div className="flex-1 flex flex-col p-4 overflow-hidden h-full">
            <div className="text-slate-400 text-xs font-mono mb-4 pb-2 border-b border-slate-700 flex justify-between items-center">
               <span>SYSTEM CONSOLE</span>
               <div className="flex gap-2"><button onClick={() => setLogs([])} className="text-[10px] hover:text-red-400">CLEAR</button><span className="text-emerald-500 animate-pulse">● LIVE</span></div>
            </div>
            <div className="flex-1 overflow-y-auto font-mono text-xs space-y-2 scrollbar-thin scrollbar-thumb-slate-700 pr-2">
               {logs.length === 0 && <div className="text-slate-700 italic text-center mt-10">Waiting for events...</div>}
               {logs.map((log, i) => (
                 <div key={i} className={`p-2 rounded border-l-2 bg-slate-900/50 ${log.includes('ERROR') ? 'text-red-300 border-red-500 bg-red-900/10' : log.includes('SUCCESS') ? 'text-emerald-300 border-emerald-500 bg-emerald-900/10' : log.includes('WARN') ? 'text-yellow-300 border-yellow-500 bg-yellow-900/10' : 'text-cyan-300 border-cyan-500/30'}`}>{log}</div>
               ))}
            </div>
          </div>
        )}
      </div>

    </div>
  )
}