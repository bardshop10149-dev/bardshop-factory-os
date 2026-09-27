# 資安修復：公開 anon key 可 dump 生產資料表 — 盤點、修法、部署順序、驗證

- 日期：2026-09-27
- 分支：`fix/security-anon-lockdown`（從 `origin/main` 0a0b36c 開出）
- 嚴重度：🔴 High（不需登入即可整表下載客戶地址、單價、採購價格、成員 email）
- 對應：SECURITY_AUDIT.md SEC-05（RLS 系統性失效）、SEC-02 尾巴（members.password 欄位）

---

## 0. 一句話

`NEXT_PUBLIC_SUPABASE_ANON_KEY` 隨 JS bundle 送到每個瀏覽器，等於公開；任何人打開 EIP 登入頁、
從 bundle 抄下這把 key，就能對 `https://<project>.supabase.co/rest/v1/<table>` 直接整表讀取
（**39 張表、其中 erp_pj_sync 24,945 列、erp_so_lines 8,541 列、legacy_inventory_receipts 71,698 列**），
十幾張表甚至能直接 INSERT / UPDATE / DELETE。
修法 = 前端所有資料表存取改走「需登入的同源代查閘門」+ Supabase 端用 RLS + REVOKE 把 anon 完全擋掉。

---

## 1. 盤點（唯讀、只數筆數、未讀任何列內容）

工具：`scripts/security/anon-probe.mjs`（用 anon key 對每張表送 `HEAD` + `Prefer: count=exact`，只看 Content-Range）。
表清單 = 程式碼所有 `.from('…')` ∪ `sql/` 所有 create/alter 過的表，共 78 張。

### 1.1 anon 可讀且有資料（39 張，依筆數）

| 表 | 筆數 | 敏感內容 | 前端直讀？ |
|---|---:|---|---|
| legacy_inventory_receipts | 71,698 | 舊系統入庫**成本／單價** | 是（每日出單表） |
| erp_mo_lines | 48,972 | 製令、客戶、品項 | 是 |
| sara_wip_records | 44,918 | 塔台報工明細 | 是 |
| sara_reports | 33,976 | 報工原始資料 | 否 |
| erp_pj_sync | 24,945 | `customer_vendor`、`extra` jsonb（**採購價格／付款／廠商**） | 是 |
| erp_so_lines | 8,541 | **`delivery_address`（客戶 PII）、`unit_price_oru`** | 是（~12 頁 SoOrderModal） |
| mm_bom_part_units / material_inventory_list / item_routes / erp_material_prep_lines / mm_bom_structure | 4k–8k | BOM、庫存、製程 | 是 |
| argoerp_mo_upload_log / sara_101_master / argoerp_material_prep_log / sara_orders | 1k–3k | 派工、備料 | 部分 |
| operation_times / route_operations / station_time_summary / sara_sync_logs / schedule_anomaly_reports / sara_jobs | 269–645 | 工時、異常單（含人員） | 是 |
| system_logs | 256 | **操作者 email、操作內容** | 是（/admin/system-logs） |
| daily_order_sheets | 105 | 出單表（含示意圖網址、客戶） | 是 |
| sara_resources / qa_anomaly_option_items / schedule_inquiries / **members (32，含 email)** / production_machines / production_notice_groups / material_substitute_rules / app_settings / sara_workcenters / schedule_inquiry_salespersons / departments / order_anomaly_options / tasks / task_messages / system_announcements / order_anomaly_records | 2–96 | 成員、任務內容、公告 | 大多是 |

> ⚠️ **members 仍可讀 32 列** → `sql/20260814_members_rls_lockdown.sql` 很可能**從未套用到 production**（或事後被放寬）。本次 migration 第 1 段會再鎖一次（含 REVOKE）。
> ✅ `password` 欄位 32 列全部為空（登入早改走 Supabase Auth），無密碼外洩；但欄位仍在 → 本次刪除。

### 1.2 anon 正確被擋（回 0 列或 404）
erp_customers、argoerp_mo_summary、changping_ship_marks、po_line_tracking、po_payment、erp_vendors、quote_*、item_code_request*、print_asset_index、sara_lot_progress、sara_wip_schedule、design_daily_sheets、po_void_shipped_alerts …（皆為 sql/ 裡有正確 `enable RLS` + 只給 service_role policy 的表）。`bom` 404（已於 2026-09-01 刪表；`app/notice-board/page.tsx` 還在讀它，屬既有死碼，見 §6）。

