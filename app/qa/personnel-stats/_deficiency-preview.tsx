'use client'

import type { DeficiencySheetData } from '../../../lib/qa/deficiencyPrint'

// 缺失單下載前預覽：以 HTML 呈現與 Excel 相同的內容與版面順序，
// 確認無誤後才按「下載 Excel」。
export default function DeficiencyPreviewModal({
  sheets,
  fileName,
  downloading,
  onDownload,
  onClose,
}: {
  sheets: DeficiencySheetData[]
  fileName: string
  downloading: boolean
  onDownload: () => void
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="w-full max-w-[880px] max-h-[92vh] flex flex-col bg-slate-900 border border-slate-700 rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-700">
          <div>
            <h2 className="text-lg font-bold text-white">缺失單預覽</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              共 {sheets.length} 張（一位缺失人員一張）｜檔名：{fileName}
            </p>
          </div>
          <button onClick={onClose} className="px-2 py-1 text-slate-300 hover:text-white">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-6">
          {sheets.map((s, idx) => (
            <div key={s.sheetName} className="bg-white text-black rounded-lg overflow-hidden">
              <div className="px-3 py-1 bg-slate-200 text-slate-600 text-[11px] font-mono">
                第 {idx + 1} / {sheets.length} 張 · 工作表 {s.sheetName}
              </div>
              <table className="w-full text-[12px] border-collapse">
                <tbody>
                  <tr>
                    <td colSpan={4} className="border border-slate-400 text-center text-lg font-bold py-2">品質異常處理單</td>
                  </tr>
                  <tr>
                    <td colSpan={2} className="border border-slate-400 px-2 py-1">編號：{s.serial}</td>
                    <td colSpan={2} className="border border-slate-400 px-2 py-1 text-right">日期：{s.dateText}</td>
                  </tr>
                  <tr>
                    <td rowSpan={4} className="border border-slate-400 px-2 py-1 align-top whitespace-pre-line w-[30%]">
                      {'不良發生點 Occurred Point：\n□進料檢驗　□半成品檢驗\n□成品檢驗　□製圖失誤\n□其它：'}
                    </td>
                    <td className="border border-slate-400 px-2 py-1 bg-slate-100 font-bold text-center w-[16%]">廠商/客戶名稱</td>
                    <td colSpan={2} className="border border-slate-400 px-2 py-1">{s.partnerName || ' '}</td>
                  </tr>
                  <tr>
                    <td className="border border-slate-400 px-2 py-1 bg-slate-100 font-bold text-center">客戶訂單單號</td>
                    <td className="border border-slate-400 px-2 py-1">{s.orderNumber || ' '}</td>
                    <td className="border border-slate-400 px-2 py-1">
                      <span className="bg-slate-100 font-bold px-1">製造單號</span>
                      <span className="text-slate-400 ml-1 text-[11px]">（手填）</span>
                    </td>
                  </tr>
                  <tr>
                    <td className="border border-slate-400 px-2 py-1 bg-slate-100 font-bold text-center">訂單量</td>
                    <td className="border border-slate-400 px-2 py-1">{s.orderQtyText || ' '}</td>
                    <td className="border border-slate-400 px-2 py-1">
                      <span className="bg-slate-100 font-bold px-1">不良數</span> {s.lossText}
                    </td>
                  </tr>
                  <tr>
                    <td className="border border-slate-400 px-2 py-1 bg-slate-100 font-bold text-center">不良率</td>
                    <td className="border border-slate-400 px-2 py-1">{s.rateText || ' '}</td>
                    <td className="border border-slate-400 px-2 py-1">
                      <span className="bg-slate-100 font-bold px-1">異常數量</span> {s.lossText}
                    </td>
                  </tr>
                  <tr>
                    <td className="border border-slate-400 px-2 py-1 bg-slate-100 font-bold text-center">品名規格物料編號</td>
                    <td colSpan={3} className="border border-slate-400 px-2 py-1">{s.itemText || ' '}</td>
                  </tr>

                  <tr><td colSpan={4} className="border border-slate-400 px-2 py-0.5 bg-slate-200 font-bold">（1）發現人填寫</td></tr>
                  <tr>
                    <td colSpan={2} className="border-x border-t border-slate-400 px-2 pt-1">異常狀況說明：</td>
                    <td colSpan={2} className="border-x border-t border-slate-400 px-2 pt-1">經辦：{s.reporter}</td>
                  </tr>
                  <tr>
                    <td colSpan={4} className="border-x border-b border-slate-400 px-2 pb-2 align-top h-[52px] whitespace-pre-line">{s.reason}</td>
                  </tr>

                  <tr><td colSpan={4} className="border border-slate-400 px-2 py-0.5 bg-slate-200 font-bold">（2）責任單位填寫</td></tr>
                  <tr>
                    <td colSpan={2} className="border-x border-t border-slate-400 px-2 pt-1">異常原因分析：</td>
                    <td colSpan={2} className="border-x border-t border-slate-400 px-2 pt-1">責任人員：{s.person}</td>
                  </tr>
                  <tr>
                    <td colSpan={4} className="border-x border-b border-slate-400 px-2 pb-2 align-top h-[46px] whitespace-pre-line">{s.causeAnalysis}</td>
                  </tr>
                  <tr>
                    <td colSpan={2} className="border-x border-t border-slate-400 px-2 pt-1">即時處理方式：</td>
                    <td colSpan={2} className="border-x border-t border-slate-400 px-2 pt-1">人員：{s.handlers}</td>
                  </tr>
                  <tr>
                    <td colSpan={4} className="border-x border-b border-slate-400 px-2 pb-2 align-top h-[46px] whitespace-pre-line">{s.immediateAction}</td>
                  </tr>
                  <tr>
                    <td colSpan={2} className="border-x border-t border-slate-400 px-2 pt-1">預防及修正方式：</td>
                    <td colSpan={2} className="border-x border-t border-slate-400 px-2 pt-1">部門主管：</td>
                  </tr>
                  <tr>
                    <td colSpan={4} className="border-x border-b border-slate-400 px-2 pb-2 align-top h-[46px] whitespace-pre-line">{s.correctiveAction}</td>
                  </tr>

                  <tr>
                    <td className="border border-slate-400 px-2 py-1 bg-slate-100 font-bold text-center">部門</td>
                    <td className="border border-slate-400 px-2 py-1">{s.dept || ' '}</td>
                    <td className="border border-slate-400 px-2 py-1 bg-slate-100 font-bold text-center">缺失人員</td>
                    <td className="border border-slate-400 px-2 py-1">{s.person || ' '}</td>
                  </tr>
                  <tr>
                    <td className="border border-slate-400 px-2 py-1 bg-slate-100 font-bold text-center">（3）處置方式</td>
                    <td colSpan={3} className="border border-slate-400 px-2 py-1">{s.dispositionLine}</td>
                  </tr>
                  <tr>
                    <td colSpan={2} className="border-x border-t border-slate-400 px-2 pt-1">（4）品保判定責任歸屬：</td>
                    <td colSpan={2} className="border-x border-t border-slate-400 px-2 pt-1">經辦人員：</td>
                  </tr>
                  <tr><td colSpan={4} className="border-x border-b border-slate-400 px-2 pb-2 h-[38px]">&nbsp;</td></tr>

                  <tr><td colSpan={4} className="border border-slate-400 px-2 py-0.5 bg-slate-200 font-bold">（5）結案</td></tr>
                  <tr>
                    <td className="border border-slate-400 px-2 py-1">責任單位：</td>
                    <td className="border border-slate-400 px-2 py-1 bg-slate-100 font-bold text-center">總經理</td>
                    <td className="border border-slate-400 px-2 py-1 bg-slate-100 font-bold text-center">品保部</td>
                    <td className="border border-slate-400 px-2 py-1 bg-slate-100 font-bold text-center">部門主管</td>
                  </tr>
                  <tr>
                    <td className="border border-slate-400 px-2 py-1">損失成本：</td>
                    <td rowSpan={2} className="border border-slate-400 h-[40px]">&nbsp;</td>
                    <td rowSpan={2} className="border border-slate-400">&nbsp;</td>
                    <td rowSpan={2} className="border border-slate-400">&nbsp;</td>
                  </tr>
                  <tr><td className="border border-slate-400 px-2 py-1">其他：</td></tr>
                </tbody>
              </table>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between gap-3 px-5 py-3 border-t border-slate-700">
          <p className="text-xs text-slate-500">白底區塊為單子內容；空白處為列印後手寫欄位。</p>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-lg border border-slate-600 text-slate-300 hover:bg-slate-800 text-sm"
            >
              取消
            </button>
            <button
              onClick={onDownload}
              disabled={downloading}
              className="px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white text-sm font-bold"
            >
              {downloading ? '產生中…' : '下載 Excel'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
