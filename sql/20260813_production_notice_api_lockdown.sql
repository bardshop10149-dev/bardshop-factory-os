-- 安全修復：生產管理入口（開單異常統計 / 告示設定 / 群組設定 / 產期詢問記錄）
--
-- 背景：這幾個頁面原本由瀏覽器端用 anon key 直接呼叫 Supabase 存取以下資料表，
-- 完全沒有經過任何登入/權限檢查（實測證實完全未登入的匿名訪客也能直接讀寫）。
-- 已於 2026-08-13 將這 6 張表的存取全部改走後端 API route
-- （app/api/production/order-anomaly、/options、/notice、/notice-group、
--   /schedule-confirm、/schedule-confirm/salespersons），
-- 每個 endpoint 一律先呼叫 lib/requireAuth.ts 的 guardAuth() 要求登入，
-- 再用 lib/supabaseAdmin.ts 的 service role 存取資料庫。
--
-- RLS：比照本專案既有慣例（見 20260701_sara_wip_records.sql、
-- 20260806_sara_exchange.sql）——不啟用 RLS，改由 API 層的 guardAuth() 保護。
-- service role（後端 API 使用）本來就會略過 RLS，所以啟用與否不影響後端存取；
-- 這裡明確停用只是為了讓意圖清楚、與全站其他表格一致，避免未來誤以為
-- 這幾張表「應該」要設 RLS policy 卻沒設。
--
-- ⚠️ 重要前提：往後任何人都不應該再對這幾張表新增瀏覽器端
-- `lib/supabaseClient`（anon key）直接呼叫，否則本次修復的保護會被繞過。
-- 一律透過上述 API route 存取。

ALTER TABLE order_anomaly_records         DISABLE ROW LEVEL SECURITY;
ALTER TABLE order_anomaly_options         DISABLE ROW LEVEL SECURITY;
ALTER TABLE production_notice_groups      DISABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_inquiries            DISABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_inquiry_salespersons DISABLE ROW LEVEL SECURITY;

-- 注意：bom 表未包含在上面——它是全站共用的核心資料表（3803筆，多處其他
-- 頁面仍會直接以 anon key 存取查詢），這次只把「告示設定」頁面對它的存取
-- （group_name 欄位讀寫）改走 API，bom 表本身的 RLS 現況維持不動，
-- 屬於後續「全站 71 個直連 Supabase 的頁面」清查範圍，不在本次修復範圍內。