### 1.3 INSERT / UPDATE / DELETE（未對 production 測寫入，以下為推論）

| 依據 | 結論 |
|---|---|
| `sql/` 明寫 `DISABLE ROW LEVEL SECURITY` 的 14 張表（sara_wip_records、sara_exchange、order_anomaly_*、production_notice_groups、schedule_inquir*、order_change_log、bom_manual_supplement、argoerp_daily_machine_output_snapshots、argoerp_auto_doc_runs、daily_order_sheet_history、engineering_maintenance_records、sara_anomaly_reports） | **確定 anon 可 INSERT/UPDATE/DELETE**：Supabase 預設把 public schema 所有表 GRANT ALL 給 anon/authenticated，RLS 關掉 = 毫無防護。`20260813_production_notice_api_lockdown.sql` 註解說「不啟用 RLS，改由 API 層保護」是誤解——API 守門擋不住直接打 REST 的人。 |
| SECURITY_AUDIT.md SEC-05：~17 張表 `using(true) with check(true)` 且無 `TO` 角色 | **極可能 anon 可寫**（policy 未指定角色 = 套用到 public 含 anon）。這些表的 DDL 已不在 repo（sql/ 只剩 2026-07 以後），無法逐表確認是哪幾張。 |
| 沒有 DDL 的表（members、departments、erp_so_lines、erp_pj_sync、erp_mo_lines、item_routes、operation_times、route_operations、tasks、task_messages、system_logs、system_announcements、info_board_posts…） | **無法從 repo 確認**。請 Snow 在 Supabase SQL Editor 跑 §1.4 的唯讀查詢一次，把結果貼回來即可定案。 |

### 1.4 請 Snow 跑的唯讀查詢（SQL Editor，不改任何東西）

```sql
-- A. 每張表：RLS 有沒有開、有哪些 policy 套到 anon/authenticated/public、指令是什麼
select c.relname as "table",
       c.relrowsecurity as rls_on,
       p.policyname, p.cmd, p.roles, p.qual, p.with_check
from pg_class c
join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
left join pg_policies p on p.schemaname = 'public' and p.tablename = c.relname
where c.relkind = 'r'
order by 1, 3;

-- B. anon 對每張表實際持有的 privilege（SELECT/INSERT/UPDATE/DELETE）
select table_name, string_agg(privilege_type, ',' order by privilege_type) as anon_privs
from information_schema.role_table_grants
where grantee = 'anon' and table_schema = 'public'
group by table_name order by 1;
```

判讀：`rls_on = false` 且 B 有 INSERT → anon 可寫；`rls_on = true` 但 policy 的 `roles` 含 `{public}` 或 `{anon}` 且 `cmd` 是 ALL/INSERT/UPDATE → anon 可寫。

---

## 2. 程式修改（前端改走需登入的伺服器代查）

### 2.1 為什麼是「代查閘門」而不是逐頁改成專屬 API

瀏覽器直連 Supabase 的地方：**60 個檔案、162 處 `.from()`、約 50 張表**（完整清單見 §2.4）。
逐頁重寫成專屬 API route = 重寫半個系統、回歸風險極高。

supabase-js 本質上只是把 `.select().eq().range()` 翻譯成 `GET /rest/v1/<table>?select=…&col=eq.…`。
所以把前端 client 的 base URL 換成我們自己的 **`/api/db`**，它就會自動打到
`/api/db/rest/v1/<table>?…`；伺服器端這支 route 先驗 httpOnly 登入 cookie、對照白名單，再以 service role
轉發給 Supabase。**60 個頁面的查詢程式碼一行都不用改**，卻全部過了登入關卡。
之後任何頁面想「更嚴」（欄位裁剪、逐列權限），再逐一改成專屬 API 即可，閘門不擋這條路。

### 2.2 改動清單

