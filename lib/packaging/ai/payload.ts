// 包裝專區 P3 AI 模擬排程 — 送 AI 的去識別化資料（純函式，規格 §4.3、§4.4；D84 白名單、D92 大量門檻）
//
// 最小揭露（D84）：payload 只放 AiCard／AiLine／AiWindowDay 等型別明列的欄位——
//   用「建新物件逐欄複製」實作，**不得 spread 原物件**（PackagingCard 上有 customer、orderRemark、cpShipNote、sources／docNo…）。
//   絕不送：單號本體、客戶名稱、訂單備註、常平出貨備註、單價金額、送貨地址、廠商、sources／docNo、人名、任何未列在白名單的欄位。
//   客戶名 → C01…、SO 行 → K001…（keyMap 只在記憶體；runner 用完即丟，不存 DB、不 log）。
// 為什麼白名單而不是黑名單：黑名單是「列出不能送的，其餘照送」，PackagingCard 將來多一個欄位（例如地址）就會默默外流；
//   白名單是「只送列出來的」，新增欄位預設不出去（盤點 payload.md §2 就找到 8 類 D84 沒列到、但會間接洩漏的欄位）。
// 品名／包裝方式是 ERP 自由文字 → 截短之外再做遮罩（8 位以上數字、email、電話、客戶名稱），截短不能取代掃描。
//   遮罩前先 NFKC 正規化（全形 ＠．０-９ → 半形），電話除了固定格式，也認「數字之間夾空白／點／連字號、合計 ≥ 7 位」的寫法
//   （審查驗證 mask-probe2：02 2345 6789、2345-6789、0912.345.678、abc＠gmail.com、138 1234 5678 原本都漏）。
//   包裝方式另外在「送至／寄到／自取／門市／地址」或街路名（路、街、巷、弄）處截斷：盤點發現有 5 張卡結尾是同一個「○光街」
//   （疑似出貨地點混進包裝欄，D84 不送送貨地址；待 Snow 確認前先保守截掉）。
// 規則文字（主管寫的）送出前也去識別化：提到的客戶名稱換成本次的 C 代號、SO 單號換成 K 代號（這批沒有的換成 #）——
//   AI 對得上卡片的 c／k 欄位照樣能執行「某客戶排某線」，而客戶全名、單號不會以明文送出（D84）。
// 送出前的最後一道（fail-closed）：scanPayloadLeaks 對自由文字欄位再掃一次（email、電話、SO 單號、本批客戶名），
//   命中就不送（runner 把 run 標成 ai_pii_blocked，只記欄位、不記內容；payload 也不存）。
//
// 硬規則：不 import supabase、不讀時鐘、相對路徑 import、不用 enum。
// 品類：lib/packaging/stdTime.ts 的 matchCategory 需要 DB 的 packagingOps 表 → 這裡改用同一份 CATEGORY_RULES 與 productNameCandidates
//   依序比對取 rule.label（與 matchCategory 同順序）；判不出用 card.work.baseOps[0].opName 去掉「常規包裝/」前綴；都沒有 '未分類'。
//   （stdTime.ts 對 supabase 只有 import type，純函式檔 import 它不會拉進 DB client。）

import type { BoardCard, PackagingLine, YMD } from '../scheduleTypes'
import type { PackagingCard } from '../types'
import { CATEGORY_RULES, packingMethodText, productNameCandidates } from '../stdTime'
import { isPlaceableBlock, lineSupply, minutesForQty, r3 } from '../scheduleAllocate'
import { isValidYmd, isWeekend, weekdayOf } from '../scheduleCalendar'
import { laneStopped } from '../scheduleLines'
import { workdaysBetween } from '../workdays'
import { isOrderLocked, isRowLocked, soNumberOf } from './simState'
import {
  AI_MAX_CANDIDATES,
  AI_PAYLOAD_TEXT_MAX,
  type AiCard,
  type AiKeyMap,
  type AiLine,
  type AiLineDay,
  type AiNowSlot,
  type AiPayload,
  type AiPayloadBuild,
  type AiPayloadInput,
  type AiPayloadMeta,
  type AiSoPrefix,
  type AiSource,
  type AiUnknownMinutes,
  type AiWindowDay,
  type BulkDecision,
  type BulkThreshold,
  type SimPlacement,
} from './types'

const EPS = 1e-9
const round1 = (x: number): number => Math.round(x * 10) / 10
const round4 = (x: number): number => Math.round(x * 10000) / 10000
/** 品類字串上限（來自內部工序表，不是客戶資料；只是防呆） */
const CAT_MAX = 30
/** 客戶名稱遮罩：本卡自己的客戶 ≥ 2 字、其他客戶 ≥ 3 字才比對（太短的名字容易誤遮一般字詞） */
const OWN_CUSTOMER_MIN = 2
const ANY_CUSTOMER_MIN = 3

// ─────────────────────────────────────────────────────────────────────
// 文字遮罩（§4.3）
// ─────────────────────────────────────────────────────────────────────

