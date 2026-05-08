-- 將 argoerp_mo_summary 中已分配的機台資料遷移至 argoerp_mo_machine_assign
-- 執行時間：2026-05-07
-- 說明：只遷移 machine 欄位非空的記錄，若 mo_number 已存在則跳過（不覆蓋）

insert into public.argoerp_mo_machine_assign (mo_number, machine, updated_at)
select
  mo_number,
  machine,
  now() as updated_at
from public.argoerp_mo_summary
where machine is not null
  and machine <> ''
on conflict (mo_number) do nothing;

-- 確認遷移結果
select count(*) as migrated_count from public.argoerp_mo_machine_assign;
