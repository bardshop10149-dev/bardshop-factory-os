-- ============================================================
-- 2026-05-07  新增 daily_order_sheets — 每日出單表
-- ============================================================
-- 每個日期只有一張出單表（sheet_date 為 PK）
-- rows 欄位為 JSONB 陣列，每筆包含工單欄位 + mo_status 狀態

CREATE TABLE IF NOT EXISTS public.daily_order_sheets (
  sheet_date   date        PRIMARY KEY,
  raw_text     text        NOT NULL DEFAULT '',
  rows         jsonb       NOT NULL DEFAULT '[]'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.daily_order_sheets
  IS '每日出單表 — 儲存每天的工單清單及其製令轉換狀態（已匯入製令 / 暫緩區 / 尚未轉單）';

COMMENT ON COLUMN public.daily_order_sheets.sheet_date
  IS '出單日期（YYYY-MM-DD），一天一張表';

COMMENT ON COLUMN public.daily_order_sheets.raw_text
  IS '原始貼上的 TSV 文字，供重新顯示或重新解析用';

COMMENT ON COLUMN public.daily_order_sheets.rows
  IS 'JSON 陣列，每筆 = SourceRow 欄位 + row_key(唯一識別) + mo_status(null/已匯入製令/暫緩區)';

-- RLS：允許已認證及匿名使用者讀寫（後台使用）
ALTER TABLE public.daily_order_sheets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "allow_all_daily_order_sheets"
  ON public.daily_order_sheets
  FOR ALL
  USING (true)
  WITH CHECK (true);
