'use client'

import { useEffect, useState, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'

// ── 假資料（?demo=1 預覽用）──────────────────────────────────
const DEMO_RECORDS: MoRecord[] = [
  {
    mo_number: 'MOT202605040015',
    planned_start_date: '2026/05/06',
    planned_end_date: '2026/05/20',
    mo_status: 'OPEN',
    department: 'M1100',
    product_code: 'LED-BOX-40',
    lot_number: '台灣客戶股份有限公司',
    planned_qty: '1000',
    source_order: 'RO26050101',
    mo_note: '客製 | LED 方形燈箱 (ABS外殼 / 黑色 / 40×40×21mm)',
    create_date: '2026/05/04',
    factory: 'T',
    prep_status: 'PENDING',
  },
  {
    mo_number: 'MOC202605040023',
    planned_start_date: '2026/05/07',
    planned_end_date: '2026/05/30',
    mo_status: 'OPEN',
    department: 'M1100',
    product_code: 'PCB-V2-CP',
    lot_number: '常平外銷客戶',
    planned_qty: '500',
    source_order: 'RO26050203',
    mo_note: 'SMT 貼片 / 標準版 / 需 QC 全檢',
    create_date: '2026/05/04',
    factory: 'C',
    prep_status: 'READY',
  },
]

const DEMO_SO_MAP = new Map<string, SoLine>([
  ['RO26050101|15', {
    project_id: 'RO26050101', line_no: '15',
    mbp_part: 'LED-BOX-40', mbp_ver: 1,
    partner_name: '台灣客戶股份有限公司', sales_name: '陳業務',
    duedate: '2026/05/20',
    order_qty_oru: 1000, unit_of_measure_oru: '個',
    description: 'LED 方形燈箱（40mm ABS）',
    remark: '客製顏色：黑色，需附保固書',
    packing: 'OPP 袋裝，每盒 50 個，外箱 10 盒',
    remark2: '出貨前請確認 LED 亮度測試報告',
    grade: null,
  }],
  ['RO26050203|23', {
    project_id: 'RO26050203', line_no: '23',
    mbp_part: 'PCB-V2-CP', mbp_ver: 2,
    partner_name: '常平外銷客戶', sales_name: '李業務',
    duedate: '2026/05/30',
    order_qty_oru: 500, unit_of_measure_oru: 'PCS',
    description: 'PCB 控制板 V2',
    remark: 'SMT 貼片規格見附件BOM',
    packing: '防靜電袋，每包 10 片',
    remark2: null,
    grade: 'A',
  }],
])

// ── 型別 ────────────────────────────────────────────────────
interface MoRecord {
  mo_number: string
  planned_start_date?: string
  planned_end_date?: string
  mo_status?: string
  department?: string
  product_code?: string
  lot_number?: string
  planned_qty?: string
  source_order?: string
  mo_note?: string
  create_date?: string
  factory?: string
  prep_status?: string
  machine?: string
  line_no_override?: string  // 直接指定行號（供每日出單表列印使用）
}

interface SoLine {
  project_id: string
  line_no: string
  mbp_part: string | null
  mbp_ver: number | null
  partner_name: string | null
  sales_name: string | null
  duedate: string | null
  order_qty_oru: number | null
  unit_of_measure_oru: string | null
  description: string | null
  remark: string | null
  packing: string | null
  remark2: string | null
  grade: string | null
  // legacy aliases (fallback)
  part?: string | null
  order_qty?: number | null
  unit_of_measure?: string | null
}

// ── 工具函式 ─────────────────────────────────────────────────
const FACTORY_LABEL: Record<string, string> = {
  T: 'T 台北廠',
  C: 'C 常平廠',
  O: 'O 委外廠',
}

const FACTORY_COLOR: Record<string, string> = {
  T: '#1d4ed8',
  C: '#c2410c',
  O: '#7c3aed',
}

function getLineNo(mo: MoRecord): string {
  if (mo.line_no_override !== undefined && mo.line_no_override !== null && mo.line_no_override !== '') {
    const n = parseInt(mo.line_no_override, 10)
    return isNaN(n) ? mo.line_no_override : String(n)
  }
  // 製令號格式：MO{廠別}{soDateDigits}{seqStr(2碼)}
  // 末 2 碼為來源訂單項號（LINE_NO padStart 2）
  const last2 = mo.mo_number.slice(-2)
  const n = parseInt(last2, 10)
  return isNaN(n) ? '0' : String(n)
}

// ── 子元件 ───────────────────────────────────────────────────
function SectionTitle({ children, color = '#1e3a5f' }: { children: string; color?: string }) {
  return (
    <div style={{
      background: color, color: 'white',
      padding: '4px 10px', fontSize: '15px', fontWeight: 'bold',
      marginBottom: '6px', letterSpacing: '0.5px',
    }}>
      {children}
    </div>
  )
}

function InfoGrid({ rows }: {
  rows: Array<[string, string | null | undefined] | [string, string | null | undefined, string, string | null | undefined]>
}) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i}>
            <td style={{ padding: '3px 6px', fontSize: '14px', color: '#555', background: '#f5f6f8', width: '70px', whiteSpace: 'nowrap', border: '1px solid #e2e4e8' }}>
              {row[0]}
            </td>
            <td style={{ padding: '3px 6px', fontSize: '15px', fontWeight: 500, border: '1px solid #e2e4e8', wordBreak: 'break-word' }}
              colSpan={row.length === 2 ? 3 : 1}>
              {row[1] || '—'}
            </td>
            {row.length === 4 && (
              <>
                <td style={{ padding: '3px 6px', fontSize: '14px', color: '#555', background: '#f5f6f8', width: '70px', whiteSpace: 'nowrap', border: '1px solid #e2e4e8' }}>
                  {row[2]}
                </td>
                <td style={{ padding: '3px 6px', fontSize: '15px', fontWeight: 500, border: '1px solid #e2e4e8', wordBreak: 'break-word' }}>
                  {row[3] || '—'}
                </td>
              </>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ── 主頁面 ───────────────────────────────────────────────────
function MoPrintContent() {
  const searchParams = useSearchParams()
  const isDemo = searchParams.get('demo') === '1'

  const [records, setRecords] = useState<MoRecord[]>([])
  const [soMap, setSoMap]     = useState<Map<string, SoLine>>(new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)
  const printTime = new Date().toLocaleString('zh-TW')

  useEffect(() => {
    // ── Demo 模式：使用假資料，不讀 sessionStorage ──
    if (isDemo) {
      setRecords(DEMO_RECORDS)
      setSoMap(DEMO_SO_MAP)
      setLoading(false)
      return
    }

    try {
      const raw = sessionStorage.getItem('mo_print_selection')
      if (!raw) {
        setError('無選取製令資料，請返回製令總表重新選擇。')
        setLoading(false)
        return
      }
      const mos = JSON.parse(raw) as MoRecord[]
      setRecords(mos)

      const projectIds = [
        ...new Set(mos.map(m => m.source_order).filter((x): x is string => !!x)),
      ]
      if (projectIds.length === 0) { setLoading(false); return }

      void (async () => {
        const { data, error: err } = await supabase
          .from('erp_so_lines')
          .select('project_id,line_no,mbp_part,mbp_ver,partner_name,sales_name,duedate,order_qty_oru,unit_of_measure_oru,description,remark,packing,remark2,grade,part,order_qty,unit_of_measure')
          .in('project_id', projectIds)
        if (err) console.error('so fetch:', err)

        const map = new Map<string, SoLine>()
        for (const row of (data ?? []) as SoLine[]) {
          const normalizedLine = String(parseInt(String(row.line_no || '0'), 10))
          map.set(`${row.project_id}|${normalizedLine}`, row)
        }
        setSoMap(map)
        setLoading(false)
      })()
    } catch (e) {
      setError(e instanceof Error ? e.message : '資料讀取失敗')
      setLoading(false)
    }
  }, [isDemo])

  // ── Loading / Error states ──
  if (loading) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f3f4f6' }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: '24px', marginBottom: '8px' }}>⏳</div>
        <p style={{ color: '#6b7280', fontSize: '14px' }}>載入製令與訂單資料中...</p>
      </div>
    </div>
  )

  if (error) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f3f4f6' }}>
      <div style={{ textAlign: 'center', maxWidth: '400px' }}>
        <div style={{ fontSize: '32px', marginBottom: '12px' }}>⚠️</div>
        <p style={{ color: '#dc2626', marginBottom: '16px', fontSize: '14px' }}>{error}</p>
        <button
          onClick={() => window.close()}
          style={{ padding: '8px 20px', background: '#e5e7eb', borderRadius: '6px', cursor: 'pointer', fontSize: '13px' }}
        >
          關閉視窗
        </button>
      </div>
    </div>
  )

  return (
    <>
      {/* ── 全域列印 CSS ───────────────────────────────────── */}
      <style dangerouslySetInnerHTML={{ __html: `
        @page { size: A4 portrait; margin: 0; }
        @media print {
          .mo-toolbar { display: none !important; }
          .no-print { display: none !important; }
          * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
          html, body { background: white !important; color: black !important; }
          /* 隱藏 admin layout 的裝飾背景層 */
          body > * { background: white !important; }
          .fixed, [class*="fixed"] { display: none !important; }
          main { background: white !important; padding: 0 !important; min-height: unset !important; }
          .mo-pages-wrapper { padding: 0 !important; background: white !important; }
          .mo-card {
            box-shadow: none !important;
            margin: 0 !important;
            page-break-after: always;
            break-after: page;
          }
          .mo-card:last-child {
            page-break-after: auto;
            break-after: auto;
          }
        }
      `}} />

      {/* ── 工具列（列印時隱藏）─────────────────────────────── */}
      <div className="mo-toolbar" style={{
        position: 'sticky', top: 0, zIndex: 50,
        background: '#0f172a', color: 'white',
        padding: '10px 24px',
        display: 'flex', alignItems: 'center', gap: '12px',
        borderBottom: '1px solid #1e293b',
        boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
      }}>
        <button
          onClick={() => window.close()}
          style={{ padding: '6px 14px', background: '#334155', borderRadius: '6px', cursor: 'pointer', color: '#e2e8f0', fontSize: '13px', border: 'none' }}
        >
          ← 返回
        </button>

        <span style={{ fontSize: '13px', color: '#94a3b8' }}>
          {isDemo
            ? <span>🎨 <strong style={{ color: '#fbbf24' }}>設計預覽模式</strong>（假資料，僅供格式調整）</span>
            : <>列印預覽 — 共 <strong style={{ color: 'white' }}>{records.length}</strong> 張製令</>
          }
        </span>

        <div style={{ fontSize: '11px', color: '#64748b' }}>
          （每張為一個 A4 直式頁面，PDF 請選「另存為 PDF」）
        </div>

        <div style={{ marginLeft: 'auto', display: 'flex', gap: '8px', alignItems: 'center' }}>
          <span style={{ fontSize: '11px', color: '#475569' }}>
            SO 資料：{soMap.size} 行已載入
          </span>
          <button
            onClick={() => window.print()}
            style={{
              padding: '8px 22px', background: '#0891b2', borderRadius: '6px',
              cursor: 'pointer', color: 'white', fontSize: '13px',
              fontWeight: 700, border: 'none',
            }}
          >
            🖨 列印 / 下載 PDF
          </button>
        </div>
      </div>

      {/* ── 頁面容器 ───────────────────────────────────────── */}
      <div className="mo-pages-wrapper" style={{ background: '#64748b', padding: '24px 16px', minHeight: '100vh' }}>
        {records.map((mo, idx) => {
          const lineNo = getLineNo(mo)
          const so = soMap.get(`${mo.source_order ?? ''}|${lineNo}`)

          const part   = so?.mbp_part || so?.part || null
          const qty    = so?.order_qty_oru ?? so?.order_qty ?? null
          const uom    = so?.unit_of_measure_oru || so?.unit_of_measure || null
          const qtyStr = qty != null ? `${qty}${uom ? ' ' + uom : ''}`.trim() : null

          const labelTd = { border: '1px solid #ccc', padding: '4px 6px', fontSize: '14px', color: '#555', background: '#f2f2f2', width: '70px', whiteSpace: 'nowrap' as const }
          const valueTd = { border: '1px solid #ccc', padding: '4px 6px', fontSize: '15px', fontWeight: 500 as const, wordBreak: 'break-word' as const }
          const writeTd = { border: '1px solid #ccc', padding: '0 8px', height: '36px' }

          return (
            <div
              key={mo.mo_number}
              className="mo-card"
              style={{
                width: '210mm',
                minHeight: '297mm',
                background: 'white',
                margin: '0 auto 24px',
                padding: '13mm 15mm 10mm',
                boxSizing: 'border-box',
                boxShadow: '0 4px 24px rgba(0,0,0,0.35)',
                display: 'flex',
                flexDirection: 'column',
                fontFamily: 'Arial, "Microsoft JhengHei", "PingFang TC", sans-serif',
                color: '#111',
              }}
            >
              {/* ── 頁首（3欄：製令號+急打樣 ｜ 置中標題 ｜ 廠別+日期）── */}
              <div style={{
                display: 'grid',
                gridTemplateColumns: '1fr auto 1fr',
                alignItems: 'center',
                gap: '8px',
                borderBottom: '2px solid #000',
                paddingBottom: '8px',
                marginBottom: '10px',
              }}>
                {/* 左：製令號 + 急件/打樣 checkbox */}
                <div>
                  <div style={{
                    fontFamily: 'Arial, "Microsoft JhengHei", "PingFang TC", sans-serif', fontSize: '22px', fontWeight: 'bold',
                    letterSpacing: '1px', background: '#f0f0f0',
                    padding: '3px 8px', border: '1px solid #555',
                    display: 'inline-block', borderRadius: '3px', color: '#000',
                  }}>
                    {mo.mo_number}
                  </div>
                  <div style={{ marginTop: '6px', display: 'flex', gap: '6px' }}>
                    {(['急件單', '打樣單'] as const).map(label => (
                      <div key={label} style={{
                        border: '1.5px solid #333', padding: '3px 8px', borderRadius: '2px',
                        fontSize: '15px', fontWeight: 700,
                        display: 'flex', alignItems: 'center', gap: '6px',
                      }}>
                        <span style={{
                          display: 'inline-block', width: '14px', height: '14px',
                          border: '1.5px solid #333', borderRadius: '2px', flexShrink: 0,
                        }} />
                        {label}
                      </div>
                    ))}
                  </div>
                </div>

                {/* 中：製令工單（置中）*/}
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: '36px', fontWeight: 900, letterSpacing: '5px', color: '#000', WebkitTextStroke: '1px #000' }}>
                    製令工單
                  </div>
                  <div style={{ fontSize: '14px', color: '#666', marginTop: '3px', letterSpacing: '1px' }}>
                    Manufacturing Order
                  </div>
                </div>

                {/* 右：印刷機台（手填框）*/}
                <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center' }}>
                  <div style={{ border: '2px solid #222', borderRadius: '4px', padding: '8px 14px', minWidth: '210px' }}>
                    <div style={{ fontSize: '11px', color: '#555', marginBottom: '6px', fontWeight: 600, letterSpacing: '1px' }}>印刷機台</div>
                    <div style={{
                      borderBottom: mo.machine ? 'none' : '1.5px solid #888',
                      height: '36px', fontSize: '22px', fontWeight: 800,
                      display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
                      letterSpacing: '1px',
                    }}>
                      {mo.machine || ''}
                    </div>
                  </div>
                </div>
              </div>

              {/* ── 製令資訊 + 交期資訊（左右並排）── */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '10px', alignItems: 'stretch' }}>

                {/* 左：製令資訊 */}
                <div>
                  <SectionTitle color="#222">製令資訊</SectionTitle>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <tbody>
                      {([
                        ['生產貨號', mo.product_code],
                        ['客戶名稱', mo.lot_number],
                        ['預訂產出量', mo.planned_qty ?? null],
                        ['廠別', FACTORY_LABEL[mo.factory ?? ''] ?? mo.factory ?? '—'],
                        ['開立日', mo.create_date ?? null],
                      ] as [string, string | null | undefined][]).map(([label, val]) => (
                        <tr key={label} style={{ height: '36px' }}>
                          <td style={labelTd}>{label}</td>
                          <td style={valueTd}>{val || '—'}</td>
                        </tr>
                      ))}
                      {mo.mo_note && (
                        <tr>
                          <td style={labelTd}>製令說明</td>
                          <td style={valueTd}>{mo.mo_note}</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                {/* 右：交期資訊 */}
                <div>
                  <SectionTitle color="#222">交期資訊</SectionTitle>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <tbody>
                      <tr>
                        <td style={labelTd}>印刷交期</td>
                        <td style={{ ...writeTd, height: '54px' }} />
                      </tr>
                      <tr>
                        <td style={labelTd}>雷切交期</td>
                        <td style={{ ...writeTd, height: '54px' }} />
                      </tr>
                      <tr>
                        <td style={labelTd}>後加工交期</td>
                        <td style={{ ...writeTd, height: 'auto', padding: '6px 8px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                            {/* 左：日期填寫空間 */}
                            <div style={{ flex: '0 0 auto', width: '90px', height: '28px' }} />
                            {/* 右：勾選項 */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', flex: 1 }}>
                              <span style={{ fontSize: '13px', color: '#444', whiteSpace: 'nowrap' }}>類型：</span>
                              {(['貼合', '包邊', '車縫', '胸章', '其他'] as const).map(opt => (
                                <span key={opt} style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', fontSize: '13px', whiteSpace: 'nowrap' }}>
                                  <span style={{
                                    display: 'inline-block', width: '13px', height: '13px',
                                    border: '1.5px solid #333', borderRadius: '1px', flexShrink: 0,
                                  }} />
                                  {opt}
                                </span>
                              ))}
                            </div>
                          </div>
                        </td>
                      </tr>
                      <tr>
                        <td style={labelTd}>出貨交期</td>
                        <td style={{ ...valueTd, fontWeight: 700, fontSize: '17px' }}>
                          {so?.duedate || mo.planned_end_date || '—'}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>

              {/* ── 來源訂單資訊 ── */}
              <div style={{ marginBottom: '10px' }}>
                <SectionTitle color="#222">來源訂單資訊</SectionTitle>
                {so ? (
                  <InfoGrid rows={[
                    ['訂單號', mo.source_order, '項號', lineNo],
                    ['客戶', so.partner_name, '業務員', so.sales_name],
                    ['料號', part, '版本', so.mbp_ver != null ? String(so.mbp_ver) : null],
                    ['訂購數量', qtyStr, '交貨日', so.duedate],
                    ...(so.description ? [['品名', so.description] as [string, string]] : []),
                    ...(so.grade      ? [['等級', so.grade] as [string, string]] : []),
                    ...(so.remark     ? [['REMARK', so.remark] as [string, string]] : []),
                    ...(so.packing    ? [['PACKING', so.packing] as [string, string]] : []),
                    ...(so.remark2    ? [['REMARK2', so.remark2] as [string, string]] : []),
                  ]} />
                ) : (
                  <>
                    <InfoGrid rows={[
                      ['訂單號', mo.source_order, '項號', lineNo],
                    ]} />
                    <div style={{ padding: '8px 6px', color: '#9ca3af', fontSize: '10px', fontStyle: 'italic' }}>
                      {mo.source_order
                        ? '▸ 訂單詳細資訊尚未同步或查無對應行項，請至「銷售訂單同步」頁面執行同步'
                        : '（此製令無來源訂單）'}
                    </div>
                  </>
                )}
              </div>

              {/* ── 生產備註 ── */}
              <div style={{ flex: 1, marginBottom: '10px', display: 'flex', flexDirection: 'column' }}>
                <SectionTitle color="#222">生產備註</SectionTitle>
                <div style={{ border: '1px solid #ccc', flex: 1, padding: '4px 8px' }}>
                  &nbsp;
                </div>
              </div>

              {/* ── 作業確認 ── */}
              <div>
                <SectionTitle color="#222">作業確認</SectionTitle>
                <div style={{
                  display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)',
                  border: '1px solid #bbb',
                }}>
                  {['倉管發料', '品檢抽驗', '包裝人員', '出貨人員'].map((role, ri) => (
                    <div key={role} style={{
                      borderRight: ri < 3 ? '1px solid #bbb' : 'none',
                    }}>
                      {/* 上方：填寫人員 */}
                      <div style={{
                        padding: '6px 10px 28px',
                        borderBottom: '1px solid #bbb',
                      }}>
                        <div style={{ fontSize: '13px', color: '#6b7280', fontWeight: 500 }}>{role}</div>
                      </div>
                      {/* 下方：填寫日期 */}
                      <div style={{
                        padding: '6px 10px 20px',
                      }}>
                        <div style={{ fontSize: '12px', color: '#9ca3af' }}>日期</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* ── 頁尾 ── */}
              <div style={{
                marginTop: '8px', paddingTop: '4px',
                borderTop: '1px solid #e5e7eb',
                display: 'flex', justifyContent: 'space-between',
                fontSize: '12px', color: '#9ca3af',
              }}>
                <span>列印時間：{printTime}</span>
                <span>{idx + 1} / {records.length}</span>
              </div>
            </div>
          )
        })}
      </div>
    </>
  )
}

export default function MoPrintPage() {
  return (
    <Suspense fallback={<div style={{ padding: '40px', textAlign: 'center', color: '#666' }}>載入中…</div>}>
      <MoPrintContent />
    </Suspense>
  )
}
