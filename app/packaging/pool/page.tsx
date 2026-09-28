'use client'

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  POOL_BLOCK_META,
  POOL_BLOCK_ORDER,
  type PackagingCard as PackagingCardData,
  type PoolBlock as PoolBlockData,
  type PoolBlockId,
  type PoolExcluded,
  type PoolFreshness,
  type StaleUnsynced,
} from '@/lib/packaging/types'
import { MANUAL_BLOCK_ID } from '@/lib/packaging/scheduleTypes'
// 只 import 型別：manualPool.ts 會連帶 classify.ts 等伺服器端純函式，值 import 會把它們整包拉進瀏覽器
import type { PoolManualSection, PoolPageResponse } from '@/lib/packaging/manualPool'
import PoolBlock from '@/components/packaging/PoolBlock'
import PackagingOrderModal from '@/components/packaging/PackagingOrderModal'
import ManualPoolSection from '@/components/packaging/pool/ManualPoolSection'
import { usePoolManual } from '@/components/packaging/pool/usePoolManual'
import {
  BLOCK_SHORT,
  BLOCK_TONE,
  POOL_COLUMNS,
  POOL_WIDE_BLOCKS,
  TONE_STYLES,
  fmtHours,
  fmtQty,
  fmtShortDate,
} from '@/components/packaging/poolStyles'

// 包裝專區待排池頁（P0 起，D42）。
// 資料全部來自 GET /api/packaging/pool（伺服器端彙整 ERP／塔台／採購追蹤／出單表並算好區塊、工時、旗標），
// 這一頁負責「顯示＋前端篩選排序」；瀏覽器端的 Supabase 是 anon，受保護表查不到，所以不在這裡直接查表。
//
// D102「待排池頁是可排卡片的唯一控制台」（Snow：「所有可排的卡片都在那張卡裡面控制」）：
//   - 最上面多「手動加入」區塊（'mn'，ManualPoolSection）：主管按標題列「＋加入訂單」把不在待排池的訂單品項加進來，
//     手動卡的「改數量…／移出待排池」也在這一頁（排程工作台側欄已拿掉這些入口，手動卡在工作台照樣顯示、照樣能拖）。
//   - 權限：主管（admin 或 packaging_admin）可加入／改量／移出；唯讀者（packaging）按「查詢訂單」只能查、不能加。
//   - 不需要編輯鎖（Snow 確認：工作台有人在編輯也照樣能加；工作台按重新整理就看得到新卡）。
//     寫入只經 /api/packaging/manual*（伺服器仍驗 packaging_admin 與數量），這頁本身不寫任何資料。
//   - 手動卡算進摘要的「共 N 張卡／估計工時／可立即開包」（它們也是可排的卡）；已全數完成的在伺服器就拆出去，不灌水。

type PoolOk = Extract<PoolPageResponse, { success: true }>
type SortMode = 'default' | 'due_asc' | 'due_desc'
type Focus = 'all' | 'ready' | 'danger' | 'overdue' | 'sample' | 'maybe_unshipped'

/** 自動重抓間隔：與伺服器快取（120 秒）搭配，5 分鐘足夠；手動「重新整理」才略過快取 */
const POLL_MS = 5 * 60 * 1000
// 回應大小注意：Vercel 函式回應上限 4.5MB。D43 改以塔台未結案批界定範圍後，卡數從約 2,000 張降到約 300 張，
// 舊的「隱藏逾期舊單」勾選（?hideStale）已移除。
const COLLAPSE_KEY = 'packaging.pool.collapsed.v1'
/** 已移除的「隱藏舊單」偏好鍵：載入時順手清掉，避免瀏覽器留著用不到的設定 */
const LEGACY_HIDE_STALE_KEY = 'packaging.pool.hideStale.v1'

/** 交期類旗標由卡片右上角的交期晶片表達；「有紅色警示」要排除它們，否則幾乎等於「已逾期」 */
const DUE_FLAG_CODES = new Set(['overdue', 'due_soon'])

/** 各資料來源的顯示名稱與「多久沒更新算偏舊」（分鐘；null＝不提示） */
const FRESHNESS_ITEMS: { key: keyof PoolFreshness; label: string; staleMins: number | null; tip: string }[] = [
  { key: 'erpSo', label: 'ERP 訂單', staleMins: 120, tip: 'erp_so_lines 最後同步時間（平日每 5 分~1 小時）' },
  { key: 'erpPo', label: 'ERP 採購', staleMins: 120, tip: 'erp_pj_sync 最後同步時間（每小時）' },
  { key: 'saraSchedule', label: '塔台排程', staleMins: 60, tip: 'sara_wip_schedule 最後同步時間（每 30 分）' },
  { key: 'saraRecords', label: '塔台報工', staleMins: 240, tip: 'sara_wip_records 最後匯入時間（每 3 小時）' },
  { key: 'changping', label: '常平出貨', staleMins: 26 * 60, tip: '常平黃底同步（目前每晚 23:30 一次）' },
  { key: 'orderSheet', label: '出單表', staleMins: null, tip: 'daily_order_sheets 最後更新時間' },
  // D73：ARGO 銷貨鏡像（erp_so_sales）最後一次成功同步；排程由 P3 設定（建議上班時間每 30 分增量、每晚全量）
  { key: 'soSales', label: 'ARGO 銷貨', staleMins: 180, tip: '銷貨同步（erp_so_sales）最後一次成功的時間；取不到＝銷貨同步尚未啟用，待排池暫不排除已銷貨' },
]

/**
 * 頁尾「未列入待排池」的每一項（給包裝主管看：為什麼這些單不在池裡）。
 * 型別用 Record<keyof PoolExcluded, …>：資料層新增計數欄位時，這裡沒補就編譯不過，不會再漏顯示。
 * 顯示順序＝物件鍵的順序。
 */
