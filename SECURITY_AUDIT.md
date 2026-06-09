# EIP(bardshop-factory-os)安全稽核報告

- **稽核日期**:2026-06-09
- **分支**:`security/full-audit`
- **稽核範圍**:全 repo 原始碼(~130 檔)、24 個 SQL migration、19 個 API route、`proxy.ts`、Supabase 金鑰處理、認證/授權流程、RLS、Webhook
- **技術棧**:Next.js 16.1.6 / React 19 / Supabase(Auth + Postgres)/ Vercel
- **整體評級**:🔴 **嚴重(Critical)— 存在「公開外洩的最高權限金鑰」與「明文密碼」,屬資料庫外洩等級事件**

---

## 0. 風險總覽

| ID | 嚴重度 | 問題 | 位置 |
|----|--------|------|------|
| SEC-01 | 🔴 Critical | **Supabase `service_role` 金鑰寫死並 commit 進「公開」repo**(繞過所有 RLS = 整個 DB 最高權限) | `_tmp_migrate.mjs:5`、`_tmp_run_migration.mjs:6`、`_tmp_verify_cols.mjs:5` |
| SEC-02 | 🔴 Critical | **members 表存「明文密碼」,且可透過瀏覽器 anon key 讀取** | `app/apply-account/page.tsx:67`、`app/admin/team/page.tsx:109` |
| SEC-03 | 🔴 Critical | **管理員 API 只靠可偽造的 `bardshop-role` cookie 授權** → 任何人可建立管理員帳號 | `app/api/admin/members/route.ts:44`、`app/api/admin/members/sync/route.ts:35` |
| SEC-04 | 🔴 Critical | **多數 API route 完全無認證**,且使用 service_role → 匿名者可對生產資料表完整 CRUD、操作 ERP | `app/api/argoerp/route.ts`、`app/api/argoerp/*`、`app/api/sara/*` |
| SEC-05 | 🔴 Critical | **RLS 系統性失效**:~17 張表 `using(true) with check(true)` 不限角色 → anon(公開金鑰)可讀寫;`mo_machines` 完全未開 RLS | `sql/*.sql`、`sql/20260505_mo_machine.sql` |
| SEC-06 | 🟠 High | **ARGO ERP 帳密寫死並 commit 進公開 repo**(`ARGOIFAF/ARGOIFAF`) | `_tmp_bom_interface_probe.mjs:7` 等 5 檔 |
| SEC-07 | 🟠 High | **LINE Webhook 無簽章驗證** → 可偽造訊息、用我方 channel token 發送 | `app/api/webhook/line-notify/route.ts`、`line-events/route.ts` |
| SEC-08 | 🟠 High | **資訊洩漏除錯端點**:`/api/sara` 回傳 token 預覽、`/api/sara/schema` 回傳樣本資料(皆無認證) | `app/api/sara/route.ts:71`、`app/api/sara/schema/route.ts:44` |
| SEC-09 | 🟡 Medium | **proxy(middleware)只驗 JWT「格式」不驗「簽章」,且信任前端 cookie 的 role/permissions** | `proxy.ts` |
| SEC-10 | 🟡 Medium | **登入 cookie 缺 `Secure` 旗標** | `app/api/auth/login/route.ts:92-100` |
| SEC-11 | 🟡 Medium | **無任何安全標頭**(CSP / HSTS / X-Frame-Options / X-Content-Type-Options 等) | `next.config.ts` |
| SEC-12 | 🟡 Medium | **ARGO `S_QUERY` 透傳注入**:`table`/`filters`/`projectId` 未跳脫直接帶入 ERP 查詢語言 | `app/api/argoerp/route.ts:357,593,776` |
| SEC-13 | 🟢 Low | `members`、`departments`、`argoerp_mo_summary`、`material_inventory_list`、`erp_so_lines` 的 DDL/RLS 未進版控,無法 code review | `sql/`(缺檔) |

---

## 1. 🚨 立即處置(營運面,需你「現在」手動執行,程式修改無法取代)

> SEC-01 / SEC-02 / SEC-06 屬於**憑證已外洩**。只刪檔、改程式**無效**,因為金鑰已存在於 git 歷史與任何看過此公開 repo 的人手中。必須「輪替(rotate)+ 視為已被入侵」。

1. **輪替 Supabase 金鑰(最優先)**
   - 進 Supabase Dashboard → 專案 `jsybeaebvvzpgrnxwums` → Settings → API →
     **重新產生 `service_role` 金鑰**(及考慮輪替 `anon`/JWT secret)。
   - 更新 Vercel 與本機 `.env.local` 的 `SUPABASE_SERVICE_ROLE_KEY`。
   - 舊金鑰 `exp` 到 2036 年,**不輪替=長期門戶大開**。

