'use client'

// 日檢視 ◀ ▶ 要知道「哪些週六開了加班」（D48：開加班的週六才出現在工作台）。
// 日檢視只向工作台 API 要 1 天，回應裡看不到前後的週六 → 另外讀一次產能表（GET /api/packaging/capacity，唯讀）。
// 只在載入時、產能存檔後（refreshKey 變動）讀；讀不到就只靠已載入的工作台欄位（kind = saturday_ot）判斷。

import { useEffect, useState } from 'react'
import type { YMD } from '@/lib/packaging/scheduleTypes'
import { addDays } from '@/lib/packaging/scheduleCalendar'
import { fetchCapacity } from './boardApi'

/** 產能 API 一次最多查 180 天 */
const SPAN_DAYS = 180

export function useOpenSaturdays(enabled: boolean, today: YMD | null, refreshKey: number): ReadonlySet<YMD> {
  const [sats, setSats] = useState<ReadonlySet<YMD>>(() => new Set())
  useEffect(() => {
    if (!enabled || !today) return
    let alive = true
    void fetchCapacity(today, addDays(today, SPAN_DAYS)).then(r => {
      if (!alive || !r.json || !r.json.success) return
      const next = new Set<YMD>()
      for (const row of r.json.rows) {
        if (row.isSaturdayOpen && row.overtimeHoursMax > 0) next.add(row.date)
      }
      setSats(next)
    })
    return () => { alive = false }
  }, [enabled, today, refreshKey])
  return sats
}
