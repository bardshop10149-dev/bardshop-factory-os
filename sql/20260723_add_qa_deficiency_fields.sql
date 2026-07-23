-- 2026-07-23
-- 品保專區「異常人員缺失單處理作業」改版：
-- schedule_anomaly_reports 新增品質異常處理單（缺失單）列印所需欄位。
--
-- 背景：缺失單原為 Word 手抄。改為系統填寫後一鍵匯出 Excel，
-- 需補「異常數量」與 (2)責任單位填寫 的三段文字欄位。
--
-- 注意：既有欄位一律不動；部署順序 = 先跑本 SQL，再合併部署程式
-- （personnel-stats 頁的 select 明確清單會引用新欄位）。

ALTER TABLE public.schedule_anomaly_reports
  ADD COLUMN IF NOT EXISTS loss_qty          numeric,
  ADD COLUMN IF NOT EXISTS cause_analysis    text,
  ADD COLUMN IF NOT EXISTS immediate_action  text,
  ADD COLUMN IF NOT EXISTS corrective_action text;

COMMENT ON COLUMN public.schedule_anomaly_reports.loss_qty          IS '異常數量／缺失導致損失數量（列印單：不良數、異常數量）';
COMMENT ON COLUMN public.schedule_anomaly_reports.cause_analysis    IS '異常原因分析（列印單 (2)責任單位填寫）';
COMMENT ON COLUMN public.schedule_anomaly_reports.immediate_action  IS '即時處理方式（列印單 (2)責任單位填寫；異常單處理頁可填）';
COMMENT ON COLUMN public.schedule_anomaly_reports.corrective_action IS '預防及修正方式（列印單 (2)責任單位填寫）';
