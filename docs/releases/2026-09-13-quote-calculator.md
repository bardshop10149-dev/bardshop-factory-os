# 報價計算機（Quote Calculator）MVP 上線

發布日期：2026-09-13
範圍：新增「業務資訊看板 → 報價計算機」前台頁＋後台新群組「報價系統」四個維護頁＋九支 `/api/quote/*` API＋五張 Supabase 表（含價格表 seed 與 6 筆待核可驗證案例）；既有檔僅 additive 修改（看板 modal 一張卡、後台選單一個 group、權限清單、globals.css 末端 token）。
MVP 範圍：**只做壓克力鑰匙圈 × 常平廠（RMB）**，只做算價試算；其他品項照 SOP 一個一個上。

---

## 一句話

業務在「業務資訊看板」點「報價計算機」，選鑰匙圈、填尺寸／數量／印刷／配件，右邊即時出現成本單價與報價（RMB，可切 TWD），五段成本明細可展開看算式；價格與參數全在後台維護，每個品項要通過 Snow 核可的 Excel 驗證案例才能發布給業務。

## 公告欄貼文（白話版，可直接貼 system_announcements）

> 【測試版】報價計算機 🧮（先開給指定測試帳號）
> 首頁「業務資訊看板」多了一張「報價計算機」卡。目前有 **壓克力鑰匙圈、貼合鑰匙圈（2貼2／3貼1／2貼1／3貼2）、登山鉤**（常平廠）：
> 1. 選品項、板材厚度，填尺寸（公分）與數量；配件數量會跟著訂單數一起算。
> 2. 選單面／雙面、印刷方式（仿柯 7151 / 仿柯 百川 / 柯式＋版數 / 無印刷）。
> 3. 勾配件（D字吊環、C字扣、紙卡…），常用的排前面，底部可展開全部；包裝由系統依品項預設帶入。
> 4. 毛利率預設帶品項標準值，需要時可改；右側即時顯示報價（RMB；有設匯率時可切 TWD）與本單合計。
> 5. 按「產生報價」會留一筆紀錄（報價單號 Q-年月日-流水號）並可一鍵複製文字摘要。
> 這是試算工具，對外報價仍由業務判斷。測試期間有問題請直接回報 Snow。

## 對外變化

- 業務資訊看板 modal：「業務改單表 🔧 維修中」灰卡 → 「報價計算機」可點卡（`/info-board/quote`）。
- 後台 `/admin` 側欄多一個群組「報價系統」：品項維護／材料價格表／全域參數／Excel 匯入（需 `quote_admin` 權限）。
- 團隊管理權限清單多一項「報價系統後台 (Quote Admin)」；管理員自動擁有。
- 前台視覺是獨立的「紙墨報價單」設計系統（暖紙白底、墨色字、零陰影零漸層），token 只掛在 `.q-page` wrapper 下，不影響其他頁。

## 技術重點