| 檔案 | 內容 |
|---|---|
| `lib/dbProxyAllowlist.ts` **(新)** | 白名單：哪張表能讀（`auth` / `production_admin` / `system_settings`）、能做哪些寫入。**members 刻意不在名單**。附三個純函式：`decideAccess`、`findDisallowedEmbeds`（擋 `select=*,members(*)` 這種嵌入關聯繞道）、`hasRowFilter`（PATCH/DELETE 必須帶條件，拒絕整表操作）。 |
| `app/api/db/rest/v1/[table]/route.ts` **(新)** | 代查閘門。`guardAuthCached` → 白名單 → 只轉發 PostgREST 看得懂的標頭（Prefer/Range/Accept/Content-Type）→ 換成 service role → **串流**回傳（Vercel 4.5MB 回應上限只限非串流）。不轉發瀏覽器的 apikey/Authorization、鎖定 `public` schema、`rpc` 一律 404。 |
| `lib/requireAuth.ts` | 新增 `guardAuthCached()`：驗過的成員以 token SHA-256 為 key 快取 60 秒（一頁常連發幾十個查詢，不快取會每個多兩趟往返）。只快取成功結果。 |
| `lib/supabaseClient.js` / `.d.ts` | `from()` 走 `/api/db`；`storage` / `auth` 仍直連（附件上傳、重設密碼 recovery session）。型別只開 `from / storage / auth`，`channel`/`rpc` 刻意拿掉——RLS 鎖上後 anon 的 Realtime 收不到事件。 |
| `app/api/profile/favorites/route.ts` **(新)** + `context/FavoritesContext.tsx` | 側欄我的最愛：原本 anon 直讀／直改 members（= 任何人能改任何成員的 `is_admin`）→ 只能讀寫自己那列。 |
| `app/api/system-logs/route.ts` **(新)** + `lib/logger.ts` | 系統日誌：操作者改由伺服器 guardAuth 認定。原本靠 `supabase.auth.getUser()`，但瀏覽器沒有 Supabase session，**每一筆都記成 "Unknown"**——順手修好。 |
| `app/qa/report-sales-design/page.tsx` | 「依登入帳號預填部門／人員」改用 `/api/profile`。同樣原因，這段預填以前從未生效過。 |
| `app/tasks/page.tsx` | `postgres_changes` 即時訂閱 → 15 秒輪詢（比照 `app/admin/production/notice/page.tsx`）。 |
| `app/api/admin/members/sync/route.ts` | 不再讀 `members.password`（欄位要刪）；找不到 Auth 帳號的成員列在 failed，請管理員用「設定登入密碼」建立。 |
| `scripts/security/anon-probe.mjs` **(新)** | 曝險探針，套用 migration 前後各跑一次。 |
| `sql/20260927_lockdown_anon.sql` **(新)** | migration，見 §3。 |

### 2.3 白名單權限對照（與 `proxy.ts` 頁面守門一致）

- 讀：全部 `auth`（登入即可），例外 `legacy_inventory_receipts`（成本）與 `system_logs` 各自綁 `production_admin` / `system_settings`。
- 寫：只列前端目前實際會做的操作。`/admin/*` 頁面的寫入綁 `production_admin`；`/admin/team`、`/admin/settings` 的綁 `system_settings`（`production_admin` 可代替，沿用 proxy.ts 規則）；品保／任務／資訊看板的寫入 `auth`。
- **現況 vs 修後**：現況是「網際網路上任何人」；修後是「登入的同事」。這一步先止血；逐頁細化權限是下一階段。

### 2.4 前端直連 Supabase 的完整清單（60 檔）

`app/admin/argoerp/{bulk-order-tracking, daily-order-sheet, erp-db/ErpDbTable, erp-db/bom, erp-sync/ErpSyncPage, group-order-export, material-prep, mo-summary/print, ng-material-prep, order-batch-export, order-batch-export-c, order-batch-export-pr, shortage-tracking, so-change-notices, so-sync, standalone-po-create, standalone-pr-create}`、
`app/admin/{database, materials, materials/substitute, production/anomaly/records, production/anomaly/report, sara/exchange, sara/process-gen(+PendingPastePanel, sheetRows), sara/sara_101-master, sara/sara_101, sara/wip-records, settings/announcements, system-logs, team, upload}`、
`app/{design-studio/so-query, estimation, info-board, info-board/order-records, info-board/schedule, material-issue, notice-board, page, qa/analytics, qa/handling, qa/options/_option-manager, qa/personnel-stats, qa/report-sales-design, qa/upload, reset-password, tasks, upload-photo}`、
`components/{PoOrderModal, ProductionViewer, SaraProductionBoard, SoOrderModal}`、`context/FavoritesContext`、`lib/{logger, qa/deficiencyPrint, sara/clientRowGen}`。
（各檔用到哪些表、哪些操作 → 全部已收進 `lib/dbProxyAllowlist.ts`；`upload-photo`／`reset-password` 只用 storage／auth。）

