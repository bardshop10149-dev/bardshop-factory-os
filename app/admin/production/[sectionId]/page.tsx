'use client'

import { useParams } from 'next/navigation'
import SaraProductionBoard from '../../../../components/SaraProductionBoard'
import { PRODUCTION_SECTIONS } from '../../../../config/productionSections'

export default function DynamicSectionPage() {
  // 抓取網址上的參數，例如 /admin/production/printing -> sectionId = "printing"
  const params = useParams()
  const sectionId = params?.sectionId as string

  const sectionInfo = PRODUCTION_SECTIONS.find(s => s.id === sectionId)

  if (!sectionInfo) {
    return <div className="p-10 text-center text-red-500">無效的生產區塊 ID</div>
  }

  // 2026-08-31 起六個產線排程看板改以塔台（SARA）資料為準、唯讀呈現
  // （原人工拖曳排程元件 ProductionScheduler 保留於 components/，需要時可切回）
  return <SaraProductionBoard sectionId={sectionId} sectionName={sectionInfo.name} />
}