- **價格由確定性引擎算，AI 不算價**（`lib/quote/engines/acrylic.ts`）：純函式，同輸入同輸出；照常平廠 `报价模板 v1.5.x` 逐儲存格逆向（`docs/design/2026-09-13-quote-cost-model.md`），五段成本每段回 `lines[]{name, formula, amount}`，分母永遠是訂單數 Q、報廢率最後一步乘。已知模板瑕疵（外形刀 ×1.21、第二板不進切割、開版費被乘報廢率…）**刻意照抄**，各做成 `quote_settings` 旗標，預設 = Excel 現況；要修正是 Snow 翻旗標，不是工程師順手改。
- **所有常數不寫死**：板價／PET／五金／包材／刀費／人工／設備折舊全部來自 `quote_price_items` 與 `quote_settings`，帶 `effective_from`、`source_file`、`updated_by`。同一格在不同版本值不同（外形刀 12 → 27）就是「後台參數 + 生效日」。
- **沒過驗證不准發布**：品項 `draft → testing → published`，前台只讀 `published`。「發布」按鈕的閘門 = `POST /api/quote/admin/verify` 跑該品項全部 `approved` golden（每筆用自己的 `settings_snapshot` 覆蓋現價，誤差 < 1%）。改 config 自動退回 `testing`、`version + 1`。Golden 匯入後一律 `proposed`，Snow 核可才算數（舊表不是每份都準：`docs/design/2026-09-13-quote-sheet-trust.md`）。
- **資料層**（`sql/20260913_quote_system.sql`，五張表皆 service-role-only RLS，前端只走 API）：`quote_products`（品項 config + 狀態 + 版本）、`quote_price_items`（價格表 121 項（v1.5.6 价格表 + 手補 5 項），含五金 ARGO 料號）、`quote_settings`（key/value jsonb：拼板間距、刀費、產能、人工、旗標、匯率、加成）、`quote_golden_cases`（驗證案例 + 快照 + 最近一次結果差異）、`quote_calc_logs`（每張報價：`quote_no`、規則版本、輸入、結果、價格快照、匯率）。
- **API**（`app/api/quote/`）：前台 `catalog`（只回 published 品項與其用到的價格）、`calc`（伺服器端算價，回 warnings/errors/priceSnapshot）、`log`（寫報價紀錄、發 `Q-YYYYMMDD-NN`）走 `guardPermission('info_board')`；後台 `admin/{products,prices,settings,import,verify,erp-suggest}` 走 `guardPermission('quote_admin')`。一律 `{ success, ... }`，資料表不存在回 **503** 並提示「報價系統資料表尚未建立，請通知管理員執行 sql/20260913_quote_system.sql」。
- **Excel 匯入是確定性解析、不用 AI**（`lib/quote/excelImport.ts`，沿用既有 `xlsx` 套件）：`价格表` → 差異清單（新增／漲／跌／名稱異常）勾選套用；`主产品` 或各數量分頁 → 每頁一筆 golden `proposed`，含輸入、當時常數快照與模板版本（A1 表頭 + L2 + 版本信息）。
- **ERP 建議價**：價格表每列可填 ARGO 料號，「抓 ERP 建議價」查 `erp_pj_sync` 最近採購單價 + 幣別，顯示現價／ERP 價／換算／差異 %，**人工「採用」才覆寫**；幣別不同只顯示換算值。
- **前台設計系統**（`docs/design/2026-09-13-quote-ui-spec.md`）：三套字型走 `next/font/google`（Noto Serif TC 標題／Noto Sans TC 內文／IBM Plex Mono 數字），token 追加在 `app/globals.css` 最末端且只掛 `.q-page`；圓角 ≤ 4px、零陰影、訊息一律「※」開頭。
- **既有檔微修**：`app/page.tsx`（看板一張卡）、`config/menuItems.ts`（新 group；設計書寫 `amber`，因 admin 色票表只支援 cyan/purple/blue/orange/indigo/emerald，改用 `orange`）、`lib/authShared.ts`（`ADMIN_PERMISSIONS` 加 `quote_admin`）、`app/admin/team/page.tsx`（權限選項 + 已授權標籤各一行）。無新增 npm 依賴。

## 檢視模式：工程／業務（2026-09-13 追加）

- **業務模式（預設）**：只回報價單價、本單合計、TWD 換算。**伺服器根本不回**成本、五段明細、毛利、每盤／盤數、價格快照——不是前端藏，DevTools 也看不到。包裝由品項預設自動計入，業務不用挑、也看不到單價。
- **工程模式**：有 `quote_admin` 才切得到（頁首右側「業務／工程」鈕），內容同原本：五段算式、成本單價、成本率、每盤覆寫、包裝可調。
- 「產生報價」落庫一律存完整五段與價格快照（稽核用，`runCalc(..., { audit: true })`），回給前端的只有編號與摘要。
- 客戶版（VIP）的防蒸餾設計見 `docs/design/2026-09-13-quote-modes-and-customer-guard.md`，尚未實作。