2. **把 GitHub repo 改為 Private**(若無公開必要),並評估是否已被存取
   - GitHub → repo → Settings → Danger Zone → Change visibility → Private。
   - 檢視 Supabase 的 Logs / DB 是否有非預期存取(過去 ~12 天)。

3. **視所有成員密碼為已洩漏 → 強制全員改密碼**
   - members 表存明文密碼且公開可讀,應假設**全部帳密已外流**。
   - 立即停用 `apply-account` 公開註冊頁,或改為後端審核。

4. **輪替 ARGO ERP 密碼**(`ARGOIFAF`)及任何 LINE channel token / WEBHOOK_SECRET。

5. **清理 git 歷史中的機密**
   - 刪除所有 `_tmp_*.mjs` 後,用 `git filter-repo`(或 BFG)從**整個歷史**移除外洩字串,force-push。
   - 注意:即使清掉歷史,已外洩金鑰仍須輪替(見第 1 點)。

---

## 2. 詳細發現

### SEC-01 🔴 公開外洩 service_role 金鑰
- 檔案:`_tmp_migrate.mjs:5,27,28`、`_tmp_run_migration.mjs:6`、`_tmp_verify_cols.mjs:5`(另有 `_tmp_check_po_match.mjs`、`_tmp_trace_po.mjs` 從 env 讀同一把)。
- JWT payload:`{"role":"service_role","ref":"jsybeaebvvzpgrnxwums","exp":2085673325}`。
- 加入歷史的 commit:`c0fd128`(2026-05-28)。**repo 為 public**。
- 影響:`service_role` 繞過所有 RLS,等同 DB 超級管理員,可讀寫刪所有資料表、列舉/建立/刪除 Auth 使用者。

### SEC-02 🔴 明文密碼 + anon 可讀
- 公開的註冊頁用瀏覽器 anon client 直接寫入明文密碼:`app/apply-account/page.tsx:67`(`password: formData.password`)。
- 後台用 anon client `select(... password ...)`:`app/admin/team/page.tsx:109`,並可 `update`/`delete`(`:184`、`:232`)。
- members 表的 DDL/RLS 不在 repo,但上述程式能運作,代表 anon/authenticated 對 members 有 SELECT/INSERT 權限且 RLS 寬鬆。
- 影響:任何人用公開 anon key 即可能 dump 全體 email + 明文密碼,並竄改 `is_admin` 提權。

### SEC-03 🔴 管理 API 用可偽造 cookie 授權
- `app/api/admin/members/route.ts:44`:`const role = cookieStore.get('bardshop-role')?.value; if (role !== 'admin') 403`。
- 但 `bardshop-role` 在登入時以**非 httpOnly**寫入(`app/api/auth/login/route.ts:98`),前端可 `document.cookie='bardshop-role=admin'` 偽造。
- 全 repo **沒有任何 route 真正驗證 `bardshop-token`**(無 `admin.auth.getUser(token)`、無 jose 驗章)。
- 影響:匿名者送 `Cookie: bardshop-role=admin` 即可呼叫 `createUser` 建立任意管理員帳號(`members/sync` 同樣問題)。

### SEC-04 🔴 多數 API route 無認證 + service_role
- 19 個 route 僅 2 個有(弱)授權檢查;其餘(`/api/argoerp` 全系列、`/api/sara`、`/api/sara/schema`、`/api/ocr`、兩個 webhook)**完全無認證**。
- 多數使用 `getSupabaseAdminClient()`(service_role,繞 RLS)。
- 影響:匿名者可對 `daily_order_sheets`、`argoerp_*`、`sara_*` 等生產表做含 **DELETE** 的完整 CRUD;`/api/argoerp` 可用我方 ERP 憑證對 ARGO 查詢/匯入。

### SEC-05 🔴 RLS 系統性失效
- 約 17 張表政策為 `using(true) with check(true)` 且**未加 `TO` 角色限制**;在 Postgres 中未指定角色=套用到**所有角色含 `anon`**。
- `mo_machines`(`sql/20260505_mo_machine.sql`)**完全未 `enable row level security`**。
- 僅 3 張表(`argoerp_mo_machine_assign`、`erp_material_prep_lines`、`erp_material_issue_status`)正確限定 `TO service_role`。
- **零**張表使用 `auth.uid()` 做逐列(per-user)RLS。
- 受影響的敏感資料含:`legacy_inventory_receipts`(成本/單價)、`daily_order_sheets`/`argoerp_staging`/`sara_orders`(客戶/訂單)等,皆 anon 可讀寫。

