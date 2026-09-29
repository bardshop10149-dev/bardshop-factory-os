// 包裝專區 P1 — D46／D47 塔台單號純函式（不 import supabase、不讀時鐘）
//
// 規格：docs/design/2026-09-27-packaging-schedule-p1.md §3.10、§六。
// 本檔只用相對路徑 import（目前沒有 import），可直接用 node --experimental-strip-types 跑測試。
//
// D46：出單表「素材單/包裝單」本來就不上塔台 → 不列入待排池、也不算「未上塔台」。
// D47：塔台報工的來源單號欄是空的，但製令號本身內含 SO＋項次，解碼後以「SO 數字＋項次」比對「上過塔台」：
//   MOT＋SO 9 碼＋項次 2~3 碼        MOT26082502107           → SO260825021 第 7 項
//   MOS＋SOB 9 碼＋項次（集單）       MOS26090250402-3MM-0915  → SOB260902504 第 2 項
//   舊式：製令號＝SO／SOB／RO 號本身，lot＝項次   RO25080441＋lot 3 → RO25080441 第 3 項
//   其餘（MOM 集單流水號、POC、MPO、SOA 長格式 MOT260806-120202-73801…）→ null，寧可不判斷（同 lib/moLineMatch.ts）

/** D46：出單表單據種類是否為「素材單／包裝單」（實測值為「素材單/包裝單」；用子字串以防日後改名） */
export function isNonScheduleDocType(docType: string | null | undefined): boolean {
  return /素材單|包裝單/.test(docType ?? '')
}

export interface DecodedSaraMo {
  /** SO 號去掉英文前綴後的數字（MOT／MOS 固定 9 碼） */
  soDigits: string
  /** 項次（已去前導零） */
  line: string
  /** 推測的完整 SO 號（MOT → SO、MOS → SOB、舊式 → 製令號本身）；僅供顯示，比對一律用 soDigits */
  soGuess: string
  rule: 'mot' | 'mos' | 'legacy'
}

const norm = (v: string | null | undefined) => String(v ?? '').trim().toUpperCase().replace(/\s+/g, '')
/** 純數字（容許 "3.0" 這種數值轉字串，同 classify.ts lineStr）、> 0 的項次 → 去前導零字串；其餘 null */
const lineOf = (v: string | null | undefined): string | null => {
  const s = String(v ?? '').trim()
  if (!/^\d+(\.0+)?$/.test(s)) return null
  const n = parseInt(s, 10)
  return n > 0 ? String(n) : null
}

// 只接受「9 碼 SO＋2~3 碼項次」且後面接 - 或結尾：SOA 訂單的長格式（MOT260806-120202-73801）無法還原 SO 號
const MOT_MOS_RE = /^(MOT|MOS)(\d{9})(\d{2,3})(?:-|$)/
const LEGACY_RE = /^(SOB|SO|RO)(\d+)$/

/** D47：塔台製令號（＋批號）→ SO 數字＋項次；無法可靠解碼回 null */
export function decodeSaraMo(mo: string | null | undefined, lot: string | null | undefined): DecodedSaraMo | null {
  const m = norm(mo)
  if (!m) return null
  const a = m.match(MOT_MOS_RE)
  if (a) {
    const line = lineOf(a[3])
    if (!line) return null
    const mos = a[1] === 'MOS'
    return { soDigits: a[2], line, soGuess: `${mos ? 'SOB' : 'SO'}${a[2]}`, rule: mos ? 'mos' : 'mot' }
  }
  const b = m.match(LEGACY_RE)
  if (b) {
    const line = lineOf(lot)
    if (!line) return null
    return { soDigits: b[2], line, soGuess: m, rule: 'legacy' }
  }
  return null
}

/**
 * 「SO 數字＋項次」比對鍵：SO 去掉開頭英文字母（SO／SOB／RO 不分，同原 session 驗證腳本 keys_from_mo）＋ '|' ＋ 項次。
 * SO 號去前綴後不是純數字、或項次無法解析 → null。
 */
export function soLineDigitsKey(so: string | null | undefined, line: string | null | undefined): string | null {
  const digits = norm(so).replace(/^[A-Z]+/, '')
  if (!/^\d+$/.test(digits)) return null
  const l = lineOf(line)
  return l ? `${digits}|${l}` : null
}

/** D47：一批塔台列（批／排程／報工紀錄）解碼後的「SO 數字＋項次」鍵集合 */
export function decodedTowerKeys(rows: Iterable<{ mo_nbr: string | null; lot_nbr: string | null }>): Set<string> {
  const out = new Set<string>()
  for (const r of rows) {
    const d = decodeSaraMo(r.mo_nbr, r.lot_nbr)
    if (!d) continue
    const k = soLineDigitsKey(d.soDigits, d.line)
    if (k) out.add(k)
  }
  return out
}
