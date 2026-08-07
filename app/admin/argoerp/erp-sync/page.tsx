// 路由入口：實際畫面在同資料夾的 ErpSyncPage.tsx。
//
// 為什麼要拆成兩個檔：/argo-db 也要嵌用同一個畫面（<ErpSyncPage />），
// 原本直接在 page.tsx 裡多加一行 `export { ErpSyncPage }` 讓它可被引用，
// 但 Next.js 的 page 檔只允許 default 等特定匯出，多的具名匯出會在
// 型別檢查階段報 "does not satisfy the constraint" 而擋下建置。
// 改成「元件放獨立檔、page 只負責當路由入口」即可兩邊共用。
export { ErpSyncPage as default } from './ErpSyncPage'
