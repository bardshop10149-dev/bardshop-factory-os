// 示意圖比對與轉圖：從使用者選取的本機/內網共用資料夾（如
// \\192.168.1.141\ro排單圖庫\RO）裡的檔案，依檔名裡的「SO銷售單號#項號」
// 自動比對出每一張製令/採購/請購單對應的示意圖，供列印頁插入穿插頁面。
//
// 瀏覽器基於安全性，JS 無法自行連到內網路徑讀檔——使用者用資料夾選取對話框
// 選一次整個資料夾（webkitdirectory），瀏覽器會把資料夾內所有檔案以 File
// 物件全部交給頁面，之後的比對、轉圖都在本機完成，檔案不會離開瀏覽器。

// 從檔名裡找「SO + 數字 + # + 數字」，例如 SO260805024#1.jpg、
// SO260805024#1_示意圖.pdf、SO260805024#01-v2.png（可有零填充/後綴，不需完全相符）。
// 用負向前瞻避免 #1 誤配到 #10、#11 這種同前綴不同項次的檔名。
const ORDER_LINE_PATTERN = /(SO\d+)#0*(\d+)(?!\d)/i

export interface MatchedSketch {
  file: File
  order: string
  line: string
}

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|bmp)$/i
const PDF_EXT = /\.pdf$/i

function sketchKey(order: string, line: string): string {
  return `${order.toUpperCase()}#${line}`
}

/**
 * 掃描資料夾選取後拿到的整批 File，依檔名比對出「訂單#項號」對應的示意圖檔案。
 * 一個訂單#項號可能對到多個檔案（例如同時有一張圖跟一份 PDF），全部保留、
 * 列印時依序全部插入。
 */
export function matchSketchFiles(files: FileList | File[]): Map<string, MatchedSketch[]> {
  const map = new Map<string, MatchedSketch[]>()
  for (const file of Array.from(files)) {
    const name = file.name
    if (!IMAGE_EXT.test(name) && !PDF_EXT.test(name)) continue
    const m = name.match(ORDER_LINE_PATTERN)
    if (!m) continue
    const order = m[1].toUpperCase()
    const line = String(parseInt(m[2], 10))
    const key = sketchKey(order, line)
    const arr = map.get(key) ?? []
    arr.push({ file, order, line })
    map.set(key, arr)
  }
  // 同一個訂單#項次若對到多個檔案，依檔名排序後再印，順序才會是可預期的
  // （瀏覽器讀取資料夾的順序不保證跟檔名排序一致，不同作業系統/瀏覽器可能不同）
  for (const arr of map.values()) {
    arr.sort((a, b) => a.file.name.localeCompare(b.file.name, 'zh-Hant', { numeric: true }))
  }
  return map
}

/** 供列印頁查詢用的 key，跟 matchSketchFiles 內部組 key 的規則一致 */
export function makeSketchLookupKey(order: string, line: string): string {
  return sketchKey(order, line)
}

// ── PDF → 圖片（供跟一般圖片統一用 <img> 排版列印，不用另外處理 iframe/PDF 檢視器）──

let pdfjsLoaderPromise: Promise<typeof import('pdfjs-dist')> | null = null

async function loadPdfjs() {
  if (!pdfjsLoaderPromise) {
    pdfjsLoaderPromise = import('pdfjs-dist').then(mod => {
      mod.GlobalWorkerOptions.workerSrc = new URL(
        'pdfjs-dist/build/pdf.worker.min.mjs',
        import.meta.url,
      ).toString()
      return mod
    })
  }
  return pdfjsLoaderPromise
}

/** 把一份 PDF 的 ArrayBuffer 逐頁轉成 PNG dataURL（多頁 PDF 會展開成多張示意圖頁） */
async function renderPdfBufferPages(buf: ArrayBuffer): Promise<string[]> {
  const pdfjs = await loadPdfjs()
  const pdf = await pdfjs.getDocument({ data: buf }).promise
  const urls: string[] = []
  // 示意圖通常張數不多，此為本機瀏覽器運算，逐頁處理即可
  for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
    const page = await pdf.getPage(pageNo)
    // scale 2 大約對應列印可接受的清晰度（原生 A4 頁面在瀏覽器約 96dpi，*2 約等於 192dpi）
    const viewport = page.getViewport({ scale: 2 })
    const canvas = document.createElement('canvas')
    canvas.width = viewport.width
    canvas.height = viewport.height
    const ctx = canvas.getContext('2d')
    if (!ctx) continue
    await page.render({ canvasContext: ctx, viewport, canvas }).promise
    urls.push(canvas.toDataURL('image/png'))
  }
  return urls
}

/** 把一個本機 PDF 檔的每一頁都轉成一張 PNG dataURL */
async function renderPdfPages(file: File): Promise<string[]> {
  return renderPdfBufferPages(await file.arrayBuffer())
}

