'use client'

import { useState, useEffect, useCallback } from 'react'
// 🔥 修正路徑：往上三層即可找到 src/lib (src/app/admin/database -> src)
import { supabase } from '../../../lib/supabaseClient'

interface DatabaseRow {
  id?: number
  item_code?: string
  item_name?: string
  route_id?: string
  sequence?: number
  op_name?: string
  station?: string
  std_time_min?: number
  created_at?: string
}

type EditValues = {
  item_code: string
  item_name: string
  route_id: string
  sequence: string
  op_name: string
  station: string
  std_time_min: string
}

function emptyEditValues(): EditValues {
  return { item_code: '', item_name: '', route_id: '', sequence: '', op_name: '', station: '', std_time_min: '' }
}

function rowToEditValues(row: DatabaseRow): EditValues {
  return {
    item_code: row.item_code ?? '',
    item_name: row.item_name ?? '',
    route_id: row.route_id ?? '',
    sequence: row.sequence != null ? String(row.sequence) : '',
    op_name: row.op_name ?? '',
    station: row.station ?? '',
    std_time_min: row.std_time_min != null ? String(row.std_time_min) : '',
  }
}

export default function DatabaseViewer() {
  const [activeTab, setActiveTab] = useState<'ops' | 'routes' | 'items'>('ops')
  const [data, setData] = useState<DatabaseRow[]>([])
  const [loading, setLoading] = useState(false)
  
  // 分頁與搜尋狀態
  const [searchTerm, setSearchTerm] = useState('')
  const [page, setPage] = useState(0)
  const [totalCount, setTotalCount] = useState(0)
  const PAGE_SIZE = 100

  // CRUD 狀態
  const [editRowId, setEditRowId] = useState<number | null>(null)   // id of row being edited
  const [editValues, setEditValues] = useState<EditValues>(emptyEditValues())
  const [isNewRow, setIsNewRow] = useState(false)
  const [saveLoading, setSaveLoading] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<number | null>(null)
  const [crudMsg, setCrudMsg] = useState('')

  const tableName = activeTab === 'ops' ? 'operation_times' : activeTab === 'routes' ? 'route_operations' : 'item_routes'

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      let query = supabase.from(tableName).select('*', { count: 'exact' })

      if (searchTerm) {
        if (activeTab === 'ops') {
          query = query.or(`op_name.ilike.%${searchTerm}%,station.ilike.%${searchTerm}%`)
        } else if (activeTab === 'routes') {
          query = query.or(`route_id.ilike.%${searchTerm}%,op_name.ilike.%${searchTerm}%`)
        } else if (activeTab === 'items') {
          query = query.or(`item_code.ilike.%${searchTerm}%,item_name.ilike.%${searchTerm}%,route_id.ilike.%${searchTerm}%`)
        }
      }

      if (activeTab === 'ops') {
        query = query.order('op_name', { ascending: true })
      } else if (activeTab === 'routes') {
        query = query.order('route_id', { ascending: true }).order('sequence', { ascending: true })
      } else if (activeTab === 'items') {
        query = query.order('item_code', { ascending: true })
      }

      query = query.range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)

      const { data: result, count, error } = await query
      if (error) throw error
      setData((result as DatabaseRow[]) || [])
      setTotalCount(count || 0)
    } catch (err: unknown) {
      console.error('讀取失敗:', err)
      alert('讀取資料失敗: ' + (err instanceof Error ? err.message : '未知錯誤'))
    } finally {
      setLoading(false)
    }
  }, [activeTab, page, searchTerm, tableName])

  const formatDate = (value?: string) => {
    if (!value) return '-'
    return new Date(value).toLocaleDateString()
  }

  useEffect(() => { fetchData() }, [fetchData])

  const handleTabChange = (tab: 'ops' | 'routes' | 'items') => {
    setActiveTab(tab)
    setPage(0)
    setSearchTerm('')
    setData([])
    cancelEdit()
  }

  const handleSearch = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchTerm(e.target.value)
    setPage(0)
  }

  const cancelEdit = () => {
    setEditRowId(null)
    setIsNewRow(false)
    setEditValues(emptyEditValues())
    setDeleteTarget(null)
  }

  const startEdit = (row: DatabaseRow) => {
    setIsNewRow(false)
    setEditRowId(row.id ?? null)
    setEditValues(rowToEditValues(row))
    setDeleteTarget(null)
    setCrudMsg('')
  }

  const startNewRow = () => {
    setIsNewRow(true)
    setEditRowId(null)
    setEditValues(emptyEditValues())
    setDeleteTarget(null)
    setCrudMsg('')
  }

  const buildPayload = (): Partial<DatabaseRow> => {
    if (activeTab === 'ops') {
      return {
        op_name: editValues.op_name.trim(),
        station: editValues.station.trim(),
        std_time_min: editValues.std_time_min !== '' ? parseFloat(editValues.std_time_min) : 0,
      }
    } else if (activeTab === 'routes') {
      return {
        route_id: editValues.route_id.trim(),
        sequence: editValues.sequence !== '' ? parseInt(editValues.sequence, 10) : 0,
        op_name: editValues.op_name.trim(),
      }
    } else {
      return {
        item_code: editValues.item_code.trim().toUpperCase(),
        item_name: editValues.item_name.trim() || undefined,
        route_id: editValues.route_id.trim(),
      }
    }
  }

  const handleSave = async () => {
    const payload = buildPayload()
    // Basic validation
    if (activeTab === 'ops' && !payload.op_name) { alert('工序名稱不得為空'); return }
    if (activeTab === 'routes' && (!payload.route_id || !payload.op_name)) { alert('途程代碼與工序名稱不得為空'); return }
    if (activeTab === 'items' && (!payload.item_code || !payload.route_id)) { alert('品項編碼與途程 ID 不得為空'); return }

    setSaveLoading(true)
    setCrudMsg('')
    try {
      if (isNewRow) {
        const { error } = await supabase.from(tableName).insert(payload)
        if (error) throw error
        setCrudMsg('✅ 已新增')
        setIsNewRow(false)
        setEditRowId(null)
        setEditValues(emptyEditValues())
      } else {
        const { error } = await supabase.from(tableName).update(payload).eq('id', editRowId!)
        if (error) throw error
        setCrudMsg('✅ 已儲存')
        setEditRowId(null)
        setEditValues(emptyEditValues())
      }
      await fetchData()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setCrudMsg(`❌ ${msg}`)
    } finally {
      setSaveLoading(false)
    }
  }

  const handleDelete = async (rowId: number) => {
    setSaveLoading(true)
    setCrudMsg('')
    try {
      const { error } = await supabase.from(tableName).delete().eq('id', rowId)
      if (error) throw error
      setCrudMsg('✅ 已刪除')
      setDeleteTarget(null)
      setEditRowId(null)
      await fetchData()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setCrudMsg(`❌ ${msg}`)
    } finally {
      setSaveLoading(false)
    }
  }

  const EV = editValues
  const setEV = (k: keyof EditValues, v: string) => setEditValues(prev => ({ ...prev, [k]: v }))

  const inputCls = 'px-2 py-1 rounded bg-slate-800 border border-slate-600 text-white text-xs focus:outline-none focus:border-cyan-500 w-full'

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1600px] mx-auto text-slate-300 min-h-screen">
      
      {/* 標題區 */}
      <div className="flex flex-col md:flex-row justify-between items-end mb-6 md:mb-8 gap-4">
        <div>
          <h1 className="text-xl md:text-3xl font-bold text-white tracking-tight">工序母資料庫</h1>
          <p className="text-cyan-500/80 mt-1 font-mono text-sm uppercase">
            DATABASE VIEWER // 伺服器端搜尋與分頁
          </p>
        </div>

        {/* 搜尋框 + 新增按鈕 */}
        <div className="flex items-center gap-3 w-full md:w-auto">
          <div className="relative flex-1 md:w-96">
            <div className="absolute inset-y-0 left-0 flex items-center pl-3 pointer-events-none">
              <svg className="w-5 h-5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
            </div>
            <input 
              type="text" 
              placeholder="全欄位搜尋 (Enter search...)" 
              value={searchTerm}
              onChange={handleSearch}
              className="w-full bg-slate-900 border border-slate-700 text-white text-sm rounded-lg block pl-10 p-2.5 focus:ring-cyan-500 focus:border-cyan-500 placeholder-slate-600 outline-none transition-all"
            />
          </div>
          <button
            onClick={startNewRow}
            disabled={isNewRow}
            className="px-4 py-2.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:bg-slate-700 disabled:text-slate-500 text-white text-sm font-medium transition-colors whitespace-nowrap flex items-center gap-1.5"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
            新增
          </button>
        </div>
      </div>

      {/* 分頁標籤 (Tabs) */}
      <div className="flex gap-2 mb-6 border-b border-slate-800 overflow-x-auto">
        <button 
          onClick={() => handleTabChange('items')}
          className={`px-4 md:px-6 py-3 text-sm font-bold border-b-2 transition-all whitespace-nowrap ${activeTab === 'items' ? 'border-cyan-500 text-cyan-400 bg-cyan-950/20' : 'border-transparent text-slate-500 hover:text-slate-300'}`}
        >
          品項關聯 (Items)
        </button>
        <button 
          onClick={() => handleTabChange('routes')}
          className={`px-4 md:px-6 py-3 text-sm font-bold border-b-2 transition-all whitespace-nowrap ${activeTab === 'routes' ? 'border-purple-500 text-purple-400 bg-purple-950/20' : 'border-transparent text-slate-500 hover:text-slate-300'}`}
        >
          途程表 (Routes)
        </button>
        <button 
          onClick={() => handleTabChange('ops')}
          className={`px-4 md:px-6 py-3 text-sm font-bold border-b-2 transition-all whitespace-nowrap ${activeTab === 'ops' ? 'border-blue-500 text-blue-400 bg-blue-950/20' : 'border-transparent text-slate-500 hover:text-slate-300'}`}
        >
          工序時間 (Operations)
        </button>
      </div>

      {/* CRUD 訊息 */}
      {crudMsg && (
        <div className={`mb-3 px-4 py-2 rounded-lg text-sm font-medium ${crudMsg.startsWith('✅') ? 'bg-emerald-900/40 text-emerald-300 border border-emerald-700/50' : 'bg-red-900/40 text-red-300 border border-red-700/50'}`}>
          {crudMsg}
        </div>
      )}

      {/* 資料表格 */}
      <div className="bg-slate-900/50 rounded-xl border border-slate-700 overflow-hidden shadow-xl flex flex-col min-h-[600px]">
        {loading ? (
          <div className="flex-1 flex flex-col items-center justify-center text-slate-500 animate-pulse">
             <svg className="w-10 h-10 mb-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
             正在向伺服器查詢資料...
          </div>
        ) : (
          <>
            <div className="overflow-x-auto flex-1">
              <table className="w-full text-left text-sm text-slate-400">
                <thead className="bg-slate-950 text-slate-200 uppercase text-xs font-mono">
                  <tr>
                    {activeTab === 'items' && (
                      <>
                        <th className="px-6 py-4">品項編碼 (Item Code)</th>
                        <th className="px-6 py-4">品項名稱</th>
                        <th className="px-6 py-4 text-right">對應途程 ID</th>
                        <th className="px-6 py-4 text-right text-slate-500">建立時間</th>
                        <th className="px-4 py-4 text-center text-slate-500">操作</th>
                      </>
                    )}
                    {activeTab === 'routes' && (
                      <>
                        <th className="px-6 py-4">途程代碼 (Route ID)</th>
                        <th className="px-6 py-4 text-center">順序</th>
                        <th className="px-6 py-4">工序名稱</th>
                        <th className="px-6 py-4 text-right text-slate-500">建立時間</th>
                        <th className="px-4 py-4 text-center text-slate-500">操作</th>
                      </>
                    )}
                    {activeTab === 'ops' && (
                      <>
                        <th className="px-6 py-4">工序名稱 (Op Name)</th>
                        <th className="px-6 py-4">站點</th>
                        <th className="px-6 py-4 text-right">標準工時 (分)</th>
                        <th className="px-6 py-4 text-right text-slate-500">建立時間</th>
                        <th className="px-4 py-4 text-center text-slate-500">操作</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {/* 新增列表單 */}
                  {isNewRow && (
                    <tr className="bg-emerald-950/30 border-b border-emerald-700/40">
                      {activeTab === 'items' && (
                        <>
                          <td className="px-4 py-2"><input className={inputCls} placeholder="品項編碼 *" value={EV.item_code} onChange={e => setEV('item_code', e.target.value)} /></td>
                          <td className="px-4 py-2"><input className={inputCls} placeholder="品項名稱" value={EV.item_name} onChange={e => setEV('item_name', e.target.value)} /></td>
                          <td className="px-4 py-2"><input className={inputCls} placeholder="途程 ID *" value={EV.route_id} onChange={e => setEV('route_id', e.target.value)} /></td>
                          <td className="px-4 py-2 text-xs text-slate-600">—</td>
                        </>
                      )}
                      {activeTab === 'routes' && (
                        <>
                          <td className="px-4 py-2"><input className={inputCls} placeholder="途程代碼 *" value={EV.route_id} onChange={e => setEV('route_id', e.target.value)} /></td>
                          <td className="px-4 py-2"><input className={inputCls + ' text-center'} placeholder="順序" type="number" value={EV.sequence} onChange={e => setEV('sequence', e.target.value)} /></td>
                          <td className="px-4 py-2"><input className={inputCls} placeholder="工序名稱 *" value={EV.op_name} onChange={e => setEV('op_name', e.target.value)} /></td>
                          <td className="px-4 py-2 text-xs text-slate-600">—</td>
                        </>
                      )}
                      {activeTab === 'ops' && (
                        <>
                          <td className="px-4 py-2"><input className={inputCls} placeholder="工序名稱 *" value={EV.op_name} onChange={e => setEV('op_name', e.target.value)} /></td>
                          <td className="px-4 py-2"><input className={inputCls} placeholder="站點" value={EV.station} onChange={e => setEV('station', e.target.value)} /></td>
                          <td className="px-4 py-2"><input className={inputCls + ' text-right'} placeholder="0" type="number" step="0.1" value={EV.std_time_min} onChange={e => setEV('std_time_min', e.target.value)} /></td>
                          <td className="px-4 py-2 text-xs text-slate-600">—</td>
                        </>
                      )}
                      <td className="px-4 py-2">
                        <div className="flex gap-1 justify-center">
                          <button onClick={handleSave} disabled={saveLoading} className="px-3 py-1 rounded bg-emerald-700 hover:bg-emerald-600 disabled:bg-slate-700 text-white text-xs font-medium transition-colors">{saveLoading ? '…' : '儲存'}</button>
                          <button onClick={cancelEdit} className="px-3 py-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-300 text-xs transition-colors">取消</button>
                        </div>
                      </td>
                    </tr>
                  )}

                  {data.length === 0 && !isNewRow ? (
                    <tr><td colSpan={5} className="p-12 text-center text-slate-600">查無資料</td></tr>
                  ) : (
                    data.map((row) => {
                      const isEditing = !isNewRow && editRowId === row.id
                      return (
                        <tr key={row.id ?? row.item_code ?? row.op_name} className={`transition-colors ${isEditing ? 'bg-blue-950/30 border-blue-700/40' : 'hover:bg-slate-800/50'}`}>
                          {isEditing ? (
                            <>
                              {activeTab === 'items' && (
                                <>
                                  <td className="px-4 py-2"><input className={inputCls} value={EV.item_code} onChange={e => setEV('item_code', e.target.value)} /></td>
                                  <td className="px-4 py-2"><input className={inputCls} value={EV.item_name} onChange={e => setEV('item_name', e.target.value)} /></td>
                                  <td className="px-4 py-2"><input className={inputCls} value={EV.route_id} onChange={e => setEV('route_id', e.target.value)} /></td>
                                  <td className="px-4 py-2 text-xs text-slate-600 text-right font-mono">{formatDate(row.created_at)}</td>
                                </>
                              )}
                              {activeTab === 'routes' && (
                                <>
                                  <td className="px-4 py-2"><input className={inputCls} value={EV.route_id} onChange={e => setEV('route_id', e.target.value)} /></td>
                                  <td className="px-4 py-2"><input className={inputCls + ' text-center'} type="number" value={EV.sequence} onChange={e => setEV('sequence', e.target.value)} /></td>
                                  <td className="px-4 py-2"><input className={inputCls} value={EV.op_name} onChange={e => setEV('op_name', e.target.value)} /></td>
                                  <td className="px-4 py-2 text-xs text-slate-600 text-right font-mono">{formatDate(row.created_at)}</td>
                                </>
                              )}
                              {activeTab === 'ops' && (
                                <>
                                  <td className="px-4 py-2"><input className={inputCls} value={EV.op_name} onChange={e => setEV('op_name', e.target.value)} /></td>
                                  <td className="px-4 py-2"><input className={inputCls} value={EV.station} onChange={e => setEV('station', e.target.value)} /></td>
                                  <td className="px-4 py-2"><input className={inputCls + ' text-right'} type="number" step="0.1" value={EV.std_time_min} onChange={e => setEV('std_time_min', e.target.value)} /></td>
                                  <td className="px-4 py-2 text-xs text-slate-600 text-right font-mono">{formatDate(row.created_at)}</td>
                                </>
                              )}
                              <td className="px-4 py-2">
                                <div className="flex gap-1 justify-center">
                                  <button onClick={handleSave} disabled={saveLoading} className="px-3 py-1 rounded bg-blue-700 hover:bg-blue-600 disabled:bg-slate-700 text-white text-xs font-medium transition-colors">{saveLoading ? '…' : '儲存'}</button>
                                  <button onClick={cancelEdit} className="px-3 py-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-300 text-xs transition-colors">取消</button>
                                </div>
                              </td>
                            </>
                          ) : (
                            <>
                              {activeTab === 'items' && (
                                <>
                                  <td className="px-6 py-3 font-mono text-cyan-400 font-bold">{row.item_code}</td>
                                  <td className="px-6 py-3">{row.item_name || '-'}</td>
                                  <td className="px-6 py-3 text-right font-mono text-purple-400">{row.route_id}</td>
                                  <td className="px-6 py-3 text-right text-xs text-slate-600 font-mono">{formatDate(row.created_at)}</td>
                                </>
                              )}
                              {activeTab === 'routes' && (
                                <>
                                  <td className="px-6 py-3 font-mono text-purple-400">{row.route_id}</td>
                                  <td className="px-6 py-3 text-center font-mono text-slate-500">{row.sequence}</td>
                                  <td className="px-6 py-3 text-slate-300">{row.op_name}</td>
                                  <td className="px-6 py-3 text-right text-xs text-slate-600 font-mono">{formatDate(row.created_at)}</td>
                                </>
                              )}
                              {activeTab === 'ops' && (
                                <>
                                  <td className="px-6 py-3 text-white font-bold">{row.op_name}</td>
                                  <td className="px-6 py-3 text-slate-500">{row.station}</td>
                                  <td className="px-6 py-3 text-right font-mono text-green-400">{row.std_time_min}</td>
                                  <td className="px-6 py-3 text-right text-xs text-slate-600 font-mono">{formatDate(row.created_at)}</td>
                                </>
                              )}
                              <td className="px-4 py-3">
                                <div className="flex gap-1 justify-center">
                                  {deleteTarget === row.id ? (
                                    <>
                                      <button onClick={() => void handleDelete(row.id!)} disabled={saveLoading} className="px-2 py-1 rounded bg-red-700 hover:bg-red-600 disabled:bg-slate-700 text-white text-xs font-medium transition-colors">{saveLoading ? '…' : '確認刪除'}</button>
                                      <button onClick={() => setDeleteTarget(null)} className="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-300 text-xs transition-colors">取消</button>
                                    </>
                                  ) : (
                                    <>
                                      <button onClick={() => startEdit(row)} disabled={isNewRow} className="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-40 text-slate-200 text-xs transition-colors">編輯</button>
                                      <button onClick={() => { setDeleteTarget(row.id ?? null); setCrudMsg('') }} disabled={isNewRow} className="px-2 py-1 rounded bg-slate-800 hover:bg-red-900/60 disabled:opacity-40 text-slate-400 hover:text-red-300 text-xs transition-colors">刪除</button>
                                    </>
                                  )}
                                </div>
                              </td>
                            </>
                          )}
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>

            {/* 底部：分頁控制器 */}
            <div className="bg-slate-950 p-4 border-t border-slate-800 flex flex-col md:flex-row justify-between items-center gap-4">
              <div className="text-xs text-slate-500 font-mono">
                顯示 {data.length > 0 ? page * PAGE_SIZE + 1 : 0} - {Math.min((page + 1) * PAGE_SIZE, totalCount)} 筆，共 {totalCount} 筆資料
              </div>
              
              <div className="flex items-center gap-2">
                <button 
                  onClick={() => setPage(p => Math.max(0, p - 1))}
                  disabled={page === 0 || loading}
                  className="px-3 py-1 rounded bg-slate-800 border border-slate-700 text-slate-300 text-xs hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  上一頁
                </button>
                <span className="text-xs font-mono text-slate-400 px-2">
                   Page {page + 1}
                </span>
                <button 
                  onClick={() => setPage(p => p + 1)} // 簡化分頁邏輯，因為 totalCount 是動態的
                  disabled={data.length < PAGE_SIZE || loading}
                  className="px-3 py-1 rounded bg-slate-800 border border-slate-700 text-slate-300 text-xs hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  下一頁
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}