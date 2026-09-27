// 包裝專區待排池的配色與顯示字典（畫面層共用）。
//
// 為什麼集中在這裡：Tailwind v4 是「掃原始碼找完整類別字串」產生 CSS，
// 類別名稱若在元件裡用字串拼接（`bg-${color}-500`）會被漏掉、畫面沒有顏色。
// 所以每一個類別都寫成完整字面值，區塊、卡片、摘要列都從這一份取，換色只改一處。

import { BOARD_ONLY_BLOCKS, type CardStatus, type DangerFlag, type PoolBlockId, type SourceKind } from '@/lib/packaging/types'

/** 區塊色調：三種來源色＋品檢中＋提醒（常平未寄緊張／委外出貨待確認／無前站需確認／已發單未上塔台） */
export type BlockTone = 'changping' | 'outsource' | 'inhouse' | 'qc' | 'alert' | 'manual'

export const BLOCK_TONE: Record<PoolBlockId, BlockTone> = {
  '3': 'alert',
  'ns': 'alert',
  '1': 'changping',
  '1b': 'qc',
  '2': 'changping',
  '4': 'inhouse',
  '4x': 'alert',
  '5c': 'alert',
  '5a': 'outsource',
  '5b': 'outsource',
  // D66 手動加入：獨立色調（琥珀），一眼看出「不是系統判定進池的」
  'mn': 'manual',
}

export interface ToneStyle {
  /** 區塊外框 */
  border: string
  /** 區塊標題列底色 */
  headerBg: string
  /** 標題文字 */
  title: string
  /** 左側色條 */
  bar: string
  /** 摘要列晶片（未選取） */
  chip: string
  /** 小圓點 */
  dot: string
}

export const TONE_STYLES: Record<BlockTone, ToneStyle> = {
  changping: {
    border: 'border-emerald-800/60',
    headerBg: 'bg-emerald-950/40',
    title: 'text-emerald-300',
    bar: 'bg-emerald-500',
    chip: 'border-emerald-700/60 bg-emerald-950/40 text-emerald-200 hover:bg-emerald-900/50',
    dot: 'bg-emerald-400',
  },
  outsource: {
    border: 'border-sky-800/60',
    headerBg: 'bg-sky-950/40',
    title: 'text-sky-300',
    bar: 'bg-sky-500',
    chip: 'border-sky-700/60 bg-sky-950/40 text-sky-200 hover:bg-sky-900/50',
    dot: 'bg-sky-400',
  },
  inhouse: {
    border: 'border-violet-800/60',
    headerBg: 'bg-violet-950/40',
    title: 'text-violet-300',
    bar: 'bg-violet-500',
    chip: 'border-violet-700/60 bg-violet-950/40 text-violet-200 hover:bg-violet-900/50',
    dot: 'bg-violet-400',
  },
  qc: {
    border: 'border-yellow-700/60',
    headerBg: 'bg-yellow-950/40',
    title: 'text-yellow-300',
    bar: 'bg-yellow-400',
    chip: 'border-yellow-700/60 bg-yellow-950/40 text-yellow-200 hover:bg-yellow-900/50',
    dot: 'bg-yellow-400',
  },
  alert: {
    border: 'border-rose-800/70',
    headerBg: 'bg-rose-950/40',
    title: 'text-rose-300',
    bar: 'bg-rose-500',
    chip: 'border-rose-700/60 bg-rose-950/40 text-rose-200 hover:bg-rose-900/50',
    dot: 'bg-rose-400',
  },
  manual: {
    border: 'border-amber-700/60',
    headerBg: 'bg-amber-950/40',
    title: 'text-amber-300',
    bar: 'bg-amber-500',
    chip: 'border-amber-700/60 bg-amber-950/40 text-amber-200 hover:bg-amber-900/50',
    dot: 'bg-amber-400',
  },
}

/** 各欄放哪些區塊（欄內順序）。1b 同時含常平與委外，依規格 §8「1b 放常平欄頂」（已到台、只差品檢入庫，是最快變成可包的一批） */
const COLUMN_BLOCKS = {
  changping: ['1b', '3', '1', '2'],
  inhouse: ['4', '4x'],
  outsource: ['5c', '5a', '5b'],
} as const satisfies Record<SourceKind, readonly PoolBlockId[]>

/** 跨來源、畫在三欄上方整列寬的區塊（ns：已發單・未上塔台，來源只是推定，放哪一欄都不對） */
export const POOL_WIDE_BLOCKS = ['ns'] as const satisfies readonly PoolBlockId[]
/**
 * 只在 P1 工作台待排池出現的區塊（D66 手動加入 'mn'）：P0 唯讀待排池頁的 API 不產生它，所以不放進三欄或整列區
 * （放進 POOL_WIDE_BLOCKS 會讓 P0 頁多畫一個永遠空的區塊）。工作台側欄自行排在最上面。
 */
export const BOARD_ONLY_POOL_BLOCKS = BOARD_ONLY_BLOCKS

type PlacedBlock = (typeof COLUMN_BLOCKS)[SourceKind][number] | (typeof POOL_WIDE_BLOCKS)[number] | (typeof BOARD_ONLY_BLOCKS)[number]
/** 編譯期防呆：新增 PoolBlockId 卻沒放進任何欄或整列區時，這裡會編譯失敗（否則資料有、畫面不畫） */
const UNPLACED_BLOCKS: Record<Exclude<PoolBlockId, PlacedBlock>, never> = {}
void UNPLACED_BLOCKS

