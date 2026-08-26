'use client'

// 圖檔/PDF 列印：從本機或公司內網共用資料夾（如 \\192.168.1.141\ro排單圖庫\RO）
// 選取圖片/PDF 直接預覽與列印。檔案完全在瀏覽器本地處理（blob URL），不上傳雲端——
// 系統伺服器在雲端連不到內網 IP，但使用者的瀏覽器在內網電腦上，選檔對話框可以直接
// 瀏覽網路磁碟機，選取後即可本地預覽列印。

import { useCallback, useEffect, useRef, useState } from 'react'

interface PickedFile {
  id: string
  name: string
  type: string   // MIME
  size: number
  url: string    // blob URL
}

const fmtSize = (n: number) =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`

export default function FilePrintPage() {
  const [files, setFiles] = useState<PickedFile[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const printFrameRef = useRef<HTMLIFrameElement | null>(null)

  // 離開頁面時釋放 blob URL
  useEffect(() => {
    return () => { files.forEach(f => URL.revokeObjectURL(f.url)) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const addFiles = useCallback((list: FileList | File[]) => {
    const accepted = Array.from(list).filter(f =>
      f.type.startsWith('image/') || f.type === 'application/pdf'
    )
    if (accepted.length === 0) return
    const picked: PickedFile[] = accepted.map(f => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: f.name,
      type: f.type,
      size: f.size,
      url: URL.createObjectURL(f),
    }))
    setFiles(prev => [...prev, ...picked])
    setActiveId(prev => prev ?? picked[0].id)
  }, [])

  const removeFile = useCallback((id: string) => {
    setFiles(prev => {
      const target = prev.find(f => f.id === id)
      if (target) URL.revokeObjectURL(target.url)
      const next = prev.filter(f => f.id !== id)
      setActiveId(cur => (cur === id ? (next[0]?.id ?? null) : cur))
      return next
    })
  }, [])

  const clearAll = useCallback(() => {
    files.forEach(f => URL.revokeObjectURL(f.url))
    setFiles([])
    setActiveId(null)
  }, [files])

  // 列印：用隱藏 iframe 載入該檔（blob URL 同源，可直接呼叫 print）。
  // 圖片包一層 HTML 讓它符合紙張寬度；PDF 直接載入交給瀏覽器內建檢視器列印。
  const handlePrint = useCallback((file: PickedFile) => {
    const old = printFrameRef.current
    if (old) { old.remove(); printFrameRef.current = null }

    const iframe = document.createElement('iframe')
    iframe.style.position = 'fixed'
    iframe.style.right = '0'
    iframe.style.bottom = '0'
    iframe.style.width = '0'
    iframe.style.height = '0'
    iframe.style.border = '0'
    printFrameRef.current = iframe

    if (file.type === 'application/pdf') {
      iframe.src = file.url
      iframe.onload = () => {
        try { iframe.contentWindow?.print() } catch { window.open(file.url, '_blank') }
      }
      document.body.appendChild(iframe)
    } else {
      document.body.appendChild(iframe)
      const doc = iframe.contentDocument
      if (!doc) return
      doc.open()
      doc.write(`<!doctype html><html><head><title>${file.name.replace(/</g, '&lt;')}</title>
        <style>@page{margin:8mm}html,body{margin:0;padding:0}img{max-width:100%;max-height:100vh;display:block;margin:0 auto}</style>
        </head><body><img src="${file.url}" onload="setTimeout(function(){window.print()},50)"></body></html>`)
      doc.close()
    }
  }, [])

  const active = files.find(f => f.id === activeId) ?? null

  return (
    <div className="max-w-[1400px] mx-auto">
      <div className="mb-5">
        <h1 className="text-2xl font-bold text-white">圖檔 / PDF 列印</h1>
        <p className="text-sm text-slate-400 mt-1">
          選取本機或公司內網共用資料夾（例如 <span className="font-mono text-cyan-400">\\192.168.1.141\ro排單圖庫\RO</span>）內的圖片或 PDF 直接列印。
          檔案只在你的瀏覽器本地處理，<b className="text-slate-300">不會上傳到雲端</b>。
        </p>
      </div>

      {/* 選檔區 */}
      <div
        onDragOver={e => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files) }}
        onClick={() => inputRef.current?.click()}
        className={`rounded-xl border-2 border-dashed p-8 text-center cursor-pointer transition-colors ${
          dragOver ? 'border-cyan-500 bg-cyan-950/30' : 'border-slate-700 bg-slate-900/50 hover:border-slate-500'
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept="image/*,application/pdf"
          multiple
          className="hidden"
          onChange={e => { if (e.target.files) addFiles(e.target.files); e.target.value = '' }}
        />
        <div className="text-4xl mb-2">🖨️</div>
        <div className="text-slate-300 font-medium">點擊選擇檔案，或把檔案拖進來</div>
        <div className="text-xs text-slate-500 mt-1">
          支援圖片（JPG/PNG…）與 PDF，可一次選多個。選檔視窗的路徑列輸入 <span className="font-mono">\\192.168.1.141\ro排單圖庫\RO</span> 可直接瀏覽共用資料夾
        </div>
      </div>

      {files.length > 0 && (
        <div className="mt-5 grid grid-cols-1 lg:grid-cols-[340px_1fr] gap-4">
          {/* 檔案清單 */}
          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-3 self-start">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-semibold text-slate-300">已選 {files.length} 個檔案</span>
              <button onClick={clearAll} className="text-xs text-slate-500 hover:text-red-400 transition-colors">全部清除</button>
            </div>
            <div className="flex flex-col gap-1.5 max-h-[60vh] overflow-y-auto">
              {files.map(f => (
                <div
                  key={f.id}
                  onClick={() => setActiveId(f.id)}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-colors ${
                    f.id === activeId ? 'border-cyan-600/60 bg-cyan-950/30' : 'border-slate-800 bg-slate-900 hover:bg-slate-800/60'
                  }`}
                >
                  <span className="text-lg shrink-0">{f.type === 'application/pdf' ? '📄' : '🖼️'}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-slate-200 truncate" title={f.name}>{f.name}</div>
                    <div className="text-[10px] text-slate-500">{fmtSize(f.size)}</div>
                  </div>
                  <button
                    onClick={e => { e.stopPropagation(); handlePrint(f) }}
                    className="px-2.5 py-1 rounded-lg bg-cyan-700 hover:bg-cyan-600 text-white text-xs font-medium shrink-0 transition-colors"
                  >🖨 列印</button>
                  <button
                    onClick={e => { e.stopPropagation(); removeFile(f.id) }}
                    className="w-6 h-6 rounded flex items-center justify-center text-slate-500 hover:text-red-400 shrink-0 transition-colors"
                    title="移除"
                  >✕</button>
                </div>
              ))}
            </div>
          </div>

          {/* 預覽 */}
          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-3 min-h-[420px]">
            {active ? (
              <>
                <div className="flex items-center justify-between mb-2 gap-3">
                  <span className="text-sm text-slate-300 truncate" title={active.name}>{active.name}</span>
                  <button
                    onClick={() => handlePrint(active)}
                    className="px-4 py-1.5 rounded-lg bg-cyan-700 hover:bg-cyan-600 text-white text-sm font-medium shrink-0 transition-colors"
                  >🖨 列印這個檔案</button>
                </div>
                {active.type === 'application/pdf' ? (
                  <iframe src={active.url} className="w-full h-[70vh] rounded-lg bg-white" title={active.name} />
                ) : (
                  <div className="flex items-center justify-center bg-slate-950 rounded-lg p-3">
                    {/* blob URL 本地預覽，非遠端資源 */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={active.url} alt={active.name} className="max-w-full max-h-[70vh] object-contain" />
                  </div>
                )}
              </>
            ) : (
              <div className="h-full flex items-center justify-center text-slate-600 text-sm">選擇左側檔案以預覽</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
