'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import SoOrderModal from '@/components/SoOrderModal'
import ZoomableViewer, { type ZoomableViewerImage } from '@/components/packaging/ZoomableViewer'
import type { SketchImage, SketchLine, SketchResponse } from '@/lib/packaging/types'

// ─────────────────────────────────────────────────────────────────────────────
// 包裝專區・訂單詳情彈窗（需求 9 / D42 P0）
//
// 包一層既有的 SoOrderModal（全站 12 頁共用的 SO 明細彈窗），只透過兩個選用 prop 擴充：
//   ・renderLineExtra：每個品項行右側放「示意圖 (n)」按鈕 → 開 ZoomableViewer
//   ・dedupeRemarks：「商品備註」「備註2」同源自 ARGO REMARK2，只在包裝專區去重
// 其他頁不傳這兩個 prop，畫面完全不變。
//
// 示意圖一律向 /api/packaging/sketches 要「可顯示的網址」，前端不自行拼接 storage 路徑：
//   bucket 之後會改 private＋短期簽名網址（D39），屆時只改 API 層，這裡不必動。
//   已預留：網址帶 expiresAt 且快過期時，點按鈕會先重抓一次再開檢視器。
//
// 檢視器與 SoOrderModal 是「兄弟」而非巢狀：ZoomableViewer 雖以 portal 掛到 <body>，
// React 事件仍沿元件樹冒泡；若放在 SoOrderModal 裡面，檢視器內的點擊會冒到彈窗背幕
// 的 onClick 而把整個詳情關掉。
// ─────────────────────────────────────────────────────────────────────────────

interface Props {
  so: string
  open: boolean
  onClose: () => void
}

type SketchState =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; lines: SketchLine[] }

/** 檢視器目前開的是哪一行（依項次或品號對到的出單表行）或「全部」 */
type ViewerTarget = { scope: 'line'; by: 'line' | 'item'; key: string } | { scope: 'all' }

/** 簽名網址剩不到這麼多毫秒就視為過期，先重抓 */
const EXPIRY_MARGIN_MS = 30_000

/** 項次正規化："01"、1、" 1 " → "1"；同步表是文字、ARGO 即時可能是數字 */
function normLineNo(v: number | string | null | undefined): string | null {
  if (v == null) return null
  const s = String(v).trim().replace(/^0+(?=\d)/, '')
  return s || null
}

function isStale(images: SketchImage[]): boolean {
  const limit = Date.now() + EXPIRY_MARGIN_MS
  return images.some(img => img.expiresAt != null && Date.parse(img.expiresAt) <= limit)
}

function lineNoLabel(line: SketchLine): string {
  return line.lineNo ? `項次 ${line.lineNo}` : line.itemCode ? `品號 ${line.itemCode}` : '未標項次'
}

// 檢視器標題：項次與出單日放前面，品名很長時被截斷也不會丟掉關鍵資訊
function toViewerImages(line: SketchLine): ZoomableViewerImage[] {
  return line.images
    .filter(img => img.kind === 'image')
    .map(img => ({
      url: img.url,
      label: `${lineNoLabel(line)}（出單表 ${img.sheetDate}）${line.itemName ? `・${line.itemName}` : ''}`,
    }))
}

/** 向 API 要該 SO 各行示意圖網址；被中止時回 null（呼叫端不更新狀態） */
async function requestSketches(so: string, signal: AbortSignal): Promise<Exclude<SketchState, { status: 'loading' }> | null> {
  try {
    const res = await fetch(`/api/packaging/sketches?so=${encodeURIComponent(so)}`, { cache: 'no-store', signal })
    let body: SketchResponse | null = null
    try { body = await res.json() as SketchResponse } catch { body = null }
    if (signal.aborted) return null
    if (res.ok && body?.success) return { status: 'ready', lines: body.lines }
    const msg = body && !body.success && body.error
      ? body.error
      : res.status === 401 ? '登入逾時，請重新登入'
      : res.status === 403 ? '沒有包裝專區權限'
      : `HTTP ${res.status}`
    return { status: 'error', error: msg }
  } catch (e) {
    if (signal.aborted) return null
    return { status: 'error', error: e instanceof Error ? e.message : '網路錯誤' }
  }
}

export default function PackagingOrderModal({ so, open, onClose }: Props) {
  const soKey = so.trim()
  if (!open || !soKey) return null
  // 關閉即卸載內層、換單就換 key → 示意圖與檢視器狀態自然歸零，不必在 effect 裡手動重設
  return <OrderModalBody key={soKey} so={soKey} onClose={onClose} />
}

