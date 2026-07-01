-- 塔台 SARA 報工紀錄（從 CSV 匯入，無法透過 API 取得）
-- work_order 欄位為 SARA 系統內部的工作單 UUID，作為唯一鍵避免重複匯入

CREATE TABLE IF NOT EXISTS public.sara_wip_records (
  id                  bigserial   PRIMARY KEY,
  id_list             text,                        -- 報工 ID 列表（可為逗號分隔多個 ID）
  work_order          text        NOT NULL,        -- 工作單號（UUID，SARA 內部唯一識別碼）
  mo_nbr              text,                        -- 製令單號
  product_name        text,                        -- 生產料號
  product_subname     text,                        -- 品名
  product_description text,                        -- 規格
  lot_nbr             text,                        -- 批號
  doc_nbr             text,                        -- 來源單號（訂貨單號）
  workcenter_name     text,                        -- 站點
  job_name            text,                        -- 製程名稱
  job_sequence        integer,                     -- 工序
  status              text,                        -- 報工狀態（running / finished / pause）
  source_type         text,                        -- 資料來源（sara / auto_sara）
  wip_qty             numeric,                     -- 回報數量
  real_start_time     timestamptz,                 -- 報工開始
  real_end_time       timestamptz,                 -- 報工結束
  report_resources    text,                        -- 報工資源
  username            text,                        -- 報工人員
  imported_at         timestamptz DEFAULT now(),   -- 匯入時間

  UNIQUE(work_order)
);

COMMENT ON TABLE  public.sara_wip_records IS '塔台 SARA 報工紀錄（CSV 匯入）';
COMMENT ON COLUMN public.sara_wip_records.work_order      IS 'SARA 工作單 UUID，唯一鍵';
COMMENT ON COLUMN public.sara_wip_records.doc_nbr         IS '來源單號（即訂貨單號，用於比對每日出單表）';
COMMENT ON COLUMN public.sara_wip_records.workcenter_name IS '站點，比對時以 印刷站2F 篩選';

-- 建立常用查詢索引
CREATE INDEX IF NOT EXISTS sara_wip_records_mo_nbr_idx         ON public.sara_wip_records (mo_nbr);
CREATE INDEX IF NOT EXISTS sara_wip_records_doc_nbr_idx        ON public.sara_wip_records (doc_nbr);
CREATE INDEX IF NOT EXISTS sara_wip_records_workcenter_idx     ON public.sara_wip_records (workcenter_name);
CREATE INDEX IF NOT EXISTS sara_wip_records_real_end_time_idx  ON public.sara_wip_records (real_end_time DESC);

-- RLS：允許已登入使用者完整操作（此為後台管理工具，無需列級權限控管）
ALTER TABLE public.sara_wip_records ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authenticated_all" ON public.sara_wip_records;
CREATE POLICY "authenticated_all" ON public.sara_wip_records
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);
