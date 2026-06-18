-- ============================================================
-- 2026-06-10  批次更名機台（含歷史資料回填）
-- 用途：
-- 1) 更新機台選單名稱（argoerp_machines）
-- 2) 回填既有紀錄中的機台名稱，避免新舊名稱並存
--    - argoerp_mo_machine_assign.machine
--    - argoerp_mo_summary.machine
--    - daily_order_sheets.rows(JSON: machine / assigned_machine)
--    - sara_101_master.assigned_machine
-- ============================================================

begin;

-- 0) 在這裡填入「舊名稱 -> 新名稱」
--    可一次放多組，格式：('舊機台', '新機台')
create temporary table _machine_map (
  old_name text not null,
  new_name text not null
);

insert into _machine_map(old_name, new_name)
values
  ('7151#3', '7151#3')
, ('7151#6', '7151#6')
, ('7151#7', '7151#7')
, ('7151#8', '7151#8')
, ('7151#9', '7151#9')
, ('7151#10', '7151#10')
, ('7151#11', '7151#11')
, ('F10030H', 'EPSON-F10030H')
, ('F3030', 'EPSON-F3030')
, ('熱壓機', '熱壓機')
, ('SWQ', 'swissQ_Impala4')
, ('小雷', '雷射切割機_小雷_GCC')
, ('標籤機', 'EPSON-F130')
, ('UCJV', 'UCJV#1')
, ('P9530', 'P9530')
, ('護膜機', '護膜機(陸)')
, ('馬克杯機', '馬克杯轉印機')
, ('鐳射打標機', '金屬鐳射打標機');

create temporary table _machine_map_valid as
select distinct trim(old_name) as old_name, trim(new_name) as new_name
from _machine_map
where trim(old_name) <> ''
  and trim(new_name) <> ''
  and trim(old_name) <> trim(new_name);

select * from _machine_map_valid;

-- 1) 先補齊選單中的「新名稱」(避免 unique 衝突)
insert into public.argoerp_machines(name, sort_order)
select vm.new_name, coalesce(am.sort_order, 0)
from _machine_map_valid vm
left join public.argoerp_machines am on am.name = vm.old_name
where not exists (
  select 1
  from public.argoerp_machines x
  where x.name = vm.new_name
);

-- 2) 回填 MO 機台分配
update public.argoerp_mo_machine_assign t
set machine = vm.new_name,
    updated_at = now()
from _machine_map_valid vm
where t.machine = vm.old_name;

-- 3) 回填 MO 總表
update public.argoerp_mo_summary t
set machine = vm.new_name
from _machine_map_valid vm
where t.machine = vm.old_name;

-- 4) 回填 daily_order_sheets.rows JSON（machine / assigned_machine）
with
rebuilt as (
  select
    d.sheet_date,
    jsonb_agg(
      jsonb_set(
        jsonb_set(
          e.elem,
          '{machine}',
          to_jsonb(coalesce((select vm.new_name from _machine_map_valid vm where vm.old_name = e.elem->>'machine' limit 1), e.elem->>'machine')),
          true
        ),
        '{assigned_machine}',
        to_jsonb(coalesce((select vm.new_name from _machine_map_valid vm where vm.old_name = e.elem->>'assigned_machine' limit 1), e.elem->>'assigned_machine')),
        true
      )
      order by e.ord
    ) as new_rows
  from public.daily_order_sheets d
  cross join lateral jsonb_array_elements(d.rows) with ordinality as e(elem, ord)
  where jsonb_typeof(d.rows) = 'array'
  group by d.sheet_date
)
update public.daily_order_sheets d
set rows = r.new_rows,
    updated_at = now()
from rebuilt r
where d.sheet_date = r.sheet_date
  and d.rows is distinct from r.new_rows;

-- 5) 回填 SARA_101 總表（若有使用 assigned_machine）
do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'sara_101_master'
      and column_name = 'assigned_machine'
  ) then
    execute '
      update public.sara_101_master t
      set assigned_machine = vm.new_name,
          updated_at = now()
      from _machine_map_valid vm
      where t.assigned_machine = vm.old_name
    ';
  end if;
end
$$;

-- 6) 清掉舊機台選單（只刪除 old_name，保留 new_name）
delete from public.argoerp_machines m
using _machine_map_valid vm
where m.name = vm.old_name;

commit;

-- ============================================================
-- 建議執行前先做快照備份，並先把上面 values 的對照表改好
-- 若只想測試可把最後一行 commit; 改成 rollback;
-- ============================================================