/** 品名前綴（同 stdTime.productNameCandidates）：「打樣 /」「客製 |」 */
const NAME_PREFIX_RE = /^\s*(打樣\s*[/／]\s*)?(客製\s*[|｜]\s*)?/
/** email：只吃 ASCII（包裝方式經 packingMethodText 會去掉空白，「客服abc@x.com」不能連中文一起吃掉） */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*/g
/** 台灣手機：09xx-xxx-xxx、0912 345 678、+886 912…、886-9… */
const MOBILE_RE = /(?:\+?886[-\s]?|0)9\d{2}[-\s]?\d{3}[-\s]?\d{3}/g
/** 市話：(02)2345-6789、(04) 2345 6789 */
const PAREN_PHONE_RE = /\(0\d{1,2}\)\s*\d{3,4}[-\s]?\d{4}/g
/** 市話：02-2345-6789、04-23456789 */
const DASH_PHONE_RE = /(?<!\d)0\d{1,2}-\d{3,4}-?\d{3,4}(?!\d)/g
/** 國際格式市話：+886-2-2345-6789 */
const INTL_PHONE_RE = /\+886[-\s]?\d{1,2}[-\s]?\d{3,4}[-\s]?\d{4}/g
/** 8 位以上連續數字（統編、電話、單號、順豐單號…） */
const LONG_DIGITS_RE = /\d{8,}/g
/**
 * 以空白、點、連字號分隔的數字串（電話常見寫法：02 2345 6789、2345-6789、0912.345.678、138 1234 5678）：
 * 數字合計 ≥ SEP_DIGITS_MIN 位就整段遮掉。連續 7 位（沒有分隔）不遮——那是數量或型號的機率高，8 位以上才由 LONG_DIGITS_RE 遮。
 */
const SEP_DIGITS_RE = /(?<!\d)\d+(?:[ .-]\d+)+(?!\d)/g
const SEP_DIGITS_MIN = 7
const maskSepDigits = (t: string): string => t.replace(SEP_DIGITS_RE, (m) => (m.replace(/\D/g, '').length >= SEP_DIGITS_MIN ? '#' : m))

/** 全形數字 → 半形（「０９１２…」也要遮得到；NFKC 已涵蓋，保留當第二道） */
const halfWidthDigits = (s: string): string => s.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
/** 相容字正規化：全形英數與符號（＠．－０-９Ａ-Ｚ）→ 半形，遮罩與掃描才認得「abc＠gmail.com」「０９１２．３４５」 */
const normText = (s: string): string => halfWidthDigits(s.normalize('NFKC'))

/** 包裝方式裡的出貨／取貨指示（出現就從那裡截斷） */
const DELIVERY_WORD_RE = /送至|送到|寄至|寄到|寄送|自取|門市|地址/
/** 街路名（出現就連同前面的路名一起截斷；路名多為 2 字，前面 6 字內有「送／寄」就從「送／寄」開始截） */
const STREET_RE = /[路街巷弄]/
const STREET_NAME_BACK = 2

/**
 * 包裝方式的出貨地點防線（盤點 payload.md 建議；「○光街」待 Snow 確認前先保守處理）：
 * 從最早出現的出貨指示詞或街路名處截斷，截掉的部分以 '#' 表示（讓 AI 知道後面還有內容，但看不到）。
 */
export function cutDeliveryText(t: string): string {
  let cut = t.search(DELIVERY_WORD_RE)
  const st = t.search(STREET_RE)
  if (st >= 0) {
    const from = Math.max(0, st - 6)
    const before = t.slice(from, st)
    const sj = Math.max(before.lastIndexOf('送'), before.lastIndexOf('寄'))
    const c = sj >= 0 ? from + sj : Math.max(0, st - STREET_NAME_BACK)
    cut = cut < 0 ? c : Math.min(cut, c)
  }
  if (cut < 0) return t
  const head = t.slice(0, cut).trimEnd()
  return head ? `${head}#` : '#'
}

/** 以字元（code point）截斷，不切壞 surrogate pair */
const cutChars = (s: string, max: number): string => {
  const chars = Array.from(s)
  return chars.length > max ? chars.slice(0, max).join('') : s
}

/**
 * 遮罩核心：NFKC 正規化 → 去「-||-」後的品名備註 → （可選）去品名前綴 → 空白正規化 →（可選）出貨地點截斷 → 客戶名稱 → email →
 * 電話（固定格式 → 分隔數字串 ≥ 7 位）→ 8 位以上數字 → 截斷。
 * terms：要換成 '#' 的字串（客戶名稱；由長到短先換，避免短名把長名切一半；一樣先 NFKC）。
 */
