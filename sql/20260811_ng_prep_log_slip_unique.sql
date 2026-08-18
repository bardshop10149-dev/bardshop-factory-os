-- 2026-08-11  NG補印批備料：argo_slip_no 唯一索引（防止併發重複送單 / 單號重用）
--
-- 背景：app/admin/argoerp/ng-material-prep/page.tsx 的「瑕疵補印」流程會產生
--   ${mo_number}NG${n} 格式的批備料單號，並在送出 ARGO 前先寫入
--   argoerp_material_prep_log 作為「保留位（reservation）」，藉由本索引在
--   資料庫層面擋下同一 argo_slip_no 被第二次插入 —— 即使前端的預飛檢查
--   （重新查詢下一個可用單號）因為競態而被繞過，DB 仍會拒絕第二筆 INSERT
--   （23505 unique_violation），前端再據此中止、不送出重複的 ARGO 匯入。
--
-- ⚠️ 執行順序：先在 Supabase 跑本檔，再部署對應的程式改動
--   （app/api/argoerp/material-prep-log/route.ts 的 POST 需要 23505 才能正確判斷衝突；
--    索引先建好對舊程式無影響 —— 舊程式從不會插入重複 argo_slip_no，若真的重複，
--    舊程式本來就沒有處理、現在只是在 DB 層多一道防線）。
--
-- 去重語句為防禦性（保留 id 最大＝最新寫入那筆），全檔可重複執行（idempotent）。
-- argo_slip_no 允許 NULL（部分舊資料或非 NG 流程可能未填），故用部分索引，
-- 只在「非 NULL」時要求唯一。

DELETE FROM public.argoerp_material_prep_log a
USING public.argoerp_material_prep_log b
WHERE a.argo_slip_no IS NOT NULL
  AND a.argo_slip_no = b.argo_slip_no
  AND a.id < b.id;

CREATE UNIQUE INDEX IF NOT EXISTS argoerp_material_prep_log_argo_slip_no_uidx
  ON public.argoerp_material_prep_log (argo_slip_no)
  WHERE argo_slip_no IS NOT NULL;
