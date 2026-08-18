-- ============================================================================
-- 資安緊急止血：members 表 RLS 鎖定（對應資安審查 V1 / V2 / V3）
-- 日期：2026-08-14
--
-- 背景：members 表原本對 anon（前端公開金鑰）完全開放讀寫，導致：
--   V1 任何人不需登入即可 dump 全體員工 email + 明文密碼 + is_admin 管理員旗標
--   V2 任何人可 update members set is_admin=true 提權成管理員
--   V3 帳號資料任意外洩/竄改
--
-- 前置作業（已於同批程式碼修復完成，必須先部署再跑本 SQL）：
--   - 申請帳號、組織成員管理、argo-db 權限判斷全部改走後端 API（guardAuth/guardAdmin），
--     前端不再用 anon key 直接讀寫 members。
--   - 停止一切明文密碼寫入（申請時直接建立 Supabase Auth 帳號，密碼只進 Auth）。
--   後端 API 使用 service_role client，service_role 本來就會「繞過」RLS，
--   所以啟用 RLS 後、後端功能完全不受影響；被擋掉的只有前端 anon 的直接存取。
--
-- ⚠️ 部署順序很重要：務必「先部署改好的程式碼」，再跑這段 SQL。
--    若先跑 SQL 才部署，舊版前端頁面（仍用 anon 讀 members）會在部署空窗期壞掉。
-- ============================================================================

-- 1. 啟用 RLS
ALTER TABLE public.members ENABLE ROW LEVEL SECURITY;

-- 2. 移除任何既有的寬鬆 policy（清乾淨，避免殘留的 anon 全開 policy 破功）
DO $$
DECLARE pol record;
BEGIN
  FOR pol IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'members'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.members', pol.policyname);
  END LOOP;
END $$;

-- 3. 不建立任何允許 anon / authenticated 角色的 policy。
--    → RLS 啟用且無對應 policy 時，anon 與 authenticated 一律讀寫皆被拒絕。
--    → 後端 API 用 service_role，繞過 RLS，正常運作。
--    這正是本次要的效果：members 只能透過後端 API（有 guardAuth/guardAdmin 把關）存取。

-- 驗證方式（部署後）：
--   用 anon key 打 REST：GET .../rest/v1/members?select=email
--   應回傳 [] 或 401/權限錯誤（不再是全表資料）。
--   對照組 erp_customers 早已是此狀態。
