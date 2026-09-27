// 包裝專區 P3 AI 模擬排程 — AI 輸出的 JSON Schema 與結構驗證（純函式，規格 §4.6）
//
// AI_OUTPUT_SCHEMA：地基代理已依規格 §4.6 寫好（claude.ts 放進 output_config.format = { type: 'json_schema', schema }）。
//   規則：所有 object additionalProperties: false、全部欄位 required；不用 minimum／maxLength 等限制
//   （結構化輸出對限制類關鍵字支援有限，數量／字數由 validate.ts 與 prompt 控制）。改 schema 必須同步改 types.ts 的 AiOutput。
// parseAiOutput：手寫驗證、不引入 zod。
//   為什麼 API 已強制 schema 還要再驗：結構化輸出保證的是「語法」，但 SDK／模型版本、拒答備援（fallbacks）換模型時仍可能出現
//   形狀不同的回應；runner 之後的驗算、存 DB、畫面全都假設形狀正確，這裡是信任邊界——壞的整份擋下（ai_bad_output），
//   好的也只逐欄複製 AiOutput 定義的欄位（多出來的欄位不帶進系統）。
//
// 硬規則：不 import SDK、supabase；不讀時鐘；相對路徑 import。

import type { AiAssignment, AiOutput, ParseAiOutputResult } from './types'

const obj = (properties: Record<string, unknown>) => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
})
const arr = (items: unknown) => ({ type: 'array', items })
const S = { type: 'string' } as const
const I = { type: 'integer' } as const
const N = { type: 'number' } as const

/**
 * { summary, assignments[{k, day, line, qty, order, reason}], unplaced[{k, reason}],
 *   overtime[{day, line, hours, reason}], warnings[{k, message}]（與卡無關 k = ""）, ruleSuggestions[string] }
 * 型別與 SDK JSONOutputFormat.schema（{ [key: string]: unknown }）相容。
 */
export const AI_OUTPUT_SCHEMA: { [key: string]: unknown } = obj({
  summary: S,
  assignments: arr(obj({ k: S, day: I, line: S, qty: N, order: I, reason: S })),
  unplaced: arr(obj({ k: S, reason: S })),
  overtime: arr(obj({ day: I, line: S, hours: N, reason: S })),
  warnings: arr(obj({ k: S, message: S })),
  ruleSuggestions: arr(S),
})

/**
 * 驗證 JSON.parse 後的 AI 輸出（claude.ts 取 text block → JSON.parse → 本函式；失敗 → AiError('ai_bad_output')）。
 * - raw 必須是物件，六個欄位齊全且型別正確（summary string；assignments／unplaced／overtime／warnings 為物件陣列；ruleSuggestions 為字串陣列）。
 * - 陣列元素：欄位齊全、型別正確（day／order 為整數、qty／hours 為有限數字、字串欄為 string）；**多餘欄位忽略**（不因多一個欄位整份作廢），
 *   輸出時只逐欄複製 AiOutput 定義的欄位。
 * - 任一元素型別錯 → { ok: false, message: '第 N 筆 assignments 的 day 不是整數' 之類的繁中訊息 }（不含資料內容以外的東西）。
 * - 不檢查業務規則（k 對不對得回、day 在不在窗內、qty 夠不夠）——那是 validate.ts 的事，壞的單筆由它丟棄並記 dropped。
 */
export function parseAiOutput(raw: unknown): ParseAiOutputResult {
  const bad = (message: string): ParseAiOutputResult => ({ ok: false, message })
  if (!isObj(raw)) return bad('AI 輸出不是 JSON 物件')
  if (typeof raw.summary !== 'string') return bad('AI 輸出缺少 summary 或不是文字')

  const list = (field: string): unknown[] | ParseAiOutputResult => {
    const v = raw[field]
    return Array.isArray(v) ? v : bad(`AI 輸出缺少 ${field} 或不是陣列`)
  }
  const isFail = (x: unknown): x is ParseAiOutputResult => !Array.isArray(x)

  const asg = list('assignments')
  if (isFail(asg)) return asg
  const assignments: AiAssignment[] = []
  for (let i = 0; i < asg.length; i++) {
    const a = asg[i]
    const at = `第 ${i + 1} 筆 assignments`
    if (!isObj(a)) return bad(`${at} 不是物件`)
    const err = needStr(a, 'k', at) ?? needInt(a, 'day', at) ?? needStr(a, 'line', at) ?? needNum(a, 'qty', at)
      ?? needInt(a, 'order', at) ?? needStr(a, 'reason', at)
    if (err) return bad(err)
    assignments.push({
      k: a.k as string, day: a.day as number, line: a.line as string,
      qty: a.qty as number, order: a.order as number, reason: a.reason as string,
    })
  }

  const unp = list('unplaced')
  if (isFail(unp)) return unp
  const unplaced: AiOutput['unplaced'] = []
  for (let i = 0; i < unp.length; i++) {
    const u = unp[i]
    const at = `第 ${i + 1} 筆 unplaced`
    if (!isObj(u)) return bad(`${at} 不是物件`)
    const err = needStr(u, 'k', at) ?? needStr(u, 'reason', at)
    if (err) return bad(err)
    unplaced.push({ k: u.k as string, reason: u.reason as string })
  }

  const ot = list('overtime')
  if (isFail(ot)) return ot
  const overtime: AiOutput['overtime'] = []
  for (let i = 0; i < ot.length; i++) {
    const o = ot[i]
    const at = `第 ${i + 1} 筆 overtime`
    if (!isObj(o)) return bad(`${at} 不是物件`)
    const err = needInt(o, 'day', at) ?? needStr(o, 'line', at) ?? needNum(o, 'hours', at) ?? needStr(o, 'reason', at)
    if (err) return bad(err)
    overtime.push({ day: o.day as number, line: o.line as string, hours: o.hours as number, reason: o.reason as string })
  }

  const wn = list('warnings')
  if (isFail(wn)) return wn
  const warnings: AiOutput['warnings'] = []
  for (let i = 0; i < wn.length; i++) {
    const w = wn[i]
    const at = `第 ${i + 1} 筆 warnings`
    if (!isObj(w)) return bad(`${at} 不是物件`)
    const err = needStr(w, 'k', at) ?? needStr(w, 'message', at)
    if (err) return bad(err)
    warnings.push({ k: w.k as string, message: w.message as string })
  }

  const rs = list('ruleSuggestions')
  if (isFail(rs)) return rs
  const ruleSuggestions: string[] = []
  for (let i = 0; i < rs.length; i++) {
    if (typeof rs[i] !== 'string') return bad(`第 ${i + 1} 筆 ruleSuggestions 不是文字`)
    ruleSuggestions.push(rs[i] as string)
  }

  return { ok: true, output: { summary: raw.summary, assignments, unplaced, overtime, warnings, ruleSuggestions } }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const needStr = (o: Record<string, unknown>, f: string, at: string): string | null =>
  typeof o[f] === 'string' ? null : `${at} 的 ${f} ${f in o ? '不是文字' : '缺少'}`
const needInt = (o: Record<string, unknown>, f: string, at: string): string | null =>
  typeof o[f] === 'number' && Number.isInteger(o[f]) ? null : `${at} 的 ${f} ${f in o ? '不是整數' : '缺少'}`
const needNum = (o: Record<string, unknown>, f: string, at: string): string | null =>
  typeof o[f] === 'number' && Number.isFinite(o[f]) ? null : `${at} 的 ${f} ${f in o ? '不是有限數字' : '缺少'}`