---

## 3. Migration `sql/20260927_lockdown_anon.sql`（**不要現在跑**）

每張表做三件事（idempotent，重跑無害）：`enable row level security` → 刪掉所有套到 anon/authenticated/public 的 policy → `revoke all … from anon, authenticated`。
service_role 有 BYPASSRLS 且保有自己的 grant，後端 API 完全不受影響。

分四段：
1. **只有後端 API 在用的表（39 張，含 members）** → 任何時候跑都安全。
2. **前端以前直讀、現在走 /api/db 的表（36 張 = 白名單全部）** → ⚠️ **先部署程式碼、確認頁面正常，再跑**。
3. `alter table members drop column if exists password`。
4. （註解掉，建議但可獨立決定）整個 public schema 對 anon 收回 + default privileges，未來新表就算忘了 RLS，anon 也進不來。

回滾：`alter table … disable row level security; grant all on table … to anon, authenticated;`（policy 不會自動長回來；password 欄本來就全空）。

---

## 4. 部署與驗證計畫（順序不能反）

### 4.0 已由本分支完成的驗證
- [x] `tsc --noEmit`、`eslint`、`next build` 全過。
- [x] 白名單純函式單元測試 34 條（decideAccess / memberSatisfies / findDisallowedEmbeds / hasRowFilter）全過。
- [x] 本機 dev server：`/api/db/rest/v1/erp_so_lines` 無 cookie → 401；偽造 JWT → 401；`/api/db/rest/v1/members` → 401；`/api/profile/favorites`、`/api/system-logs` 無 cookie → 401；`rpc` → 404；`/login` 正常 200；production bundle 內確認 client 指向 `/api/db`。
- [ ] **登入後的正向路徑尚未驗證**（我沒有帳密，也不該替你登入）→ 步驟 4.1。

### 4.1 本機／Preview 登入煙霧測試（Snow 操作，約 5 分鐘）
1. `npm run dev` 後登入，依序開：首頁（公告＋我的最愛切換）、`/admin/argoerp/daily-order-sheet`（最重的頁，38+ 查詢）、任一有 SoOrderModal 的頁（例如 `/design-studio/so-query`）、`/tasks`（列表、送訊息、等 15 秒看輪詢）、`/qa/report-sales-design`（部門是否自動預填——這是第一次會生效）、`/admin/settings/announcements`（新增再刪除 → `/admin/system-logs` 應看到操作者是你的名字而不是 Unknown）、`/admin/system-logs`、`/estimation`、`/material-issue`、`/reset-password` 流程（若方便）。
2. 開 DevTools → Network，確認資料表請求全部是 `/api/db/rest/v1/…` 且 200/206，**沒有任何**直接打 `*.supabase.co/rest/v1/` 的請求（storage/auth 的 `*.supabase.co/storage/v1`、`/auth/v1` 是正常的）。
3. 用非管理員帳號重做一次 1.，特別是 `/qa/*`、`/tasks`、`/info-board`。

### 4.2 手動備份（Supabase 是 production 且無自動備份）
Dashboard → Database → Backups 若無法用，改用：
```bash
pg_dump "postgresql://postgres:[PASSWORD]@db.<project-ref>.supabase.co:5432/postgres" --schema=public --no-owner -Fc -f eip_before_lockdown_2026-09-27.dump
```

