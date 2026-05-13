-- 在 argoerp_material_prep_log 新增 argo_slip_no 欄位
-- 用於儲存 ARGO S_IMPORT 成功後回傳的批備料單號（RESULT[].SLIP_NO）
ALTER TABLE public.argoerp_material_prep_log
  ADD COLUMN IF NOT EXISTS argo_slip_no text;

COMMENT ON COLUMN public.argoerp_material_prep_log.argo_slip_no
  IS 'ARGO ERP S_IMPORT 成功後回傳的批備料單號（RESULT[].SLIP_NO；若有多筆以逗號分隔）';
