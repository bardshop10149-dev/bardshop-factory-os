# 採購專區 ALL 模式不再顯示作廢單與取消行(2026-09-10)

## 公告欄白話版

> 採購專區預設的「ALL」現在只列**活的採購行**:整張作廢的單、以及被採購改成數量 0 的取消行都不再出現。
> 要查作廢單,點狀態快篩的「VOID」即可。

## 技術版

- `lib/purchasing/data.ts`:`loadPoPage` 與 `fetchAllOpenPoRows` 在 `poStatus=ALL` 時加
  `status != 'VOID'` 且 `qty != 0`;其他快篩(OPEN/CLOSE/VOID)行為不變。
- 緣起:2026-09-10 Snow 在 ALL 模式看到 POC2026071601(整張作廢後重開為 071603)與
  POC2026072102/072202 的數量 0 行,「發單燈暗、出貨燈亮」自相矛盾——那是死單掛著常平工作表的舊單號。
- ARGO 的兩種「取消」:整張作廢=表頭 HOLD_STATUS=VOID;單行取消=ORDER_QTY 改 0、狀態仍 OPEN。
  任何「活單」判定都要同時看這兩個欄位。
