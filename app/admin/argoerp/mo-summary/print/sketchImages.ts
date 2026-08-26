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

/** 把一個 PDF 檔的每一頁都轉成一張 PNG dataURL（多頁 PDF 會展開成多張示意圖頁） */
async function renderPdfPages(file: File): Promise<string[]> {
  const pdfjs = await loadPdfjs()
  const buf = await file.arrayBuffer()
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

/**
 * 把比對到的示意圖檔案（可能混合圖片與 PDF）全部轉成可直接 <img> 顯示的網址清單。
 * 圖片直接轉 blob URL（快、不佔記憶體轉檔）；PDF 逐頁轉成 PNG dataURL。
 */
export async function resolveSketchImages(matches: MatchedSketch[]): Promise<string[]> {
  const urls: string[] = []
  for (const m of matches) {
    if (PDF_EXT.test(m.file.name)) {
      try {
        urls.push(...await renderPdfPages(m.file))
      } catch (e) {
        console.error(`示意圖 PDF 轉圖失敗（${m.file.name}）：`, e)
      }
    } else {
      urls.push(URL.createObjectURL(m.file))
    }
  }
  return urls
}