## 貼合款：2貼2／3貼1／2貼1／3貼2（2026-09-15 追加）

- 新品項「貼合鑰匙圈（雙板貼合）」：板材下拉改成組合選項 **2 貼 2（1.8+1.8）／3 貼 1（2.8+0.8）／2 貼 1（1.8+0.8）／3 貼 2（2.8+1.8）**；預設雙面印刷、成本率 0.7、包裝產能 120／人時（照 `_2贴2报价模板_v1.5.6` 與 `_3贴1报价模板_v1.5.6`）。
- 兩份新模板跟基本模板只差 7 格：A10 第二板（盤數公式同主板）、A17 印刷改「7151/双面」、A18 貼合改「双面」、L4 30、L7 120；PET（L9）仍單面——**雙面 = 同一張 PET 兩面印，PET 張數不加倍**。2 筆 golden 對 Excel 0.0000%。
- 雙面計價口徑定案（Snow 2026-09-15）：**單板雙面 = PET ×2**（兩面各一張，印刷用單面價 × PET 張數）；**貼合款雙面不增加 PET**（一張 PET 兩面印，印刷用「印刷/xxx/双面」價 × 主板盤數）。後台「PET 面數（L9）」欄位控制，貼合鑰匙圈固定 1。
- 品項設定新欄位：板材選項 `key`／`pairItem`（同一主板可出現在多個組合）、第二板材「由板材選項帶入」、每盤數留空＝跟主板、`defaultPrintSides`。後台品項維護已加對應欄位。

## 工程模式補強（2026-09-16）

- 板材厚度右邊多「毛利率 %」欄，預設帶品項的 L4（鑰匙圈 28、貼合款 30、登山鉤 35），改了只影響本張試算（送 `overrides.costRatio = 1 − 毛利率/100`），明細註腳會標「本張毛利率覆寫」。**兩個模式都可調**（Snow 決定）：伺服器在業務模式只放行這一個覆寫，其他覆寫照丟。
- 尺寸區改成兩列格子（板材厚度｜毛利率／尺寸 W×H｜數量），板材選單加寬到 220px，「2 貼 2（1.8 + 1.8 mm）」不會被切。
- 配件清單預設只列常用 12 項，清單底部多「展開全部 N 項 ↓」，上方「顯示全部／只顯示常用」保留。
- 工程模式：五段明細預設全部展開（不再記 localStorage）、配件／包裝清單顯示單價。業務模式維持左右都不出現任何成本。

## 測試期開放方式（2026-09-16）

- 前台 `/info-board/quote`、首頁「報價計算機」卡片、`/api/quote/{catalog,calc,log}` 全部改看新權限 **`quote_user`**（不再是整個業務資訊看板的 `info_board`）。
- 要讓誰測試：後台 → 團隊管理 → 該帳號勾「報價計算機 (Quote)」→ 對方重新登入。沒勾的人首頁看不到卡片、直接打網址會 403。admin 不用勾。
- 品項要先在後台核可 golden → 跑驗證 → 發布，前台才會列出（未發布的品項前台看不到）。

## 部署／設定步驟（缺一不可，依序）

