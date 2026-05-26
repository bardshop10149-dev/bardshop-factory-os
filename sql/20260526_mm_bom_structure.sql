-- BOM 結構表：存放從 ARGO ERP MM_BOM_STRUCTURE 同步的 BOM 展開資料
-- 母件(parent_part) → 子件(child_part) + 用量(child_qty)

create table if not exists mm_bom_structure (
  id              bigserial primary key,
  parent_part     text        not null,   -- MBP_PART    母件料號
  bom_ver         int         not null default 1,  -- MBP_VER
  child_part      text        not null,   -- MBP_CHILD_PART 子件料號
  child_ver       int         not null default 1,  -- MBP_CHILD_VER
  line_no         int         not null default 1,  -- LINE_NO
  child_qty       numeric     not null default 0,  -- CHILD_QTY 每組用量
  child_scrap     numeric     not null default 0,  -- CHILD_SCRAP 損耗率
  lot_child_qty   numeric     null,                -- LOT_CHILD_QTY 批量用量
  lot_base        numeric     null,                -- LOT_BASE 批量基準
  synced_at       timestamptz not null default now(),

  unique (parent_part, bom_ver, child_part, child_ver, line_no)
);

-- 加速查詢「某成品的 BOM 清單」
create index if not exists idx_mm_bom_structure_parent on mm_bom_structure (parent_part, bom_ver);
-- 加速反查「某材料被哪些成品使用」
create index if not exists idx_mm_bom_structure_child  on mm_bom_structure (child_part);

comment on table mm_bom_structure is 'ARGO ERP MM_BOM_STRUCTURE 同步 — BOM 展開結構（母件→子件）';

-- RLS
ALTER TABLE public.mm_bom_structure ENABLE ROW LEVEL SECURITY;
CREATE POLICY allow_read  ON public.mm_bom_structure FOR SELECT USING (true);
CREATE POLICY allow_write ON public.mm_bom_structure FOR ALL    USING (true) WITH CHECK (true);