function maskCore(
  s: string | null | undefined,
  max: number,
  opts: { stripPrefix: boolean; terms?: readonly string[]; cutDelivery?: boolean },
): string {
  if (s == null) return ''
  let t = normText(String(s)).split('-||-')[0]
  if (opts.stripPrefix) t = t.replace(NAME_PREFIX_RE, '')
  t = t.replace(/\s+/g, ' ').trim()
  if (opts.cutDelivery) t = cutDeliveryText(t)
  for (const raw of opts.terms ?? []) {
    const term = raw ? normText(raw) : ''
    if (term && t.includes(term)) t = t.split(term).join('#')
  }
  t = maskSepDigits(t
    .replace(EMAIL_RE, '#')
    .replace(INTL_PHONE_RE, '#')
    .replace(MOBILE_RE, '#')
    .replace(PAREN_PHONE_RE, '#')
    .replace(DASH_PHONE_RE, '#'))
    .replace(LONG_DIGITS_RE, '#')
  return cutChars(t, Math.max(0, max)).trim()
}

/**
 * 遮罩＋截斷（§4.3）：先去品名前綴（「打樣/」「客製|」等，同 stdTime.productNameCandidates 的前綴規則）與「-||-」後的品名備註，
 * 把 8 位以上連續數字、email 樣式、電話樣式（含 09xx-xxx-xxx、(02)xxxx-xxxx、+886…、以空白／點／連字號分隔合計 ≥ 7 位的數字串）
 * 一律換成 '#'，再取前 max 字（以字元計，不切壞 surrogate）。全形字先轉半形（NFKC）。null／undefined → ''。
 */
export function maskText(s: string | null | undefined, max: number): string {
  return maskCore(s, max, { stripPrefix: true })
}