const EXCLUDED_ITEMS: Record<keyof PoolExcluded, { label: string; desc: string }> = {
  soldOut: {
    label: '已全數銷貨',
    desc: '以 SO 品項行計。ARGO 銷貨單已出貨完（銷貨量依項次由小到大分配到同品號各行，本行未出貨量 ≤ 0，D73）；部分銷貨的仍在池內，只留未出貨量並標「部分已出貨」。銷貨同步尚未啟用時為 0',
  },
  saraClosedOrAbsent: {
    label: '塔台已結案或不在塔台',
    desc: '以卡計。卡片對不到塔台目前未結案的批（塔台已結案＝多半已出貨，D43），也不是出單表 30 天內已發單、尚未上塔台的品項；發單超過 30 天仍未上塔台的另列在上方清單',
  },
  packagedDone: {
    label: '包裝站已報完工',
    desc: '塔台包裝工序已由人工報完工（P0 暫用完成規則；塔台系統自動結工、ARGO 入庫都不算）',
  },
  closedSo: {
    label: '訂單已結案',
    desc: '採購單或製令對應的 SO／RO 已在 ARGO 結案',
  },
  notInPool: {
    label: '還沒到進池時機',
    desc: '常平未寄且交期不緊張、委外還沒到採購交期、製令前站未開工，或已沒有剩餘可包量',
  },
  materialPurchase: {
    label: '原物料／耗材採購',
    desc: '品號 M、W 開頭且訂單上沒有這個品項（空白板材、PET、燈座、PE 膜、墨水等），是製令的投入料，跟著製令卡包，不另出卡',
  },
  poExceedsSo: {
    label: '採購量超過訂單',
    desc: '同一 SO 行已由其他採購單入庫足量，這些採購行還沒到的量不另出卡（可能重複開單）；該 SO 行的卡片會標橘色旗標，請採購確認',
  },
  nonPhysical: {
    label: '費用行',
    desc: '運費、設計費、急件費、版費、刀模費、加工費等非實體品項（訂單詳情仍看得到）',
  },
}
const EXCLUDED_KEYS = Object.keys(EXCLUDED_ITEMS) as (keyof PoolExcluded)[]

const FOCUS_OPTIONS: { id: Focus; label: string; tip: string }[] = [
  { id: 'all', label: '全部', tip: '顯示全部卡片' },
  { id: 'ready', label: '可立即包', tip: '可包量 > 0（已入庫、前站已完成）' },
  { id: 'danger', label: '有紅色警示', tip: '有紅色危險旗標的卡（不含逾期／即將到期；看逾期請用「已逾期」）' },
  { id: 'overdue', label: '已逾期', tip: 'ERP 品項行交期早於今天' },
  { id: 'sample', label: '打樣類', tip: '打樣單或品名含「打樣」的行' },
]

/** API 沒給 notes 時的後備（摘自規格文件第九節「已知限制與 P0 暫用規則」） */
const FALLBACK_NOTES = [
  '待排池範圍（D43）：只列與塔台 SARA 目前未結案批相連的卡，加上出單表 30 天內已發單、塔台尚未建立的品項（D44）。塔台已結案＝多半已出貨，不再列入；取代原本的「隱藏逾期舊單」勾選。',
  '已發單・未上塔台（D44）：已有採購或製令卡的留在原區塊並標「已發單、塔台尚未建立」；沒有任何來源的（例：壓克力集單）另出卡，來源依出單表廠別推定，數量取 ERP 訂單量。',
  '出單日超過 30 天仍未上塔台、ERP 也未結案的品項不列入，另列「發單超過 30 天仍未上塔台」清單（只涵蓋近 365 天的出單表）。塔台已結案批的歷史只能從報工紀錄推，沒報過工就結案的批會被當成未上塔台。',
  'P0 暫用完成規則：常平／委外沒有完成勾選框可存。常平卡與自製製令在塔台包裝站的包裝工序（非 QC）人工報完工即隱藏（塔台系統自動結工不算）；委外卡沒有完成訊號，塔台批結案（D43）或 SO 在 ARGO 結案才隱藏。P1 改為主管勾選完成。ARGO 入庫＝品檢完成＝才要開始包，絕不當完成。',
  '原物料／耗材採購行（品號 M、W 開頭且 SO 上沒有此品項）是自製投入料，由製令卡包裝，不另出卡。',
  '同 SO 行各採購單已入庫合計達訂單量時，其他採購行的未到量不另出卡，卡上標「可能重複開單」請採購確認。',
  '委外（MPO）在塔台只有 QC 工序，P0 沒有包裝完成訊號；已入庫的委外卡留到塔台批結案或 SO 結案。',
  '自製製令以塔台包裝工序完工代替 ARGO 繳庫（EIP 未同步繳庫量）。',
  '已銷貨（D73）：EIP 定時把 ARGO 銷貨依「SO＋品號」同步成鏡像，待排池只讀鏡像；全數銷貨的品項行不列入，部分銷貨只留未出貨量並標「部分已出貨」。銷貨同步尚未啟用時不排除。',
  '常平出貨燈可能誤亮：同單同品號多行時黃底同步會把所有行都亮燈；配不到數量的行標「出貨燈可能誤亮」。',
  '常平黃底同步目前每晚 23:30 一次；分批寄出時只記第一次寄出。出貨日未解析者不估可包日。',
  '預估可包日＝寄出日＋預設運輸工作天（順豐 3、空運 5、海特快 7、一般海運 13），尚未以實績校正。',
  '委外「已出貨」靠採購手動點，已出貨未到區多半是空的；「委外出貨待確認」以採購追蹤交期（已倒推 2 工作日）判斷。',
  'MPO↔PO 在資料庫無直接關聯，委外到台訊號只能套在 SO 行層級。',
  '中轉單若採購開給第三方廠商，P0 會歸在委外。',
  '前站平行鏈資料庫沒有；同序號多道視為平行鏈取最落後者。塔台報工紀錄每 3 小時同步、排程每 30 分同步。',
  '「只有包裝站、沒有前站」可能是塔台工序錯誤，請用區塊標題的「複製清單」核對。',
  '工時：常平換箱 0.2 分/件暫以「每人」解讀；牛皮盒、鋁箔袋、條碼、五金組裝、氣泡袋、放數尚無附加工時；多個附加元素直接相加。',
  '工作天用台灣行政日曆（內建 2026–2027）；包裝部週六是否上班未定。',
  '採購行只看近 180 天開單；打樣單判定只看近 365 天出單表。',
]

