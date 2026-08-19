# 出單表：PO 顯示入庫進度、製令可查塔台製程報工

發布日期：2026-08-19
範圍：每日出單表（發單作業區）。既有顯示內容不變，屬純新增。

---

## 一句話

出單表的採購單點進去，每個品項右下角多了「入庫/應到」；製令號也變成可以點，點進去直接看塔台上這張製令的所有製程與各站報工數量。

## 公告欄白話版

> 🔍 **出單表新增兩個查詢**
> 1. 點**採購單號** → 每個品項右下角顯示「入庫/應到」，一眼看出到貨了沒（綠=到齊、黃=部分、灰=未到）
> 2. 點**製令號** → 直接看塔台上這張製令的所有製程，每一站的「應做／已報工／剩餘」與完成進度

## 功能一：採購單入庫進度

- `components/PoOrderModal.tsx` 每個品項的最右下角新增「入庫/應到」，並依進度配色（已到齊/差 N/未到貨）。
- 資料早已存在：ARGO 進貨入庫後會回寫採購單身 `ACTUAL_QTY_ORU`，同步時已存進 `erp_pj_sync.extra.RECEIVED_QTY`，本次只是顯示出來，**不需改同步邏輯**。

## 功能二：製令 → 塔台製程與報工

- 出單表的製令號改為可點（兩處渲染）。
- 新 `GET /api/argoerp/mo-route?mo=<製令號>`：
  - **優先讀塔台即時資料**——以 `/api/project/management/table` 依單號找批(lot)，再以 `/api/project/job/table?lot_id=` 取該批「完整工序（含未排程者）」，直接帶回 `required_qty`／`reported_qty`／`remaining_qty`。
  - 塔台不可用時（未設帳密或連線失敗）**自動退回資料庫**：標準途程（`item_routes`→`route_operations`→`operation_times`）＋報工快照（`sara_wip_records`）。視窗會標示「⚠ 快照資料」，避免誤以為是即時值。
- 新 `lib/saraWebClient.ts`：塔台網頁版 session 客戶端（兩步驟 CSRF 登入、cookie 管理、模組層 session 快取 20 分鐘、401/403 自動重登）。
- 新 `components/MoRouteModal.tsx`：以表格列出序號／站點／工序／應做／已報工／剩餘／狀態，另含批次完成百分比、指定資源、製程備註。

### 為什麼不用既有的 `sara_wip_records`

該表是人工上傳的 CSV 快照（最後匯入停在 7/31），且只含「已報工」的站，看不到尚未開工的製程。塔台即時 API 三者皆備：即時、完整工序、含應做/剩餘。故改以塔台為主、快照為備援。

## 設計說明

- **走後端 API，不從前端直連 Supabase**：呼應 2026-08 資安審查對「前端直連」的結論，新功能不再擴大該面；塔台帳密亦只存在伺服器端。
- **支援一張製令對多批**：實測有 44 張單在塔台對到多個批（最多 19 批），會分批列出。
- **相容訂單層級掛載**：部分批的 `mo_nbr` 存的是來源訂單號，查不到製令時自動改以來源訂單再查一次，並在視窗標示「以訂單號對應」。

## 部署後必做

在 **Vercel → Settings → Environment Variables** 新增塔台帳密，否則線上只會顯示「⚠ 快照資料」：

```
SARA_LOGIN_EMAIL
SARA_LOGIN_PASSWORD
```

（亦相容 `TOWER_LOGIN_EMAIL` / `TOWER_LOGIN_PASSWORD` 命名。）加完需 Redeploy 生效。

## 驗證

- 塔台登入與查詢以真實製令實測通過：`MOT26080651214` → 1 批、3 道工序、報工 2/2、2/2、0/2。
- 未開工情境亦正確（全部製程列出、報工 0）。`operation_times` 站點對照 645 筆 100% 有值。
- 採購入庫量抽驗 200 筆有 35 筆已入庫（例 PO26050402/1 應到 140／入庫 140）。
- `tsc --noEmit`、`eslint` 皆綠；API 授權正常（未登入回 401）。

## 變更檔案

新增：`lib/saraWebClient.ts`、`app/api/argoerp/mo-route/route.ts`、`components/MoRouteModal.tsx`
既有微修：`components/PoOrderModal.tsx`（+24 行顯示）、`app/admin/argoerp/daily-order-sheet/page.tsx`（製令可點，+15 行）