/** 卡片品類（見檔頭「品類」）：CATEGORY_RULES label → baseOps[0].opName 去「常規包裝/」→ '未分類' */
export function cardCategory(card: Pick<PackagingCard, 'itemName' | 'work'>): string {
  for (const text of productNameCandidates(card.itemName ?? '')) {
    if (!text) continue
    for (const rule of CATEGORY_RULES) {
      if (rule.match.every((re) => re.test(text))) return rule.label
    }
  }
  const op = card.work?.baseOps?.[0]?.opName?.trim() ?? ''
  const cat = op.replace(/^常規包裝(?:\+[^/]*)?\//, '').trim()
  return cat ? cutChars(cat, CAT_MAX) : '未分類'
}

/**
 * 大量判定（§4.4，D92）：threshold 依序取「門檻表 key 完全等於品類」→「品名包含 key（取最長 key；同長取字典序小）」→ 無。
 * bulk＝qty ≥ threshold；無門檻 → { bulk: false, thresholdKey: null, threshold: null }（呼叫端把品類記進 noThresholdCategories）。
 */
export function buildBulkFlag(cat: string, itemName: string | null, qty: number, thresholds: readonly BulkThreshold[]): BulkDecision {
  const c = (cat ?? '').trim()
  let hit: BulkThreshold | null = thresholds.find((t) => t.key.trim() === c) ?? null
  if (!hit) {
    const name = itemName ?? ''
    for (const t of thresholds) {
      const k = t.key.trim()
      if (!k || !name.includes(k)) continue
      const best = hit ? hit.key.trim() : null
      const kl = Array.from(k).length
      const bl = best ? Array.from(best).length : -1
      if (!best || kl > bl || (kl === bl && k < best)) hit = t
    }
  }
  if (!hit) return { bulk: false, thresholdKey: null, threshold: null }
  return { bulk: qty >= hit.threshold, thresholdKey: hit.key.trim(), threshold: hit.threshold }
}

/** 單號前綴：SO 單號（大寫）以 'SOB' 開頭 → 'SOB'；以 'SO' 開頭 → 'SO'；其他 'OTHER'（不送單號本體） */
export function soPrefixOf(so: string): AiSoPrefix {
  const s = (so ?? '').trim().toUpperCase()
  if (s.startsWith('SOB')) return 'SOB'
  if (s.startsWith('SO')) return 'SO'
  return 'OTHER'
}

/** 來源：card.sourceKind 直接對應（changping／outsource／inhouse） */
export function sourceOf(card: Pick<PackagingCard, 'sourceKind'>): AiSource {
  return card.sourceKind === 'changping' || card.sourceKind === 'outsource' ? card.sourceKind : 'inhouse'
}

/**
 * 把 AI 文字裡的代號換回（D84「回來後系統換回」；summary、reason、warnings 顯示前用）：
 * K\d{3,} → keyMap.cardToLine（對不到保留原字）；C\d{2,} → keyMap.customerByCode（對不到保留原字）。
 * 以完整單字比對（前後不是英數字），不要把 'SOK0012' 之類的字串切壞。
 */
export function decodeAiText(text: string, keyMap: AiKeyMap): string {
  if (!text) return ''
  return String(text).replace(/(?<![A-Za-z0-9])([KC])(\d+)(?![A-Za-z0-9])/g, (m: string, kind: string, digits: string) => {
    if (kind === 'K' && digits.length >= 3) return keyMap.cardToLine.get(m) ?? m
    if (kind === 'C' && digits.length >= 2) return keyMap.customerByCode.get(m) ?? m
    return m
  })
}

// ─────────────────────────────────────────────────────────────────────
// 規則文字去識別化與送出前掃描（D84）
// ─────────────────────────────────────────────────────────────────────

/**
 * 規則文字、掃描用的客戶名稱最短字數（2 字的名字太容易撞到一般詞，例如「統一」「全家」會把規則句子改壞）。
 * 只比對「客戶全名」（與品名遮罩同一份名單）：AI 的規則修改建議換回的就是全名，主管照抄進規則時會被換掉。
 * 不比對自行推的簡稱（去「股份有限公司」等）：簡稱很容易就是品類詞（例如客戶「壓克力工作室」→「壓克力」），
 * 會把「C 線以壓克力為主」改壞、讓排程照錯的規則走。主管自己打的簡稱不在防線內（已列為待 Snow 確認）。
 */
const RULE_CUSTOMER_MIN = 3

/** 規則比對用的客戶名稱（NFKC 後、≥ RULE_CUSTOMER_MIN 字；太短回空陣列） */
function customerAliases(name: string): string[] {
  const n = normText(name).trim()
  return Array.from(n).length >= RULE_CUSTOMER_MIN ? [n] : []
}

/** SO／SOB／RO 單號（可帶「-行號」）；前後不是英數字 */
const RULE_SO_RE = /(?<![A-Za-z0-9])((?:SOB?|RO)\d{6,})(?:-(\d{1,4}))?(?![A-Za-z0-9])/gi

/**
 * 規則文字去識別化（D84：規則是主管的自由文字，可能寫到客戶名稱或單號）：
 * - SO 單號（SO260901001、SO260901001-1）→ 這批對應的 K 代號（整張單＝該單所有送出的行，用「、」連接）；這批沒有 → '#'
 * - 客戶名稱（全名，≥ 3 字；長的先換）→ 本次的 C 代號；這批沒有這位客戶 → '#'
 * 規則的其他文字原樣保留（全形轉半形）；AI 看得到「C03 的急單排 C 線」，對照卡片 c 欄位就能照做，但看不到客戶全名。
 * 為什麼換成「本次」代號而不是固定代號：代號每次重編（最小揭露）；主管在規則裡照樣寫客戶名稱，每次送出前再換。
 */
export function deidentifyRules(
  text: string,
  opts: {
    customerNames: Iterable<string>
    codeOfCustomer: (name: string) => string | null
    kCodesOfOrder: (soNumber: string) => string[]
    kCodeOfLine: (soLineKey: string) => string | null
  },
): string {
  if (!text) return ''
  let t = normText(text)
  t = t.replace(RULE_SO_RE, (_m: string, so: string, line: string | undefined) => {
    const soU = so.toUpperCase()
    if (line) {
      const k = opts.kCodeOfLine(`${soU}-${line}`)
      if (k) return k
    }
    const ks = opts.kCodesOfOrder(soU)
    return ks.length > 0 ? ks.join('、') : '#'
  })
  const terms: { term: string; code: string }[] = []
  for (const name of opts.customerNames) {
    const code = opts.codeOfCustomer(name) ?? '#'
    for (const a of customerAliases(name)) terms.push({ term: a, code })
  }
  terms.sort((a, b) => b.term.length - a.term.length || (a.term < b.term ? -1 : 1))
  for (const { term, code } of terms) if (t.includes(term)) t = t.split(term).join(code)
  return t
}

/** 送出前掃描用（與遮罩同一套規則；日期 YYYY-MM-DD 等先拿掉，不當成電話） */
const SCAN_EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/
const SCAN_SO_RE = /(?<![A-Za-z0-9])(?:SOB?|RO)\d{6,}/i
const SCAN_DATE_RE = /(?<!\d)\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?!\d)/g
/** 固定格式的電話 regex（遮罩用的帶 g 旗標，lastIndex 會殘留 → 掃描用不帶 g 的複本） */
const SCAN_FIXED_PHONE_RES = [INTL_PHONE_RE, MOBILE_RE, PAREN_PHONE_RE, DASH_PHONE_RE].map((re) => new RegExp(re.source))

/**
 * sepDigits：也檢查「分隔數字串 ≥ 7 位」（只對卡片欄位——它們已用同一條規則遮過，命中＝遮罩出錯）。
 * 規則、門檻、產線名稱不檢查這一條：主管寫「1000-2000 件放 A 線」這種數量範圍很正常，會被誤判成電話而整次停掉；
 * 這些欄位只認固定格式的電話（09 開頭手機、0 開頭市話、+886）與 8 位以上連續數字。
 */
function textLooksPersonal(raw: string, names: readonly string[], sepDigits: boolean): boolean {
  const t = normText(raw)
  if (SCAN_EMAIL_RE.test(t) || SCAN_SO_RE.test(t)) return true
  const noDates = t.replace(SCAN_DATE_RE, ' ')
  if (SCAN_FIXED_PHONE_RES.some((re) => re.test(noDates))) return true
  if (/\d{8,}/.test(noDates)) return true
  if (sepDigits) {
    for (const m of noDates.matchAll(SEP_DIGITS_RE)) if (m[0].replace(/\D/g, '').length >= SEP_DIGITS_MIN) return true
  }
  return names.some((n) => n && t.includes(n))
}