function OrderModalBody({ so, onClose }: { so: string; onClose: () => void }) {
  const [sketch, setSketch] = useState<SketchState>({ status: 'loading' })
  const [viewer, setViewer] = useState<{ target: ViewerTarget; index: number } | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  // 使用者觸發的重抓（重試、簽名網址過期）：先切回讀取中；回傳最新的行清單，失敗為 null
  const reloadSketches = async (): Promise<SketchLine[] | null> => {
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setSketch({ status: 'loading' })
    const next = await requestSketches(so, ctrl.signal)
    if (!next) return null
    setSketch(next)
    return next.status === 'ready' ? next.lines : null
  }

  // 開啟時讀一次；關閉（卸載）或換單時中止進行中的請求
  useEffect(() => {
    const ctrl = new AbortController()
    abortRef.current = ctrl
    void requestSketches(so, ctrl.signal).then(next => { if (next) setSketch(next) })
    return () => { ctrl.abort() }
  }, [so])

  // 出單表的行 → SO 行對應：先用項次；出單表沒填項次的，才退用品號比對
  const index = useMemo(() => {
    const byLine = new Map<string, SketchLine>()
    const byItemNoLine = new Map<string, SketchLine>()
    const lines = sketch.status === 'ready' ? sketch.lines : []
    for (const l of lines) {
      const key = normLineNo(l.lineNo)
      if (key) {
        // 同一項次若回傳多筆（理論上 API 已合併），把圖接在一起
        const prev = byLine.get(key)
        byLine.set(key, prev ? { ...prev, images: [...prev.images, ...l.images] } : l)
      } else if (l.itemCode) {
        const prev = byItemNoLine.get(l.itemCode)
        byItemNoLine.set(l.itemCode, prev ? { ...prev, images: [...prev.images, ...l.images] } : l)
      }
    }
    const withImages = lines.filter(l => l.images.some(img => img.kind === 'image'))
    const imageCount = withImages.reduce((n, l) => n + l.images.filter(img => img.kind === 'image').length, 0)
    // 只有 PDF、沒有圖片的行：檢視器不收 PDF，總覽另外列新分頁連結（項次對不到 SO 行時才點得到）
    const pdfOnly = lines.filter(l => l.images.length > 0 && l.images.every(img => img.kind === 'pdf'))
    return { byLine, byItemNoLine, withImages, imageCount, pdfOnly }
  }, [sketch])

  // API 會把 SO 每一行都列出（無圖 images=[]），所以項次命中但沒圖時，仍要再試品號
  const findLine = (line: { line_no: number | string | null; mbp_part: string | null }) => {
    const lineKey = normLineNo(line.line_no)
    const byLine = lineKey ? index.byLine.get(lineKey) : undefined
    if (lineKey && byLine && byLine.images.length > 0) {
      return { hit: byLine, byItem: false, target: { scope: 'line', by: 'line', key: lineKey } as ViewerTarget }
    }
    const byItem = line.mbp_part ? index.byItemNoLine.get(line.mbp_part) : undefined
    if (line.mbp_part && byItem && byItem.images.length > 0) {
      return { hit: byItem, byItem: true, target: { scope: 'line', by: 'item', key: line.mbp_part } as ViewerTarget }
    }
    return null
  }

  // 檢視器的圖片清單由「目前的」示意圖狀態推導 → 過期重抓後自動換成新網址
  const viewerImages = useMemo<ZoomableViewerImage[]>(() => {
    if (!viewer) return []
    const t = viewer.target
    if (t.scope === 'all') return index.withImages.flatMap(toViewerImages)
    const hit = t.by === 'line' ? index.byLine.get(t.key) : index.byItemNoLine.get(t.key)
    return hit ? toViewerImages(hit) : []
  }, [viewer, index])

  const openViewer = async (target: ViewerTarget, images: SketchImage[], startIndex = 0) => {
    // 簽名網址快過期：先換新網址；換不到就不開（避免開出一片空白）
    if (isStale(images) && !(await reloadSketches())) return
    setViewer({ target, index: startIndex })
  }

  const renderLineExtra = (line: { line_no: number | string | null; mbp_part: string | null; description: string | null }) => {
    if (sketch.status === 'loading') {
      return <span className={`${btnBase} border-slate-700 text-slate-500`}>示意圖…</span>
    }
    if (sketch.status === 'error') {
      return <span className={`${btnBase} border-slate-700 text-slate-600`} title={sketch.error}>示意圖 —</span>
    }
    const found = findLine(line)
    const imgs = found ? found.hit.images.filter(img => img.kind === 'image') : []
    const pdfs = found ? found.hit.images.filter(img => img.kind === 'pdf') : []
    if (!found || (imgs.length === 0 && pdfs.length === 0)) {
      return (
        <button type="button" disabled className={`${btnBase} border-slate-800 text-slate-600 cursor-not-allowed`}>
          無示意圖
        </button>
      )
    }
    const { hit, target } = found
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        {imgs.length > 0 && (
          <button
            type="button"
            onClick={() => void openViewer(target, imgs)}
            title={found.byItem
              ? '出單表未標項次，依品號比對（同品號多行時可能屬於其他行）'
              : hit.itemName ? `出單表品名：${hit.itemName}` : undefined}
            className={`${btnBase} border-violet-600/60 bg-violet-950/40 text-violet-200 hover:bg-violet-800/60 hover:text-white`}
          >
            🖼 示意圖{imgs.length > 1 ? ` (${imgs.length})` : ''}{found.byItem ? ' ?' : ''}
          </button>
        )}
        {/* PDF 示意圖 P0 以新分頁開啟（近期實測 0 張；頁內渲染留 P1） */}
        {pdfs.map((p, i) => (
          <a
            key={`${p.url}|${i}`}
            href={p.url}
            target="_blank"
            rel="noopener noreferrer"
            className={`${btnBase} border-slate-600 text-slate-300 hover:bg-slate-700`}
          >
            PDF{pdfs.length > 1 ? ` ${i + 1}` : ''} ↗
          </a>
        ))}
      </span>
    )
  }

  // 明細下方：本單示意圖總覽（也讓「項次對不到 SO 行」的圖仍點得到）
  const extraContent = (
    <div className="text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-xs text-slate-400">出單表示意圖</span>
        {sketch.status === 'loading' && <span className="text-slate-500 text-xs">讀取中…</span>}
        {sketch.status === 'error' && (
          <>
            <span className="text-red-400 text-xs">⚠ 讀取失敗：{sketch.error}</span>
            <button type="button" onClick={() => void reloadSketches()}
              className={`${btnBase} border-slate-600 text-slate-300 hover:bg-slate-700`}>
              重試
            </button>
          </>
        )}
        {sketch.status === 'ready' && index.imageCount === 0 && index.pdfOnly.length === 0 && (
          <span className="text-slate-500 text-xs">出單表查無此單的示意圖</span>
        )}
        {sketch.status === 'ready' && index.imageCount > 0 && (
          <>
            <span className="text-slate-400 text-xs">{index.withImages.length} 行・共 {index.imageCount} 張</span>
            <button
              type="button"
              onClick={() => void openViewer({ scope: 'all' }, index.withImages.flatMap(l => l.images))}
              className={`${btnBase} border-violet-600/60 bg-violet-950/40 text-violet-200 hover:bg-violet-800/60 hover:text-white`}
            >
              全部瀏覽
            </button>
          </>
        )}
      </div>
      {sketch.status === 'ready' && index.withImages.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {index.withImages.map((l, i) => {
            // 在「全部」清單中的起始位置 = 前面各行圖數加總
            const start = index.withImages.slice(0, i).reduce((n, x) => n + x.images.filter(img => img.kind === 'image').length, 0)
            const n = l.images.filter(img => img.kind === 'image').length
            return (
              <button
                key={`${l.lineNo ?? ''}|${l.itemCode ?? ''}|${i}`}
                type="button"
                onClick={() => void openViewer({ scope: 'all' }, l.images, start)}
                title={l.itemName ?? undefined}
                className="max-w-full truncate px-2 py-0.5 rounded border border-slate-700 bg-slate-800/60 text-slate-300 text-xs hover:border-violet-500 hover:text-white transition-colors"
              >
                {lineNoLabel(l)}{n > 1 ? ` ×${n}` : ''}
              </button>
            )
          })}
        </div>
      )}
      {sketch.status === 'ready' && index.pdfOnly.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-slate-400">PDF（新分頁開啟）：</span>
          {index.pdfOnly.flatMap((l, i) => l.images.map((p, j) => (
            <a
              key={`${l.lineNo ?? ''}|${l.itemCode ?? ''}|${i}|${j}`}
              href={p.url}
              target="_blank"
              rel="noopener noreferrer"
              title={l.itemName ?? undefined}
              className={`${btnBase} border-slate-600 text-slate-300 hover:bg-slate-700`}
            >
              {lineNoLabel(l)}{l.images.length > 1 ? ` ${j + 1}` : ''} ↗
            </a>
          )))}
        </div>
      )}
    </div>
  )

  return (
    <>
      <SoOrderModal
        projectId={so}
        onClose={onClose}
        renderLineExtra={renderLineExtra}
        dedupeRemarks
        hideHoldStatus
        numericLineSort
        extraContent={extraContent}
      />
      <ZoomableViewer
        open={viewer !== null}
        images={viewerImages}
        initialIndex={viewer?.index ?? 0}
        onClose={() => setViewer(null)}
      />
    </>
  )
}

const btnBase = 'inline-flex items-center gap-1 px-2.5 py-1 rounded border text-xs font-medium whitespace-nowrap transition-colors'