/** ISO 時間 → 台北「今天 HH:mm」或「M/D HH:mm」＋距今分鐘 */
function fmtSync(iso: string | null, now: number): { clock: string; ago: string; mins: number } | null {
  if (!iso) return null
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return null
  const mins = Math.max(0, Math.floor((now - t.getTime()) / 60000))
  const parts = new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(t)
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? ''
  const todayMD = new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric' }).format(new Date(now))
  const md = `${get('month')}/${get('day')}`
  const hm = `${get('hour')}:${get('minute')}`
  const sameDay = new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric' }).format(t) === todayMD
  let ago: string
  if (mins < 1) ago = '剛剛'
  else if (mins < 60) ago = `${mins} 分前`
  else if (mins < 1440) ago = `${Math.floor(mins / 60)} 小時前`
  else ago = `${Math.floor(mins / 1440)} 天前`
  return { clock: sameDay ? hm : `${md} ${hm}`, ago, mins }
}

/** 關鍵字比對的欄位：單號（SO／採購／製令／塔台批）、客戶、品名、品號 */
function haystack(c: PackagingCardData): string {
  return [
    c.so, c.soLineKey, c.customer, c.itemName, c.itemCode,
    ...c.sources.flatMap(s => [s.docNo, s.lineNo ? `${s.docNo}-${s.lineNo}` : null, s.saraMo]),
    c.preStation?.moNbr, ...(c.preStation?.otherMos ?? []),
  ].filter(Boolean).join('\n').toLowerCase()
}

function readCollapsed(): Set<PoolBlockId> {
  try {
    const raw = window.localStorage.getItem(COLLAPSE_KEY)
    const arr = raw ? (JSON.parse(raw) as unknown) : []
    return new Set(Array.isArray(arr) ? arr.filter((x): x is PoolBlockId => typeof x === 'string' && x in POOL_BLOCK_META) : [])
  } catch {
    return new Set()
  }
}

function writeCollapsed(s: Set<PoolBlockId>) {
  try { window.localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...s])) } catch { /* 無痕模式等情況寫不進去就算了 */ }
}

/**
 * CSV 一格：含逗號、引號、換行時用雙引號包起來，引號重複一次（RFC 4180）。
 * 另防 CSV／公式注入（OWASP 建議）：品名、單據種類是人工輸入的自由文字，開頭若是 = + - @ Tab CR，
 * Excel 開檔時會當成公式執行 → 前面加一個單引號，讓 Excel 當純文字。
 */
