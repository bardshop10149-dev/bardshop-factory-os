-- =====================================================================
-- 將批備料頁的臨時設定（原存 localStorage）遷移至 app_settings
-- key: material_prep_overrides
-- value: {
--   qty_overrides: Record<string, string>,
--   material_overrides: Record<string, string>,
--   no_buffer_keys: string[],
--   no_need_keys: string[],
--   custom_code_inputs: Record<string, string>,
--   extra_nobom_slots: Record<string, string[]>
-- }
-- =====================================================================
insert into app_settings (key, value)
values ('material_prep_overrides', '{
  "qty_overrides": {},
  "material_overrides": {},
  "no_buffer_keys": [],
  "no_need_keys": [],
  "custom_code_inputs": {},
  "extra_nobom_slots": {}
}'::jsonb)
on conflict (key) do nothing;
