-- 為 erp_material_prep_lines 加入 remark 欄位（批備料單表頭 IV_NOTICE.REMARK，存放機台資訊）
alter table public.erp_material_prep_lines
  add column if not exists remark text;