function csvCell(v: string | number | null | undefined): string {
  let t = v == null ? '' : String(v)
  if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`
  return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t
}

const FACTORY_LABEL: Record<string, string> = { T: '自製', C: '常平', O: '委外' }

/**
 * 「發單超過 30 天仍未上塔台」下載成 CSV（前端產生，不另打 API）。
 * 開頭加 UTF-8 BOM（位元組 EF BB BF，程式裡寫成跳脫的 \uFEFF，避免隱形字元被編輯器或格式化工具吃掉）：Excel 看到 BOM 才會用 UTF-8 解讀，否則中文會變亂碼（Windows Excel 預設用系統編碼開 CSV）。
 */
function downloadStaleCsv(stale: StaleUnsynced, today: string) {
  const header = ['出單日', 'SO', '項次', '單據種類', '廠別', '製令號', '採購單', '請購單', '品名']
  const lines = stale.rows.map(r => [
    r.sheetDate, r.so, r.soLine, r.docType, r.factory ? `${r.factory} ${FACTORY_LABEL[r.factory] ?? ''}`.trim() : '',
    r.moNumber, r.poNumber, r.prNumber, r.itemName,
  ].map(csvCell).join(','))
  const blob = new Blob(['\uFEFF' + [header.join(','), ...lines].join('\r\n')], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `發單超過${stale.windowDays}天未上塔台_${today}.csv`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** 頁尾上方的可收合異常清單（D44）：出單日超過 30 天、ERP 未結案、比對不到任何塔台批 */
function StaleUnsyncedPanel({ stale, today, onOpenOrder }: { stale: StaleUnsynced; today: string; onOpenOrder: (so: string) => void }) {
  return (
    <details className="group mt-8 rounded-xl border border-orange-800/50 bg-orange-950/15 text-xs text-slate-300">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-4 py-3 [&::-webkit-details-marker]:hidden">
        <span className="text-orange-300 transition-transform group-open:rotate-90">▶</span>
        <h2 className="text-sm font-bold text-orange-200">發單超過 {stale.windowDays} 天仍未上塔台（{fmtQty(stale.count)}）</h2>
        <span className="text-[11px] text-slate-400">不列入待排池；請生管確認是塔台建單失敗，還是該在 ERP 結案</span>
      </summary>
      <div className="border-t border-orange-900/40 px-4 py-3">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => downloadStaleCsv(stale, today)}
            disabled={stale.count === 0}
            className="rounded border border-orange-600/60 bg-orange-900/40 px-2.5 py-1 text-[11px] font-semibold text-orange-100 hover:bg-orange-800/50 disabled:opacity-50"
          >下載 CSV</button>
          <span className="text-[11px] text-slate-500">依出單日由新到舊；同一 SO 行出現在多張出單表時取最新一張</span>
        </div>
        {stale.count === 0 ? (
          <p className="py-2 text-slate-400">目前沒有。</p>
        ) : (
          // 表格只在這個框內捲動，手機整頁不會出現橫向捲軸
          <div className="max-h-[60vh] overflow-auto rounded border border-slate-800">
            <table className="w-full min-w-[720px] border-collapse text-left text-[11px]">
              <thead className="sticky top-0 bg-slate-900 text-slate-400">
                <tr>
                  {['出單日', 'SO-項次', '單據種類', '廠別', '製令號', '採購單', '請購單', '品名'].map(h => (
                    <th key={h} className="whitespace-nowrap px-2 py-1.5 font-semibold">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {stale.rows.map(r => (
                  <tr key={`${r.so}-${r.soLine}`} className="border-t border-slate-800/70 hover:bg-slate-900/60">
                    <td className="whitespace-nowrap px-2 py-1">{fmtShortDate(r.sheetDate, today)}</td>
                    <td className="whitespace-nowrap px-2 py-1">
                      <button type="button" onClick={() => onOpenOrder(r.so)} title="開啟訂單詳情"
                        className="font-mono text-sky-300 hover:underline">{r.so}<span className="text-slate-400">-{r.soLine}</span></button>
                    </td>
                    <td className="whitespace-nowrap px-2 py-1">{r.docType ?? '—'}</td>
                    <td className="whitespace-nowrap px-2 py-1">{r.factory ? (FACTORY_LABEL[r.factory] ?? r.factory) : '—'}</td>
                    <td className="whitespace-nowrap px-2 py-1 font-mono">{r.moNumber ?? '—'}</td>
                    <td className="whitespace-nowrap px-2 py-1 font-mono">{r.poNumber ?? '—'}</td>
                    <td className="whitespace-nowrap px-2 py-1 font-mono">{r.prNumber ?? '—'}</td>
                    <td className="px-2 py-1 text-slate-400">{r.itemName ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </details>
  )
}

export default function PackagingPoolPage() {
  const router = useRouter()
  const [auth, setAuth] = useState<'checking' | 'allowed' | 'denied'>('checking')
  /** D102：主管（is_admin 或 packaging_admin，同伺服器 guardPackaging('write')）才顯示加入／改量／移出；只影響按鈕，守門在伺服器 */
  const [canEdit, setCanEdit] = useState(false)
  const [data, setData] = useState<PoolOk | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const [keyword, setKeyword] = useState('')
  const deferredKeyword = useDeferredValue(keyword)
  const [sortMode, setSortMode] = useState<SortMode>('default')
  const [focus, setFocus] = useState<Focus>('all')
  // 折疊狀態是「每位使用者自己的習慣」，存在瀏覽器即可（讀不到就全部展開）。
  // 伺服器端渲染時只會畫「驗證權限中」，區塊還沒出現，所以這裡直接讀 localStorage 不會造成 hydration 不一致
  const [collapsed, setCollapsed] = useState<Set<PoolBlockId>>(
    () => (typeof window === 'undefined' ? new Set() : readCollapsed()),
  )
  const [orderSo, setOrderSo] = useState<string | null>(null)

  const inflight = useRef(false)
  /** 載入中又有人要求重抓（D102 手動加入寫入成功）：載完再抓一次，不能像輪詢那樣直接丟掉 */
  const reloadQueued = useRef(false)
  const lastLoadAt = useRef(0)

  // 「隱藏舊單」勾選已移除（D43），清掉舊偏好
  useEffect(() => {
    try { window.localStorage.removeItem(LEGACY_HIDE_STALE_KEY) } catch { /* 無痕模式等情況存取不到就算了 */ }
  }, [])

  // ── 權限：比照工程專區，先問 /api/auth/me（admin 或 packaging／packaging_admin） ──
  useEffect(() => {
    const check = async () => {
      try {
        const res = await fetch('/api/auth/me', { cache: 'no-store' })
        if (res.status === 401) { router.replace('/login'); return }
        if (!res.ok) { setAuth('denied'); return }
        const me = await res.json() as { is_admin?: boolean; permissions?: string[] }
        const perms = Array.isArray(me.permissions) ? me.permissions : []
        setCanEdit(Boolean(me.is_admin) || perms.includes('packaging_admin'))
        setAuth(Boolean(me.is_admin) || perms.includes('packaging') || perms.includes('packaging_admin') ? 'allowed' : 'denied')
      } catch { setAuth('denied') }
    }
    void check()
  }, [router])

  const load = useCallback(async (fresh: boolean) => {
    if (inflight.current) return
    inflight.current = true
    setLoading(true)
    try {
      const res = await fetch(`/api/packaging/pool${fresh ? '?fresh=1' : ''}`, { cache: 'no-store' })
      if (res.status === 401) { router.replace('/login'); return }
      if (res.status === 403) { setAuth('denied'); return }
      const json = await res.json().catch(() => null) as PoolPageResponse | null
      if (!json) throw new Error(`伺服器回應無法解析（HTTP ${res.status}）`)
      if (!json.success) throw new Error(json.error || `HTTP ${res.status}`)
      // 部署交接時可能拿到舊版回應（沒有 manual）：手動區顯示暫不可用，其他照常（形狀同 manualPool.unavailableManualSection）
      const oldServer: PoolManualSection = {
        available: false, error: '伺服器版本較舊，請稍後重新整理', lines: {}, ended: [], skipped: { soGone: 0, backInPool: 0, soldOut: 0 },
      }
      setData(json.manual ? json : { ...json, manual: oldServer })
      setError(null)
      lastLoadAt.current = Date.now()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      inflight.current = false
      setLoading(false)
      setNow(Date.now())
      if (reloadQueued.current) {
        reloadQueued.current = false
        void load(false)
      }
    }
  }, [router])

  /**
   * D102 手動加入寫入後的重抓（排隊版）。既有 load() 遇到進行中直接 return（輪詢撞到就算了，5 分鐘後還會再抓）；
   * 但寫入後那次不能漏——剛好撞上輪詢時，等它載完再抓一次。
   * 不用 fresh=1：手動寫入不改底層待排池（ERP／塔台彙整），伺服器手動層有自己的失效機制，一般讀取 0.3～1 秒就是新的。
   */
  const requestReload = useCallback(() => {
    if (inflight.current) { reloadQueued.current = true; return }
    void load(false)
  }, [load])

  const manualCtl = usePoolManual({ canEdit, onChanged: requestReload })

  useEffect(() => { if (auth === 'allowed') void load(false) }, [auth, load])

  // 每 5 分鐘自動重抓（分頁在背景時不抓；切回來若已超過 5 分鐘立刻補抓）；「N 分前」每分鐘刷新
  useEffect(() => {
    if (auth !== 'allowed') return
    const poll = setInterval(() => {
      if (document.visibilityState === 'visible') void load(false)
    }, POLL_MS)
    const tick = setInterval(() => setNow(Date.now()), 60 * 1000)
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastLoadAt.current > POLL_MS) void load(false)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(poll)
      clearInterval(tick)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [auth, load])

  // ── 區塊：以 API 回傳為準；API 若省略空區塊，補一個空殼讓版面固定 ──
  const blockMap = useMemo(() => {
    const m = new Map<PoolBlockId, PoolBlockData>()
    for (const id of POOL_BLOCK_ORDER) {
      m.set(id, {
        id, title: POOL_BLOCK_META[id].title, hint: POOL_BLOCK_META[id].hint,
        cards: [], cardCount: 0, totalMinutes: 0, unknownMinutesCards: 0, overdueCount: 0, sampleCount: 0,
      })
    }
    for (const b of data?.blocks ?? []) m.set(b.id, b)
    return m
  }, [data])

  // ── 篩選＋排序（前端；卡片最多幾百張，每次重算成本很低） ──
  const terms = useMemo(
    () => deferredKeyword.trim().toLowerCase().split(/\s+/).filter(Boolean),
    [deferredKeyword],
  )
  const filtered = terms.length > 0 || focus !== 'all'

  const today = data?.today ?? null
  const viewCards = useMemo(() => {
    const out = new Map<PoolBlockId, PackagingCardData[]>()
    for (const [id, b] of blockMap) {
      let cards = b.cards
      if (focus === 'ready') cards = cards.filter(c => c.qtyReady > 0)
      else if (focus === 'danger') cards = cards.filter(c => c.flags.some(f => f.level === 'danger' && !DUE_FLAG_CODES.has(f.code)))
      else if (focus === 'overdue') cards = cards.filter(c => c.dueDate != null && today != null && c.dueDate < today)
      else if (focus === 'sample') cards = cards.filter(c => c.sample.isSample)
      // 與區塊 3 提示的計數用同一個條件，點「只看這些」後的張數才對得上
      else if (focus === 'maybe_unshipped') cards = cards.filter(c => c.flags.some(f => f.code === 'maybe_unshipped_urgent'))
      if (terms.length > 0) cards = cards.filter(c => { const h = haystack(c); return terms.every(t => h.includes(t)) })
      if (sortMode !== 'default') {
        // 預設順序由伺服器排好（逾期→打樣→剩餘工作天→預估可包日→SO）；交期排序時沒交期的排最後。sort 是穩定排序，同交期維持原順序
        const dir = sortMode === 'due_asc' ? 1 : -1
        cards = [...cards].sort((a, b) => {
          if (a.dueDate === b.dueDate) return 0
          if (!a.dueDate) return 1
          if (!b.dueDate) return -1
          return a.dueDate < b.dueDate ? -dir : dir
        })
      }
      out.set(id, cards)
    }
    return out
  }, [blockMap, focus, terms, sortMode, today])

  // ── 摘要合計 ──
  const summary = useMemo(() => {
    let cards = 0, minutes = 0, unknown = 0, overdue = 0, readyMinutes = 0, maybeUnshipped = 0
    for (const b of blockMap.values()) {
      cards += b.cardCount
      minutes += b.totalMinutes
      unknown += b.unknownMinutesCards
      overdue += b.overdueCount
      for (const c of b.cards) {
        if ((c.status === 'ready' || c.status === 'pre_station_finished') && c.work.minutes != null) readyMinutes += c.work.minutes
        if (c.flags.some(f => f.code === 'maybe_unshipped_urgent')) maybeUnshipped++
      }
    }
    return { cards, minutes, unknown, overdue, readyMinutes, maybeUnshipped }
  }, [blockMap])

  const toggleBlock = useCallback((id: PoolBlockId) => {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      writeCollapsed(next)
      return next
    })
  }, [])

  const setAllCollapsed = (collapse: boolean) => {
    // D102：'mn' 不在 POOL_BLOCK_ORDER（摘要晶片不放它），「全部收合」要另外補上
    const next = collapse ? new Set<PoolBlockId>([...POOL_BLOCK_ORDER, MANUAL_BLOCK_ID]) : new Set<PoolBlockId>()
    writeCollapsed(next)
    setCollapsed(next)
  }

  /** 摘要晶片 → 展開該區並捲過去 */
  const jumpTo = (id: PoolBlockId) => {
    if (collapsed.has(id)) toggleBlock(id)
    requestAnimationFrame(() => {
      document.getElementById(`pool-block-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }

  // ── 權限狀態畫面 ──
  if (auth === 'checking') {
    return (
      <div className="min-h-screen bg-[#050b14] flex items-center justify-center">
        <div className="text-amber-400 font-mono text-sm animate-pulse">驗證權限中...</div>
      </div>
    )
  }
  if (auth === 'denied') {
    return (
      <div className="min-h-screen bg-[#050b14] flex items-center justify-center p-4">
        <div className="bg-slate-900 border border-red-800 rounded-2xl p-10 max-w-md w-full text-center">
          <div className="text-5xl mb-4">🔒</div>
          <h1 className="text-xl font-bold text-red-400 mb-3">存取被拒絕</h1>
          <p className="text-slate-400 text-sm mb-6 leading-relaxed">
            你沒有<span className="text-amber-400 font-mono mx-1">包裝專區</span>的存取權限。<br />
            請聯絡核心管理員開通。
          </p>
          <button onClick={() => router.push('/')}
            className="px-6 py-2 rounded border border-slate-600 text-slate-300 text-sm font-mono hover:bg-slate-700">← 返回首頁</button>
        </div>
      </div>
    )
  }

  const genAt = data ? fmtSync(data.generatedAt, now) : null
  // D37：常平卡角落標「常平資料更新於」（常平黃底同步目前一天一次，是最容易過時的來源）
  const cpSync = data ? fmtSync(data.freshness.changping, now) : null
  const cpSyncLabel = cpSync ? `常平資料 ${cpSync.clock}` : '常平資料時間不明'
  const notes = data && data.notes.length > 0 ? data.notes : FALLBACK_NOTES

  return (
    <div className="min-h-screen bg-[#050b14] text-white">
      <div className="mx-auto max-w-[1800px] px-4 py-4 md:px-6 md:py-6">

        {/* ─── 標題列 ─── */}
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <Link href="/packaging"
              className="mb-2 inline-block text-xs font-mono text-slate-400 hover:text-white transition-colors">← 包裝專區</Link>
            <h1 className="text-2xl font-bold">
              待排池
              {/* D102：這頁不再是唯讀總覽——主管可在這裡手動加入、改數量、移出；徽章依權限顯示（字樣同包裝專區首頁） */}
              <span className={`ml-2 align-middle rounded border px-1.5 py-0.5 text-[11px] font-semibold ${canEdit
                ? 'border-violet-500/40 bg-violet-500/10 text-violet-300'
                : 'border-slate-600 bg-slate-800/60 text-slate-400'}`}>{canEdit ? '主管編輯權限' : '唯讀'}</span>
            </h1>
            <p className="mt-1 text-sm text-slate-400">
              依來源分組的待包裝品項（一張卡＝一個 ARGO 品項行）
              {data && <span className="text-slate-500">・今天 {fmtShortDate(data.today)}</span>}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {/* D102：手動加入的入口（主管＝加入；唯讀＝只能查詢某張單為什麼不在待排池） */}
            <button
              type="button"
              onClick={manualCtl.openAdd}
              disabled={!data || !data.manual.available}
              title={data && !data.manual.available
                ? `手動加入暫時無法使用：${data.manual.error ?? ''}`
                : canEdit ? '手動把不在待排池的訂單品項加進來排程（D66／D102）' : '查詢某張單的品項為什麼不在待排池（加入需要包裝主管權限）'}
              className={canEdit
                ? 'rounded-lg border border-amber-500 bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-500 disabled:opacity-50'
                : 'rounded-lg border border-slate-600 bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-slate-700 disabled:opacity-50'}
            >{canEdit ? '＋加入訂單' : '查詢訂單'}</button>
            {/* D102 起與排程工作台共用同一份待排池快取（D98：2 分鐘內直接用；較舊時先顯示舊的、背景更新，最多 10 分鐘） */}
            {genAt && (
              <span className="text-[11px] text-slate-500" title={`伺服器彙整時間 ${data?.generatedAt}${data?.cached ? '（伺服器快取：與排程工作台共用，2 分鐘內直接用；較舊時先顯示、背景更新）' : ''}`}>
                彙整於 {genAt.clock}（{genAt.ago}）{data?.cached ? '・快取' : ''}
              </span>
            )}
            <button
              type="button"
              onClick={() => void load(true)}
              disabled={loading}
              title="略過伺服器快取，重新彙整（約 3~6 秒；30 秒內重按視同一般讀取）"
              className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-slate-700 disabled:opacity-50"
            >{loading ? '更新中…' : '重新整理'}</button>
          </div>
        </div>

        {/* P0 暫用規則提醒：放在最上面，避免有人以為「卡片消失＝包裝完成」是最終邏輯 */}
        <div className="mt-3 rounded-lg border border-amber-700/40 bg-amber-950/20 px-3 py-2 text-[11px] leading-relaxed text-amber-200/90">
          <b className="text-amber-300">P0 暫用規則：</b>
          待排池只列<b>塔台未結案批</b>相連的卡，加上出單表 30 天內已發單、塔台尚未建立的品項（D43／D44）。
          常平卡與自製製令在「塔台包裝站包裝工序（非 QC）<b>人工</b>報完工」時隱藏（塔台系統自動結工不算）；委外卡沒有完成訊號，塔台批結案或「SO 在 ARGO 結案」才隱藏。<b>P1 改為主管勾選完成</b>。
          ARGO 入庫＝品檢完成＝才開始包，不代表包裝完成。其他限制與「未列入待排池」的原因見頁尾。
        </div>

        {/* ─── 錯誤（已有舊資料時只顯示橫幅） ─── */}
        {error && data && (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-red-800/60 bg-red-950/30 px-3 py-2 text-xs text-red-200">
            <span>更新失敗：{error}。目前顯示的是 {genAt?.clock ?? '上一次'} 的資料。</span>
            <button type="button" onClick={() => void load(true)} className="rounded border border-red-700 px-2 py-0.5 hover:bg-red-900/50">重試</button>
          </div>
        )}

        {!data ? (
          error ? (
            <div className="mt-10 mx-auto max-w-lg rounded-2xl border border-red-800 bg-slate-900 p-8 text-center">
              <div className="text-lg font-bold text-red-400 mb-2">待排池載入失敗</div>
              <p className="text-sm text-slate-400 break-words mb-5">{error}</p>
              <button type="button" onClick={() => void load(true)}
                className="px-5 py-2 rounded border border-slate-600 text-slate-200 text-sm hover:bg-slate-700">重試</button>
            </div>
          ) : (
            <div className="mt-10 flex flex-col items-center gap-3 text-center">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-amber-500 border-t-transparent" />
              <div className="text-sm text-amber-300">載入待排池中…</div>
              <div className="text-xs text-slate-500">彙整 ERP 訂單／採購、塔台排程與報工、常平出貨、出單表，首次約 3~6 秒</div>
            </div>
          )
        ) : (
          <>
            {/* ─── 摘要：總量＋各區塊卡數與工時 ─── */}
            <div className="mt-4 rounded-xl border border-slate-800 bg-slate-900/50 p-3">
              <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-xs">
                <span className="text-slate-300">共 <b className="text-lg text-white">{summary.cards}</b> 張卡</span>
                <span className="text-amber-200" title="各區塊已知工時合計（1 人）">
                  估計工時 <b className="text-lg">{fmtHours(summary.minutes)}</b> 小時
                </span>
                <span className="text-lime-300" title="狀態為「可包」或「前站已完工」的卡片工時合計">
                  可立即開包 <b className="text-lg">{fmtHours(summary.readyMinutes)}</b> 小時
                </span>
                {/* D102：手動卡已算進上面的張數與工時；另給一個跳到手動區的入口（不放進 10 格晶片列，會變 11 格換行） */}
                {data.manual.available && (
                  <button type="button" onClick={() => jumpTo(MANUAL_BLOCK_ID)}
                    title="主管手動加入的品項（已算進共 N 張卡與工時）；點一下跳到「手動加入」區"
                    className="text-amber-300 underline decoration-dotted underline-offset-2 hover:text-amber-200">
                    其中手動加入 {blockMap.get(MANUAL_BLOCK_ID)?.cardCount ?? 0} 張
                  </button>
                )}
                {summary.unknown > 0 && <span className="text-orange-300">工時未知 {summary.unknown} 張</span>}
                {summary.overdue > 0 && <span className="font-semibold text-red-300">已逾期 {summary.overdue} 張</span>}
                {data.staleUnsynced.count > 0 && (
                  <span className="text-orange-300" title="出單日超過 30 天、ERP 未結案、比對不到任何塔台批；不列入待排池，清單在頁尾上方">
                    另有發單超過 {data.staleUnsynced.windowDays} 天未上塔台 {data.staleUnsynced.count} 行
                  </span>
                )}
              </div>
              <div className="mt-2.5 grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-10">
                {POOL_BLOCK_ORDER.map(id => {
                  const b = blockMap.get(id)!
                  const tone = TONE_STYLES[BLOCK_TONE[id]]
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => jumpTo(id)}
                      title={`${b.title}：${b.hint}`}
                      className={`min-w-0 rounded-lg border px-2 py-1.5 text-left transition-colors ${tone.chip} ${b.cardCount === 0 ? 'opacity-50' : ''}`}
                    >
                      <div className="flex items-center gap-1 text-[11px] leading-tight">
                        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`} />
                        <span className="font-mono opacity-70">{id}</span>
                        <span className="truncate">{BLOCK_SHORT[id]}</span>
                      </div>
                      <div className="mt-0.5 flex items-baseline gap-1.5 whitespace-nowrap">
                        <b className="text-base leading-none text-white">{b.cardCount}</b>
                        <span className="text-[10px] opacity-80">張</span>
                        <span className="text-[11px] text-amber-200">{fmtHours(b.totalMinutes)}h</span>
                        {b.overdueCount > 0 && <span className="text-[10px] font-semibold text-red-300">逾{b.overdueCount}</span>}
                      </div>
                    </button>
                  )
                })}
              </div>
              {/* 資料更新時間（各來源） */}
              <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 border-t border-slate-800 pt-2 text-[11px] text-slate-500">
                <span className="text-slate-400">資料更新：</span>
                {FRESHNESS_ITEMS.map(it => {
                  const f = fmtSync(data.freshness[it.key], now)
                  const stale = f != null && it.staleMins != null && f.mins > it.staleMins
                  return (
                    <span key={it.key} title={it.tip} className={stale ? 'text-amber-400' : ''}>
                      {it.label} {f ? `${f.clock}（${f.ago}）` : '取不到'}{stale ? ' ⚠' : ''}
                    </span>
                  )
                })}
              </div>
            </div>

            {/* ─── 篩選列 ─── */}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <input
                value={keyword}
                onChange={e => setKeyword(e.target.value)}
                aria-label="搜尋待排池"
                placeholder="搜尋單號／客戶／品名／品號（空白分隔＝同時符合）"
                className="w-full rounded border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-white placeholder:text-slate-400 focus:border-amber-500 focus:outline-none sm:w-80"
              />
              <select
                value={sortMode}
                onChange={e => setSortMode(e.target.value as SortMode)}
                className="rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-200 focus:border-amber-500 focus:outline-none"
                title="區塊內卡片排序"
                aria-label="區塊內排序"
              >
                <option value="default">預設：逾期→打樣→剩餘工作天</option>
                <option value="due_asc">交期 近→遠</option>
                <option value="due_desc">交期 遠→近</option>
              </select>
              <div className="flex flex-wrap gap-1">
                {FOCUS_OPTIONS.map(o => (
                  <button key={o.id} type="button" onClick={() => setFocus(o.id)} title={o.tip} aria-pressed={focus === o.id}
                    className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${focus === o.id
                      ? 'border-amber-500 bg-amber-600 text-white'
                      : 'border-slate-700 bg-slate-900 text-slate-400 hover:text-slate-200'}`}
                  >{o.label}</button>
                ))}
                {focus === 'maybe_unshipped' && (
                  <button type="button" onClick={() => setFocus('all')} aria-pressed="true" title="取消這個篩選"
                    className="rounded-full border border-orange-500 bg-orange-700/60 px-2.5 py-1 text-[11px] text-white">
                    出貨燈可能誤亮 ✕
                  </button>
                )}
              </div>
              <div className="flex-1" />
              <button type="button" onClick={() => setAllCollapsed(false)}
                className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-400 hover:text-white">全部展開</button>
              <button type="button" onClick={() => setAllCollapsed(true)}
                className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-400 hover:text-white">全部收合</button>
            </div>

            {/* ─── D102 手動加入（'mn'）：所有區塊最上面；篩選、排序、全部收合與其他區塊同一套 ─── */}
            <div className="mt-4">
              <ManualPoolSection
                block={blockMap.get(MANUAL_BLOCK_ID)}
                cards={viewCards.get(MANUAL_BLOCK_ID) ?? []}
                filtered={filtered}
                collapsed={collapsed.has(MANUAL_BLOCK_ID)}
                onToggle={() => toggleBlock(MANUAL_BLOCK_ID)}
                manual={data.manual}
                today={data.today}
                canEdit={canEdit}
                changpingSyncLabel={cpSyncLabel}
                onOpenOrder={setOrderSo}
                onAdd={manualCtl.openAdd}
                onEdit={manualCtl.openEdit}
                onRemove={manualCtl.openRemove}
              />
            </div>

            {/* ─── 跨來源的整列區塊（ns：已發單・未上塔台，D44）─── */}
            {POOL_WIDE_BLOCKS.map(id => (
              <div key={id} className="mt-4">
                <PoolBlock
                  block={blockMap.get(id)!}
                  cards={viewCards.get(id) ?? []}
                  filtered={filtered}
                  collapsed={collapsed.has(id)}
                  onToggle={() => toggleBlock(id)}
                  onOpenOrder={setOrderSo}
                  today={data.today}
                  changpingSyncLabel={cpSyncLabel}
                  wide
                />
              </div>
            ))}

            {/* ─── 區塊：桌機三欄（常平／自製／委外），手機與平板單欄依序疊 ─── */}
            <div className="mt-4 grid grid-cols-1 items-start gap-4 lg:grid-cols-3">
              {POOL_COLUMNS.map(col => {
                const tone = TONE_STYLES[col.tone]
                const colCards = col.blocks.reduce((n, id) => n + (blockMap.get(id)?.cardCount ?? 0), 0)
                const colMinutes = col.blocks.reduce((n, id) => n + (blockMap.get(id)?.totalMinutes ?? 0), 0)
                return (
                  <section key={col.id} className="min-w-0 space-y-3">
                    <div className="flex items-baseline gap-2 border-b border-slate-800 pb-1.5">
                      <span className={`h-2.5 w-2.5 shrink-0 self-center rounded-full ${tone.dot}`} />
                      <h2 className={`text-base font-bold ${tone.title}`}>{col.title}</h2>
                      <span className="min-w-0 truncate text-[11px] text-slate-500">{col.sub}</span>
                      <span className="ml-auto shrink-0 text-[11px] text-slate-400">{colCards} 張・{fmtHours(colMinutes)} 小時</span>
                    </div>
                    {col.blocks.map(id => {
                      const b = blockMap.get(id)!
                      // 提示列放在區塊標題下方、不跟著卡片清單收合：區塊 3 收合或沒卡時也要看得到
                      const unshippedNotice = id === '3' && summary.maybeUnshipped > 0 ? (
                        <div className="flex flex-wrap items-center gap-2 rounded border border-orange-600/50 bg-orange-950/30 px-2 py-1.5 text-[11px] text-orange-200">
                          <span>
                            另有 <b>{summary.maybeUnshipped}</b> 張放在「常平 — 已寄出運送中」，但出貨燈可能誤亮、且交期緊張，請向常平確認是否真的寄出。
                          </span>
                          <button type="button" onClick={() => { setFocus('maybe_unshipped'); jumpTo('1') }}
                            className="rounded border border-orange-500/70 px-2 py-0.5 hover:bg-orange-900/50">只看這些</button>
                        </div>
                      ) : null
                      return (
                        <PoolBlock
                          key={id}
                          block={b}
                          cards={viewCards.get(id) ?? []}
                          filtered={filtered}
                          collapsed={collapsed.has(id)}
                          onToggle={() => toggleBlock(id)}
                          onOpenOrder={setOrderSo}
                          today={data.today}
                          notice={unshippedNotice ?? undefined}
                          changpingSyncLabel={cpSyncLabel}
                        />
                      )
                    })}
                  </section>
                )
              })}
            </div>

            {/* ─── D44：發單超過 30 天仍未上塔台（不列入待排池，給生管／Snow 追查）─── */}
            <StaleUnsyncedPanel stale={data.staleUnsynced} today={data.today} onOpenOrder={setOrderSo} />

            {/* ─── 頁尾：P0 暫用規則與已知限制、排除統計 ─── */}
            <footer className="mt-4 rounded-xl border border-slate-800 bg-slate-900/40 p-4 text-xs text-slate-400">
              <h2 className="mb-2 text-sm font-bold text-slate-300">P0 暫用規則與已知限制</h2>
              <ol className="list-decimal space-y-1 pl-5 leading-relaxed">
                {notes.map((n, i) => <li key={i} className="break-words">{n}</li>)}
              </ol>
              <div className="mt-3 border-t border-slate-800 pt-3">
                <div className="flex flex-wrap items-baseline gap-x-2 text-[11px]">
                  <span className="font-semibold text-slate-300">未列入待排池</span>
                  <span className="text-slate-500">
                    計數單位是採購行或製令（費用行以 SO 品項行計、塔台範圍以卡計），同一 SO 行可能同時落在幾項，不能相加當卡數
                  </span>
                </div>
                {/* 說明直接寫出來、不只放 title：平板／手機沒有滑鼠停留提示 */}
                <dl className="mt-1.5 grid grid-cols-1 gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
                  {EXCLUDED_KEYS.map(k => {
                    const it = EXCLUDED_ITEMS[k]
                    const n = data.excluded[k]
                    return (
                      <div key={k} className={`min-w-0 rounded border border-slate-800 bg-slate-950/40 px-2 py-1.5 ${n ? '' : 'opacity-60'}`}>
                        <dt className="flex items-baseline justify-between gap-2 text-[11px] text-slate-300">
                          <span>{it.label}</span>
                          <b className="text-sm text-white">{fmtQty(n)}</b>
                        </dt>
                        <dd className="mt-0.5 break-words text-[10px] leading-snug text-slate-500">{it.desc}</dd>
                      </div>
                    )
                  })}
                </dl>
              </div>
              <div className="mt-1.5 text-[11px] text-slate-500">
                工作天：台灣行政日曆（含國定假日與補班；內建 {data.calendar.coveredYears.join('、') || '—'} 年）
                {data.calendar.source === 'fallback' && (
                  <span className="ml-1 text-orange-300">⚠ 部分日期超出內建日曆，改以週一~五計算</span>
                )}
              </div>
            </footer>
          </>
        )}
      </div>

      {orderSo && <PackagingOrderModal so={orderSo} open onClose={() => setOrderSo(null)} />}
      {manualCtl.dialogs}
    </div>
  )
}
