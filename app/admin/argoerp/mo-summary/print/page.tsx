'use client'

import { useCallback, useEffect, useMemo, useRef, useState, Suspense, Fragment } from 'react'
import { useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { matchSketchFiles, resolveSketchImages, resolveSketchUrls, makeSketchLookupKey, type MatchedSketch } from './sketchImages'

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
    is_sample: 'RO26042901',
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
  pr_number?: string | null   // ERP 請購單號（委外 O 列印請購單時使用）
  pr_sub_no?: string | null   // ERP 請購單項號
  is_sample?: string          // 打樣/追加單號（每日出單表原始欄位，非布林值，儘管欄位名稱是 is_sample）
  sketch_urls?: string[]      // 每日出單表該列已存好的示意圖網址（優先於下方選資料夾比對出的結果）
}

interface SoLine {
  project_id: string
  line_no: string
  mbp_part: string | null
  mbp_ver: number | null
  tpn_partner_id: string | null
  partner_name: string | null
  delivery_address?: string | null
  customer_remark?: string | null
  invoice_format?: string | null
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

const RENDER_CHUNK_SIZE = 20

const EXPORT_MODE_LABELS: Record<string, string> = {
  '1': '有統編-發票隨貨',
  '2': '有統編-電子發票',
  '3': '月結合併開立',
  '4': '無統編-發票隨貨',
  '5': '無統編-個人載具',
  '6': '零元或不開立',
  '7': '特殊-請洽業務',
  '8': '至SHOPLINE開立',
}

function formatExportMode(value: string | null | undefined): string {
  const raw = String(value ?? '').trim()
  if (!raw) return '—'
  const label = EXPORT_MODE_LABELS[raw]
  return label ? `${raw} ${label}` : raw
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

function normalizeLineNo(lineNo: string | null | undefined): string {
  const n = parseInt(String(lineNo ?? '0'), 10)
  return isNaN(n) ? String(lineNo ?? '0') : String(n)
}

function createSoLookupKey(projectId: string | null | undefined, lineNo: string | null | undefined): string {
  return `${String(projectId ?? '')}::${normalizeLineNo(lineNo)}`
}

// ── 子元件 ───────────────────────────────────────────────────
function SectionTitle({ children, color = '#e5e7eb' }: { children: string; color?: string }) {
  return (
    <div style={{
      background: color, color: '#111',
      padding: '2px 8px', fontSize: '12px', fontWeight: 'bold',
      borderLeft: '3px solid #8b8b8b',
      marginBottom: '3px', letterSpacing: '0.5px',
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

// ── 示意圖穿插頁：緊跟在對應製令/採購/請購單後面，一張圖/一頁 PDF 各一頁 ──
function SketchCard({ url, label }: { url: string; label: string }) {
  return (
    <div
      className="mo-card sketch-card print-keep-color"
      style={{
        width: '210mm',
        background: 'white',
        margin: '0 auto 24px',
        padding: '5mm 12mm',
        boxSizing: 'border-box',
        boxShadow: '0 4px 24px rgba(0,0,0,0.35)',
        fontFamily: 'Arial, "Microsoft JhengHei", "PingFang TC", sans-serif',
        color: '#111',
        display: 'flex', flexDirection: 'column', minHeight: 'calc(297mm - 8mm)',
      }}
    >
      <div className="sketch-card-label" style={{ fontSize: '12px', color: '#888', marginBottom: '4px' }}>示意圖 — {label}</div>
      <div className="sketch-card-body" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- blob/dataURL 本機圖片，非遠端資源，不適用 next/image */}
        {/* maxHeight 用絕對長度（mm）而非 100%：列印時外層 flex 容器的高度不是確定值，
            百分比高度會算不出來而退回 auto，圖片就以原始尺寸撐出紙張、被裁掉只印出一部分。
            實際列印時的尺寸由下方 @media print 的 .sketch-card img 決定（鋪滿整頁）。 */}
        <img src={url} alt={label} style={{ maxWidth: '100%', maxHeight: '265mm', objectFit: 'contain' }} />
      </div>
    </div>
  )
}

// ── 採購單／請購單卡片（常平 C → 採購單；委外 O → 請購單）──────────
function PoCard({
  mo, soMap, soLineLookup, customerCodeMap, variant = 'po',
}: {
  mo: MoRecord
  soMap: Map<string, SoLine[]>
  soLineLookup: Map<string, SoLine>
  customerCodeMap: Map<string, string>
  variant?: 'po' | 'pr'
}) {
  const isPr = variant === 'pr'
  const docNo = isPr ? (mo.pr_number || mo.mo_number) : (mo.po_number || mo.mo_number)
  const docNoLabel = isPr ? '請購單號' : '採購單號'
  const cardTitle = isPr ? '請購單' : '採購單'
  const cardTitleEn = isPr ? 'Purchase Requisition' : 'Purchase Order'
  const infoTitle = isPr ? '請購資訊' : '採購資訊'
  const qtyLabel = isPr ? '請購數量' : '採購數量'
  const goodsLabel = isPr ? '請購貨號' : '採購貨號'
  const noSourceText = isPr ? '（此請購單無來源訂單）' : '（此採購單無來源訂單）'
  const lineNo = getLineNo(mo)
  const soLines = soMap.get(mo.source_order ?? '') ?? []
  const so = soLineLookup.get(createSoLookupKey(mo.source_order ?? '', lineNo)) ?? soLines[0] ?? null
  const poUnit = so?.unit_of_measure_oru || so?.unit_of_measure || ''
  const poQtyValue = (mo.planned_qty || '').trim()
  const poQtyDisplay = poQtyValue ? `${poQtyValue}${poUnit ? ` ${poUnit}` : ''}` : '—'

  const factoryLabel = FACTORY_LABEL[mo.factory ?? ''] ?? mo.factory ?? '—'

  const labelTd: React.CSSProperties = { border: '1px solid #ccc', padding: '4px 6px', fontSize: '14px', color: '#555', background: '#f2f2f2', width: '70px', whiteSpace: 'nowrap' }
  const valueTd: React.CSSProperties = { border: '1px solid #ccc', padding: '4px 6px', fontSize: '15px', fontWeight: 500, wordBreak: 'break-word' }

  return (
    <div
      className="mo-card"
      style={{
        width: '210mm', background: 'white',
        margin: '0 auto 24px', padding: '5mm 12mm 5mm',
        boxSizing: 'border-box', boxShadow: '0 4px 24px rgba(0,0,0,0.35)',
        fontFamily: 'Arial, "Microsoft JhengHei", "PingFang TC", sans-serif',
        color: '#111',
        display: 'flex', flexDirection: 'column', minHeight: 'calc(297mm - 8mm)',
      }}
    >
      {/* ── 頁首（採購單號 ｜ 採購單標題 ｜ 供應廠別）── */}
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr auto 1fr',
        alignItems: 'center', gap: '8px',
        borderBottom: '2px solid #000',
        paddingBottom: '4px', marginBottom: '6px',
      }}>
        {/* 左：採購單號／請購單號（取消急件/打樣，用空間放大單號）*/}
        <div>
          <div style={{ fontSize: '10px', color: '#555', marginBottom: '3px', fontWeight: 600, letterSpacing: '1px' }}>{docNoLabel}</div>
          <div style={{
            fontSize: '22px', fontWeight: 'bold', letterSpacing: '1px',
            background: '#f0f0f0', padding: '5px 12px', border: '1.5px solid #444',
            display: 'inline-block', borderRadius: '3px', color: '#000',
          }}>
            {docNo}
          </div>
          {/* 委外請購單：若這筆同時已經比對到採購單號，一併列出（不取代請購單號，兩者並列）*/}
          {isPr && mo.po_number && (
            <div style={{ marginTop: '4px' }}>
              <span style={{ fontSize: '10px', color: '#555', fontWeight: 600, letterSpacing: '1px', marginRight: '6px' }}>採購單號</span>
              <span style={{
                fontSize: '15px', fontWeight: 'bold', letterSpacing: '0.5px',
                background: '#f0f0f0', padding: '2px 8px', border: '1px solid #999',
                display: 'inline-block', borderRadius: '3px', color: '#000',
              }}>
                {mo.po_number}
              </span>
            </div>
          )}
          <div style={{ marginTop: '4px' }}>
            <span style={{ fontSize: '10px', color: '#555', fontWeight: 600, letterSpacing: '1px', marginRight: '6px' }}>打樣/追加單號</span>
            <span style={{
              fontSize: '13px', fontWeight: 'bold', letterSpacing: '0.5px',
              background: '#f0f0f0', padding: '2px 8px', border: '1px solid #999',
              display: 'inline-block', borderRadius: '3px', color: '#000', minWidth: '70px', minHeight: '16px',
            }}>
              {mo.is_sample || ''}
            </span>
          </div>
        </div>

        {/* 中：採購單／請購單 大標題 */}
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '22px', fontWeight: 900, letterSpacing: '2px', color: '#000', WebkitTextStroke: '1px #000' }}>
            {cardTitle}
          </div>
          <div style={{ fontSize: '10px', color: '#666', marginTop: '1px', letterSpacing: '1px' }}>
            {cardTitleEn}
          </div>
        </div>

        {/* 右：供應廠別 */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center' }}>
          <div style={{ border: '2px solid #222', borderRadius: '4px', padding: '4px 10px', minWidth: '110px', textAlign: 'center' }}>
            <div style={{ fontSize: '10px', color: '#555', marginBottom: '2px', fontWeight: 600, letterSpacing: '1px' }}>供應廠別</div>
            <div style={{ fontSize: '16px', fontWeight: 800, color: '#000', letterSpacing: '1px' }}>
              {factoryLabel}
            </div>
          </div>
        </div>
      </div>

      {/* ── 採購資訊（合併：訂單資訊 + 交期 + 貨品備註）── */}
      <div className="mo-section" style={{ marginBottom: '10px' }}>
        <SectionTitle color="#e5e7eb">{infoTitle}</SectionTitle>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <tbody>
            <tr>
              <td style={labelTd}>來源訂單</td>
              <td style={{ ...valueTd, fontWeight: 600 }}>{mo.source_order || '—'}</td>
              <td style={labelTd}>開立日</td>
              <td style={valueTd}>{mo.create_date || '—'}</td>
            </tr>
            <tr>
              <td style={labelTd}>{qtyLabel}</td>
              <td style={{ ...valueTd, fontWeight: 600 }}>{poQtyDisplay}</td>
              <td style={labelTd}>廠別</td>
              <td style={valueTd}>{factoryLabel}</td>
            </tr>
            <tr>
              <td style={labelTd}>{goodsLabel}</td>
              <td style={{ ...valueTd, fontSize: '13px' }}>{mo.product_code || '—'}</td>
              <td style={labelTd}>要求到料日</td>
              <td style={{ ...valueTd, fontWeight: 700, fontSize: '20px' }}>
                {(() => {
                  const d = so?.duedate || mo.planned_end_date
                  return d ? <>{d} <span style={{ fontSize: '15px' }}>{dayOfWeekZh(d)}</span></> : '—'
                })()}
              </td>
            </tr>
            <tr>
              <td style={{ ...labelTd, whiteSpace: 'normal' as const }}>品名規格</td>
              <td style={{ ...valueTd, fontSize: '13px' }} colSpan={3}>{mo.mo_note || '—'}</td>
            </tr>
            {so?.customer_remark && (
              <tr>
                <td style={labelTd}>訂單備註</td>
                <td style={{ ...valueTd, fontSize: '13px' }} colSpan={3}>{so.customer_remark}</td>
              </tr>
            )}
            {so?.packing && (
              <tr>
                <td style={labelTd}>包裝方式</td>
                <td style={{ ...valueTd, fontSize: '13px' }} colSpan={3}>{so.packing}</td>
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
            {/* 銷售單號 | 製令項號 | 負責業務 | 發票型態（四欄一行）*/}
            <div style={{ display: 'flex', border: '1px solid #e2e4e8', borderBottom: 'none', fontSize: '12px' }}>
              {([
                ['銷售單號', mo.source_order || '—'],
                ['製令項號', lineNo],
                ['負責業務', so?.sales_name || '—'],
                ['發票型態', formatExportMode(so?.invoice_format || soLines.find(l => l.invoice_format)?.invoice_format)],
              ] as [string, string][]).map(([lbl, val], i) => (
                <div key={lbl} style={{ display: 'flex', alignItems: 'stretch', flex: '1 1 25%', minWidth: 0, borderRight: i < 3 ? '1px solid #e2e4e8' : 'none' }}>
                  <div style={{ background: '#f2f2f2', padding: '3px 5px', color: '#555', whiteSpace: 'nowrap' as const, display: 'flex', alignItems: 'center', fontSize: '11px', flexShrink: 0 }}>{lbl}</div>
                  <div style={{ padding: '3px 5px', fontWeight: 500, display: 'flex', alignItems: 'center', minWidth: 0, wordBreak: 'break-word' as const, overflowWrap: 'break-word' as const, fontSize: '12px' }}>{val || '—'}</div>
                </div>
              ))}
            </div>
            {/* 客戶名稱 | 交貨地址（兩欄一行）*/}
            <div style={{ display: 'flex', border: '1px solid #e2e4e8', borderBottom: 'none', fontSize: '12px' }}>
              {([
                ['客戶名稱', (() => {
                  const name = so?.partner_name ?? mo.lot_number ?? '—'
                  const code = so?.tpn_partner_id ?? customerCodeMap.get(name) ?? null
                  return code ? `[${code}] ${name}` : name
                })()],
                ['交貨地址', so?.delivery_address || soLines.find(l => l.delivery_address)?.delivery_address || '—'],
              ] as [string, string][]).map(([lbl, val], i) => (
                <div key={lbl} style={{ display: 'flex', alignItems: 'stretch', flex: '1 1 50%', minWidth: 0, borderRight: i === 0 ? '1px solid #e2e4e8' : 'none' }}>
                  <div style={{ background: '#f2f2f2', padding: '3px 5px', color: '#555', whiteSpace: 'nowrap' as const, display: 'flex', alignItems: 'center', fontSize: '11px', flexShrink: 0 }}>{lbl}</div>
                  <div style={{ padding: '3px 5px', fontWeight: 500, display: 'flex', alignItems: 'center', minWidth: 0, wordBreak: 'break-word' as const, overflowWrap: 'break-word' as const, fontSize: '12px' }}>{val || '—'}</div>
                </div>
              ))}
            </div>
            {/* 全部行項表格 — 本採購項加底色＋星號 */}
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', tableLayout: 'fixed' }}>
              <colgroup>
                <col style={{ width: '32px' }} />
                <col style={{ width: '36%' }} />
                <col style={{ width: '80px' }} />
                <col style={{ width: '18%' }} />
                <col style={{ width: '18%' }} />
                <col style={{ width: '96px' }} />
              </colgroup>
              <thead>
                <tr style={{ background: '#f5f6f8' }}>
                  {(['序', '品項編碼 / 規格', '數量', '包裝方式', '出貨備註', '交貨日'] as const).map((h, hi) => (
                    <th key={h} style={{ border: '1px solid #e2e4e8', padding: '3px 5px', fontWeight: 600, color: '#555', textAlign: hi === 0 ? 'center' as const : 'left' as const, whiteSpace: 'nowrap' as const, fontSize: '11px' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {soLines.length > 0 ? [...soLines]
                  .sort((a, b) => {
                    const an = parseInt(String(a.line_no || '0'), 10)
                    const bn = parseInt(String(b.line_no || '0'), 10)
                    if (Number.isNaN(an) && Number.isNaN(bn)) return String(a.line_no || '').localeCompare(String(b.line_no || ''))
                    if (Number.isNaN(an)) return 1
                    if (Number.isNaN(bn)) return -1
                    return an - bn
                  })
                  .map(line => {
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
                      <td style={{ ...td, color: line.remark2 ? '#000' : '#6b7280', fontWeight: line.remark2 ? 600 : 400 }}>{line.remark2 || '—'}</td>
                      <td style={td}>{line.duedate || '—'}</td>
                    </tr>
                  )
                }) : (
                  <tr>
                    <td colSpan={6} style={{ border: '1px solid #e2e4e8', padding: '6px', fontSize: '11px', fontStyle: 'italic', color: '#9ca3af', textAlign: 'center' }}>
                      訂單詳細資訊尚未同步，請至「銷售訂單同步」頁面執行同步
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </>
        ) : null}
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
  const [exportingWord, setExportingWord] = useState(false)
  const [visibleCount, setVisibleCount] = useState(0)
  // 列印範圍：製令/採購/請購單、示意圖、或兩者都印（預設）
  const [printMode, setPrintMode] = useState<'both' | 'mo' | 'sketch'>('both')
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)

  // ── 示意圖穿插列印：使用者選一次本機/內網共用資料夾，依「SO單號#項號」自動
  // 比對每張製令/採購/請購單對應的示意圖，列印時緊接在該單據後面插入 ────────
  const sketchFolderInputRef = useRef<HTMLInputElement>(null)
  const [sketchMatches, setSketchMatches] = useState<Map<string, MatchedSketch[]>>(new Map())
  const [sketchImageMap, setSketchImageMap] = useState<Map<string, string[]>>(new Map())
  const [sketchLoading, setSketchLoading] = useState(false)
  const [sketchLoadedCount, setSketchLoadedCount] = useState(0)
  const [sketchFolderPicked, setSketchFolderPicked] = useState(false)

  // 每日出單表該列已存好的示意圖（sketch_urls）——優先於選資料夾即時比對的結果，見下方
  // visibleRecords.map 裡的 sketchUrls 判斷。這裡只需要把其中的 PDF 轉成圖片（跟本機
  // 資料夾比對走同一套轉圖邏輯，排版才會一致），一般圖片網址不需要額外處理。
  const [resolvedSketchMap, setResolvedSketchMap] = useState<Map<number, string[]>>(new Map())
  const [resolvingSketchUrls, setResolvingSketchUrls] = useState(false)

  const handlePickSketchFolder = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return
    const matches = matchSketchFiles(files)
    setSketchMatches(matches)
    setSketchFolderPicked(true)
    setSketchImageMap(new Map())
    setSketchLoadedCount(0)
    setSketchLoading(true)
    try {
      const entries = [...matches.entries()]
      const nextMap = new Map<string, string[]>()
      for (const [key, matchedFiles] of entries) {
        const urls = await resolveSketchImages(matchedFiles)
        nextMap.set(key, urls)
        setSketchLoadedCount(c => c + 1)
        // 逐筆更新，讓使用者在還在轉檔時也能看到已完成的結果
        setSketchImageMap(new Map(nextMap))
      }
    } finally {
      setSketchLoading(false)
    }
  }, [])

  // 每筆 record 各自已存好的 sketch_urls（若有）轉成可列印的圖片網址，index 當 key
  // （mo_number 在 C/O 廠列可能是空字串，會有多筆撞 key，用陣列 index 不會有這個問題）
  useEffect(() => {
    const targets = records
      .map((r, idx) => ({ r, idx }))
      .filter(({ r }) => r.sketch_urls && r.sketch_urls.length > 0)
    if (targets.length === 0) {
      setResolvedSketchMap(new Map())
      return
    }
    let cancelled = false
    setResolvingSketchUrls(true)
    void (async () => {
      const map = new Map<number, string[]>()
      for (const { r, idx } of targets) {
        if (cancelled) return
        try {
          map.set(idx, await resolveSketchUrls(r.sketch_urls!))
        } catch (e) {
          console.error(`示意圖轉圖失敗（第 ${idx} 筆）：`, e)
        }
      }
      if (!cancelled) {
        setResolvedSketchMap(map)
        setResolvingSketchUrls(false)
      }
    })()
    return () => { cancelled = true }
  }, [records])

  const soLineLookup = useMemo(() => {
    const map = new Map<string, SoLine>()
    for (const [projectId, lines] of soMap.entries()) {
      for (const line of lines) {
        const key = createSoLookupKey(projectId, line.line_no)
        if (!map.has(key)) map.set(key, line)
      }
    }
    return map
  }, [soMap])

  const handleExportWord = useCallback(async () => {
    if (exportingWord) return
    setExportingWord(true)
    try {
      const mod = await import('./exportWord')
      await mod.exportPoToWord(records, soMap, customerCodeMap)
    } finally {
      setExportingWord(false)
    }
  }, [exportingWord, records, soMap, customerCodeMap])

  const visibleRecords = useMemo(() => {
    if (visibleCount <= 0) return []
    return records.slice(0, visibleCount)
  }, [records, visibleCount])

  useEffect(() => {
    if (records.length === 0) {
      setVisibleCount(0)
      return
    }
    setVisibleCount(Math.min(RENDER_CHUNK_SIZE, records.length))
  }, [records])

  useEffect(() => {
    if (visibleCount === 0) return
    if (visibleCount >= records.length) return
    const timer = window.setTimeout(() => {
      setVisibleCount(prev => Math.min(prev + RENDER_CHUNK_SIZE, records.length))
    }, 16)
    return () => window.clearTimeout(timer)
  }, [visibleCount, records.length])

  const handlePrintClick = useCallback(async (mode: 'both' | 'mo' | 'sketch') => {
    if (mode !== 'mo' && (sketchLoading || resolvingSketchUrls)) {
      alert('示意圖還在轉檔中，請稍候轉檔完成再列印，避免漏印示意圖。')
      return
    }
    if (visibleCount < records.length) {
      setVisibleCount(records.length)
      await new Promise<void>(resolve => window.setTimeout(resolve, 80))
    }
    setPrintMode(mode)
    // 等 React 把 data-print-mode 寫進 DOM 後再觸發列印，否則列印範圍 CSS 可能還沒生效。
    await new Promise<void>(resolve => window.setTimeout(resolve, 30))
    if (mode !== 'mo') {
      // 確保每張示意圖都已完整解碼再送印。Chrome 列印時若圖片還沒解碼完，印出來會是
      // 上半部正常、下半部一整塊灰（JPEG）或空白（PNG）——2026-09-04 使用者拍照回報。
      const imgs = Array.from(document.querySelectorAll<HTMLImageElement>('.sketch-card img'))
      await Promise.all(imgs.map(img => img.decode().catch(() => undefined)))
    }
    window.print()
  }, [visibleCount, records.length, sketchLoading, resolvingSketchUrls])

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
        // 沒有來源訂單時，僅查本次列印會用到的客戶，避免掃整張客戶表
        const lotNames = [...new Set(mos.map(m => (m.lot_number ?? '').trim()).filter(Boolean))]
        if (lotNames.length === 0) {
          setLoading(false)
          return
        }
        void (async () => {
          const { data: custData } = await supabase
            .from('erp_customers')
            .select('partner_id, cname')
            .in('cname', lotNames)
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
          .select('project_id,line_no,mbp_part,mbp_ver,tpn_partner_id,partner_name,delivery_address,customer_remark,invoice_format,sales_name,duedate,order_qty_oru,unit_of_measure_oru,description,remark,packing,remark2,grade,part,order_qty,unit_of_measure')
          .in('project_id', projectIds)
        if (err) console.error('so fetch:', err)

        const map = new Map<string, SoLine[]>()
        for (const row of (data ?? []) as SoLine[]) {
          const existing = map.get(row.project_id) ?? []
          existing.push(row)
          map.set(row.project_id, existing)
        }
        setSoMap(map)

        // 同時載入客戶代碼表（僅查本次列印實際需要的客戶名稱）
        const customerNames = [...new Set([
          ...mos.map(m => (m.lot_number ?? '').trim()),
          ...(data ?? []).map(r => String((r as SoLine).partner_name ?? '').trim()),
        ].filter(Boolean))]

        const codeMap = new Map<string, string>()
        if (customerNames.length > 0) {
          const { data: custData } = await supabase
            .from('erp_customers')
            .select('partner_id, cname')
            .in('cname', customerNames)
          for (const c of (custData ?? []) as { partner_id: string; cname: string }[]) {
            codeMap.set(c.cname, c.partner_id)
          }
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
        @page { size: A4 portrait; margin: 4mm 0; }
        @media screen {
          html, body { background: #fff !important; color: #000 !important; }
          .mo-pages-wrapper { background: #efefef !important; }
          .mo-toolbar {
            background: #f3f4f6 !important;
            color: #000 !important;
            border-bottom: 1px solid #bbb !important;
            box-shadow: none !important;
          }
          .mo-toolbar * { color: #000 !important; }
          .mo-toolbar button {
            background: #fff !important;
            color: #000 !important;
            border: 1px solid #bbb !important;
          }
        }
        @media print {
          .mo-toolbar { display: none !important; }
          .no-print { display: none !important; }
          /* 列印範圍：工具列的「列印製令／列印示意圖／示意圖+製令」三個按鈕會在按下時
             把 data-print-mode 寫到 .mo-pages-wrapper 上，這裡依模式隱藏不要列印的部分。
             預設（未設定或 both）兩者都印，維持原本行為。 */
          .mo-pages-wrapper[data-print-mode="mo"] .sketch-card {
            display: none !important;
          }
          .mo-pages-wrapper[data-print-mode="sketch"] .mo-card:not(.sketch-card) {
            display: none !important;
          }
          /* 灰階只套在「單據頁」（製令/採購/請購），示意圖頁保留原色。
             注意：CSS filter 套在祖先層之後，子層無法再還原成彩色，所以絕對不能像原本那樣
             對 html 整頁套 grayscale——那會連示意圖一起變黑白，即使印表機設定彩色也救不回來。
             搭配「印表機設為彩色列印」即可達成：單據黑白、示意圖彩色。 */
          .mo-card:not(.sketch-card) {
            -webkit-filter: grayscale(100%) !important;
            filter: grayscale(100%) !important;
          }
          * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
          .mo-card:not(.sketch-card),
          .mo-card:not(.sketch-card) * {
            color: #000 !important;
            text-shadow: none !important;
            box-shadow: none !important;
          }
          /* 示意圖頁：只去掉陰影，不動顏色 */
          .sketch-card { box-shadow: none !important; }
          /* 示意圖頁絕對不可被切開跨頁——上面 .mo-card 的 break-inside:auto 是為了讓單據
             的長表格能流到下一頁，但套在圖片上就會把圖從中間切斷、只印出一半
             （2026-09-03 使用者回報）。這裡明確覆寫成不允許斷開。
             注意：break-inside:avoid 在 Chrome 對 display:flex 容器不可靠（已知相容性問題），
             加了也常常沒用、圖還是會被從中間切開只印出上半部（2026-09-04 使用者再次回報）。
             所以下面把 .sketch-card 及其內層容器在列印時都強制改回 display:block，
             改用 text-align:center 置中取代 flex 置中，徹底避開 flex 分頁的問題。 */
          .sketch-card {
            break-inside: avoid !important;
            page-break-inside: avoid !important;
            display: block !important;
            text-align: center !important;
          }
          .sketch-card-body {
            display: block !important;
            overflow: visible !important;
          }
          /* 示意圖本身就是照一整張 A4 設計的，列印時應該鋪滿整頁，不要再被卡片的左右留白
             （原本各 12mm）縮小——那會讓圖只印到約 88% 大小、四周多一圈空白。
             @page 已設 margin 4mm 0，所以可用範圍是 210mm × 289mm，這裡把卡片留白歸零，
             標題縮到最小，讓圖片能吃滿整頁（維持原比例，不變形）。 */
          .sketch-card {
            padding: 0 !important;
            min-height: 289mm !important;
          }
          .sketch-card-label {
            font-size: 8px !important;
            margin: 0 0 1mm 2mm !important;
            color: #999 !important;
          }
          /* 圖片本身也不可被切開；以絕對長度限制在單頁可用範圍內 */
          .sketch-card img {
            break-inside: avoid !important;
            page-break-inside: avoid !important;
            max-height: 284mm !important;
            max-width: 210mm !important;
            width: auto !important;
            height: auto !important;
            object-fit: contain !important;
          }
          .mo-card:not(.sketch-card) th,
          .mo-card:not(.sketch-card) td,
          .mo-card:not(.sketch-card) tr,
          .mo-card:not(.sketch-card) div,
          .mo-card:not(.sketch-card) span {
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
            min-height: calc(297mm - 8mm) !important;
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
            : <>列印預覽 — 共 <strong style={{ color: 'white' }}>{records.length}</strong> 張單據（製令 / 採購單 / 請購單）</>
          }
        </span>

        <div style={{ fontSize: '11px', color: '#64748b' }}>
          （每張為一個 A4 直式頁面，PDF 請選「另存為 PDF」）
        </div>

        <div style={{ marginLeft: 'auto', display: 'flex', gap: '8px', alignItems: 'center' }}>
          <span style={{ fontSize: '11px', color: '#475569' }}>
            SO 資料：{soMap.size} 筆訂單已載入
          </span>
          <span style={{ fontSize: '11px', color: '#475569' }}>
            預覽載入：{Math.min(visibleCount, records.length)} / {records.length}
          </span>
          <input
            ref={sketchFolderInputRef}
            type="file"
            multiple
            {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
            style={{ display: 'none' }}
            onChange={e => { void handlePickSketchFolder(e.target.files); e.target.value = '' }}
          />
          {resolvingSketchUrls && (
            <span style={{ fontSize: '11px', color: '#22c55e' }}>📎 出單表示意圖轉檔中…</span>
          )}
          <span style={{ fontSize: '11px', color: sketchFolderPicked ? '#22c55e' : '#64748b' }} title="檔名需含「SO銷售單號#項號」，例如 SO260805024#1.jpg（若已透過每日出單表帶入示意圖則不需要選資料夾）">
            {sketchLoading
              ? `示意圖轉檔中… ${sketchLoadedCount}/${sketchMatches.size}`
              : sketchFolderPicked
                ? `📁 已比對 ${sketchImageMap.size} / ${sketchMatches.size} 筆有示意圖`
                : '尚未選示意圖資料夾'}
          </span>
          <button
            onClick={() => sketchFolderInputRef.current?.click()}
            style={{
              padding: '8px 14px', background: '#334155', borderRadius: '6px',
              cursor: 'pointer', color: '#e2e8f0', fontSize: '13px', border: 'none',
            }}
          >
            📁 選示意圖資料夾
          </button>
          <button
            onClick={() => void handleExportWord()}
            disabled={exportingWord}
            style={{
              padding: '8px 18px', background: '#16a34a', borderRadius: '6px',
              cursor: 'pointer', color: 'white', fontSize: '13px',
              fontWeight: 700, border: 'none',
            }}
          >
            {exportingWord ? '產生中...' : '📄 下載 Word'}
          </button>
          <div style={{ display: 'flex', gap: '4px', border: '1px solid #334155', borderRadius: '6px', overflow: 'hidden' }}>
            <button
              onClick={() => void handlePrintClick('mo')}
              title="只印製令 / 採購單 / 請購單，不印示意圖"
              style={{
                padding: '8px 14px', background: '#0e7490', cursor: 'pointer', color: 'white', fontSize: '13px',
                fontWeight: 700, border: 'none',
              }}
            >
              🖨 列印製令
            </button>
            <button
              onClick={() => void handlePrintClick('sketch')}
              title="只印示意圖，不印製令 / 採購單 / 請購單"
              style={{
                padding: '8px 14px', background: '#0e7490', cursor: 'pointer', color: 'white', fontSize: '13px',
                fontWeight: 700, border: 'none', borderLeft: '1px solid #164e63', borderRight: '1px solid #164e63',
              }}
            >
              🖨 列印示意圖
            </button>
            <button
              onClick={() => void handlePrintClick('both')}
              title="示意圖 + 製令 / 採購單 / 請購單全部印出（預設）"
              style={{
                padding: '8px 14px', background: '#0891b2', cursor: 'pointer', color: 'white', fontSize: '13px',
                fontWeight: 700, border: 'none',
              }}
            >
              🖨 示意圖+製令
            </button>
          </div>
        </div>
      </div>

      {/* ── 頁面容器 ───────────────────────────────────────── */}
      <div className="mo-pages-wrapper" data-print-mode={printMode} style={{ background: '#64748b', padding: '24px 16px', minHeight: '100vh' }}>
        {visibleRecords.map((mo, idx) => {
          // 示意圖穿插：優先用每日出單表該列已經存好的示意圖（sketch_urls，人工核對過或自動比對過的
          // 結果，一經設定所有人都看得到，不用每次列印都重選資料夾，PDF 已在上面的 effect 轉成
          // 圖片存在 resolvedSketchMap）；只有在沒有這筆資料時（例如直接從 mo-summary 表格列印，
          // 非透過每日出單表）才退回用選資料夾即時比對的結果。
          // 沒有示意圖的列兩種來源都會是空陣列，自然就不會印出任何示意圖頁。
          const lineNo = getLineNo(mo)
          const sketchUrls = (mo.sketch_urls && mo.sketch_urls.length > 0)
            ? (resolvedSketchMap.get(idx) ?? [])
            : sketchImageMap.get(makeSketchLookupKey(mo.source_order ?? '', lineNo)) ?? []
          const sketchPages = sketchUrls.map((url, i) => (
            <SketchCard key={`${mo.mo_number}-sketch-${i}`} url={url} label={`${mo.source_order ?? '—'} #${lineNo}`} />
          ))

          // 常平 C → 採購單格式；委外 O → 請購單格式
          if (mo.factory === 'C' || mo.factory === 'O') {
            return (
              <Fragment key={mo.mo_number}>
                <PoCard mo={mo} soMap={soMap} soLineLookup={soLineLookup} customerCodeMap={customerCodeMap} variant={mo.factory === 'O' ? 'pr' : 'po'} />
                {sketchPages}
              </Fragment>
            )
          }

          const soLines = soMap.get(mo.source_order ?? '') ?? []
          const so = soLineLookup.get(createSoLookupKey(mo.source_order ?? '', lineNo)) ?? soLines[0] ?? null

          const part   = so?.mbp_part || so?.part || null
          const qty    = so?.order_qty_oru ?? so?.order_qty ?? null
          const uom    = so?.unit_of_measure_oru || so?.unit_of_measure || null
          const qtyStr = qty != null ? `${qty}${uom ? ' ' + uom : ''}`.trim() : null

          const labelTd = { border: '1px solid #ccc', padding: '4px 6px', fontSize: '14px', color: '#555', background: '#f2f2f2', width: '70px', whiteSpace: 'nowrap' as const }
          const valueTd = { border: '1px solid #ccc', padding: '4px 6px', fontSize: '15px', fontWeight: 500 as const, wordBreak: 'break-word' as const }
          const writeTd = { border: '1px solid #ccc', padding: '0 8px', height: '36px' }

          return (
            <Fragment key={mo.mo_number}>
            <div
              className="mo-card"
              style={{
                width: '210mm',
                background: 'white',
                margin: '0 auto 24px',
                padding: '5mm 12mm 5mm',
                boxSizing: 'border-box',
                boxShadow: '0 4px 24px rgba(0,0,0,0.35)',
                fontFamily: 'Arial, "Microsoft JhengHei", "PingFang TC", sans-serif',
                color: '#111',
                display: 'flex', flexDirection: 'column', minHeight: 'calc(297mm - 8mm)',
              }}
            >
              {/* ── 頁首（3欄：製令號+急打樣 ｜ 置中標題 ｜ 廠別+日期）── */}
              <div style={{
                display: 'grid',
                gridTemplateColumns: '1fr auto 1fr',
                alignItems: 'center',
                gap: '8px',
                borderBottom: '2px solid #000',
                paddingBottom: '4px',
                marginBottom: '6px',
              }}>
                {/* 左：製令號 + 急件/打樣 checkbox */}
                <div>
                  <div style={{
                    fontFamily: 'Arial, "Microsoft JhengHei", "PingFang TC", sans-serif', fontSize: '22px', fontWeight: 'bold',
                    letterSpacing: '1px', background: '#f0f0f0',
                    padding: '5px 12px', border: '1.5px solid #444',
                    display: 'inline-block', borderRadius: '3px', color: '#000',
                  }}>
                    {mo.mo_number}
                  </div>
                  <div style={{ marginTop: '4px' }}>
                    <span style={{ fontSize: '10px', color: '#555', fontWeight: 600, letterSpacing: '1px', marginRight: '6px' }}>打樣/追加單號</span>
                    <span style={{
                      fontSize: '13px', fontWeight: 'bold', letterSpacing: '0.5px',
                      background: '#f0f0f0', padding: '2px 8px', border: '1px solid #999',
                      display: 'inline-block', borderRadius: '3px', color: '#000', minWidth: '70px', minHeight: '16px',
                    }}>
                      {mo.is_sample || ''}
                    </span>
                  </div>
                </div>

                {/* 中：製令工單（置中）*/}
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: '22px', fontWeight: 900, letterSpacing: '2px', color: '#000', WebkitTextStroke: '1px #000' }}>
                    製令工單
                  </div>
                  <div style={{ fontSize: '10px', color: '#666', marginTop: '1px', letterSpacing: '1px' }}>
                    Manufacturing Order
                  </div>
                </div>

                {/* 右：印刷機台（手填框）*/}
                <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center' }}>
                  <div style={{ border: '2px solid #222', borderRadius: '4px', padding: '4px 10px', minWidth: '160px' }}>
                    <div style={{ fontSize: '10px', color: '#555', marginBottom: '3px', fontWeight: 600, letterSpacing: '1px' }}>印刷機台</div>
                    <div style={{
                      borderBottom: mo.machine ? 'none' : '1.5px solid #888',
                      height: '28px', fontSize: '18px', fontWeight: 800,
                      display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
                      letterSpacing: '1px',
                    }}>
                      {mo.machine || ''}
                    </div>
                  </div>
                </div>
              </div>

              {/* ── 製令資訊（含來源訂單基本資訊）── */}
              <div className="mo-section" style={{ marginBottom: '10px' }}>
                <SectionTitle color="#e5e7eb">製令資訊</SectionTitle>
                {mo.source_order && (
                  <>
                    {/* 銷售單號 | 製令項號 | 負責業務 | 發票型態 */}
                    <div style={{ display: 'flex', border: '1px solid #e2e4e8', borderBottom: 'none', fontSize: '12px' }}>
                      {([
                        ['銷售單號', mo.source_order],
                        ['製令項號', lineNo],
                        ['負責業務', so?.sales_name || '—'],
                        ['發票型態', formatExportMode(so?.invoice_format || soLines.find(l => l.invoice_format)?.invoice_format)],
                      ] as [string, string][]).map(([lbl, val], i) => (
                        <div key={lbl} style={{ display: 'flex', alignItems: 'stretch', flex: '1 1 25%', minWidth: 0, borderRight: i < 3 ? '1px solid #e2e4e8' : 'none' }}>
                          <div style={{ background: '#f2f2f2', padding: '3px 5px', color: '#555', whiteSpace: 'nowrap' as const, display: 'flex', alignItems: 'center', fontSize: '11px', flexShrink: 0 }}>{lbl}</div>
                          <div style={{ padding: '3px 5px', fontWeight: 500, display: 'flex', alignItems: 'center', minWidth: 0, wordBreak: 'break-word' as const, overflowWrap: 'break-word' as const, fontSize: '12px' }}>{val || '—'}</div>
                        </div>
                      ))}
                    </div>
                    {/* 客戶名稱 | 交貨地址 */}
                    <div style={{ display: 'flex', border: '1px solid #e2e4e8', borderBottom: 'none', fontSize: '12px' }}>
                      {([
                        ['客戶名稱', (() => {
                          const name = so?.partner_name ?? mo.lot_number ?? '—'
                          const code = so?.tpn_partner_id ?? customerCodeMap.get(name) ?? null
                          return code ? `[${code}] ${name}` : name
                        })()],
                        ['交貨地址', so?.delivery_address || soLines.find(l => l.delivery_address)?.delivery_address || '—'],
                      ] as [string, string][]).map(([lbl, val], i) => (
                        <div key={lbl} style={{ display: 'flex', alignItems: 'stretch', flex: '1 1 50%', minWidth: 0, borderRight: i === 0 ? '1px solid #e2e4e8' : 'none' }}>
                          <div style={{ background: '#f2f2f2', padding: '3px 5px', color: '#555', whiteSpace: 'nowrap' as const, display: 'flex', alignItems: 'center', fontSize: '11px', flexShrink: 0 }}>{lbl}</div>
                          <div style={{ padding: '3px 5px', fontWeight: 500, display: 'flex', alignItems: 'center', minWidth: 0, wordBreak: 'break-word' as const, overflowWrap: 'break-word' as const, fontSize: '12px' }}>{val || '—'}</div>
                        </div>
                      ))}
                    </div>
                  </>
                )}
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <tbody>
                    <tr>
                      <td style={labelTd}>生產貨號</td>
                      <td style={valueTd}>{mo.product_code || '—'}</td>
                      <td style={labelTd}>廠別</td>
                      <td style={valueTd}>{FACTORY_LABEL[mo.factory ?? ''] ?? mo.factory ?? '—'}</td>
                    </tr>
                    <tr>
                      <td style={labelTd}>預訂產出量</td>
                      <td style={valueTd}>{mo.planned_qty || '—'}</td>
                      <td style={labelTd}>開立日</td>
                      <td style={valueTd}>{mo.create_date || '—'}</td>
                    </tr>
                    <tr>
                      <td style={labelTd}>生產備註</td>
                      <td style={{ ...valueTd, fontSize: '13px' }} colSpan={3}>{so?.remark || '—'}</td>
                    </tr>
                    <tr>
                      <td style={{ ...labelTd, verticalAlign: 'middle' }}>出貨交期</td>
                      <td colSpan={3} style={{ ...valueTd, fontWeight: 700, fontSize: '22px', verticalAlign: 'middle' }}>
                        {(() => {
                          const d = so?.duedate || mo.planned_end_date
                          return d ? <>{d} <span style={{ fontSize: '18px' }}>{dayOfWeekZh(d)}</span></> : '—'
                        })()}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* ── 交期資訊（手填工序）── */}
              <div className="mo-section" style={{ marginBottom: '10px' }}>
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
                      <td style={{ ...writeTd, height: '52px', padding: '4px 8px' }} colSpan={3}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                          <div style={{ flex: '0 0 auto', width: '90px', height: '28px' }} />
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' as const, flex: 1 }}>
                            {(['貼合', '包邊', '車縫', '胸章'] as const).map(opt => (
                              <span key={opt} style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', fontSize: '13px', whiteSpace: 'nowrap' as const }}>
                                <span style={{ display: 'inline-block', width: '13px', height: '13px', border: '1.5px solid #333', borderRadius: '1px', flexShrink: 0 }} />
                                {opt}
                              </span>
                            ))}
                          </div>
                        </div>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* ── 來源訂單行項 ── */}
              {mo.source_order ? (
              <div className="mo-section" style={{ marginBottom: '10px' }}>
                <SectionTitle color="#e5e7eb">訂單行項</SectionTitle>
                <>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', tableLayout: 'fixed' }}>
                      <colgroup>
                        <col style={{ width: '32px' }} />
                        <col style={{ width: '36%' }} />
                        <col style={{ width: '80px' }} />
                        <col style={{ width: '18%' }} />
                        <col style={{ width: '18%' }} />
                        <col style={{ width: '96px' }} />
                      </colgroup>
                      <thead>
                        <tr style={{ background: '#f5f6f8' }}>
                          {(['序', '品項編碼 / 規格', '數量', '包裝方式', '出貨備註', '交貨日'] as const).map((h, hi) => (
                            <th key={h} style={{ border: '1px solid #e2e4e8', padding: '3px 5px', fontWeight: 600, color: '#555', textAlign: hi === 0 ? 'center' as const : 'left' as const, whiteSpace: 'nowrap' as const, fontSize: '11px' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {soLines.length > 0 ? [...soLines]
                          .sort((a, b) => {
                            const an = parseInt(String(a.line_no || '0'), 10)
                            const bn = parseInt(String(b.line_no || '0'), 10)
                            if (Number.isNaN(an) && Number.isNaN(bn)) return String(a.line_no || '').localeCompare(String(b.line_no || ''))
                            if (Number.isNaN(an)) return 1
                            if (Number.isNaN(bn)) return -1
                            return an - bn
                          })
                          .map(line => {
                          const lno = String(parseInt(String(line.line_no || '0'), 10))
                          const isThis = lno === lineNo
                          const lqty = line.order_qty_oru ?? line.order_qty
                          const luom = line.unit_of_measure_oru || line.unit_of_measure || ''
                          const td = { border: '1px solid #e2e4e8', padding: '3px 5px', wordBreak: 'break-word' as const, overflowWrap: 'break-word' as const }
                          return (
                            <tr key={line.line_no} style={{ background: isThis ? '#f3f4f6' : 'white', fontWeight: isThis ? 600 : 400 }}>
                              <td style={{ ...td, textAlign: 'center' as const, whiteSpace: 'nowrap' as const }}>{lno}{isThis ? ' ★' : ''}</td>
                              <td style={td}>
                                <div style={{ fontWeight: isThis ? 700 : 500 }}>{line.mbp_part || line.part || '—'}</div>
                                <div style={{ fontSize: '11px', color: '#555', marginTop: '1px' }}>{line.description || '—'}</div>
                              </td>
                              <td style={td}>{lqty != null ? `${lqty} ${luom}`.trim() : '—'}</td>
                              <td style={td}>{line.packing || '—'}</td>
                              <td style={{ ...td, color: line.remark2 ? '#000' : '#6b7280', fontWeight: line.remark2 ? 600 : 400 }}>{line.remark2 || '—'}</td>
                              <td style={td}>{line.duedate || '—'}</td>
                            </tr>
                          )
                        }) : (
                          <tr>
                            <td colSpan={6} style={{ border: '1px solid #e2e4e8', padding: '6px', fontSize: '11px', fontStyle: 'italic' as const, color: '#9ca3af', textAlign: 'center' as const }}>
                              訂單詳細資訊尚未同步，請至「銷售訂單同步」頁面執行同步
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </>
              </div>
              ) : null}

              {/* ── 作業確認 ── */}
              <div className="mo-card-footer">
                <SectionTitle color="#e5e7eb">作業確認</SectionTitle>
                <div style={{
                  display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)',
                  border: '1px solid #bbb',
                }}>
                  {['印刷人員', '品檢抽驗', '包裝人員', '出貨人員'].map((role, ri) => (
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
            {sketchPages}
            </Fragment>
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
