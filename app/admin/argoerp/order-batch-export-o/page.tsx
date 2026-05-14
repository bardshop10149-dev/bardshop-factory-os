import FactoryOrderExportPage from '../_shared/FactoryOrderExportPage'

export default function OrderBatchExportOPage() {
  return (
    <FactoryOrderExportPage
      factory="O"
      title="出單表➜委外請購"
      subtitle="ArgoERP — 載入出單表（委外訂單）→ 比對序號 → 匯入 IFAF044 採購單"
      storageKey="argoerp_order_batch_o_v1"
      failedKey="argoerp_order_batch_o_failed_v1"
      theme={{
        accent:       'text-purple-300',
        accentBg:     'bg-purple-900/40',
        accentBorder: 'border-purple-700/50',
        btn:          'bg-purple-700 hover:bg-purple-600',
        headerBg:     'bg-purple-900/30',
      }}
      hideImport
    />
  )
}
