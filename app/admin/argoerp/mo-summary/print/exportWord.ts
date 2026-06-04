/**
 * exportWord.ts
 * 將採購單（PoCard）資料匯出為 .docx Word 檔案
 */
import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  AlignmentType, BorderStyle, WidthType, ShadingType, PageBreak,
  TableLayoutType, convertInchesToTwip,
} from 'docx'
import { saveAs } from 'file-saver'

// ── 型別（與 page.tsx 一致）─────────────────────────────────
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
  line_no_override?: string
  po_number?: string | null
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
  part?: string | null
  order_qty?: number | null
  unit_of_measure?: string | null
}

// ── 工具 ─────────────────────────────────────────────────────
const FACTORY_LABEL: Record<string, string> = {
  T: 'T 台北廠',
  C: 'C 常平廠',
  O: 'O 委外廠',
}

const DOW_ZH = ['日', '一', '二', '三', '四', '五', '六'] as const
function dayOfWeekZh(dateStr: string | null | undefined): string {
  if (!dateStr) return ''
  const d = new Date(dateStr.replace(/\//g, '-'))
  if (isNaN(d.getTime())) return ''
  return `(${DOW_ZH[d.getDay()]})`
}

function getLineNo(mo: MoRecord): string {
  if (mo.line_no_override !== undefined && mo.line_no_override !== null && mo.line_no_override !== '') {
    const n = parseInt(mo.line_no_override, 10)
    return isNaN(n) ? mo.line_no_override : String(n)
  }
  const last2 = mo.mo_number.slice(-2)
  const n = parseInt(last2, 10)
  return isNaN(n) ? '0' : String(n)
}

// ── 邊框樣式 helper ──────────────────────────────────────────
const BORDER_SINGLE = { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC' }
const BORDER_NONE   = { style: BorderStyle.NIL, size: 0, color: 'FFFFFF' }
const BORDER_THICK  = { style: BorderStyle.SINGLE, size: 8, color: '000000' }
const BORDER_MEDIUM = { style: BorderStyle.SINGLE, size: 6, color: '555555' }

const allBorderSingle = { top: BORDER_SINGLE, bottom: BORDER_SINGLE, left: BORDER_SINGLE, right: BORDER_SINGLE }
const allBorderNone   = { top: BORDER_NONE,   bottom: BORDER_NONE,   left: BORDER_NONE,   right: BORDER_NONE }
const allBorderThick  = { top: BORDER_THICK,  bottom: BORDER_THICK,  left: BORDER_THICK,  right: BORDER_THICK }

// ── 文字 helper ──────────────────────────────────────────────
function t(text: string, opts?: { bold?: boolean; size?: number; color?: string; italics?: boolean }): TextRun {
  return new TextRun({
    text: text || '—',
    bold: opts?.bold ?? false,
    size: opts?.size ?? 20,          // 10pt default
    color: opts?.color ?? '000000',
    italics: opts?.italics ?? false,
    font: 'Microsoft JhengHei',
  })
}

// ── Label cell（灰底）────────────────────────────────────────
function labelCell(text: string, opts?: { width?: number; rowSpan?: number }): TableCell {
  return new TableCell({
    children: [new Paragraph({ children: [t(text, { size: 18, color: '555555' })], spacing: { before: 40, after: 40 } })],
    shading: { type: ShadingType.SOLID, color: 'F2F2F2', fill: 'F2F2F2' },
    borders: allBorderSingle,
    width: opts?.width != null ? { size: opts.width, type: WidthType.DXA } : undefined,
    rowSpan: opts?.rowSpan,
  })
}

// ── Value cell ──────────────────────────────────────────────
function valueCell(text: string, opts?: { bold?: boolean; size?: number; colSpan?: number; rowSpan?: number; shading?: string }): TableCell {
  return new TableCell({
    children: [new Paragraph({ children: [t(text || '—', { size: opts?.size ?? 22, bold: opts?.bold ?? false })], spacing: { before: 40, after: 40 } })],
    borders: allBorderSingle,
    columnSpan: opts?.colSpan,
    rowSpan: opts?.rowSpan,
    shading: opts?.shading ? { type: ShadingType.SOLID, color: opts.shading, fill: opts.shading } : undefined,
  })
}

// ── 空的填寫格 ───────────────────────────────────────────────
function writeCell(opts?: { colSpan?: number }): TableCell {
  return new TableCell({
    children: [new Paragraph({ children: [], spacing: { before: 200, after: 200 } })],
    borders: allBorderSingle,
    columnSpan: opts?.colSpan,
  })
}

// ── Section header paragraph ─────────────────────────────────
function sectionHeader(title: string): Paragraph {
  return new Paragraph({
    children: [t(title, { bold: true, size: 22, color: 'FFFFFF' })],
    shading: { type: ShadingType.SOLID, color: '222222', fill: '222222' },
    spacing: { before: 120, after: 60 },
    indent: { left: 100 },
  })
}

// ── 分隔線 ──────────────────────────────────────────────────
function divider(): Paragraph {
  return new Paragraph({
    children: [],
    border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: '000000' } },
    spacing: { before: 0, after: 60 },
  })
}

// ── 每筆採購單 → 多個段落/表格陣列 ─────────────────────────
function buildPoSection(
  mo: MoRecord,
  soMap: Map<string, SoLine[]>,
  customerCodeMap: Map<string, string>,
  isLast: boolean,
): (Paragraph | Table)[] {
  const lineNo   = getLineNo(mo)
  const soLines  = soMap.get(mo.source_order ?? '') ?? []
  const so       = soLines.find(l => String(parseInt(String(l.line_no || '0'), 10)) === lineNo) ?? soLines[0] ?? null
  const factoryLabel = FACTORY_LABEL[mo.factory ?? ''] ?? mo.factory ?? '—'
  const poNo     = mo.po_number || mo.mo_number
  const dueDate  = so?.duedate || mo.planned_end_date
  const dueDateStr = dueDate ? `${dueDate} ${dayOfWeekZh(dueDate)}` : '—'

  const items: (Paragraph | Table)[] = []

  // ── 1. 頁首表格（採購單號 | 採購單 | 供應廠別）──────────
  const headerTable = new Table({
    layout: TableLayoutType.FIXED,
    width: { size: 100, type: WidthType.PERCENTAGE },
    columnWidths: [3000, 3400, 3000],
    borders: { top: BORDER_NONE, bottom: BORDER_NONE, left: BORDER_NONE, right: BORDER_NONE, insideHorizontal: BORDER_NONE, insideVertical: BORDER_NONE },
    rows: [
      new TableRow({
        children: [
          // 左：採購單號
          new TableCell({
            children: [
              new Paragraph({ children: [t('採購單號', { size: 16, color: '555555' })], spacing: { before: 0, after: 20 } }),
              new Paragraph({
                children: [t(poNo, { bold: true, size: 32 })],
                shading: { type: ShadingType.SOLID, color: 'F0F0F0', fill: 'F0F0F0' },
                border: { top: BORDER_MEDIUM, bottom: BORDER_MEDIUM, left: BORDER_MEDIUM, right: BORDER_MEDIUM },
                spacing: { before: 40, after: 40 },
                indent: { left: 80, right: 80 },
              }),
              new Paragraph({
                children: [
                  t('□ 急件單   ', { size: 20, bold: true }),
                  t('□ 打樣單', { size: 20, bold: true }),
                ],
                spacing: { before: 80, after: 0 },
              }),
            ],
            borders: allBorderNone,
          }),
          // 中：大標題
          new TableCell({
            children: [
              new Paragraph({
                children: [t('採購單', { bold: true, size: 56 })],
                alignment: AlignmentType.CENTER,
                spacing: { before: 40, after: 20 },
              }),
              new Paragraph({
                children: [t('Purchase Order', { size: 20, color: '666666' })],
                alignment: AlignmentType.CENTER,
                spacing: { before: 0, after: 0 },
              }),
            ],
            borders: allBorderNone,
            verticalAlign: 'center',
          }),
          // 右：供應廠別
          new TableCell({
            children: [
              new Paragraph({ children: [t('供應廠別', { size: 16, color: '555555' })], alignment: AlignmentType.CENTER, spacing: { before: 40, after: 40 } }),
              new Paragraph({
                children: [t(factoryLabel, { bold: true, size: 32 })],
                alignment: AlignmentType.CENTER,
                border: { top: BORDER_THICK, bottom: BORDER_THICK, left: BORDER_THICK, right: BORDER_THICK },
                spacing: { before: 60, after: 60 },
              }),
            ],
            borders: allBorderNone,
            verticalAlign: 'center',
          }),
        ],
      }),
    ],
  })
  items.push(headerTable)
  items.push(divider())

  // ── 2. 採購資訊 + 交期資訊（4欄表格）───────────────────
  items.push(new Paragraph({
    children: [
      t('採購資訊', { bold: true, size: 22, color: 'FFFFFF' }),
      t('                                    ', { size: 22, color: 'FFFFFF' }),
      t('交期資訊', { bold: true, size: 22, color: 'FFFFFF' }),
    ],
    shading: { type: ShadingType.SOLID, color: '222222', fill: '222222' },
    spacing: { before: 80, after: 60 },
    indent: { left: 100 },
  }))

  const infoTable = new Table({
    layout: TableLayoutType.FIXED,
    width: { size: 100, type: WidthType.PERCENTAGE },
    columnWidths: [1200, 3600, 1200, 3400],
    rows: [
      new TableRow({
        height: { value: convertInchesToTwip(0.5), rule: 'atLeast' },
        children: [
          labelCell('來源訂單', { width: 1200 }),
          valueCell(mo.source_order || '—', { bold: true, size: 28 }),
          labelCell('開立日', { width: 1200 }),
          valueCell(mo.create_date || '—', { size: 22 }),
        ],
      }),
      new TableRow({
        height: { value: convertInchesToTwip(0.5), rule: 'atLeast' },
        children: [
          labelCell('採購數量', { width: 1200 }),
          valueCell(mo.planned_qty || '—', { bold: true, size: 28 }),
          labelCell('廠別', { width: 1200 }),
          valueCell(factoryLabel, { size: 22 }),
        ],
      }),
      new TableRow({
        height: { value: convertInchesToTwip(0.6), rule: 'atLeast' },
        children: [
          labelCell(''),
          valueCell(''),
          labelCell('要求到料日', { width: 1200 }),
          valueCell(dueDateStr, { bold: true, size: 32 }),
        ],
      }),
    ],
  })
  items.push(infoTable)

  // ── 3. 品項資料 ─────────────────────────────────────────
  items.push(new Paragraph({ children: [], spacing: { before: 80, after: 0 } }))
  const detailRows: TableRow[] = [
    new TableRow({
      children: [
        labelCell('採購貨號', { width: 1200 }),
        valueCell(mo.product_code || '—', { size: 20 }),
      ],
    }),
    new TableRow({
      children: [
        labelCell('品名規格', { width: 1200 }),
        valueCell(mo.mo_note || '—', { size: 20 }),
      ],
    }),
  ]
  if (so?.remark) {
    detailRows.push(new TableRow({
      children: [
        labelCell('訂單備註', { width: 1200 }),
        valueCell(so.remark, { size: 20 }),
      ],
    }))
  }
  if (so?.packing) {
    detailRows.push(new TableRow({
      children: [
        labelCell('包裝方式', { width: 1200 }),
        valueCell(so.packing, { size: 20 }),
      ],
    }))
  }
  const detailTable = new Table({
    layout: TableLayoutType.FIXED,
    width: { size: 100, type: WidthType.PERCENTAGE },
    columnWidths: [1200, 8200],
    rows: detailRows,
  })
  items.push(detailTable)

  // ── 4. 來源訂單資訊 ──────────────────────────────────────
  items.push(sectionHeader('來源訂單資訊'))

  if (mo.source_order) {
    const customerName = so?.partner_name ?? mo.lot_number ?? '—'
    const customerCode = so?.tpn_partner_id ?? customerCodeMap.get(customerName) ?? null
    const customerDisplay = customerCode ? `[${customerCode}] ${customerName}` : customerName

    // 訂單摘要列
    const summaryTable = new Table({
      layout: TableLayoutType.FIXED,
      width: { size: 100, type: WidthType.PERCENTAGE },
      columnWidths: [1200, 2200, 1200, 3000, 1200, 1600],
      rows: [
        new TableRow({
          children: [
            labelCell('訂單號'),
            valueCell(mo.source_order, { size: 20 }),
            labelCell('客戶'),
            valueCell(customerDisplay, { size: 20 }),
            labelCell('業務員'),
            valueCell(so?.sales_name || '—', { size: 20 }),
          ],
        }),
        new TableRow({
          children: [
            labelCell('本採購項號'),
            new TableCell({
              children: [new Paragraph({ children: [t(lineNo, { bold: true, size: 22 })], spacing: { before: 40, after: 40 } })],
              borders: allBorderSingle,
              columnSpan: 5,
            }),
          ],
        }),
      ],
    })
    items.push(summaryTable)

    // 行項表格 header
    items.push(new Paragraph({ children: [], spacing: { before: 60, after: 0 } }))
    const lineHeaderRow = new TableRow({
      children: [
        new TableCell({
          children: [new Paragraph({ children: [t('序', { bold: true, size: 18, color: '555555' })], alignment: AlignmentType.CENTER })],
          shading: { type: ShadingType.SOLID, color: 'F5F6F8', fill: 'F5F6F8' },
          borders: allBorderSingle,
          width: { size: 400, type: WidthType.DXA },
        }),
        new TableCell({
          children: [new Paragraph({ children: [t('品項編碼 / 規格', { bold: true, size: 18, color: '555555' })] })],
          shading: { type: ShadingType.SOLID, color: 'F5F6F8', fill: 'F5F6F8' },
          borders: allBorderSingle,
          width: { size: 3800, type: WidthType.DXA },
        }),
        new TableCell({
          children: [new Paragraph({ children: [t('數量', { bold: true, size: 18, color: '555555' })] })],
          shading: { type: ShadingType.SOLID, color: 'F5F6F8', fill: 'F5F6F8' },
          borders: allBorderSingle,
          width: { size: 1400, type: WidthType.DXA },
        }),
        new TableCell({
          children: [new Paragraph({ children: [t('包裝方式', { bold: true, size: 18, color: '555555' })] })],
          shading: { type: ShadingType.SOLID, color: 'F5F6F8', fill: 'F5F6F8' },
          borders: allBorderSingle,
        }),
        new TableCell({
          children: [new Paragraph({ children: [t('等級', { bold: true, size: 18, color: '555555' })], alignment: AlignmentType.CENTER })],
          shading: { type: ShadingType.SOLID, color: 'F5F6F8', fill: 'F5F6F8' },
          borders: allBorderSingle,
          width: { size: 800, type: WidthType.DXA },
        }),
      ],
    })

    const lineDataRows: TableRow[] = soLines.length > 0
      ? soLines.map(line => {
          const lno    = String(parseInt(String(line.line_no || '0'), 10))
          const isThis = lno === lineNo
          const lqty   = line.order_qty_oru ?? line.order_qty
          const luom   = line.unit_of_measure_oru || line.unit_of_measure || ''
          const qtyStr = lqty != null ? `${lqty} ${luom}`.trim() : '—'
          const shade  = isThis ? 'FEF3C7' : 'FFFFFF'

          return new TableRow({
            children: [
              new TableCell({
                children: [new Paragraph({ children: [t(lno + (isThis ? ' ★' : ''), { bold: isThis, size: 18 })], alignment: AlignmentType.CENTER })],
                borders: allBorderSingle,
                shading: { type: ShadingType.SOLID, color: shade, fill: shade },
              }),
              new TableCell({
                children: [
                  new Paragraph({ children: [t(line.mbp_part || line.part || '—', { bold: isThis, size: 18 })] }),
                  new Paragraph({ children: [t(line.description || '', { size: 16, color: '555555' })] }),
                ],
                borders: allBorderSingle,
                shading: { type: ShadingType.SOLID, color: shade, fill: shade },
              }),
              new TableCell({
                children: [new Paragraph({ children: [t(qtyStr, { size: 18 })] })],
                borders: allBorderSingle,
                shading: { type: ShadingType.SOLID, color: shade, fill: shade },
              }),
              new TableCell({
                children: [new Paragraph({ children: [t(line.packing || '—', { size: 18 })] })],
                borders: allBorderSingle,
                shading: { type: ShadingType.SOLID, color: shade, fill: shade },
              }),
              new TableCell({
                children: [new Paragraph({ children: [t(line.grade || '—', { size: 18 })], alignment: AlignmentType.CENTER })],
                borders: allBorderSingle,
                shading: { type: ShadingType.SOLID, color: shade, fill: shade },
              }),
            ],
          })
        })
      : [
          new TableRow({
            children: [
              new TableCell({
                children: [new Paragraph({ children: [t('訂單詳細資訊尚未同步，請至「銷售訂單同步」頁面執行同步', { size: 18, color: '9CA3AF', italics: true })], alignment: AlignmentType.CENTER })],
                borders: allBorderSingle,
                columnSpan: 5,
              }),
            ],
          }),
        ]

    const linesTable = new Table({
      layout: TableLayoutType.FIXED,
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [lineHeaderRow, ...lineDataRows],
    })
    items.push(linesTable)
  } else {
    items.push(new Paragraph({
      children: [t('（此採購單無來源訂單）', { size: 18, color: '9CA3AF', italics: true })],
      spacing: { before: 60, after: 60 },
      indent: { left: 100 },
    }))
  }

  // ── 5. 作業確認 ─────────────────────────────────────────
  items.push(sectionHeader('作業確認'))
  const roles = ['倉管收料', '品檢驗收', '入庫作業', '銷單作業']
  const confirmTable = new Table({
    layout: TableLayoutType.FIXED,
    width: { size: 100, type: WidthType.PERCENTAGE },
    columnWidths: [2350, 2350, 2350, 2350],
    rows: [
      // 簽名列
      new TableRow({
        height: { value: convertInchesToTwip(0.6), rule: 'atLeast' },
        children: roles.map(role =>
          new TableCell({
            children: [
              new Paragraph({ children: [t(role, { size: 20, color: '6B7280' })], spacing: { before: 60, after: 120 } }),
            ],
            borders: allBorderSingle,
          })
        ),
      }),
      // 日期列
      new TableRow({
        height: { value: convertInchesToTwip(0.4), rule: 'atLeast' },
        children: roles.map(() =>
          new TableCell({
            children: [
              new Paragraph({ children: [t('日期', { size: 18, color: '9CA3AF' })], spacing: { before: 40, after: 80 } }),
            ],
            borders: allBorderSingle,
          })
        ),
      }),
    ],
  })
  items.push(confirmTable)

  // ── 換頁（最後一筆不加）───────────────────────────────
  if (!isLast) {
    items.push(new Paragraph({ children: [new PageBreak()] }))
  }

  return items
}

// ── 主要匯出函式 ─────────────────────────────────────────────
export async function exportPoToWord(
  records: MoRecord[],
  soMap: Map<string, SoLine[]>,
  customerCodeMap: Map<string, string>,
): Promise<void> {
  // 只匯出採購單（工廠 C 或 O）
  const poRecords = records.filter(m => m.factory === 'C' || m.factory === 'O')
  if (poRecords.length === 0) {
    alert('目前頁面中無採購單（工廠 C / O），無法匯出。')
    return
  }

  const allChildren: (Paragraph | Table)[] = []
  poRecords.forEach((mo, idx) => {
    const section = buildPoSection(mo, soMap, customerCodeMap, idx === poRecords.length - 1)
    allChildren.push(...section)
  })

  const doc = new Document({
    styles: {
      default: {
        document: {
          run: { font: 'Microsoft JhengHei', size: 20 },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: 11906, height: 16838 },   // A4
            margin: { top: 720, bottom: 720, left: 900, right: 900 },
          },
        },
        children: allChildren,
      },
    ],
  })

  const blob = await Packer.toBlob(doc)
  const dateStr = new Date().toLocaleDateString('zh-TW').replace(/\//g, '')
  saveAs(blob, `採購單_${dateStr}.docx`)
}