/** 桌機三欄：依來源分組（D21 左半邊「依來源分組的待排池」）。摘要晶片仍依 POOL_BLOCK_ORDER 排。 */
export const POOL_COLUMNS: { id: SourceKind; title: string; sub: string; blocks: PoolBlockId[]; tone: BlockTone }[] = [
  { id: 'changping', title: '常平', sub: 'POC／常平採購（含品檢中）', blocks: [...COLUMN_BLOCKS.changping], tone: 'changping' },
  { id: 'inhouse', title: '自製', sub: '製令 MOT／MOS', blocks: [...COLUMN_BLOCKS.inhouse], tone: 'inhouse' },
  { id: 'outsource', title: '委外', sub: 'MPO／委外採購', blocks: [...COLUMN_BLOCKS.outsource], tone: 'outsource' },
]

/** 來源標籤（卡片上的「常平／委外／自製＋單號」） */
export const SOURCE_STYLES: Record<SourceKind, { label: string; chip: string }> = {
  changping: { label: '常平', chip: 'border-emerald-700/60 bg-emerald-950/50 text-emerald-300' },
  outsource: { label: '委外', chip: 'border-sky-700/60 bg-sky-950/50 text-sky-300' },
  inhouse: { label: '自製', chip: 'border-violet-700/60 bg-violet-950/50 text-violet-300' },
}

/** 狀態徽章配色（文字由 API 的 statusLabel 決定） */
export const STATUS_STYLES: Record<CardStatus, string> = {
  in_transit: 'border-emerald-700/60 bg-emerald-900/30 text-emerald-200',
  qc_pending: 'border-yellow-600/60 bg-yellow-900/30 text-yellow-200',
  ready: 'border-lime-500/70 bg-lime-900/40 text-lime-200',
  not_shipped_urgent: 'border-rose-600/70 bg-rose-900/40 text-rose-200',
  pre_station_running: 'border-violet-600/60 bg-violet-900/40 text-violet-200',
  pre_station_paused: 'border-orange-600/60 bg-orange-900/30 text-orange-200',
  pre_station_finished: 'border-lime-500/70 bg-lime-900/40 text-lime-200',
  no_pre_station: 'border-rose-700/60 bg-rose-950/40 text-rose-200',
  ship_unconfirmed: 'border-rose-600/70 bg-rose-900/40 text-rose-200',
  not_on_sara: 'border-orange-600/60 bg-orange-900/30 text-orange-200',
}

/** 「本卡數量」的稱呼：同一個數字在不同狀態意義不同（在途量／品檢中量／可包量…） */
export const QTY_CARD_LABEL: Record<CardStatus, string> = {
  in_transit: '在途',
  qc_pending: '品檢中',
  ready: '可包',
  not_shipped_urgent: '未寄',
  pre_station_running: '本卡',
  pre_station_paused: '本卡',
  pre_station_finished: '本卡',
  no_pre_station: '本卡',
  ship_unconfirmed: '未出貨',
  not_on_sara: '訂單',
}

/** 危險旗標：紅／橘／灰 */
export const FLAG_STYLES: Record<DangerFlag['level'], string> = {
  danger: 'border-red-500/80 bg-red-600/25 text-red-200 font-semibold',
  warn: 'border-orange-500/70 bg-orange-600/20 text-orange-200',
  info: 'border-slate-600 bg-slate-800/80 text-slate-300',
}

export const FLAG_LEVEL_RANK: Record<DangerFlag['level'], number> = { danger: 0, warn: 1, info: 2 }

/** 前站狀態中文 */
export const PRE_STATUS_LABEL: Record<'finished' | 'running' | 'pause' | 'pending', string> = {
  finished: '已完工',
  running: '進行中',
  pause: '暫停',
  pending: '未開工',
}

export const PRE_STATUS_TEXT: Record<'finished' | 'running' | 'pause' | 'pending', string> = {
  finished: 'text-lime-300',
  running: 'text-violet-300',
  pause: 'text-orange-300',
  pending: 'text-slate-400',
}

/** 摘要列用的區塊短名（完整標題太長，手機一行放不下） */
export const BLOCK_SHORT: Record<PoolBlockId, string> = {
  '3': '常平未寄緊張',
  'ns': '已發單未上塔台',
  '1': '常平運送中',
  '1b': '品檢中',
  '2': '常平可包',
  '4': '製令前站',
  '4x': '無前站待確認',
  '5c': '委外出貨待確認',
  '5a': '委外已出貨',
  '5b': '委外可包',
  'mn': '手動加入',
}

// ── 顯示用格式 ─────────────────────────────────────────────────────────

const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六']

/** 'YYYY-MM-DD' → '10/2(五)'；星期用 UTC 算（字串本身就是台北日曆日，不能再經過本機時區）。
 *  有傳 today 且年份不同時加兩位年份 → '25/4/15(二)'：待排池有跨年的 RO 舊單，只寫 M/D 看不出是哪一年 */
export function fmtShortDate(ymd: string | null, today?: string | null): string {
  if (!ymd) return '—'
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return ymd
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  const yy = today && today.slice(0, 4) !== m[1] ? `${m[1].slice(2)}/` : ''
  return `${yy}${Number(m[2])}/${Number(m[3])}(${WEEKDAY[d.getUTCDay()]})`
}

/** 分鐘 → 「35 分」或「1.5 小時」；null＝工時未知 */
export function fmtMinutes(min: number | null): string {
  if (min == null) return '工時未知'
  if (min < 60) return `${Math.round(min)} 分`
  return `${(min / 60).toFixed(1)} 小時`
}

/** 分鐘 → 小時數字（一位小數），給合計用 */
export function fmtHours(min: number): string {
  return (min / 60).toFixed(1)
}

export function fmtQty(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return n.toLocaleString('zh-TW')
}