### SEC-06 🟠 ARGO ERP 帳密外洩
- `const USERNAME='ARGOIFAF', PASSWORD='ARGOIFAF', SEGMENT='BARDSHOP'`:`_tmp_bom_interface_probe.mjs:7`、`_tmp_bom_probe2.mjs:5`、`_tmp_bom_write_test.mjs:11`、`_tmp_check_bom_part.mjs:2`、`_tmp_query_argo.mjs:2`。

### SEC-07 🟠 LINE Webhook 無簽章驗證
- `app/api/webhook/line-notify/route.ts`:僅當 `WEBHOOK_SECRET` 有設才檢查 bearer,未設時形同無防護;**未驗 `x-line-signature` HMAC-SHA256**。
- `app/api/webhook/line-events/route.ts`:無驗證、記錄完整 request body。

### SEC-08 🟠 除錯端點資訊洩漏
- `/api/sara` GET 回傳 `tokenPreview`(token 前 16 碼)與 `raw_token`:`app/api/sara/route.ts:71,80`。
- `/api/sara/schema` 回傳所有 `sara_*` 表的欄位與**樣本資料列**:`app/api/sara/schema/route.ts:44`。皆無認證。

### SEC-09 🟡 proxy(middleware)僅驗格式
- `proxy.ts`:`isJwtFormat()` 只檢查三段 base64url 格式,**不驗簽章**(註解亦自承);role/permissions 取自前端可改的 cookie。
- 註:Next.js 16 已將 `middleware` 更名為 `proxy`,故此檔**會執行**;但官方文件明言「應在每個 route handler 內各自驗證授權,不要只靠 proxy」。proxy 亦主動跳過 `/api`。

### SEC-10 🟡 Cookie 缺 Secure
- `app/api/auth/login/route.ts:92-100`:四個 cookie 皆只有 `SameSite=Lax`,無 `Secure`,理論上可經 HTTP 外洩。

### SEC-11 🟡 無安全標頭
- `next.config.ts` 無 `headers()`;缺 CSP、HSTS、X-Frame-Options、X-Content-Type-Options、Referrer-Policy、Permissions-Policy。

### SEC-12 🟡 ARGO S_QUERY 注入
- `app/api/argoerp/route.ts:357,360`:`TABLE: table, ...(filters||{})` 直接帶入;`:593,776` 將 `projectId` 字串內插進 ARGO 查詢運算子,未跳脫/白名單。

### SEC-13 🟢 部分 DDL 未進版控
- `members`、`departments`、`argoerp_mo_summary`、`material_inventory_list`、`erp_so_lines` 僅存在於線上 DB,`sql/` 無對應檔,無法審查其 RLS。

---

## 3. 修復計畫(程式/設定面,可在 `security/full-audit` 分支進行)

依序建議:

1. **(SEC-01/06)** 刪除全部 `_tmp_*.mjs`;將機密改由 `.env.local` 注入;歷史清理 + 金鑰輪替(營運面)。
2. **(SEC-03/04)** 建立 `lib/requireAuth.ts`:從 httpOnly `bardshop-token` 取 JWT → `admin.auth.getUser(token)` 驗證 → 查 members 取得 `is_admin`/permissions → 才放行。所有 `/api/**`(尤其 admin/argoerp/sara)改用此守門。授權**只信 token,不信 role cookie**。
3. **(SEC-02)** 移除 members 的 `password` 欄位;`apply-account`/`team` 的寫入改走後端 service_role route;密碼一律只存於 Supabase Auth。
4. **(SEC-05)** 重寫 RLS:參考資料表→`TO authenticated` 唯讀;寫入→`TO service_role`(由後端);敏感表加 `auth.uid()` 逐列控管;補開 `mo_machines` 的 RLS。將缺漏 DDL 補進 `sql/`。
5. **(SEC-07)** Webhook 加 LINE 簽章驗證(HMAC-SHA256 + channel secret)。
6. **(SEC-08)** 移除/鎖死 sara 除錯端點。
7. **(SEC-10/11)** cookie 加 `Secure`;`next.config.ts` 加安全標頭。
8. **(SEC-12)** ARGO 查詢參數白名單化 + 跳脫。

---

## 附錄:稽核方法
- 靜態原始碼審查(全 API route 逐一閱讀)、SQL/RLS 政策逐表盤點、機密字串掃描、git 歷史與 repo 可見性查核、Next.js 16 `proxy` 慣例與官方安全建議交叉比對。
- 本報告為唯讀稽核,未修改任何功能程式。
