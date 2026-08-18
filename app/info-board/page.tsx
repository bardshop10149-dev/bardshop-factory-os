'use client'

import { useState, useEffect, useCallback, useRef, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { NavButton } from '../../components/NavButton'
import { supabase } from '../../lib/supabaseClient'

interface Post {
  id: number
  title: string
  content: string | null
  department: string
  author_name: string
  author_email: string | null
  is_pinned: boolean
  created_at: string
  updated_at: string
}

type FlowType = 'bizChange' | 'schedule' | 'stOrder'

interface OcrHeaderFields {
  orderNumber: string
  customerName: string
  salesPerson: string
  creator: string
}

interface OcrItemRow {
  itemCode: string
  itemName: string
  remark: string
  quantity: string
  packaging: string
}

interface OcrBlock {
  text: string
  box: { x: number; y: number; w: number; h: number }
}

/** 用 block（每個 paragraph = 一個方框 cell）解析訂貨單欄位 */
function parseOrderFields(text: string, blocks: OcrBlock[] = []): { header: OcrHeaderFields; items: OcrItemRow[] } {
  const fullText = text
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)

  // ---------- 工具函式 ----------

  // 找包含任一 keyword 的 block
  const findBlock = (keywords: string[]): OcrBlock | null => {
    for (const kw of keywords) {
      const found = blocks.find(b => b.text.includes(kw))
      if (found) return found
    }
    return null
  }

  // 判斷兩個 block 是否在同一行（Y 中心重疊）
  const sameRow = (a: OcrBlock, b: OcrBlock, tolerance?: number): boolean => {
    const aCy = a.box.y + a.box.h / 2
    const bCy = b.box.y + b.box.h / 2
    const tol = tolerance ?? Math.max(a.box.h, b.box.h) * 0.6
    return Math.abs(aCy - bCy) < tol
  }

  // 找 label block 右邊同一行最近的 block（即該欄位的值）
  const getValueBlockRightOf = (label: OcrBlock): OcrBlock | null => {
    const labelRight = label.box.x + label.box.w
    const candidates = blocks
      .filter(b => b !== label && sameRow(label, b) && b.box.x > labelRight - 10)
      .sort((a, b) => a.box.x - b.box.x)
    return candidates[0] || null
  }

  // ---------- 表頭欄位 ----------
  let orderNumber = ''
  let customerName = ''
  let salesPerson = ''
  let creator = ''

  if (blocks.length > 0) {
    // 訂貨單號
    const orderLabel = findBlock(['訂貨單號', '訂單號碼', '訂貨單'])
    if (orderLabel) {
      const val = getValueBlockRightOf(orderLabel)
      if (val) orderNumber = val.text.replace(/[^\w-]/g, '')
    }
    if (!orderNumber) {
      const m = fullText.match(/(RO\d{6,}\w*)/i)
      if (m) orderNumber = m[1]
    }

    // 客戶名稱
    const custLabel = findBlock(['客戶名稱', '客户名称', '客戶'])
    if (custLabel) {
      const val = getValueBlockRightOf(custLabel)
      if (val) customerName = val.text.replace(/\d{4}[\/-]\d{2}[\/-]\d{2}.*$/, '').trim()
    }

    // 承辦業務
    const salesLabel = findBlock(['承辦業務', '承办业务', '業務人員', '承辦'])
    if (salesLabel) {
      const val = getValueBlockRightOf(salesLabel)
      if (val) salesPerson = val.text.trim()
    }

    // 開單人員
    const creatorLabel = findBlock(['開單人員', '開单人員', '製單人員', '開單'])
    if (creatorLabel) {
      const val = getValueBlockRightOf(creatorLabel)
      if (val) creator = val.text.trim()
    }
  }

  // Fallback regex
  if (!orderNumber) {
    const m = fullText.match(/訂貨單號[\s:：|]*([A-Z0-9][\w-]*)/i) || fullText.match(/(RO\d{6,}\w*)/i)
    if (m) orderNumber = (m[1] || m[0]).trim()
  }
  if (!customerName) {
    const m = fullText.match(/客[戶户]名[稱称][\s:：|]*([^\n]{2,40})/)
    if (m) customerName = m[1].replace(/開單日期.*$/, '').replace(/\d{4}[\/-]\d{2}[\/-]\d{2}.*$/, '').trim()
  }
  if (!salesPerson) {
    const m = fullText.match(/承[辦办][業业][務务][\s:：|]*([^\n|]{2,20})/)
    if (m) salesPerson = m[1].trim()
  }
  if (!creator) {
    const m = fullText.match(/[開开][單单]人[員员][\s:：|]*([^\n|]{2,20})/)
    if (m) creator = m[1].trim()
  }

  const header: OcrHeaderFields = { orderNumber, customerName, salesPerson, creator }

  // ---------- 品項表格（block 版）----------
  const items: OcrItemRow[] = []

  if (blocks.length > 0) {
    // 找表頭列的 block
    const codeHeader = findBlock(['品項編碼', '編碼'])
    const nameHeader = findBlock(['品項名稱', '名稱/規格', '名稱'])
    const remarkHeader = findBlock(['商品備註', '備註'])
    const qtyHeader = findBlock(['數量'])
    const pkgHeader = findBlock(['包裝方式', '包裝'])

    // 用品項編碼 header 來界定表格區域
    const tableHeaderBlock = codeHeader || nameHeader
    if (tableHeaderBlock) {
      const headerBottomY = tableHeaderBlock.box.y + tableHeaderBlock.box.h
      const footerBlock = findBlock(['首件', '品檢', '出貨人', '包裝人員', '訂單號碼', '備考'])
      const footerY = footerBlock ? footerBlock.box.y : Infinity

      // 收集表頭各欄的 X 中心，用來判斷 block 屬於哪一欄
      const colDefs: { key: string; cx: number }[] = []
      if (codeHeader) colDefs.push({ key: 'code', cx: codeHeader.box.x + codeHeader.box.w / 2 })
      if (nameHeader) colDefs.push({ key: 'name', cx: nameHeader.box.x + nameHeader.box.w / 2 })
      if (remarkHeader) colDefs.push({ key: 'remark', cx: remarkHeader.box.x + remarkHeader.box.w / 2 })
      if (qtyHeader) colDefs.push({ key: 'qty', cx: qtyHeader.box.x + qtyHeader.box.w / 2 })
      if (pkgHeader) colDefs.push({ key: 'pkg', cx: pkgHeader.box.x + pkgHeader.box.w / 2 })

      // 取表格區域內的 blocks
      const tableBlocks = blocks
        .filter(b => b.box.y >= headerBottomY && b.box.y < footerY)
        .sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x)

      // 將 blocks 按行分組
      const rows: OcrBlock[][] = []
      let currentRow: OcrBlock[] = []
      let lastCy = -Infinity

      for (const b of tableBlocks) {
        const cy = b.box.y + b.box.h / 2
        if (currentRow.length === 0 || Math.abs(cy - lastCy) < Math.max(b.box.h * 0.7, 15)) {
          currentRow.push(b)
          lastCy = cy
        } else {
          if (currentRow.length > 0) rows.push(currentRow)
          currentRow = [b]
          lastCy = cy
        }
      }
      if (currentRow.length > 0) rows.push(currentRow)

      // 把每個 block 分配到最近的欄位
      const assignCol = (b: OcrBlock): string => {
        if (colDefs.length === 0) return 'name'
        const cx = b.box.x + b.box.w / 2
        let best = colDefs[0]
        let bestDist = Math.abs(cx - best.cx)
        for (let i = 1; i < colDefs.length; i++) {
          const d = Math.abs(cx - colDefs[i].cx)
          if (d < bestDist) { best = colDefs[i]; bestDist = d }
        }
        return best.key
      }

      for (const row of rows) {
        const cols: Record<string, string> = { code: '', name: '', remark: '', qty: '', pkg: '' }
        for (const b of row) {
          const col = assignCol(b)
          cols[col] = cols[col] ? cols[col] + ' ' + b.text : b.text
        }
        if (cols.code || cols.name) {
          items.push({
            itemCode: cols.code.trim(),
            itemName: cols.name.trim(),
            remark: cols.remark.trim(),
            quantity: cols.qty.trim(),
            packaging: cols.pkg.trim(),
          })
        }
      }
    }
  }

  // Fallback：純文字 regex
  if (items.length === 0) {
    let tableStarted = false
    let headerLineIdx = -1
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!tableStarted) {
        if (/品項|品名|編碼/.test(line) && /數量|包裝|備[註注]/.test(line)) {
          tableStarted = true
          headerLineIdx = i
          continue
        }
      }
      if (tableStarted && /首件|品檢|出貨人|包裝人員|訂單號碼/.test(line)) break
      if (tableStarted && i > headerLineIdx && line.length > 3) {
        const cells = line.split(/\s{2,}|\t/).map(c => c.trim()).filter(Boolean)
        if (cells.length >= 2 && /^[A-Z]{2,}[\w-]{3,}/i.test(cells[0])) {
          items.push({
            itemCode: cells[0],
            itemName: cells[1] || '',
            remark: cells.length > 4 ? cells[2] : '',
            quantity: cells.length > 4 ? cells[3] : (cells.length > 2 ? cells[2] : ''),
            packaging: cells.length > 4 ? cells[4] : (cells.length > 3 ? cells[3] : ''),
          })
        }
      }
    }
  }

  return { header, items }
}