### 4.3 正式上線
1. 合併 PR → Vercel production 部署完成 → 重做 4.1 的 1–2（production 網址）。
2. SQL Editor 跑 migration **第 1 段 + 第 3 段**（任何時候都安全）→ `node scripts/security/anon-probe.mjs`：members、sara_reports、schedule_inquiries… 應變成 401/0。
3. 確認 production 頁面仍正常（第 1 段不影響前端）。
4. SQL Editor 跑 **第 2 段** → 立刻重跑 probe：**應顯示「anon 可讀且有資料：0 張」、exit code 0**。
5. 再重做 4.1 的 1–3 一次（這次前端是真的靠代查閘門在跑）。
6. 跑 §1.4 的 A/B 查詢，確認上述表沒有 anon/authenticated policy 殘留、anon 沒有任何 privilege。
7. 決定要不要跑第 4 段（整個 schema 對 anon 關門）；跑之前確認其他機器／n8n／Apps Script 沒有拿 anon key 直連（本機所有專案已掃過：沒有）。

### 4.4 出事怎麼辦
- 某頁 403 「需要權限：…」→ 白名單權限標太嚴，改 `lib/dbProxyAllowlist.ts` 重新部署即可，不用動 DB。
- 某頁 404 「資料表 … 不開放前端直接存取」→ 該表漏列白名單（表示盤點漏了），同上。
- 某頁 405 → 前端做了白名單沒列的寫入操作，同上。
- 整站壞 → 回滾 SQL（§3）先恢復，再查。

---

## 5. 與 D39（出單表示意圖 bucket public → private + 簽名網址）的協調

兩件事都碰「每日出單表」與「製令總表列印」，但**本分支沒有改任何頁面的查詢程式碼**（代查閘門的好處），
所以 D39 之後另開小 PR 不會跟這裡衝突。建議順序：**本分支先合併 → D39 再做**，理由：D39 需要一支「換簽名網址」的 API，
正好套同一組 `guardAuth` 慣例，且示意圖網址存在 `daily_order_sheets.sketch_urls`（jsonb），這張表本次已進白名單。

D39 實作範圍（另開 PR）：
1. `app/api/production/order-sketch/route.ts`：`createBucket({ public: false })`、POST 回傳 `path` 而非 `publicUrl`；新增 **GET `?path=`** → `createSignedUrl(path, 3600)`（guardAuth）。
2. 新 `lib/sketchUrl.ts`：把既有存成完整 public URL 的 `sketch_urls` 轉回 bucket path（`…/object/public/order-sketch-images/<path>` → `<path>`），統一由前端呼叫 GET 換簽名網址。
3. 三個消費點改用它：`app/admin/argoerp/daily-order-sheet/page.tsx`（預覽 modal）、`app/admin/argoerp/mo-summary/print/sketchImages.ts`（`resolveSketchUrls`）、**包裝排程專區**（`feat/packaging-schedule` 讀 `sketch_urls` 顯示原檔的地方）。
4. Storage migration：`update storage.buckets set public=false where id='order-sketch-images'` + 刪掉 `storage.objects` 上該 bucket 的 anon policy。同樣「先部署再跑」。
5. 順帶：`anomaly-attachments` bucket 也是 public，且 `/upload-photo`（免登入的手機拍照上傳）靠 anon 直接上傳——這是刻意的公開入口，但要確認 storage policy 只允許 INSERT 到 `mobile/<sid>/`、不允許 list/delete 整個 bucket。不在本次範圍，列為後續。

---

## 6. 殘餘風險與後續

- `authenticated` 角色：本次只對「列出的表」revoke。Snow 若拿自己的 cookie token 直接打 REST，仍可能讀到未列表且 policy 寬鬆的表——第 4 段 + 逐表補 RLS 是下一步。
- `app/notice-board/page.tsx` 還在讀已刪除的 `bom` 表（每次載入必失敗但被吞掉），屬死碼，建議另清。
- SEC-13 仍在：members / departments / erp_* / tasks 等表的 DDL 不在 repo，無法 code review RLS；建議用 `supabase db dump --schema-only` 補進 `sql/baseline/`。
- Realtime：已無前端訂閱；日後若要用，需開 `to authenticated` policy 並讓瀏覽器持有 Supabase session（目前架構沒有）。
- 代查閘門的 60 秒成員快取：停權後最多 60 秒內仍可查（access_token 本身 1 小時效期，影響可接受）。
