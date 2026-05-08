-- 批備料單同步表（ARGO IV_NOTICE + IV_NOTICEDETAIL）
create table if not exists public.erp_material_prep_lines (
  id           bigserial primary key,
  slip_no      text not null,          -- 備料單號 (SLIP_NO)
  slip_date    text,                   -- 備料單日期 (SLIP_DATE)
  mo_number    text,                   -- 製令單號 (PJT_PROJECT_ID)
  fg_part      text,                   -- 製品貨號 (MO_MBP_PART)
  mo_qty       numeric default 0,      -- 生產數量 (MO_QTY)
  line_no      int,                    -- 序號 (LINE_NO)
  mbp_part     text,                   -- 料號 (MBP_PART)
  notice_qty   numeric default 0,      -- 應發數量 (NOTICE_QTY)
  synced_at    timestamptz default now()
);

create index if not exists erp_mpl_slip_no_idx   on public.erp_material_prep_lines (slip_no);
create index if not exists erp_mpl_mo_number_idx  on public.erp_material_prep_lines (mo_number);
create index if not exists erp_mpl_mbp_part_idx   on public.erp_material_prep_lines (mbp_part);

alter table public.erp_material_prep_lines enable row level security;

create policy "service_role full access" on public.erp_material_prep_lines
  for all to service_role using (true) with check (true);
