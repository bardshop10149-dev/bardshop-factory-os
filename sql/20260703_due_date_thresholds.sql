-- =====================================================================
-- 交期檢查：各廠別工作天數閾值設定
-- 存入 app_settings，key = 'due_date_thresholds'
-- value 格式：{"T": 4, "C": 5, "O": 5}
--   T = 台北廠, C = 常平廠, O = 委外
-- =====================================================================
insert into app_settings (key, value)
values (
  'due_date_thresholds',
  '{"T": 4, "C": 5, "O": 5}'::jsonb
)
on conflict (key) do nothing;
