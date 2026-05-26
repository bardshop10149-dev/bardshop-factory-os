-- 2026-05-26  mm_bom_part_units 新增 part_name、part_desc 欄位
-- 同步來源：ARGO MM_BOM_PART.PART_NAME / PART_DESC

ALTER TABLE public.mm_bom_part_units
  ADD COLUMN IF NOT EXISTS part_name text,
  ADD COLUMN IF NOT EXISTS part_desc text;

COMMENT ON COLUMN public.mm_bom_part_units.part_name
  IS 'ARGO MM_BOM_PART.PART_NAME（料號中文名稱）';
COMMENT ON COLUMN public.mm_bom_part_units.part_desc
  IS 'ARGO MM_BOM_PART.PART_DESC（規格描述，如顏色/尺寸）';
