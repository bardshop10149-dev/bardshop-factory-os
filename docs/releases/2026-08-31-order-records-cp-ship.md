# 發單記錄查詢：POC 明細加上「運送方式」與「常平出貨備註」

發布日期：2026-08-31
範圍：業務資訊看板 → 發單記錄查詢，點採購單號跳出的明細視窗。

---

## 一句話

發單記錄查詢點 POC 進去，採購明細每一行的「備註」右邊，多了「運送」和「常平出貨備註」兩欄——跟採購專區看到的同一份資料。

## 公告欄白話版

> 🚚 **發單記錄查詢的採購單多了兩欄**
> 點採購單號 → 明細右邊新增「運送」（順豐／海特快…）和「常平出貨備註」
> 常平那邊在訂單工作表填的出貨資訊（幾號出、走什麼、快遞單號）會自動帶過來。

## 內容

- 明細視窗（採購單）的「備註」欄右側新增兩欄：
  - **運送**：`po_line_tracking.ship_method`（順豐／空運／海特快／一般海運），下方帶預計出貨日。
  - **常平出貨備註**：只擷取 `po_line_tracking.note` 裡的「【常平出貨】」管理行，多行完整顯示。
- 資料來源與採購專區完全相同（每天 07:00 常平出貨同步寫入），此處只是把既有資料顯示出來，不改任何同步。
- 訂單備註（`remark`）、其他欄位一律不動；製令（MO）視窗、非採購單不受影響。

## 為什麼安全

走既有的 `/api/purchasing/po-public`（`guardAuth`，跨區可見形狀），本次在該 API 的 `PublicPoLine` 加 `cp_ship_note`，且**只擷取【常平出貨】那一行**——採購內部手打的其他備註不會外流。保持該檔「結構性防外流：無供應商／付款欄位」的原則。

## 附帶修除一顆部署地雷

`app/api/production/order-sketch/route.ts` 從 route 檔 `export const BUCKET`（route 檔只能匯出 HTTP method）——turbopack 不擋、`next build --webpack` 會失敗。順手拿掉 export（同 exchange-csv 前例）。

## 驗證

- 以真實單 `POC2026081801` 抽驗：13 行全部帶出運送（順豐×12、海特快×1）與常平出貨備註（含快遞單號）。
- `next build --webpack` 全綠（129/129 頁）、`tsc --noEmit` ✅、eslint 無錯誤。

## 變更檔案

`lib/purchasing/types.ts`（PublicPoLine 加 cp_ship_note）
`app/api/purchasing/po-public/route.ts`（select note＋擷取【常平出貨】行）
`app/info-board/order-records/page.tsx`（兩欄）
`app/api/production/order-sketch/route.ts`（拆 export 地雷）
