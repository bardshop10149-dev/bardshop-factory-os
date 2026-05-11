-- ============================================================
-- 2026-05-11  舊系統入庫紀錄資料表
-- 用途：保存從舊系統匯出的 Big5 TSV 入庫紀錄，供後續與 ARGO ERP 比對使用
-- ============================================================

CREATE TABLE IF NOT EXISTS public.legacy_inventory_receipts (
  id                  serial          PRIMARY KEY,

  -- 來源欄位（與原始 CSV 對應）
  entry_no            text            NOT NULL,   -- 日期-號碼 (e.g. "2024/01/01 -1")
  entry_date          date,                       -- 從 entry_no 提取的入庫日期
  entry_seq           int,                        -- 從 entry_no 提取的當日序號
  order_number        text,                       -- 訂貨單號
  source_location     text,                       -- 出庫倉庫/工廠名
  receiving_location  text,                       -- 收貨倉/工廠名
  handler_name        text,                       -- 承辦人編碼名
  item_name           text,                       -- 品項名[規格名]
  good_qty            integer,                    -- 良品數量
  labor_time          integer,                    -- 勞務時間
  pretax_total        numeric(14,4),              -- 稅前總價
  unit_price          numeric(14,4),              -- 進貨單價
  total_cost          numeric(14,4),              -- 製造成本合計
  production_amount   numeric(14,4),              -- 生產金額
  remark              text,                       -- 摘要

  imported_at         timestamptz     NOT NULL DEFAULT now()
);

-- 常用查詢索引
CREATE INDEX IF NOT EXISTS idx_legacy_inv_receipts_entry_date
  ON public.legacy_inventory_receipts (entry_date);
CREATE INDEX IF NOT EXISTS idx_legacy_inv_receipts_order_number
  ON public.legacy_inventory_receipts (order_number);
CREATE INDEX IF NOT EXISTS idx_legacy_inv_receipts_entry_no
  ON public.legacy_inventory_receipts (entry_no);

-- RLS
ALTER TABLE public.legacy_inventory_receipts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_read  ON public.legacy_inventory_receipts;
DROP POLICY IF EXISTS allow_write ON public.legacy_inventory_receipts;
CREATE POLICY allow_read  ON public.legacy_inventory_receipts FOR SELECT USING (true);
CREATE POLICY allow_write ON public.legacy_inventory_receipts FOR ALL    USING (true) WITH CHECK (true);

-- Comments
COMMENT ON TABLE  public.legacy_inventory_receipts
  IS '舊系統入庫紀錄（由 Big5 TSV 匯入），供與 ARGO ERP 資料比對使用';
COMMENT ON COLUMN public.legacy_inventory_receipts.entry_no
  IS '原始「日期-號碼」欄位，格式如 2024/01/01 -1';
COMMENT ON COLUMN public.legacy_inventory_receipts.entry_date
  IS '從 entry_no 解析出的入庫日期';
COMMENT ON COLUMN public.legacy_inventory_receipts.entry_seq
  IS '當日流水序號，從 entry_no 解析';
