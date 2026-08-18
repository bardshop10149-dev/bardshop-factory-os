# 資安第一波緊急止血 — 執行 Checklist

日期：2026-08-14
對應：EIP 全站資安審查報告 Part 1.6「第一波（緊急止血）」
範圍：只處理 members 表相關的 Critical 漏洞（V1 明文密碼外洩、V2 提權、V4 batch-mo-match 無守衛）。
erp_*／bom／庫存／訂單等其他表的 RLS 屬「第二波」，不在本次範圍。

---

## 一、已完成的程式碼修復（本批 commit）

- [x] **V4** `batch-mo-match` 加上授權：要求內部 `X-Internal-Secret`（= WEBHOOK_SECRET）或 `production_admin` 權限；`webhook/sync` 呼叫時帶上該 secret。
- [x] **新後端 API**
  - `GET /api/auth/me`：登入者查自己權限（取代 argo-db 等頁面 anon 讀 members）。
  - `GET /api/admin/members`：列出成員（不含 password 欄位）。
  - `PATCH /api/admin/members`：更新成員（欄位白名單，不接受 password）。
  - `DELETE /api/admin/members`：刪除成員。
  - `GET|POST /api/apply-account`：公開申請帳號（後端建立 Supabase Auth 帳號，密碼只進 Auth，不存明文）。
- [x] **前端改走 API、不再 anon 直碰 members**
  - `app/argo-db/page.tsx` 權限判斷 → `/api/auth/me`
  - `app/apply-account/page.tsx` → `/api/apply-account`
  - `app/admin/team/page.tsx` 讀取/更新/刪除成員 → `/api/admin/members`
- [x] **停止明文密碼寫入**
  - `apply-account`：不再寫 password（Auth 直接建立）。
  - `admin/members` POST：members insert 移除 password 欄位。
  - `profile/password`：移除同步寫回 `members.password` 的那行。
  - （`admin/members/set-password` 本來就只寫 Auth，無明文，維持不動。）

---

## 二、⚠️ 需要「人工」在 Supabase / Vercel 執行（程式碼無法代勞）

依序執行，順序重要：

### 步驟 1 — 先部署上面的程式碼
- [ ] 把本批 commit 部署到正式站，**確認新版前端已上線**（申請帳號、組織成員管理、argo-db 都正常）。
- 理由：RLS 一旦鎖上，舊版前端（還用 anon 讀 members）會壞掉。務必先讓新版上線。

### 步驟 2 — 對 members 開 RLS（擋住明文密碼外洩這個最致命的）
- [ ] 在 Supabase SQL Editor 執行 `sql/20260814_members_rls_lockdown.sql`。
- [ ] 驗證：用 anon key 打 `GET .../rest/v1/members?select=email` 應回空／被拒，不再回全表。

### 步驟 3 — 輪替 service-role 金鑰（V6，疑似曾外洩）
- [ ] Supabase → Project Settings → API → 重新產生 service_role key。
- [ ] 更新 Vercel 環境變數 `SUPABASE_SERVICE_ROLE` / `SUPABASE_SERVICE_ROLE_KEY`，重新部署。

### 步驟 4 — 視同全員密碼已洩漏，強制重設
- [ ] 通知全員改密碼（或由管理員在「組織成員管理」逐一用「設定登入密碼」重設）。
- 理由：明文密碼過去可被匿名下載，必須假設已外洩。

### 步驟 5 — 移除 members.password 明文欄位（做完步驟 4 之後）
- [ ] 確認沒有任何程式再讀 `members.password`（本批已清除所有寫入；
      唯一還讀它的是 `admin/members/sync`，那是給「舊的、只有明文、還沒有 Auth 帳號」的成員一次性補建 Auth 用的）。
- [ ] 先跑 `admin/members/sync` 一次，把所有 `auth_user_id IS NULL` 的舊成員補上 Auth 帳號。
- [ ] 確認全員都有 auth_user_id 後，再執行：
      ```sql
      ALTER TABLE public.members DROP COLUMN IF EXISTS password;
      ```
- [ ] drop 後把 `admin/members/sync` 裡讀 password 的分支一併移除（屆時已無明文可讀）。

---

## 三、下一波（本次未做，供排程參考）

- 第二波：逐表補 RLS（erp_*、bom、庫存、訂單、app_settings…）+ 把仍用 anon 直讀這些表的前端頁面改走 API。工程量最大，需逐頁回歸測試。
- V5 ARGO 查詢注入：table/customColumn/filter 走白名單、權限升到 production_admin。
- 第三波：XSS escape（V7）、upload-photo（V8）、forgot-password Origin（V9）、登出撤 session（V10）、rate limit（V11）。