/** 把一個遠端 PDF 網址（如已存在 Supabase Storage 的示意圖）的每一頁轉成 PNG dataURL */
async function renderPdfUrlPages(url: string): Promise<string[]> {
  const res = await fetch(url)
  return renderPdfBufferPages(await res.arrayBuffer())
}

// ── 統一縮圖：把示意圖壓到列印夠用的解析度 ──────────────────────────────
//
// 設計部交來的示意圖多半是 A4 @300dpi（2481×3508，解碼後一張就要 35MB）。Chrome 列印時
// 要把整批頁面的圖一次解碼進記憶體，一疊幾十張製令連同示意圖一起印，圖片記憶體會爆掉，
// 結果就是圖只解碼到一半就被送去印：JPEG 沒解碼到的部分印出來是一整塊灰色、PNG 則是
// 空白（2026-09-04 使用者拍照回報：上半部正常、下半部整塊灰）。
//
// 示意圖是給生產線對照用的，長邊 2000px（A4 直式約 180dpi）已足夠清楚讀字，記憶體只剩
// 原本 1/4；同時統一轉成 JPEG，讓 PNG 也一併縮小。原圖若本來就比上限小則只轉格式不放大。
const MAX_PRINT_EDGE = 2000
const PRINT_JPEG_QUALITY = 0.9

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`圖片載入失敗：${src.slice(0, 80)}`))
    img.src = src
  })
}

/** 把任一可載入的圖片網址（blob/data/同源 URL）縮到列印上限並轉成 JPEG dataURL */
async function normalizeForPrint(src: string): Promise<string> {
  const img = await loadImageElement(src)
  const w = img.naturalWidth
  const h = img.naturalHeight
  if (!w || !h) return src
  const ratio = Math.min(1, MAX_PRINT_EDGE / Math.max(w, h))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(w * ratio)
  canvas.height = Math.round(h * ratio)
  const ctx = canvas.getContext('2d')
  if (!ctx) return src
  // 轉 JPEG 沒有透明色版，先鋪白底以免 PNG 透明區變黑
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', PRINT_JPEG_QUALITY)
}

/** 本機 File → 縮圖後的 JPEG dataURL（blob URL 用完即釋放，不留在記憶體） */
async function normalizeFileForPrint(file: File): Promise<string> {
  const blobUrl = URL.createObjectURL(file)
  try {
    return await normalizeForPrint(blobUrl)
  } finally {
    URL.revokeObjectURL(blobUrl)
  }
}

/** 遠端圖片網址 → 先抓成 blob（避開 canvas 跨域污染）再縮圖 */
async function normalizeUrlForPrint(url: string): Promise<string> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const blobUrl = URL.createObjectURL(await res.blob())
  try {
    return await normalizeForPrint(blobUrl)
  } finally {
    URL.revokeObjectURL(blobUrl)
  }
}

/**
 * 把比對到的示意圖檔案（可能混合圖片與 PDF）全部轉成可直接 <img> 顯示的網址清單。
 * 圖片與 PDF 頁面都統一縮到列印上限並轉成 JPEG dataURL（見上方 normalizeForPrint 說明）。
 */
export async function resolveSketchImages(matches: MatchedSketch[]): Promise<string[]> {
  const urls: string[] = []
  for (const m of matches) {
    try {
      if (PDF_EXT.test(m.file.name)) {
        for (const pageUrl of await renderPdfPages(m.file)) urls.push(await normalizeForPrint(pageUrl))
      } else {
        urls.push(await normalizeFileForPrint(m.file))
      }
    } catch (e) {
      console.error(`示意圖轉圖失敗（${m.file.name}）：`, e)
    }
  }
  return urls
}

/**
 * 把每日出單表該列已存好的示意圖網址（Supabase Storage 公開網址，可能混合圖片與 PDF）
 * 解析成可直接 <img> 顯示的網址清單——圖片原樣使用；PDF 逐頁轉成 PNG dataURL，跟本機
 * 資料夾比對出的示意圖走同一套轉圖邏輯，列印排版才會一致。
 */
export async function resolveSketchUrls(urls: string[]): Promise<string[]> {
  const out: string[] = []
  for (const url of urls) {
    try {
      if (PDF_EXT.test(url)) {
        for (const pageUrl of await renderPdfUrlPages(url)) out.push(await normalizeForPrint(pageUrl))
      } else {
        out.push(await normalizeUrlForPrint(url))
      }
    } catch (e) {
      // 縮圖失敗（例如網址失效）時退回原網址，至少不要漏印
      console.error(`示意圖轉圖失敗（${url}）：`, e)
      if (!PDF_EXT.test(url)) out.push(url)
    }
  }
  return out
}
