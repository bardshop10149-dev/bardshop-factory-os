-- 2026-05-11  erp_customers：ARGO GL_TRADINGPARTNER 客戶資料同步表
-- 欄位來源：PARTNER_ID / CNAME / FULL_CNAME

CREATE TABLE IF NOT EXISTS public.erp_customers (
  id           bigserial PRIMARY KEY,
  partner_id   text        NOT NULL,   -- 客戶代號  (PARTNER_ID)
  cname        text        NOT NULL,   -- 公司簡稱  (CNAME)
  full_cname   text,                   -- 公司全名  (FULL_CNAME)
  synced_at    timestamptz NOT NULL DEFAULT now()
);

-- 唯一索引：以 partner_id 去重（sync 時先 DELETE 再 INSERT，不需 CONFLICT）
CREATE UNIQUE INDEX IF NOT EXISTS erp_customers_partner_id_idx
  ON public.erp_customers (partner_id);

-- 搜尋索引
CREATE INDEX IF NOT EXISTS erp_customers_cname_idx
  ON public.erp_customers (cname);

COMMENT ON TABLE  public.erp_customers              IS '客戶基本資料（同步自 ARGO GL_TRADINGPARTNER）';
COMMENT ON COLUMN public.erp_customers.partner_id   IS '客戶代號 PARTNER_ID';
COMMENT ON COLUMN public.erp_customers.cname        IS '公司簡稱 CNAME';
COMMENT ON COLUMN public.erp_customers.full_cname   IS '公司全名 FULL_CNAME';

-- RLS
ALTER TABLE public.erp_customers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow authenticated read" ON public.erp_customers
  FOR SELECT USING (auth.role() = 'authenticated');
