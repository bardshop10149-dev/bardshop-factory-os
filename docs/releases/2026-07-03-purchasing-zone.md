# 採購專區（Purchasing Zone）上線

發布日期：2026-07-03
範圍：新增首頁卡片「採購專區」＋ `/purchasing` 頁面＋三支 `/api/purchasing/*` API＋三張 Supabase 表；既有檔僅 additive 修改（首頁卡片、權限清單、argoerp 同步、業務查詢加一欄）。

---

## 一句話

採購人員有了自己的專區：所有 OPEN 採購單一頁列管，逐筆點選「已出貨 / 付款進度 / 貨運方式 / 預計出貨日」，交期前 10/5/2 天自動分級提醒；業務查詢也能點單看採購執行進度——但供應商與付款資訊只留在採購專區內。

## 公告欄貼文（白話版，可直接貼 system_announcements）

> 【新功能】採購專區上線 🛒
> 首頁新增「採購專區」卡片（需開通權限）。功能：
> 1. 所有 OPEN 採購單明細一次看，含對應 SO 單號、請購單號、製令。
> 2. 每筆可點「已出貨」、付款進度（30/50/70/100%）、貨運方式（順豐/空運/海特快/一般海運）、預計出貨日。
> 3. 「到期提醒」分頁：交期前 10/5/2 天分黃/橘/紅提醒，點過已出貨就不再提醒；卡片上會顯示待處理數字。
> 4. 可用廠商、料號、請購單號、承辦人、交期/下單/單號區間查詢（支援部分輸入）。
> 5. 業務同事在「銷售訂單查詢」點「採購進度」即可看到該單採購的執行進度與預計出貨——供應商與付款資訊不會顯示。
> 需要權限請找管理員在「團隊管理」勾選「採購專區」。

## 對外變化

- 首頁多一張「採購專區」卡片（無權限者反灰，點擊提示聯絡管理員；有權限者卡片左上顯示到期提醒數）。
- 銷售訂單查詢（美編天地 → SO 查詢）每列多一顆「採購進度」按鈕，開窗顯示 PO 明細的進度/出貨方式/預計出貨日。**不含供應商與付款**。
- 團隊管理權限清單多一項「採購專區 (Purchasing)」。

## 技術重點

- **資料層**（`sql/20260703_purchasing_tracking.sql`，三張表皆 service_role-only RLS）：
  - `po_line_tracking`（明細層級）：`shipped_at`（null=排程製作中）、`ship_method`（CHECK 四選一）、`expected_ship_date`。`erp_pj_sync` 每小時整批重建無穩定 id，故以自然鍵 `(doc_no, sub_no)` 連結，狀態不會被同步洗掉。
  - `po_payment`（表頭層級）：`payment_pct` CHECK in (0,30,50,70,100)。付款是整張 PO 的比例，放明細會不一致。
  - `erp_vendors`：供應商主檔。**不開 authenticated read**（與 erp_customers 不同），名稱只經採購 API 流出。
- **API**（`app/api/purchasing/`）：
  - `GET list`：`guardPermission('purchasing')`；OPEN PO 全量（1000 行批次）＋ 伺服器端組裝供應商名稱、請購單（沿用 daily-order-sheet 已驗證的 SO/RO＋料號比對鏈）、製令（`erp_mo_lines.source_order`）、追蹤/付款覆蓋層；`?count=1` 只回提醒統計供首頁徽章。
  - `POST status`：discriminated union（line / payment），白名單驗證，upsert 前先讀既有列合併避免部分更新洗掉其他欄位，記 `updated_by`。
  - `GET po-public`（`?po=` / `?so=`）：任何登入者可用。**結構性防外流**——select 字面不含 `customer_vendor`、完全不查 `po_payment`/`erp_vendors`、回傳逐欄映射 `PublicPoLine`（無 spread）。
- **同步**（`app/api/argoerp/route.ts`，additive）：新增 `sync_vendor`（複製 sync_customer、`VENDOR='Y'`、走 `reconcileTable` 增量引擎）；`sync_po` 表頭 CUSTOMCOLUMN 加 `SALES_NAME` 存入 extra（承辦人顯示姓名；未重跑同步前退回顯示 SALES_ID 代號）。webhook 允許清單加 `sync_vendor`。
- **前端**（`app/purchasing/page.tsx`）：兩分頁（追蹤列表／到期提醒 10/5/2 紅橘黃分組）、八組查詢條件前端過濾、樂觀更新、過濾後 500 筆渲染上限。

## 部署/設定步驟（缺一不可）

1. **先在 Supabase SQL Editor 執行 `sql/20260703_purchasing_tracking.sql`**（建三張表）。未執行前 `/api/purchasing/list` 會 500。
2. 觸發一次 `sync_vendor`（webhook `POST /api/webhook/sync` body `{"action":"sync_vendor"}`，或之後掛進排程）灌入供應商名稱；未跑前列表只顯示廠商代碼。
3. 重跑一次 `sync_po`（既有排程每小時會自動跑）讓 extra 帶入 `SALES_NAME`。
4. 團隊管理 → 為採購人員勾選「採購專區」權限。