function InfoBoardContent() {
  const searchParams = useSearchParams()
  const flowParam = searchParams.get('flow') as FlowType | null
  const [posts, setPosts] = useState<Post[]>([])
  const [loading, setLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState<string>('')
  const [filterDept, setFilterDept] = useState<string>('all')
  const [selectedFlow, setSelectedFlow] = useState<FlowType | null>(
    flowParam && ['bizChange', 'schedule', 'stOrder'].includes(flowParam) ? flowParam : null
  )
  const [showForm, setShowForm] = useState(false)
  const [editingPost, setEditingPost] = useState<Post | null>(null)
  const [formTitle, setFormTitle] = useState('')
  const [formContent, setFormContent] = useState('')
  const [formPinned, setFormPinned] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [currentUser, setCurrentUser] = useState<{ real_name: string; department: string; email: string } | null>(null)

  // OCR 相關狀態
  const [ocrImage, setOcrImage] = useState<string | null>(null)
  const [ocrLoading, setOcrLoading] = useState(false)
  const [ocrProgress, setOcrProgress] = useState(0)
  const [ocrRawText, setOcrRawText] = useState('')
  const [ocrHeader, setOcrHeader] = useState<OcrHeaderFields>({ orderNumber: '', customerName: '', salesPerson: '', creator: '' })
  const [ocrItems, setOcrItems] = useState<OcrItemRow[]>([])
  const [ocrDone, setOcrDone] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      setOcrImage(ev.target?.result as string)
      setOcrDone(false)
      setOcrRawText('')
      setOcrHeader({ orderNumber: '', customerName: '', salesPerson: '', creator: '' })
      setOcrItems([])
    }
    reader.readAsDataURL(file)
  }

  const runOcr = async () => {
    if (!ocrImage) return
    setOcrLoading(true)
    setOcrProgress(0)
    try {
      setOcrProgress(10)

      const res = await fetch('/api/ocr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: ocrImage }),
      })

      setOcrProgress(80)

      const data = await res.json()
      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`)
      }

      const text: string = data.text || ''
      const blocks: OcrBlock[] = data.blocks || []
      setOcrRawText(text)
      const parsed = parseOrderFields(text, blocks)
      setOcrHeader(parsed.header)
      setOcrItems(parsed.items)
      setOcrDone(true)
      setOcrProgress(100)
    } catch (err: unknown) {
      alert(`OCR 辨識失敗：${err instanceof Error ? err.message : '未知錯誤'}`)
    } finally {
      setOcrLoading(false)
    }
  }

  const resetOcr = () => {
    setOcrImage(null)
    setOcrDone(false)
    setOcrRawText('')
    setOcrHeader({ orderNumber: '', customerName: '', salesPerson: '', creator: '' })
    setOcrItems([])
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  // 取得當前使用者（SEC 修復：改走 /api/auth/me，不再 anon 直讀 members）
  useEffect(() => {
    const fetchUser = async () => {
      try {
        const res = await fetch('/api/auth/me', { cache: 'no-store' })
        if (!res.ok) return
        const me = await res.json() as { real_name?: string | null; department?: string | null; email?: string }
        setCurrentUser({ real_name: me.real_name || '-', department: me.department || '-', email: me.email || '' })
      } catch { /* 靜默 */ }
    }
    fetchUser()
  }, [])

  // 取得所有貼文
  const fetchPosts = useCallback(async () => {
    setLoading(true)
    setErrorMessage('')

    const { data, error } = await supabase
      .from('info_board_posts')
      .select('*')
      .order('is_pinned', { ascending: false })
      .order('created_at', { ascending: false })

    if (error) {
      const msg = error.message || '載入失敗'
      console.error('載入失敗:', msg)

      if (/info_board_posts/.test(msg) || /schema cache/i.test(msg) || error.details?.includes('info_board_posts')) {
        setErrorMessage('資料庫尚未建立 info_board_posts 表，請執行 migration：sql/20260331_add_info_board.sql')
      } else {
        setErrorMessage(`載入失敗：${msg}`)
      }

      setPosts([])
      setLoading(false)
      return
    }

    setPosts((data as Post[]) || [])
    setLoading(false)
  }, [])

  useEffect(() => { fetchPosts() }, [fetchPosts])

  // 取得所有部門清單
  const departments = Array.from(new Set(posts.map(p => p.department))).sort()

  const flowLabels: Record<'bizChange' | 'schedule' | 'stOrder', string> = {
    bizChange: '業務改單表',
    schedule: '產期詢問/預留',
    stOrder: '常平訂單',
  }

  const selectedFlowLabel = selectedFlow ? flowLabels[selectedFlow] : '資訊看板'

  const filteredPosts = filterDept === 'all' ? posts : posts.filter(p => p.department === filterDept)

  // 發布 / 更新
  const handleSubmit = async () => {
    if (!formTitle.trim() || !currentUser) return
    setSubmitting(true)

    if (editingPost) {
      const { error } = await supabase
        .from('info_board_posts')
        .update({ title: formTitle.trim(), content: formContent.trim() || null, is_pinned: formPinned, updated_at: new Date().toISOString() })
        .eq('id', editingPost.id)
      if (error) { alert('更新失敗: ' + error.message); setSubmitting(false); return }
    } else {
      const { error } = await supabase
        .from('info_board_posts')
        .insert({
          title: formTitle.trim(),
          content: formContent.trim() || null,
          department: currentUser.department,
          author_name: currentUser.real_name,
          author_email: currentUser.email,
          is_pinned: formPinned,
        })
      if (error) { alert('發布失敗: ' + error.message); setSubmitting(false); return }
    }

    setFormTitle('')
    setFormContent('')
    setFormPinned(false)
    setEditingPost(null)
    setShowForm(false)
    setSubmitting(false)
    fetchPosts()
  }

  const handleEdit = (post: Post) => {
    setEditingPost(post)
    setFormTitle(post.title)
    setFormContent(post.content || '')
    setFormPinned(post.is_pinned)
    setShowForm(true)
  }

  const handleDelete = async (id: number) => {
    if (!confirm('確定要刪除此訊息？')) return
    await supabase.from('info_board_posts').delete().eq('id', id)
    fetchPosts()
  }

  const cancelForm = () => {
    setShowForm(false)
    setEditingPost(null)
    setFormTitle('')
    setFormContent('')
    setFormPinned(false)
  }

  const isAuthor = (post: Post) => currentUser?.email === post.author_email

  // 部門顏色
  const deptColor = (dept: string) => {
    const colors: Record<string, string> = {
      '業務部': 'bg-amber-500/20 text-amber-400 border-amber-500/30',
      '生產部': 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30',
      '品保部': 'bg-teal-500/20 text-teal-400 border-teal-500/30',
      '倉庫': 'bg-blue-500/20 text-blue-400 border-blue-500/30',
      '管理部': 'bg-purple-500/20 text-purple-400 border-purple-500/30',
      '財會部': 'bg-orange-500/20 text-orange-400 border-orange-500/30',
    }
    return colors[dept] || 'bg-slate-500/20 text-slate-400 border-slate-500/30'
  }

  return (
    <div className="min-h-screen bg-[#050b14] text-slate-300">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(14,165,233,0.18),_transparent_45%)] pointer-events-none"></div>
      <div className="absolute inset-0 bg-[linear-gradient(180deg,#030812_0%,#050d18_30%,#060f1d_70%,#050b14_100%)] pointer-events-none"></div>

      {/* Header */}
      <div className="bg-slate-900/70 border-b border-slate-800 backdrop-blur-xl sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-6 py-5 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <NavButton href="/" direction="home" title="回系統入口" className="px-3 py-1.5" />
            <div>
              <h1 className="text-3xl md:text-4xl font-black text-white tracking-wide">{selectedFlowLabel}</h1>
              <p className="text-xs md:text-sm text-cyan-300 uppercase tracking-widest">資訊看板 / Info Board</p>
            </div>
          </div>
          <NavButton href="/" direction="home" title="回到首頁" className="px-4 py-2" />
        </div>
      </div>

      <div className="relative z-10 max-w-5xl mx-auto px-4 py-6">
        {errorMessage && (
          <div className="mb-4 px-4 py-3 rounded-xl border border-red-600 bg-red-950/40 text-red-300">
            <div className="font-bold text-sm mb-1">資料表不存在或載入失敗</div>
            <div className="text-xs leading-relaxed">{errorMessage}</div>
          </div>
        )}

        {/* 當前分流資訊 */}
        {selectedFlow && (
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-bold text-white">{selectedFlowLabel}</h2>
              <p className="text-xs text-slate-500">目前顯示：{selectedFlowLabel} 相關公告與交流內容</p>
            </div>
          </div>
        )}

        {/* 常平訂單 — 影像掃描辨識 */}
        {selectedFlow === 'stOrder' && (
          <div className="mb-6 bg-slate-900/60 border border-emerald-700/40 rounded-2xl overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-700 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold text-white flex items-center gap-2">
                  <span className="text-emerald-400">📷</span> 訂貨單影像辨識
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">上傳工單照片，自動擷取訂單資訊與品項明細</p>
              </div>
              {ocrDone && (
                <button onClick={resetOcr} className="px-3 py-1.5 text-xs rounded border border-slate-600 text-slate-400 hover:text-white hover:border-slate-400 transition-colors">
                  重新掃描
                </button>
              )}
            </div>

            <div className="p-5 space-y-4">
              {/* 上傳區域 */}
              {!ocrImage ? (
                <label className="flex flex-col items-center justify-center border-2 border-dashed border-slate-600 hover:border-emerald-500/60 rounded-xl p-10 cursor-pointer transition-colors group">
                  <svg className="w-12 h-12 text-slate-600 group-hover:text-emerald-400 transition-colors mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                  <span className="text-sm text-slate-400 group-hover:text-slate-300">點擊上傳訂貨單照片</span>
                  <span className="text-xs text-slate-600 mt-1">支援 JPG / PNG 格式</span>
                  <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleImageSelect} />
                </label>
              ) : (
                <div className="space-y-4">
                  {/* 圖片預覽 */}
                  <div className="relative rounded-xl overflow-hidden border border-slate-700 max-h-[400px] flex items-center justify-center bg-slate-950">
                    <img src={ocrImage} alt="上傳的訂貨單" className="max-h-[400px] object-contain" />
                  </div>

                  {/* 操作按鈕 */}
                  {!ocrDone && (
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() => void runOcr()}
                        disabled={ocrLoading}
                        className="px-5 py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-sm disabled:bg-slate-700 disabled:text-slate-400 transition-colors"
                      >
                        {ocrLoading ? `辨識中 ${ocrProgress}%...` : '開始辨識'}
                      </button>
                      <button
                        onClick={resetOcr}
                        disabled={ocrLoading}
                        className="px-4 py-2.5 rounded-lg border border-slate-600 text-slate-400 hover:text-white hover:border-slate-400 text-sm transition-colors disabled:opacity-50"
                      >
                        更換圖片
                      </button>
                      {ocrLoading && (
                        <div className="flex-1 h-2 bg-slate-800 rounded-full overflow-hidden">
                          <div className="h-full bg-emerald-500 rounded-full transition-all duration-300" style={{ width: `${ocrProgress}%` }} />
                        </div>
                      )}
                    </div>
                  )}

                  {/* 辨識結果 */}
                  {ocrDone && (
                    <div className="space-y-4">
                      {/* 表頭欄位 */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        {[
                          { label: '訂貨單號', value: ocrHeader.orderNumber, setter: (v: string) => setOcrHeader(p => ({ ...p, orderNumber: v })) },
                          { label: '客戶名稱', value: ocrHeader.customerName, setter: (v: string) => setOcrHeader(p => ({ ...p, customerName: v })) },
                          { label: '承辦業務', value: ocrHeader.salesPerson, setter: (v: string) => setOcrHeader(p => ({ ...p, salesPerson: v })) },
                          { label: '開單人員', value: ocrHeader.creator, setter: (v: string) => setOcrHeader(p => ({ ...p, creator: v })) },
                        ].map(f => (
                          <div key={f.label}>
                            <label className="text-xs text-slate-400 mb-1 block">{f.label}</label>
                            <input
                              value={f.value}
                              onChange={e => f.setter(e.target.value)}
                              className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:border-emerald-500 focus:outline-none"
                            />
                          </div>
                        ))}
                      </div>

                      {/* 品項明細表 */}
                      {ocrItems.length > 0 && (
                        <div className="border border-slate-700 rounded-xl overflow-x-auto">
                          <table className="w-full text-sm min-w-[700px]">
                            <thead>
                              <tr className="bg-slate-950 text-slate-400 text-xs uppercase font-mono border-b border-slate-700">
                                <th className="px-4 py-3 text-left">#</th>
                                <th className="px-4 py-3 text-left">品項編碼</th>
                                <th className="px-4 py-3 text-left">品項名稱/規格</th>
                                <th className="px-4 py-3 text-left">商品備註</th>
                                <th className="px-4 py-3 text-center">數量</th>
                                <th className="px-4 py-3 text-center">包裝方式</th>
                                <th className="px-3 py-3 text-center w-8"></th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-800">
                              {ocrItems.map((item, idx) => (
                                <tr key={idx} className="hover:bg-slate-800/40">
                                  <td className="px-4 py-2 text-slate-500 text-xs">{idx + 1}</td>
                                  <td className="px-4 py-2">
                                    <input value={item.itemCode} onChange={e => { const v = e.target.value; setOcrItems(p => p.map((r, i) => i === idx ? { ...r, itemCode: v } : r)) }}
                                      className="bg-transparent border-b border-slate-700 focus:border-emerald-500 outline-none text-cyan-300 font-mono text-xs w-full py-1" />
                                  </td>
                                  <td className="px-4 py-2">
                                    <input value={item.itemName} onChange={e => { const v = e.target.value; setOcrItems(p => p.map((r, i) => i === idx ? { ...r, itemName: v } : r)) }}
                                      className="bg-transparent border-b border-slate-700 focus:border-emerald-500 outline-none text-white text-xs w-full py-1" />
                                  </td>
                                  <td className="px-4 py-2">
                                    <input value={item.remark} onChange={e => { const v = e.target.value; setOcrItems(p => p.map((r, i) => i === idx ? { ...r, remark: v } : r)) }}
                                      className="bg-transparent border-b border-slate-700 focus:border-emerald-500 outline-none text-slate-300 text-xs w-full py-1" />
                                  </td>
                                  <td className="px-4 py-2 text-center">
                                    <input value={item.quantity} onChange={e => { const v = e.target.value; setOcrItems(p => p.map((r, i) => i === idx ? { ...r, quantity: v } : r)) }}
                                      className="bg-transparent border-b border-slate-700 focus:border-emerald-500 outline-none text-amber-300 font-mono text-xs w-16 text-center py-1" />
                                  </td>
                                  <td className="px-4 py-2 text-center">
                                    <input value={item.packaging} onChange={e => { const v = e.target.value; setOcrItems(p => p.map((r, i) => i === idx ? { ...r, packaging: v } : r)) }}
                                      className="bg-transparent border-b border-slate-700 focus:border-emerald-500 outline-none text-slate-300 text-xs w-20 text-center py-1" />
                                  </td>
                                  <td className="px-3 py-2 text-center">
                                    <button onClick={() => setOcrItems(p => p.filter((_, i) => i !== idx))}
                                      className="text-slate-600 hover:text-red-400 transition-colors" title="刪除此列">
                                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                                    </button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}

                      {/* 手動新增品項按鈕 */}
                      <button
                        onClick={() => setOcrItems(p => [...p, { itemCode: '', itemName: '', remark: '', quantity: '', packaging: '' }])}
                        className="w-full py-2.5 border border-dashed border-slate-600 hover:border-emerald-500/60 rounded-xl text-sm text-slate-400 hover:text-emerald-400 transition-colors"
                      >
                        + 手動新增品項
                      </button>

                      {/* OCR 原始文字（預設展開方便核對） */}
                      <details className="group" open>
                        <summary className="text-xs text-slate-400 cursor-pointer hover:text-slate-300 transition-colors font-bold">
                          📝 OCR 原始辨識文字（可從此複製貼上）
                        </summary>
                        <pre className="mt-2 p-3 bg-slate-950 border border-slate-700 rounded-lg text-xs text-slate-300 whitespace-pre-wrap max-h-[300px] overflow-y-auto font-mono leading-relaxed select-all">
                          {ocrRawText}
                        </pre>
                      </details>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* 部門篩選 */}
        {selectedFlow && (
          <div className="flex items-center gap-2 mb-6 flex-wrap">
              <span className="text-xs text-slate-500 mr-1">篩選部門:</span>
              <button
                onClick={() => setFilterDept('all')}
                className={`px-3 py-1 rounded-full text-xs font-mono transition-colors border ${filterDept === 'all' ? 'bg-white/10 text-white border-white/30' : 'text-slate-500 border-slate-700 hover:border-slate-500'}`}
              >
                全部
              </button>
              {departments.map(dept => (
                <button
                  key={dept}
                  onClick={() => setFilterDept(dept)}
                  className={`px-3 py-1 rounded-full text-xs font-mono transition-colors border ${filterDept === dept ? 'bg-white/10 text-white border-white/30' : 'text-slate-500 border-slate-700 hover:border-slate-500'}`}
                >
                  {dept}
                </button>
              ))}
            </div>
          )}

        {/* 發布表單 Modal */}
        {showForm && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
            <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-lg shadow-2xl">
              <div className="bg-slate-800 p-4 flex justify-between items-center border-b border-slate-700 rounded-t-2xl">
                <h3 className="text-white font-bold flex items-center gap-2">
                  <span className="w-2 h-6 bg-amber-500 rounded-full"></span>
                  {editingPost ? '編輯訊息' : '發布新訊息'}
                </h3>
                <button onClick={cancelForm} className="text-slate-400 hover:text-white transition-colors">
                  <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
              <div className="p-6 space-y-4">
                {currentUser && (
                  <div className="flex items-center gap-2 text-xs text-slate-500">
                    <span className={`px-2 py-0.5 rounded border ${deptColor(currentUser.department)}`}>{currentUser.department}</span>
                    <span>{currentUser.real_name}</span>
                  </div>
                )}
                <input
                  value={formTitle}
                  onChange={e => setFormTitle(e.target.value)}
                  placeholder="訊息標題"
                  className="w-full bg-slate-800 border border-slate-600 rounded-lg px-4 py-2.5 text-white placeholder-slate-500 focus:border-amber-500 focus:outline-none transition-colors"
                  maxLength={100}
                />
                <textarea
                  value={formContent}
                  onChange={e => setFormContent(e.target.value)}
                  placeholder="訊息內容（選填）"
                  rows={5}
                  className="w-full bg-slate-800 border border-slate-600 rounded-lg px-4 py-2.5 text-white placeholder-slate-500 focus:border-amber-500 focus:outline-none transition-colors resize-none"
                  maxLength={2000}
                />
                <label className="flex items-center gap-2 cursor-pointer text-sm text-slate-400">
                  <input type="checkbox" checked={formPinned} onChange={e => setFormPinned(e.target.checked)} className="accent-amber-500" />
                  置頂訊息
                </label>
                <div className="flex justify-end gap-3 pt-2">
                  <button onClick={cancelForm} className="px-4 py-2 text-sm text-slate-400 hover:text-white transition-colors">取消</button>
                  <button
                    onClick={handleSubmit}
                    disabled={submitting || !formTitle.trim()}
                    className="px-6 py-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-bold rounded-lg transition-colors"
                  >
                    {submitting ? '處理中...' : editingPost ? '更新' : '發布'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* 訊息列表 */}
        {loading ? (
          <div className="text-center text-slate-500 py-20 text-sm">載入中...</div>
        ) : filteredPosts.length === 0 ? (
          <div className="text-center py-20">
            <div className="text-slate-600 text-4xl mb-4">📋</div>
            <div className="text-slate-500 text-sm">目前沒有訊息</div>
            <div className="text-slate-600 text-xs mt-1">點擊右上角「發布訊息」開始交流</div>
          </div>
        ) : (
          <div className="space-y-3">
            {filteredPosts.map(post => (
              <div
                key={post.id}
                className={`bg-slate-900/60 border rounded-xl p-4 transition-all hover:border-slate-600 ${post.is_pinned ? 'border-amber-500/40 bg-amber-950/10' : 'border-slate-700'}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-2 flex-wrap">
                      {post.is_pinned && (
                        <span className="text-[10px] font-bold text-amber-400 bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.5 rounded">📌 置頂</span>
                      )}
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded border ${deptColor(post.department)}`}>{post.department}</span>
                      <span className="text-xs text-slate-400">{post.author_name}</span>
                      <span className="text-[10px] text-slate-600 font-mono ml-auto shrink-0">
                        {new Date(post.created_at).toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                    <h3 className="text-white font-bold text-sm mb-1">{post.title}</h3>
                    {post.content && (
                      <p className="text-slate-400 text-xs whitespace-pre-wrap leading-relaxed">{post.content}</p>
                    )}
                  </div>
                  {isAuthor(post) && (
                    <div className="flex items-center gap-1 shrink-0">
                      <button onClick={() => handleEdit(post)} className="p-1.5 text-slate-600 hover:text-amber-400 transition-colors" title="編輯">
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                      </button>
                      <button onClick={() => handleDelete(post.id)} className="p-1.5 text-slate-600 hover:text-red-400 transition-colors" title="刪除">
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default function InfoBoardPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-[#050b14]" />}>
      <InfoBoardContent />
    </Suspense>
  )
}