/**
 * 送出前的最後一道檢查（fail-closed；盤點 payload.md §5 第 4 點）：對 payload 的自由文字欄位再掃一次——
 * 卡片 name／pack／cat、規則、門檻 key、產線名稱；找 email、電話樣式、SO 單號、本批客戶名稱
 * （卡片欄位：本卡客戶 ≥ 2 字、任一客戶全名 ≥ 3 字，與遮罩同標準；規則：全名 ≥ 3 字，與 deidentifyRules 同標準）。
 * 回傳命中的欄位（例：「K003 品名」「規則文字」），**不含內容**；空陣列＝可以送。
 * 正常情況遮罩已處理過 → 應該永遠是空的；命中代表遮罩漏了新的寫法，寧可不送（runner 標 ai_pii_blocked）。
 */
export function scanPayloadLeaks(payload: AiPayload, keyMap: Pick<AiKeyMap, 'customerByCode'>): string[] {
  const hits: string[] = []
  const batchNames = [...keyMap.customerByCode.values()].map((n) => normText(n).trim()).filter(Boolean)
  const anyFull = batchNames.filter((n) => Array.from(n).length >= RULE_CUSTOMER_MIN)
  const anyAlias = [...new Set(batchNames.flatMap(customerAliases))]
  for (const c of payload.cards ?? []) {
    const own = c.c ? normText(keyMap.customerByCode.get(c.c) ?? '').trim() : ''
    const names = own && Array.from(own).length >= 2 ? [own, ...anyFull] : anyFull
    if (textLooksPersonal(c.name ?? '', names, true)) hits.push(`${c.k} 品名`)
    if (textLooksPersonal(c.pack ?? '', names, true)) hits.push(`${c.k} 包裝方式`)
    if (textLooksPersonal(c.cat ?? '', anyFull, false)) hits.push(`${c.k} 品類`)
  }
  if (textLooksPersonal(payload.rules ?? '', anyAlias, false)) hits.push('規則文字')
  const ths = payload.thresholds ?? []
  for (let i = 0; i < ths.length; i++) if (textLooksPersonal(ths[i].key, anyFull, false)) hits.push(`門檻表第 ${i + 1} 列`)
  for (const l of payload.lines ?? []) if (textLooksPersonal(l.name, anyFull, false)) hits.push(`產線 ${l.code} 名稱`)
  return hits
}

// ─────────────────────────────────────────────────────────────────────
// 組 payload（§4.3）
// ─────────────────────────────────────────────────────────────────────

/** 候選（一個 SO 行）的中間資料；只在本檔內用，送出前逐欄轉成 AiCard */
interface Candidate {
  key: string
  rep: PackagingCard
  customer: string | null
  sample: boolean
  movable: number
  ready: number
  readyDay: number | 'after' | 'unknown' | undefined
  due: number | null
  min: number
  perUnit: number
  sims: SimPlacement[]
  lockedQty: number
}

const byDueThenKey = (a: { due: number | null; key: string }, b: { due: number | null; key: string }): number => {
  if (a.due !== b.due) {
    if (a.due == null) return 1
    if (b.due == null) return -1
    return a.due - b.due
  }
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
}

/** 代表卡：可排卡中 qtyCard 最大（平手 cardId 小）——品名、客戶、交期、來源取它（同一 SO 行都一樣，取一張穩定的） */
function representativeCard(cards: readonly PackagingCard[]): PackagingCard {
  const placeable = cards.filter((c) => isPlaceableBlock(c.block))
  const list = placeable.length > 0 ? placeable : cards
  let best = list[0]
  for (const c of list) {
    if (c.qtyCard > best.qtyCard + EPS || (Math.abs(c.qtyCard - best.qtyCard) <= EPS && c.cardId < best.cardId)) best = c
  }
  return best
}

