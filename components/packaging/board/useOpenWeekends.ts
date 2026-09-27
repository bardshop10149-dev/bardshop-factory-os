'use client'

// 日檢視 ◀ ▶ 要知道「哪些週六／週日開了加班」（D48／D63：開加班的週末日才出現在工作台）。
// 日檢視只向工作台 API 要 1 天，回應裡看不到前後的週末 → 另外讀一次產能表（GET /api/packaging/capacity，唯讀）。
// 只在載入時、產能存檔後（refreshKey 變動）讀；讀不到就只靠已載入的工作台欄位（kind = weekend_ot）判斷。

import { useEffect, useState } from 'react'
import type { YMD } from '@/lib/packaging/scheduleTypes'
import { addDays, openWeekendDaysOf } from '@/lib/packaging/scheduleCalendar'
import { fetchCapacity } from './boardApi'

/** 產能 API 一次最多查 180 天 */
const SPAN_DAYS = 180

export function useOpenWeekends(enabled: boolean, today: YMD | null, refreshKey: number): ReadonlySet<YMD> {
  const [days, setDays] = useState<ReadonlySet<YMD>>(() => new Set())
  useEffect(() => {
    if (!enabled || !today) return
    let alive = true
    void fetchCapacity(today, addDays(today, SPAN_DAYS)).then(r => {
      if (!alive || !r.json || !r.json.success) return
      // 與伺服器同一個判斷（週六或週日、開加班、加班 > 0、不是國定假日）。
      // 分線輪：加班 > 0 改看「啟用中各線當天加班加總」（D71；daily 列的加班欄只是相容欄）
      const j = r.json
      const activeIds = j.lines ? new Set(j.lines.filter(l => l.active).map(l => l.id)) : undefined
      setDays(openWeekendDaysOf(j.rows, j.lineRows, activeIds))
    })
    return () => { alive = false }
  }, [enabled, today, refreshKey])
  return days
}
