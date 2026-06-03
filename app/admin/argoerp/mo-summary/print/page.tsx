'use client'

import { useEffect, useState, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { exportPoToWord } from './exportWord'

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

const DEMO_SO_MAP = new Map<string, SoLine[]>([
  ['RO26050101', [
    {
      project_id: 'RO26050101', line_no: '15',
      mbp_part: 'LED-BOX-40', mbp_ver: 1,
      tpn_partner_id: null,
      partner_name: '台灣客戶股份有限公司', sales_name: '陳業務',
      duedate: '2026/05/20',
      order_qty_oru: 1000, unit_of_measure_oru: '個',
      description: 'LED 方形燈箱（40mm ABS）',
      remark: '客製顏色：黑色，需附保固書',
      packing: 'OPP 袋裝，每盒 50 個，外箱 10 盒',
      remark2: '出貨前請確認 LED 亮度測試報告',
      grade: null,
    },
    {
      project_id: 'RO26050101', line_no: '16',
      mbp_part: 'LED-DRIVER-40', mbp_ver: 1,
      tpn_partner_id: null,
      partner_name: '台灣客戶股份有限公司', sales_name: '陳業務',
      duedate: '2026/05/22',
      order_qty_oru: 100, unit_of_measure_oru: '個',
      description: 'LED 驅動器（40W）',
      remark: null,
      packing: 'OPP 袋裝',
      remark2: null,
      grade: null,
    },
    {
      project_id: 'RO26050101', line_no: '17',
      mbp_part: 'LED-FRAME-40', mbp_ver: null,
      tpn_partner_id: null,
      partner_name: '台灣客戶股份有限公司', sales_name: '陳業務',
      duedate: '2026/05/22',
      order_qty_oru: 1000, unit_of_measure_oru: '個',
      description: '燈箱邊框（鋁擠型）',
      remark: '表面處理：陽極黑色',
      packing: '紙箱裝，每箱 100 個',
      remark2: null,
      grade: null,
    },
  ]],
  ['RO26050203', [
    {
      project_id: 'RO26050203', line_no: '23',
      mbp_part: 'PCB-V2-CP', mbp_ver: 2,
      tpn_partner_id: null,
      partner_name: '常平外銷客戶', sales_name: '李業務',
      duedate: '2026/05/30',
      order_qty_oru: 500, unit_of_measure_oru: 'PCS',
      description: 'PCB 控制板 V2',
      remark: 'SMT 貼片規格見附件BOM',
      packing: '防靜電袋，每包 10 片',
      remark2: null,
      grade: 'A',
    },
    {
      project_id: 'RO26050203', line_no: '24',
      mbp_part: 'PCB-V2-FULL', mbp_ver: 2,
      tpn_partner_id: null,
      partner_name: '常平外銷客戶', sales_name: '李業務',
      duedate: '2026/05/30',
      order_qty_oru: 200, unit_of_measure_oru: 'PCS',
      description: 'PCB 控制板 V2 完整版',
      remark: '需全檢',
      packing: '防靜電袋',
      remark2: '附測試報告',
      grade: null,
    },
  ]],
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
  po_number?: string | null   // ERP 採購單號（POC/POO 開頭）
}

interface SoLine {
  project_id: string
  line_no: string
  mbp_part: string | null
  mbp_ver: number | null
  tpn_partner_id: string | null
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
const DOW_ZH = ['日', '一', '二', '三', '四', '五', '六'] as const
function dayOfWeekZh(dateStr: string | null | undefined): string {
  if (!dateStr) return ''
  // 支援 YYYY/MM/DD、YYYY-MM-DD 格式
  const d = new Date(dateStr.replace(/\//g, '-'))
  if (isNaN(d.getTime())) return ''
  return `(${DOW_ZH[d.getDay()]})`
}

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
function SectionTitle({ children, color = '#e5e7eb' }: { children: string; color?: string }) {
  return (
    <div style={{
      background: color, color: '#111',
      padding: '4px 10px', fontSize: '15px', fontWeight: 'bold',
      borderLeft: '3px solid #8b8b8b',
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

// ── 採購單卡片（常平 C / 委外 O）────────────────────────────
function PoCard({
  mo, soMap, customerCodeMap,
}: {
  mo: MoRecord
  soMap: Map<string, SoLine[]>
  customerCodeMap: Map<string, string>
}) {
  const lineNo = getLineNo(mo)
  const soLines = soMap.get(mo.source_order ?? '') ?? []
  const so = soLines.find(l => String(parseInt(String(l.line_no || '0'), 10)) === lineNo) ?? soLines[0] ?? null

  const factoryLabel = FACTORY_LABEL[mo.factory ?? ''] ?? mo.factory ?? '—'

  const labelTd: React.CSSProperties = { border: '1px solid #ccc', padding: '4px 6px', fontSize: '14px', color: '#555', background: '#f2f2f2', width: '70px', whiteSpace: 'nowrap' }
  const valueTd: React.CSSProperties = { border: '1px solid #ccc', padding: '4px 6px', fontSize: '15px', fontWeight: 500, wordBreak: 'break-word' }

  return (
    <div
      className="mo-card"
      style={{
        width: '210mm', background: 'white',
        margin: '0 auto 24px', padding: '13mm 15mm 10mm',
        boxSizing: 'border-box', boxShadow: '0 4px 24px rgba(0,0,0,0.35)',
        fontFamily: 'Arial, "Microsoft JhengHei", "PingFang TC", sans-serif',
        color: '#111',
        display: 'flex', flexDirection: 'column', minHeight: 'calc(297mm - 16mm)',
      }}
    >
      {/* ── 頁首（採購單號 ｜ 採購單標題 ｜ 供應廠別）── */}
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr auto 1fr',
        alignItems: 'center', gap: '8px',
        borderBottom: '2px solid #000',
        paddingBottom: '8px', marginBottom: '10px',
      }}>
        {/* 左：採購單號 + 急件/打樣 */}
        <div>
          <div style={{ fontSize: '11px', color: '#555', marginBottom: '3px', fontWeight: 600, letterSpacing: '1px' }}>採購單號</div>
          <div style={{
            fontSize: '22px', fontWeight: 'bold', letterSpacing: '1px',
            background: '#f0f0f0', padding: '3px 8px', border: '1px solid #555',
            display: 'inline-block', borderRadius: '3px', color: '#000',
          }}>
            {mo.po_number || mo.mo_number}
          </div>
          <div style={{ marginTop: '6px', display: 'flex', gap: '6px' }}>
            {(['急件單', '打樣單'] as const).map(label => (
              <div key={label} style={{
                border: '1.5px solid #333', padding: '3px 8px', borderRadius: '2px',
                fontSize: '15px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '6px',
              }}>
                <span style={{ display: 'inline-block', width: '14px', height: '14px', border: '1.5px solid #333', borderRadius: '2px', flexShrink: 0 }} />
                {label}
              </div>
            ))}
          </div>
        </div>

        {/* 中：採購單 大標題 */}
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '36px', fontWeight: 900, letterSpacing: '5px', color: '#000', WebkitTextStroke: '1px #000' }}>
            採購單
          </div>
          <div style={{ fontSize: '14px', color: '#666', marginTop: '3px', letterSpacing: '1px' }}>
            Purchase Order
          </div>
        </div>

        {/* 右：供應廠別 */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center' }}>
          <div style={{ border: '2px solid #222', borderRadius: '4px', padding: '8px 14px', minWidth: '160px', textAlign: 'center' }}>
            <div style={{ fontSize: '11px', color: '#555', marginBottom: '4px', fontWeight: 600, letterSpacing: '1px' }}>供應廠別</div>
            <div style={{ fontSize: '22px', fontWeight: 800, color: '#000', letterSpacing: '1px' }}>
              {factoryLabel}
            </div>
          </div>
        </div>
      </div>

      {/* ── 採購資訊 + 交期資訊（左右並排）── */}
      <div className="mo-section" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '10px', alignItems: 'stretch' }}>
        {/* 左：採購資訊 */}
        <div>
          <SectionTitle color="#e5e7eb">採購資訊</SectionTitle>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <tbody>
              <tr style={{ height: '76px' }}>
                <td style={{ ...labelTd, verticalAlign: 'middle' }}>來源訂單</td>
                <td style={{ ...valueTd, fontSize: '24px', fontWeight: 600, verticalAlign: 'middle' }}>{mo.source_order || '—'}</td>
              </tr>
              <tr style={{ height: '76px' }}>
                <td style={{ ...labelTd, verticalAlign: 'middle' }}>採購數量</td>
                <td style={{ ...valueTd, fontSize: '24px', fontWeight: 600, verticalAlign: 'middle' }}>{mo.planned_qty || '—'}</td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* 右：交期資訊 */}
        <div>
          <SectionTitle color="#e5e7eb">交期資訊</SectionTitle>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <tbody>
              <tr style={{ height: '38px' }}>
                <td style={labelTd}>開立日</td>
                <td style={{ ...valueTd, fontWeight: 600 }}>{mo.create_date || '—'}</td>
              </tr>
              <tr style={{ height: '38px' }}>
                <td style={labelTd}>廠別</td>
                <td style={valueTd}>{factoryLabel || '—'}</td>
              </tr>
              <tr>
                <td style={{ ...labelTd, verticalAlign: 'middle' }}>要求到料日</td>
                <td style={{ ...valueTd, fontWeight: 700, fontSize: '34px', height: '76px', verticalAlign: 'middle' }}>
                  {(() => {
                    const d = so?.duedate || mo.planned_end_date
                    return d ? <>{d} <span style={{ fontSize: '24px' }}>{dayOfWeekZh(d)}</span></> : '—'
                  })()}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* ── 採購備註內容（無標題，直接接在採購資訊/交期資訊下方）── */}
      <div className="mo-section" style={{ marginBottom: '10px' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <tbody>
            <tr>
              <td style={labelTd}>採購貨號</td>
              <td style={{ ...valueTd, fontSize: '13px' }}>{mo.product_code || '—'}</td>
            </tr>
            <tr>
              <td style={{ ...labelTd, whiteSpace: 'normal' }}>品名規格</td>
              <td style={{ ...valueTd, fontSize: '13px' }}>{mo.mo_note || '—'}</td>
            </tr>
            {so?.remark && (
              <tr>
                <td style={labelTd}>訂單備註</td>
                <td style={{ ...valueTd, fontSize: '13px' }}>{so.remark}</td>
              </tr>
            )}
            {so?.packing && (
              <tr>
                <td style={labelTd}>包裝方式</td>
                <td style={{ ...valueTd, fontSize: '13px' }}>{so.packing}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ── 來源訂單資訊 ── */}
      <div className="mo-section" style={{ marginBottom: '10px' }}>
        <SectionTitle color="#e5e7eb">來源訂單資訊</SectionTitle>
        {mo.source_order ? (
          <>
            {/* 訂單摘要列 */}
            <div style={{ display: 'flex', border: '1px solid #e2e4e8', borderBottom: 'none', fontSize: '13px' }}>
              {([
                ['訂單號', mo.source_order, 1],
                ['客戶', (() => {
                  const name = so?.partner_name ?? mo.lot_number ?? '—'
                  const code = so?.tpn_partner_id ?? customerCodeMap.get(name) ?? null
                  return code ? `[${code}] ${name}` : name
                })(), 2],
                ['業務員', so?.sales_name ?? '—', 1],
                ['本採購項號', lineNo, 1],
              ] as [string, string, number][]).map(([lbl, val, flex], i, arr) => (
                <div key={lbl} style={{ display: 'flex', alignItems: 'stretch', flex, borderRight: i < arr.length - 1 ? '1px solid #e2e4e8' : 'none' }}>
                  <div style={{ background: '#f2f2f2', padding: '3px 6px', color: '#555', whiteSpace: 'nowrap' as const, display: 'flex', alignItems: 'center', fontSize: '12px' }}>{lbl}</div>
                  <div style={{ padding: '3px 6px', fontWeight: 500, display: 'flex', alignItems: 'center' }}>{val}</div>
                </div>
              ))}
            </div>
            {/* 全部行項表格 — 本採購項加底色＋星號 */}
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', tableLayout: 'fixed' }}>
              <colgroup>
                <col style={{ width: '32px' }} />
                <col style={{ width: '38%' }} />
                <col style={{ width: '80px' }} />
                <col />
                <col style={{ width: '60px' }} />
              </colgroup>
              <thead>
                <tr style={{ background: '#f5f6f8' }}>
                  {(['序', '品項編碼 / 規格', '數量', '包裝方式', '等級'] as const).map((h, hi) => (
                    <th key={h} style={{ border: '1px solid #e2e4e8', padding: '3px 5px', fontWeight: 600, color: '#555', textAlign: hi === 0 ? 'center' as const : 'left' as const, whiteSpace: 'nowrap' as const, fontSize: '11px' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {soLines.length > 0 ? soLines.map(line => {
                  const lno = String(parseInt(String(line.line_no || '0'), 10))
                  const isThis = lno === lineNo
                  const lqty = line.order_qty_oru ?? line.order_qty
                  const luom = line.unit_of_measure_oru || line.unit_of_measure || ''
                  const td: React.CSSProperties = { border: '1px solid #e2e4e8', padding: '3px 5px', wordBreak: 'break-word', overflowWrap: 'break-word' }
                  return (
                    <tr key={line.line_no} style={{ background: isThis ? '#f3f4f6' : 'white', fontWeight: isThis ? 600 : 400 }}>
                      <td style={{ ...td, textAlign: 'center', whiteSpace: 'nowrap' }}>{lno}{isThis ? ' ★' : ''}</td>
                      <td style={td}>
                        <div style={{ fontWeight: isThis ? 700 : 500 }}>{line.mbp_part || line.part || '—'}</div>
                        <div style={{ fontSize: '11px', color: '#555', marginTop: '1px' }}>{line.description || '—'}</div>
                      </td>
                      <td style={td}>{lqty != null ? `${lqty} ${luom}`.trim() : '—'}</td>
                      <td style={td}>{line.packing || '—'}</td>
                      <td style={{ ...td, textAlign: 'center', whiteSpace: 'nowrap', color: line.grade ? '#000' : '#6b7280', fontWeight: line.grade ? 600 : 400 }}>{line.grade || '—'}</td>
                    </tr>
                  )
                }) : (
                  <tr>
                    <td colSpan={5} style={{ border: '1px solid #e2e4e8', padding: '6px', fontSize: '11px', fontStyle: 'italic', color: '#9ca3af', textAlign: 'center' }}>
                      訂單詳細資訊尚未同步，請至「銷售訂單同步」頁面執行同步
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </>
        ) : (
          <div style={{ padding: '8px 6px', color: '#9ca3af', fontSize: '11px', fontStyle: 'italic' }}>
            （此採購單無來源訂單）
          </div>
        )}
      </div>

      {/* ── 作業確認 ── */}
      <div className="mo-card-footer" style={{ marginTop: 'auto' }}>
        <SectionTitle color="#e5e7eb">作業確認</SectionTitle>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', border: '1px solid #bbb' }}>
          {['倉管收料', '品檢驗收', '入庫作業', '銷單作業'].map((role, ri) => (
            <div key={role} style={{ borderRight: ri < 3 ? '1px solid #bbb' : 'none' }}>
              <div style={{ padding: '6px 10px 28px', borderBottom: '1px solid #bbb' }}>
                <div style={{ fontSize: '13px', color: '#6b7280', fontWeight: 500 }}>{role}</div>
              </div>
              <div style={{ padding: '6px 10px 20px' }}>
                <div style={{ fontSize: '12px', color: '#9ca3af' }}>日期</div>
              </div>
            </div>
          ))}
        </div>
      </div>

    </div>
  )
}

// ── 主頁面 ───────────────────────────────────────────────────
function MoPrintContent() {
  const searchParams = useSearchParams()
  const isDemo = searchParams.get('demo') === '1'

  const [records, setRecords] = useState<MoRecord[]>([])
  const [soMap, setSoMap]     = useState<Map<string, SoLine[]>>(new Map())
  const [customerCodeMap, setCustomerCodeMap] = useState<Map<string, string>>(new Map()) // cname → partner_id
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)

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
      if (projectIds.length === 0) {
        // 沒有來源訂單，仍然載入客戶代碼表供 lot_number 使用
        void (async () => {
          const { data: custData } = await supabase.from('erp_customers').select('partner_id, cname')
          const codeMap = new Map<string, string>()
          for (const c of (custData ?? []) as { partner_id: string; cname: string }[]) codeMap.set(c.cname, c.partner_id)
          setCustomerCodeMap(codeMap)
          setLoading(false)
        })()
        return
      }

      void (async () => {
        const { data, error: err } = await supabase
          .from('erp_so_lines')
          .select('project_id,line_no,mbp_part,mbp_ver,tpn_partner_id,partner_name,sales_name,duedate,order_qty_oru,unit_of_measure_oru,description,remark,packing,remark2,grade,part,order_qty,unit_of_measure')
          .in('project_id', projectIds)
        if (err) console.error('so fetch:', err)

        const map = new Map<string, SoLine[]>()
        for (const row of (data ?? []) as SoLine[]) {
          const existing = map.get(row.project_id) ?? []
          existing.push(row)
          map.set(row.project_id, existing)
        }
        setSoMap(map)

        // 同時載入客戶代碼表（供無 SO 的 lot_number fallback 使用）
        const { data: custData } = await supabase
          .from('erp_customers')
          .select('partner_id, cname')
        const codeMap = new Map<string, string>()
        for (const c of (custData ?? []) as { partner_id: string; cname: string }[]) {
          codeMap.set(c.cname, c.partner_id)
        }
        setCustomerCodeMap(codeMap)

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
        @page { size: A4 portrait; margin: 8mm 0; }
        @media print {
          .mo-toolbar { display: none !important; }
          .no-print { display: none !important; }
          html { -webkit-filter: grayscale(100%) !important; filter: grayscale(100%) !important; }
          * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
          .mo-card,
          .mo-card * {
            color: #000 !important;
            text-shadow: none !important;
            box-shadow: none !important;
          }
          .mo-card th,
          .mo-card td,
          .mo-card tr,
          .mo-card div,
          .mo-card span {
            background: #fff !important;
            border-color: #bbb !important;
          }
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
            break-inside: auto;
            min-height: calc(297mm - 16mm) !important;
            display: flex !important;
            flex-direction: column !important;
          }
          .mo-card:last-child {
            page-break-after: auto;
            break-after: auto;
          }
          /* 只保護單一列（tr）不被從中間切開；section 本身允許換頁 */
          tr {
            break-inside: avoid;
            page-break-inside: avoid;
          }
          /* 作業確認永遠底置 */
          .mo-card-footer {
            margin-top: auto !important;
            break-inside: avoid;
            page-break-inside: avoid;
            break-before: avoid;
            page-break-before: avoid;
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
            : <>列印預覽 — 共 <strong style={{ color: 'white' }}>{records.length}</strong> 張單據（製令 / 採購單）</>
          }
        </span>

        <div style={{ fontSize: '11px', color: '#64748b' }}>
          （每張為一個 A4 直式頁面，PDF 請選「另存為 PDF」）
        </div>

        <div style={{ marginLeft: 'auto', display: 'flex', gap: '8px', alignItems: 'center' }}>
          <span style={{ fontSize: '11px', color: '#475569' }}>
            SO 資料：{soMap.size} 筆訂單已載入
          </span>
          <button
            onClick={() => void exportPoToWord(records, soMap, customerCodeMap)}
            style={{
              padding: '8px 18px', background: '#16a34a', borderRadius: '6px',
              cursor: 'pointer', color: 'white', fontSize: '13px',
              fontWeight: 700, border: 'none',
            }}
          >
            📄 下載 Word
          </button>
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
        {records.map((mo) => {
          // 常平 C / 委外 O → 採購單格式
          if (mo.factory === 'C' || mo.factory === 'O') {
            return <PoCard key={mo.mo_number} mo={mo} soMap={soMap} customerCodeMap={customerCodeMap} />
          }

          const lineNo = getLineNo(mo)
          const soLines = soMap.get(mo.source_order ?? '') ?? []
          const so = soLines.find(l => String(parseInt(String(l.line_no || '0'), 10)) === lineNo) ?? soLines[0] ?? null

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
                background: 'white',
                margin: '0 auto 24px',
                padding: '13mm 15mm 10mm',
                boxSizing: 'border-box',
                boxShadow: '0 4px 24px rgba(0,0,0,0.35)',
                fontFamily: 'Arial, "Microsoft JhengHei", "PingFang TC", sans-serif',
                color: '#111',
                display: 'flex', flexDirection: 'column', minHeight: 'calc(297mm - 16mm)',
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
              <div className="mo-section" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '10px', alignItems: 'stretch' }}>

                {/* 左：製令資訊 */}
                <div>
                  <SectionTitle color="#e5e7eb">製令資訊</SectionTitle>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <tbody>
                      {([
                        ['生產貨號', mo.product_code],
                        ['預訂產出量', mo.planned_qty ?? null],
                        ['廠別', FACTORY_LABEL[mo.factory ?? ''] ?? mo.factory ?? '—'],
                        ['開立日', mo.create_date ?? null],
                      ] as [string, string | null | undefined][]).map(([label, val]) => (
                        <tr key={label} style={{ height: '38px' }}>
                          <td style={labelTd}>{label}</td>
                          <td style={valueTd}>{val || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* 右：交期資訊 */}
                <div>
                  <SectionTitle color="#e5e7eb">交期資訊</SectionTitle>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <tbody>
                      <tr>
                        <td style={labelTd}>印刷交期</td>
                        <td style={{ ...writeTd, height: '38px', width: '30%' }} />
                        <td style={labelTd}>雷切交期</td>
                        <td style={{ ...writeTd, height: '38px' }} />
                      </tr>
                      <tr>
                        <td style={labelTd}>後加工交期</td>
                        <td style={{ ...writeTd, height: '57px', padding: '4px 8px' }} colSpan={3}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                            {/* 左：日期填寫空間 */}
                            <div style={{ flex: '0 0 auto', width: '90px', height: '28px' }} />
                            {/* 右：勾選項 */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', flex: 1 }}>
                              {(['貼合', '包邊', '車縫', '胸章'] as const).map(opt => (
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
                        <td style={{ ...labelTd, verticalAlign: 'middle' }}>出貨交期</td>
                        <td colSpan={3} style={{ ...valueTd, fontWeight: 700, fontSize: '34px', height: '57px', verticalAlign: 'middle' }}>
                          {(() => {
                            const d = so?.duedate || mo.planned_end_date
                            return d ? <>{d} <span style={{ fontSize: '24px' }}>{dayOfWeekZh(d)}</span></> : '—'
                          })()}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>

              {/* ── 來源訂單資訊 ── */}
              <div className="mo-section" style={{ marginBottom: '10px' }}>
                <SectionTitle color="#e5e7eb">來源訂單資訊</SectionTitle>
                {mo.source_order ? (
                  <>
                    {/* 訂單摘要列 */}
                    <div style={{ display: 'flex', border: '1px solid #e2e4e8', borderBottom: 'none', fontSize: '13px' }}>
                      {([
                        ['訂單號', mo.source_order, 1],
                        ['客戶', (() => {
                          const name = so?.partner_name ?? mo.lot_number ?? '—'
                          const code = so?.tpn_partner_id ?? customerCodeMap.get(name) ?? null
                          return code ? `[${code}] ${name}` : name
                        })(), 2],
                        ['業務員', so?.sales_name ?? '—', 1],
                        ['本製令項號', lineNo, 1],
                      ] as [string, string, number][]).map(([lbl, val, flex], i, arr) => (
                        <div key={lbl} style={{ display: 'flex', alignItems: 'stretch', flex, borderRight: i < arr.length - 1 ? '1px solid #e2e4e8' : 'none' }}>
                          <div style={{ background: '#f2f2f2', padding: '3px 6px', color: '#555', whiteSpace: 'nowrap' as const, display: 'flex', alignItems: 'center', fontSize: '12px' }}>{lbl}</div>
                          <div style={{ padding: '3px 6px', fontWeight: 500, display: 'flex', alignItems: 'center' }}>{val}</div>
                        </div>
                      ))}
                    </div>
                    {/* 全部行項表格 */}
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', tableLayout: 'fixed' }}>
                      <colgroup>
                        <col style={{ width: '32px' }} />
                        <col style={{ width: '38%' }} />
                        <col style={{ width: '80px' }} />
                        <col />
                        <col style={{ width: '60px' }} />
                      </colgroup>
                      <thead>
                        <tr style={{ background: '#f5f6f8' }}>
                          {(['序', '品項編碼 / 規格', '數量', '包裝方式', '等級'] as const).map((h, hi) => (
                            <th key={h} style={{ border: '1px solid #e2e4e8', padding: '3px 5px', fontWeight: 600, color: '#555', textAlign: hi === 0 ? 'center' as const : 'left' as const, whiteSpace: 'nowrap' as const, fontSize: '11px' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {soLines.length > 0 ? soLines.map(line => {
                          const lno = String(parseInt(String(line.line_no || '0'), 10))
                          const isThis = lno === lineNo
                          const lqty = line.order_qty_oru ?? line.order_qty
                          const luom = line.unit_of_measure_oru || line.unit_of_measure || ''
                          const td = { border: '1px solid #e2e4e8', padding: '3px 5px', wordBreak: 'break-word' as const, overflowWrap: 'break-word' as const }
                          return (
                            <tr key={line.line_no} style={{ background: isThis ? '#eff6ff' : 'white', fontWeight: isThis ? 600 : 400 }}>
                              <td style={{ ...td, textAlign: 'center' as const, whiteSpace: 'nowrap' as const }}>{lno}{isThis ? ' ★' : ''}</td>
                              <td style={td}>
                                <div style={{ fontWeight: isThis ? 700 : 500 }}>{line.mbp_part || line.part || '—'}</div>
                                <div style={{ fontSize: '11px', color: '#555', marginTop: '1px' }}>{line.description || '—'}</div>
                              </td>
                              <td style={td}>{lqty != null ? `${lqty} ${luom}`.trim() : '—'}</td>
                              <td style={td}>{line.packing || '—'}</td>
                              <td style={{ ...td, textAlign: 'center' as const, whiteSpace: 'nowrap' as const, color: line.grade ? '#7c3aed' : '#9ca3af', fontWeight: line.grade ? 600 : 400 }}>{line.grade || '—'}</td>
                            </tr>
                          )
                        }) : (
                          <tr>
                            <td colSpan={5} style={{ border: '1px solid #e2e4e8', padding: '6px', fontSize: '11px', fontStyle: 'italic' as const, color: '#9ca3af', textAlign: 'center' as const }}>
                              訂單詳細資訊尚未同步，請至「銷售訂單同步」頁面執行同步
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </>
                ) : (
                  <div style={{ padding: '8px 6px', color: '#9ca3af', fontSize: '11px', fontStyle: 'italic' }}>
                    （此製令無來源訂單）
                  </div>
                )}
              </div>

              {/* ── 生產備註 ── */}
              <div style={{ marginBottom: '10px' }}>
                <SectionTitle color="#e5e7eb">生產備註</SectionTitle>
                <div style={{ border: '1px solid #ccc', padding: '4px 8px', minHeight: '56px' }}>
                  &nbsp;
                </div>
              </div>

              {/* ── 作業確認 ── */}
              <div className="mo-card-footer">
                <SectionTitle color="#e5e7eb">作業確認</SectionTitle>
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