/**
 * 組 payload（§4.3）。步驟：
 * 1. 候選單位＝SO 行（soLineKey）。候選條件（全部成立）：
 *    - 該行在待排池有可排區塊的卡（scheduleAllocate.isPlaceableBlock）且可排供給 > 0
 *    - 可動量 > 0；可動量＝board 剩餘待排池量（board.pool.cardMeta 各可排卡 remainingQty 加總）＋範圍內「未鎖定」模擬列的有效量
 *    - 所屬訂單未被鎖（simState.isOrderLocked）
 *    - 工時已知（perUnit 非 null）；工時未知 → 不當候選，計入 meta.unknownMinutes（只給張數與品類，預設第 7 點）
 * 2. 每張卡欄位（型別 AiCard，只准這些）：k、c、pre、src、cat、name、pack、qty、ready、readyDay、due、min、perUnit、sample、bulk、now、lockedQty。
 *    - ready：board 待排池剩餘卡的可包量（assembleBoard 已扣掉已排量）＋未鎖定模擬列分到的可包量
 *    - readyDay：未就緒部分（剩餘卡的未就緒量、模擬列的預排量）最晚的預估可包日 → 窗內第一個 ≥ 它的 day；窗外 'after'；
 *      任何一段可包日未知 'unknown'；全就緒省略。取「最晚」是保守解讀（D22 以分到的未就緒片中最晚的日期檢查）。
 *    - due：dueDate 到 today 的剩餘台灣工作日（workdays.ts workdaysBetween；負＝逾期）；交期未知 null
 *    - min：可動量的標準工時（scheduleAllocate.minutesForQty(perUnit, qty)；有覆寫的模擬列那部分用它的覆寫工時）
 *    - now：copy 模式下該行在窗內的模擬列 [{ day, line(代碼), qty, order(同日同線 1 起), locked }]；沒有省略
 *    - lockedQty：該行被鎖的模擬列量（card／line 鎖）；0 省略
 *    - bulk：buildBulkFlag(cat, 品名, qty, thresholds).bulk（§4.4）；沒有門檻的品類記進 meta.noThresholdCategories
 * 3. window：session.windowDates → [{ day: 1…, date, weekday, weekend }]。
 *    lines：session.lineIds 中啟用的線依 sort_order → [{ code, name, locked, days: [{ day, regularMin, overtimeMin, fixedMin, stopped }] }]；
 *    regular／overtime 取 board.days[].lanes[].capacity（unset → 0 且 stopped）；fixedMin＝該 lane usedMinutes − 同線同日「會被 AI 重排的模擬列」工時
 *    （＝已完成＋鎖定＋範圍外無關者＋沒送給 AI 的行的佔用；validate 會保留後者）；stopped＝scheduleLines.laneStopped。
 * 4. thresholds：[{ key, threshold }]（不含備註與人名）；rules：全文；unknownMinutes；today；mode；horizon。
 * 5. 候選 > AI_MAX_CANDIDATES（400）：依（逾期優先 → due 升冪 → soLineKey）取前 400，其餘記 meta.notSent／notSentKeys（不得默默截斷）。
 * 6. 代號：卡依（due 升冪、soLineKey）編 K001…；客戶依第一次出現順序編 C01…（同名同代號；null 客戶 → c: null）。
 * 輸出須穩定（同樣輸入 → 同樣 JSON），方便測試與比對。
 */
