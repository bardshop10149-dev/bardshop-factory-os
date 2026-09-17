-- 2026-09-17：quote_golden_cases 加「稽核備註」欄（後台核可時顯示來源可信度與手改處）。
-- 可重複執行。回填以 (product_id, name) 對應 seed；之後新匯入的 golden 由後台／匯入流程填。
alter table public.quote_golden_cases add column if not exists audit_note text;

update public.quote_golden_cases set audit_note = '可信度：中。來源 BA26080503 澄鑫 C款（v1.5.2，2026-08-05 存檔）。B5 三方重算對到 1e-10；但成本率 C5 是手打 0.72、柯式版數 C17=4 沒跟著款數變、外形刀仍是舊價 12（月費 9360）。核可＝認定「柯式＋紙卡階梯＋舊刀價」這套邏輯正確，不是認定現價。' where product_id = 'keyring' and name = 'C款 吊飾 5 萬（柯氏、鑰匙圈、舊刀價）';
update public.quote_golden_cases set audit_note = '可信度：中。同 C款檔的 2.1万 分頁，跟 5 萬那頁只差紙卡單價 0.3（階梯手打）。跟 5 萬那筆一起核或一起不核。' where product_id = 'keyring' and name = 'C款 吊飾 2.1 萬（紙卡階梯 0.3）';
update public.quote_golden_cases set audit_note = '可信度：中。同 C款檔的 5000 分頁：紙卡 0.5、成本率手打 0.70（不是 0.72）。驗固定製版費在小量時的攤提。' where product_id = 'keyring' and name = 'C款 吊飾 5000（r=0.70、紙卡 0.5）';
update public.quote_golden_cases set audit_note = '可信度：中高。BA26082304 关关 登山沟（v1.5.6，2026-08-25）。常數全有來源；三處手改引擎照抄：第二板 C10=E9/66 不進位、印刷與貼合含第二板（C17=C11+C10）、第二板不進切割段。小龍蝦扣每套 2 顆（C74=E9*2）。' where product_id = 'carabiner' and name = '登山勾 1000（7151、雙板材、小龍蝦扣每套 2 顆、現行刀價）';
update public.quote_golden_cases set audit_note = '可信度：中高，但這是「畫板」不是鑰匙圈——只作參考，不建議在鑰匙圈底下核可。驗耗損 15%、330×440 板、燙金開版費被乘耗損（旗標 fixedFeeScrapApplied）。之後建畫板品項再搬過去。' where product_id = 'keyring' and name = '[畫板參考] ANDY 燙金畫板 1000（s=15、330×440 板、外發固定費）';
update public.quote_golden_cases set audit_note = '可信度：高（純公式、沒有任何手改）。_报价模板_v1.5.6 空白模板的預設案（5×5、5,000、7151 單面）。檔案 2026-09-13 14:51 曾被重存，但數值與 v1.5.6 价格表一致。建議第一個核可：它是純邏輯基準。' where product_id = 'keyring' and name = '空白模板 v1.5.6 預設案（純公式基準）';
update public.quote_golden_cases set audit_note = '可信度：高。Snow 2026-09-15 提供的 _2贴2报价模板_v1.5.6。跟基本模板只差 7 格：A9/A10 兩張 1.8 板、印刷／貼合改双面、L4=30、L7=120；L9 PET 仍单面（彩白彩單張）。' where product_id = 'laminated-keyring' and name = '2貼2 模板 v1.5.6（1.8 + 1.8 雙面印刷貼合）5,000';
update public.quote_golden_cases set audit_note = '可信度：高。_3贴1报价模板_v1.5.6，差異同 2貼2，板為 2.8 + 0.8。' where product_id = 'laminated-keyring' and name = '3貼1 模板 v1.5.6（2.8 + 0.8 雙面印刷貼合）5,000';
