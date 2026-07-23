# 品保專區：異常人員缺失單處理作業 + 品質異常處理單 Excel 列印

發布日期：2026-07-23
範圍：品保專區內部改版（異常紀錄表、原「異常人員統計」頁、建立異常單、異常單處理）＋新模組 `lib/qa/deficiencyPrint.ts`＋一支 SQL。品保專區以外零改動。

---

## 一句話

紙本手抄的「品質異常處理單」電子化：資料在系統填好、勾選要印的事件、一鍵下載公司格式的 Excel 缺失單（一位缺失人員一張），異常紀錄表同時補上日期區間快速篩選。

## 公告欄貼文（白話版，可直接貼 system_announcements）

> 【更新】品保專區三項新功能 📋
> 1. **異常紀錄表**：新增日期區間篩選，旁邊有「本月／上個月／近三個月／近半年／近一年」快速鍵；編輯視窗新增「異常數量、異常原因分析、即時處理方式、預防及修正方式」欄位（列印缺失單會帶入）。
> 2. **「異常人員統計」改名「異常人員缺失單處理作業」**：可依部門→人員篩選缺失紀錄；每列前有勾選框，勾選後可「批量列印」與「批量修改缺失處置」；點「相關單號」直接看訂單內容不用跳頁；每列最右邊固定有「列印」鈕。
> 3. **缺失單改印 Excel**：按列印會下載「品質異常處理單」Excel 檔，格式同紙本（A4 一頁一張），廠商名稱、訂單量、不良率自動帶入，一筆事件有幾位缺失人員就出幾張。缺失處置若是「警告／小過／大過」會自動勾在處置方式框，其他處置（如口頭矯正）勾在「其他」。
> 建立異常單時多了「異常數量」欄位（選填），請盡量填寫，缺失單的不良數／不良率靠它計算。

## 對外變化

- 品保專區卡片「異常人員統計」→「異常人員缺失單處理作業」（路徑不變 `/qa/personnel-stats`，原統計表、交叉分析、下載 XLSX 全部保留）。
- 異常紀錄表篩選區多「日期區間」＋五顆快選 chip；建立/編輯視窗多「異常數量」；編輯視窗另多三個列印用文字欄。
- 建立異常單（`/qa/report`）多「異常數量（選填）」；異常單處理（`/qa/handling`）多「即時處理方式（選填）」。
- 缺失單處理作業頁明細表：左側勾選欄與右側「列印」欄固定不隨橫向捲動移動；勾選後上方出現「批量列印」「批量修改缺失處置」工具列；相關單號可點開訂單詳情彈窗（SoOrderModal）。

## 技術重點

- **資料層**（`sql/20260723_add_qa_deficiency_fields.sql`）：`schedule_anomaly_reports` 加 4 欄 `loss_qty numeric / cause_analysis / immediate_action / corrective_action text`，全部 nullable、additive，RLS 不變。
- **列印模組**（`lib/qa/deficiencyPrint.ts`，xlsx-js-style）：
  - `printDeficiencySheets(records, personnelDeptMap)`：每筆紀錄 × 每位 `qa_responsible` 產一個工作表（無人員出一張留白）；一次下載一個 `缺失單_YYYYMMDD.xlsx`。
  - 版面 9 欄 × 25 列、42 個合併儲存格、細框＋外粗框、新細明體、`!margins` 0.4"，總高 743pt < A4 直式可印 784pt（一頁一單）。
  - 訂單資訊一次 `.in('project_id', …)` 查 `erp_so_lines`：廠商名 `partner_name`、訂單量 = `mbp_part` 對 `item_code` 的行加總 `order_qty_oru`（對不到退回全行加總、查無留白）；不良數＝異常數量＝`loss_qty`，不良率自動算。
  - 處置勾選映射：值含「警告／小過／大過」勾對應框（「口頭警告」勾警告）；其他非空值勾「其他」附原文；空值全留白手勾。
  - 相對紙本範本的版面差異（Snow 指定）：移除「採購單號」列；「部門/缺失人員」移到（3）處置方式正上方；（3）縮成一排；「客戶訂單單號」帶系統相關單號（SO 單號，同步表無客戶 PO 欄）。
- **缺失單處理作業頁**（`app/qa/personnel-stats/page.tsx`）：部門→人員連動篩選（資料源 `qa_anomaly_option_items` personnel 的 `department_value`）；`Set` 勾選＋全選；批量修改處置對每筆所選紀錄的全部缺失人員寫 `qa_disposition`（confirm 後 `Promise.all`）；sticky 勾選欄/列印欄用不透明 `bg-slate-900/950` 防橫向捲動透視。
- **異常紀錄表**（`records/page.tsx`）：日期比對用 `created_at.slice(0,10)` ISO 字串（含頭尾）；快選 chip 以本地時區組日期避免 UTC 換日位移。**順手修正**：建立異常單 payload 原帶有資料表不存在的欄位（`quantity`、`source_order_id` 等），insert 會 400——已移除，「新增異常單」按鈕從此可用。

## 部署/設定步驟（缺一不可，順序不能反）

1. **先在 Supabase SQL Editor 執行 `sql/20260723_add_qa_deficiency_fields.sql`**（加 4 欄）。未執行前合併部署的話：缺失單處理作業頁查詢會失敗、三個表單儲存會 400。
2. 合併本 PR → Vercel 自動部署。
3. 無需權限調整（沿用既有 `qa` / `qa_report` 權限）。

## 驗證（已完成）

- `npx tsc --noEmit`、`npm run build` 全過。
- xlsx 結構以腳本回讀實測 27 項全過（工作表數、42 merges、25 列高、9 欄寬、民國日期、處置三種映射、無訂單/無人員/無數量降級、sheet 名清洗），styles.xml 解壓確認框線（thin×61、medium×19）、灰底、新細明體字型實際寫入。
- Dev server 實測：日期五顆快選與清除（255→28／43 筆）、卡片與頁標題改名、部門→人員連動（58→43→12 筆）、全選/勾選、批量修改處置（Supabase REST 抽樣確認寫入）、SoOrderModal 開關、單筆列印於瀏覽器成功下載 `缺失單_20260723.xlsx`，console 零錯誤。