1. **Supabase SQL Editor 執行 `sql/20260913_quote_system.sql`**（建五張表 + seed：價格表 181 項、全域參數、鑰匙圈／貼合鑰匙圈／登山鉤三個品項 `draft`、8 筆 golden `proposed`）。只在一台機器跑一次；動 schema 前先手動備份。未執行前 `/api/quote/*` 一律回 503。
2. 團隊管理 → 為**要測試的帳號**勾「報價計算機 (Quote)」（`quote_user`）。測試期只有勾了的人看得到卡片與頁面；之後全面開放時再一次勾給所有業務。
3. 團隊管理 → 為 Snow 勾「報價系統後台 (Quote Admin)」（管理員帳號自動擁有，一般帳號要手動勾）。
4. 後台 `/admin/quote/products` → 每個要開放的品項 → 逐筆核可 golden（鑰匙圈：C款 5 萬／2.1 萬／5000、空白模板 v1.5.6；貼合鑰匙圈：2貼2、3貼1；登山鉤：登山勾 1000；ANDY 燙金畫板那筆暫掛鑰匙圈下，可先不核可）→ 「跑驗證」全綠 → 「發布」。發布前前台看不到該品項。
5. （可選）`/admin/quote/settings` 設定 `fx_rmb_twd`（匯率與日期）與 `markup_bardshop_pct`；未設定時前台只顯示 RMB、TWD 切換反灰。
6. （可選）`/admin/quote/prices` 對有 ARGO 料號的五金按「抓 ERP 建議價」核對現價。

## 驗證

- `npx tsc --noEmit` 綠（main 一個 TS 錯就凍結全部部署）。
- 本機 dev：`.env.local` 設 `QUOTE_DEV_SEED=1` 時整個報價系統改用 `lib/quote/seed/*.json`（不連 DB、不驗 Supabase Auth，只在 `NODE_ENV=development` 生效，見 `lib/quote/guard.ts`），搭配 `proxy.ts` 假 cookie 即可開 `/info-board/quote` 與 `/admin/quote/*`；前台會顯示茶金橫幅「※ 目前使用開發用 seed 資料」。正式站絕不可設此變數。
- Golden：`scripts/quote-golden.mjs` 以 seed 常數快照跑 6 筆，成本／報價誤差 < 1%（C款 5 萬：成本 3.063943、報價 4.255477）。
- 端對端：後台匯入 C款 Excel → 核可 4 筆 golden → 跑驗證全綠 → 發布 → 前台選鑰匙圈 8×10.2 / 2.8mm / 柯式 V=4 / 50000 → 面板成本 3.23、報價 4.49（現行外形刀 27 元/把；golden 用該表當時的舊刀價快照 9360 才是 3.06／4.26），五段明細對得上 Excel G 欄 → `quote_calc_logs` 多一筆含 `quote_no`。
- 設計規範對照：PR review 逐項檢查 ui-spec 第 11 節「明確禁止」。

## 變更檔案

新增：`sql/20260913_quote_system.sql`、`lib/quote/{types,api,data,guard,golden,excelImport}.ts`（拼板函式在 `engines/acrylic.ts` 內，無獨立 nesting.ts）、`lib/quote/engines/acrylic.ts`、`lib/quote/seed/{settings,products,golden,priceItems}.json`、`scripts/{quote-golden,quote-seed-sql,quote-import-test}.mjs`、`app/api/quote/{catalog,calc,log}/route.ts`、`app/api/quote/admin/{products,prices,settings,import,verify,erp-suggest}/route.ts`、`app/info-board/quote/{layout,page}.tsx` 與 `_components/*`、`app/admin/quote/{products,prices,settings,import}/page.tsx`、`docs/design/2026-09-13-quote-{cost-model,sheet-trust,ui-spec}.md`、本檔
既有微修（皆 additive）：`app/page.tsx`（看板 modal 一張卡）、`config/menuItems.ts`（NAV_GROUPS 末端一個 group）、`lib/authShared.ts`（`ADMIN_PERMISSIONS` 一項）、`app/admin/team/page.tsx`（權限選項 + 已授權標籤各一行）、`app/globals.css`（末端追加 `.q-page` token）、`proxy.ts`（`/admin/quote/*` 改走 `quote_admin` 而非 `production_admin`）、`app/admin/layout.tsx`（最後一個 nav group 的下拉改靠右錨定，多了第 8 個群組後不再撐出水平捲軸）、`package.json`（`quote:golden`、`quote:seed-sql` 兩個 script，無新依賴）