## 驗證

- `npx tsc --noEmit`、`next build`、`eslint`（新增/修改檔）皆綠。
- 本機 dev（eip-dev:3700）：頁面渲染、分頁/查詢列/表格結構、未登入 API 401 處理皆正常。
- Supabase REST 實料抽驗 join 鏈：PO260515006（C3CMOUB-2024，SO=RO26043025）→ 請購 MP260511018-1（料號精準相符）→ 製令 MOT2604302501 ✅。
- 供應商防外流：`po-public` 回應無 vendor/payment 欄位（結構上選不到）；`erp_vendors`/`po_line_tracking`/`po_payment` anon 直讀被 RLS 拒絕。

## 變更檔案

新增：`sql/20260703_purchasing_tracking.sql`、`lib/purchasing/types.ts`、`lib/purchasing/data.ts`、`app/api/purchasing/{list,status,po-public}/route.ts`、`app/purchasing/page.tsx`、本檔
既有微修（皆 additive）：`app/api/argoerp/route.ts`（action union、SALES_NAME、sync_vendor 區塊）、`app/api/webhook/sync/route.ts`（allowlist 一行）、`app/api/auth/login/route.ts`（ADMIN_PERMISSIONS 一行）、`app/admin/team/page.tsx`（權限選項一行）、`app/page.tsx`（canPurchasing＋徽章＋一張卡片）、`app/design-studio/so-query/page.tsx`（採購欄＋modal）

---

## 後續增修（2026-07-04 ~ 07-07，同一 PR）

**進度模型改三里程碑**：OPEN 不代表已發給廠商，改為 **已發單 → 已出貨**（採購手動點）＋ **已到倉**（入庫量 ≥ 採購量自動亮）。三段連續光條由左往右填。到期提醒：已出貨或已到倉都不再提醒。需執行 `sql/20260705_po_line_sent.sql`（po_line_tracking 加 sent_at）。

**入庫量**：sync_po 由 ARGO `ACTUAL_QTY_ORU` 帶入 `extra.RECEIVED_QTY`，列表「入庫」欄顯示已入庫/採購數與狀態；業務查詢 POC 明細也帶進度＋入庫。⚠️ 正式站部署後每小時同步才會穩定回填（本機補同步會被線上舊碼覆蓋）。

**供應商同步**：`sync_vendor` 查詢條件更正為 `SUPPLIER='Y'`（原誤用 VENDOR）；寫入 `erp_vendors`（service_role-only）。承辦人姓名取自 sync_po 的 `SALES_NAME`（移除無效的 erp_so_lines 全表掃描）。

**查詢/檢視強化**：預設查近兩月下單日、伺服器端先收斂加速、每頁 100 筆分頁；交期可點表頭排序；欄寬可拖拉、精簡（一屏）模式、深色捲軸（`.eip-scrollbar`）；料號輸入跳查詢視窗、承辦人建議清單；「排除已全部到倉」「只看常平／只看非常平」（常平＝供應商 C01510）三顆快篩；點採購單號開整張明細視窗。

**加速索引**：`sql/20260707_purchasing_indexes.sql`（PR/MO 比對、下單日過濾用欄位建索引）。

新增檔：`sql/20260705_po_line_sent.sql`、`sql/20260707_purchasing_indexes.sql`、`app/api/purchasing/lookups/route.ts`
增修：`app/info-board/order-records/page.tsx`（POC 明細加進度＋入庫欄）、`app/globals.css`（深色捲軸）、`lib/purchasing/*`、`app/purchasing/page.tsx`

**查詢提速（2026-07-08）**：列表改「資料庫端過濾/排序/分頁」——一次只撈當頁 100 筆、只對當頁做供應商/請購/製令比對（原本撈全部 1,800+ 筆再全量比對）；請購比對查詢平行化。實測單次查詢 API 由 3~4 秒降至約 1 秒內。到期提醒改獨立輕量端點（只撈交期 10 天內）。「排除已到倉」「請購單號」兩條件為當頁前端精修（PR 為比對結果，資料庫無此欄）。

**頁內同步（2026-07-08）**：採購專區右上新增「⟳ 同步採購單」，呼叫與 ERP 同步區相同的 `sync_po`（更新單況/入庫量/承辦人/交期），含進度視窗，完成後自動依原條件重新查詢。

### 部署後必跑 SQL（Supabase SQL Editor，依序）
1. `sql/20260703_purchasing_tracking.sql`（po_line_tracking / po_payment / erp_vendors）
2. `sql/20260705_po_line_sent.sql`（sent_at 欄位）
3. `sql/20260707_purchasing_indexes.sql`（查詢加速索引）
4. 觸發一次 `sync_vendor`（灌供應商名稱）；`sync_po` 排程跑過一輪帶入承辦人姓名與入庫量
5. 團隊管理勾「採購專區」權限給採購人員