export function buildAiPayload(input: AiPayloadInput): AiPayloadBuild {
  const { today, session, board, pool, lines, thresholds } = input
  const windowDates = [...session.windowDates]
  const locks = session.locks
  const lineById = new Map(lines.map((l) => [l.id, l]))

  // ── 原料索引 ──
  const cardsByLine = new Map<string, PackagingCard[]>()
  const customerNames = new Set<string>()
  for (const b of pool.blocks) for (const c of b.cards) {
    let arr = cardsByLine.get(c.soLineKey)
    if (!arr) { arr = []; cardsByLine.set(c.soLineKey, arr) }
    arr.push(c)
    const cn = (c.customer ?? '').trim()
    if (cn) customerNames.add(cn)
  }
  /** board 待排池（已扣掉已排量）：可排卡的剩餘量與剩餘可包量 */
  const boardPoolByLine = new Map<string, PackagingCard[]>()
  for (const b of board.pool.blocks) for (const c of b.cards) {
    if (!isPlaceableBlock(c.block)) continue
    let arr = boardPoolByLine.get(c.soLineKey)
    if (!arr) { arr = []; boardPoolByLine.set(c.soLineKey, arr) }
    arr.push(c)
  }
  /** 組合工作台上每張卡：日期、同日同線第幾張（1 起，含正式區唯讀卡） */
  const boardCards = new Map<string, { card: BoardCard; date: YMD; order: number }>()
  const boardDayByDate = new Map(board.days.map((d) => [d.date, d]))
  for (const d of board.days) {
    const laneCount = new Map<number | null, number>()
    for (const c of d.cards) {
      const lane = c.laneId ?? null
      const n = (laneCount.get(lane) ?? 0) + 1
      laneCount.set(lane, n)
      boardCards.set(c.placementId, { card: c, date: d.date, order: n })
    }
  }
  const simByLine = new Map<string, SimPlacement[]>()
  for (const s of session.placements) {
    let arr = simByLine.get(s.soLineKey)
    if (!arr) { arr = []; simByLine.set(s.soLineKey, arr) }
    arr.push(s)
  }
  const dayOf = new Map(windowDates.map((d, i) => [d, i + 1]))
  const readyDayOf = (latest: YMD): number | 'after' => {
    const idx = windowDates.findIndex((d) => d >= latest)
    return idx < 0 ? 'after' : idx + 1
  }

  // ── 1. 候選 ──
  const candidates: Candidate[] = []
  const unknownByCat = new Map<string, number>()
  let unknownCount = 0
  for (const key of [...cardsByLine.keys()].sort()) {
    const cards = cardsByLine.get(key)!
    if (!cards.some((c) => isPlaceableBlock(c.block))) continue
    const supply = lineSupply(key, cards)
    if (supply.total <= EPS) continue
    if (isOrderLocked(key, locks)) continue

    const sims = (simByLine.get(key) ?? []).slice()
    const unlocked = sims.filter((s) => !isRowLocked(s, locks))
    const locked = sims.filter((s) => isRowLocked(s, locks))

    let movable = 0
    let ready = 0
    /** 未就緒部分：任何一段可包日未知 → unknown；否則取最晚的預估可包日 */
    const unready: { unknown: boolean; latest: YMD | null } = { unknown: false, latest: null }
    const noteUnready = (d: YMD | null) => {
      if (d == null) unready.unknown = true
      else if (unready.latest == null || d > unready.latest) unready.latest = d
    }
    for (const c of cards) {
      if (!isPlaceableBlock(c.block)) continue
      movable += board.pool.cardMeta[c.cardId]?.remainingQty ?? 0
    }
    for (const c of boardPoolByLine.get(key) ?? []) {
      const rq = Math.min(Math.max(0, c.qtyReady), Math.max(0, c.qtyCard))
      ready += rq
      if (c.qtyCard - rq > EPS) noteUnready(c.estReadyDate ?? null)
    }
    let overrideMin = 0
    let overrideQty = 0
    for (const s of unlocked) {
      const bc = boardCards.get(s.id)?.card
      const eff = bc ? bc.effectiveQty : s.qty
      movable += eff
      if (bc) {
        const rq = Math.min(bc.readyQty, eff)
        ready += rq
        if (eff - rq > EPS) noteUnready(bc.readiness === 'pre' ? bc.preReadyDate : null)
      } else if (eff > EPS) {
        noteUnready(null) // 不在工作台視窗內（開／關加班改了視窗）→ 就緒狀態不明，保守當未知
      }
      if (s.estMinutesOverride != null && eff > EPS) {
        overrideQty += eff
        overrideMin += bc?.minutes ?? (s.qty > 0 ? (s.estMinutesOverride * eff) / s.qty : 0)
      }
    }
    movable = r3(movable)
    ready = r3(Math.min(ready, movable))
    if (movable <= EPS) continue

    const rep = representativeCard(cards)
    if (supply.perUnit == null) {
      unknownCount++
      const cat = cardCategory(rep)
      unknownByCat.set(cat, (unknownByCat.get(cat) ?? 0) + 1)
      continue
    }

    let readyDay: Candidate['readyDay']
    if (movable - ready > EPS) {
      if (unready.unknown) readyDay = 'unknown'
      else if (unready.latest != null) readyDay = readyDayOf(unready.latest)
    }
    const dueDate = rep.dueDate ?? cards.find((c) => c.dueDate)?.dueDate ?? null
    const rest = r3(movable - overrideQty)
    const min = round1(overrideMin + (rest > EPS ? (minutesForQty(supply.perUnit, rest) ?? 0) : 0))
    candidates.push({
      key,
      rep,
      customer: (rep.customer ?? cards.find((c) => c.customer)?.customer ?? '').trim() || null,
      sample: cards.some((c) => c.sample?.isSample),
      movable,
      ready,
      readyDay,
      // + 0：workdaysBetween 往前數 0 天會回 -0（JSON 看不出來，但 Object.is 比較會不同）
      due: dueDate && isValidYmd(dueDate) ? workdaysBetween(today, dueDate) + 0 : null,
      min,
      perUnit: round4(supply.perUnit),
      sims,
      lockedQty: r3(locked.reduce((s, p) => s + p.qty, 0)),
    })
  }

  // ── 5. 上限 ──
  candidates.sort(byDueThenKey)
  const sent = candidates.slice(0, AI_MAX_CANDIDATES)
  const notSentKeys = candidates.slice(AI_MAX_CANDIDATES).map((c) => c.key)
  const sentKeys = new Set(sent.map((c) => c.key))

  // ── 6. 代號＋ 2. 逐欄組卡 ──
  const keyMap: AiKeyMap = { cardToLine: new Map(), lineToCard: new Map(), customerByCode: new Map() }
  const codeByCustomer = new Map<string, string>()
  const anyCustomerTerms = [...customerNames].filter((n) => Array.from(n).length >= ANY_CUSTOMER_MIN)
  const noThreshold = new Set<string>()
  const cards: AiCard[] = sent.map((cand, i) => {
    const k = `K${String(i + 1).padStart(3, '0')}`
    keyMap.cardToLine.set(k, cand.key)
    keyMap.lineToCard.set(cand.key, k)
    let c: string | null = null
    if (cand.customer) {
      c = codeByCustomer.get(cand.customer) ?? null
      if (!c) {
        c = `C${String(codeByCustomer.size + 1).padStart(2, '0')}`
        codeByCustomer.set(cand.customer, c)
        keyMap.customerByCode.set(c, cand.customer)
      }
    }
    // 客戶名稱若出現在品名／包裝方式（自由文字）裡也遮掉：本卡客戶 ≥ 2 字、其他客戶 ≥ 3 字；長的先換
    const terms = [...new Set([
      ...(cand.customer && Array.from(cand.customer).length >= OWN_CUSTOMER_MIN ? [cand.customer] : []),
      ...anyCustomerTerms,
    ])].sort((a, b) => b.length - a.length || (a < b ? -1 : 1))
    const cat = cardCategory(cand.rep)
    const bulk = buildBulkFlag(cat, cand.rep.itemName, cand.movable, thresholds)
    if (bulk.thresholdKey == null) noThreshold.add(cat)

    // 白名單逐欄建立（不得 spread 原物件）
    const card: AiCard = {
      k,
      c,
      pre: soPrefixOf(cand.rep.so),
      src: sourceOf(cand.rep),
      cat,
      name: maskCore(cand.rep.itemName, AI_PAYLOAD_TEXT_MAX, { stripPrefix: true, terms }),
      pack: maskCore(packingMethodText(cand.rep.packing), AI_PAYLOAD_TEXT_MAX, { stripPrefix: false, terms, cutDelivery: true }),
      qty: cand.movable,
      ready: cand.ready,
      due: cand.due,
      min: cand.min,
      perUnit: cand.perUnit,
      sample: cand.sample,
      bulk: bulk.bulk,
    }
    if (cand.readyDay !== undefined) card.readyDay = cand.readyDay
    if (session.mode === 'copy') {
      const now: AiNowSlot[] = []
      for (const s of [...cand.sims].sort((a, b) => (a.planDate < b.planDate ? -1 : a.planDate > b.planDate ? 1 : a.lineId - b.lineId))) {
        const day = dayOf.get(s.planDate)
        const line = lineById.get(s.lineId)
        if (day == null || !line) continue
        const bc = boardCards.get(s.id)
        now.push({ day, line: line.code, qty: r3(bc ? bc.card.effectiveQty : s.qty), order: bc?.order ?? 1, locked: isRowLocked(s, locks) })
      }
      if (now.length > 0) card.now = now
    }
    if (cand.lockedQty > EPS) card.lockedQty = cand.lockedQty
    return card
  })

  // ── 3. 窗與線 ──
  const window: AiWindowDay[] = windowDates.map((date, i) => ({ day: i + 1, date, weekday: weekdayOf(date), weekend: isWeekend(date) }))
  /** 會被 AI 重排（validate 步驟 2 會移除）的模擬列：未鎖定、且該行有送給 AI */
  const replanIds = new Set(session.placements.filter((s) => !isRowLocked(s, locks) && sentKeys.has(s.soLineKey)).map((s) => s.id))
  const lockedLineSet = new Set(locks.lineIds)
  const aiLines: AiLine[] = session.lineIds
    .map((id) => lineById.get(id))
    .filter((l): l is PackagingLine => !!l && l.active)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
    .map((l) => ({
      code: l.code,
      name: l.name,
      locked: lockedLineSet.has(l.id),
      days: windowDates.map((date, i): AiLineDay => {
        const bd = boardDayByDate.get(date)
        const lane = bd?.lanes?.find((x) => x.lineId === l.id)
        if (!bd || !lane) return { day: i + 1, regularMin: 0, overtimeMin: 0, fixedMin: 0, stopped: true }
        const cap = lane.capacity
        const replanMin = bd.cards
          .filter((c) => c.laneId === l.id && replanIds.has(c.placementId))
          .reduce((s, c) => s + (c.minutes ?? 0), 0)
        return {
          day: i + 1,
          regularMin: cap.regularMinutes ?? 0,
          overtimeMin: cap.overtimeMinutes,
          fixedMin: round1(Math.max(0, lane.usedMinutes - replanMin)),
          stopped: cap.regularMinutes == null || laneStopped(cap),
        }
      }),
    }))

  const unknownMinutes: AiUnknownMinutes = {
    count: unknownCount,
    categories: [...unknownByCat.entries()]
      .map(([cat, count]) => ({ cat, count }))
      .sort((a, b) => b.count - a.count || (a.cat < b.cat ? -1 : a.cat > b.cat ? 1 : 0)),
  }

  const payload: AiPayload = {
    today,
    mode: session.mode,
    horizon: session.horizon,
    window,
    lines: aiLines,
    cards,
    thresholds: thresholds
      .map((t) => ({ key: t.key, threshold: t.threshold }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
    // 規則文字去識別化：客戶名 → 本次 C 代號、單號 → K 代號（這批沒有 → #）
    rules: deidentifyRules(input.rules ?? '', {
      customerNames,
      codeOfCustomer: (name) => codeByCustomer.get(name) ?? null,
      kCodesOfOrder: (so) => sent.filter((c) => soNumberOf(c.key) === so).map((c) => keyMap.lineToCard.get(c.key) ?? '').filter(Boolean),
      kCodeOfLine: (key) => {
        const hit = sent.find((c) => c.key.trim().toUpperCase() === key)
        return hit ? keyMap.lineToCard.get(hit.key) ?? null : null
      },
    }),
    unknownMinutes,
  }
  const meta: AiPayloadMeta = {
    candidateCount: candidates.length,
    sentCount: sent.length,
    notSent: notSentKeys.length,
    notSentKeys,
    unknownMinutes: { count: unknownMinutes.count, categories: unknownMinutes.categories.map((x) => ({ ...x })) },
    noThresholdCategories: [...noThreshold].sort(),
  }
  return { payload, keyMap, meta }
}
