-- SARA 資料交換區
-- 用途：本系統將轉換後的塔台格式資料寫入此表，塔台透過 API Key 呼叫 GET /api/sara/exchange 拉取

CREATE TABLE IF NOT EXISTS sara_exchange (
  id           BIGSERIAL PRIMARY KEY,
  data_type    TEXT        NOT NULL,                    -- 資料類型，如 'mo_list' / 'schedule' / 'order_status'
  ref_key      TEXT,                                    -- 參考鍵（如 sheet_date, mo_number 等），方便查詢
  payload      JSONB       NOT NULL,                   -- 轉換後的塔台格式資料
  status       TEXT        NOT NULL DEFAULT 'pending', -- 'pending' | 'consumed'
  note         TEXT,                                    -- 備註
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed_at  TIMESTAMPTZ,                             -- 塔台拉取後回寫時間
  expires_at   TIMESTAMPTZ                              -- 可選：資料到期時間
);

CREATE INDEX IF NOT EXISTS idx_sara_exchange_data_type  ON sara_exchange(data_type);
CREATE INDEX IF NOT EXISTS idx_sara_exchange_status     ON sara_exchange(status);
CREATE INDEX IF NOT EXISTS idx_sara_exchange_created_at ON sara_exchange(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sara_exchange_ref_key    ON sara_exchange(ref_key);

-- RLS：關閉（由 API 層的 API Key 驗證保護）
ALTER TABLE sara_exchange DISABLE ROW LEVEL SECURITY;
