import { NextRequest, NextResponse } from 'next/server'
import { guardAuth } from '@/lib/requireAuth'

const GOOGLE_VISION_API_KEY = process.env.GOOGLE_VISION_API_KEY || ''
const VISION_API_URL = `https://vision.googleapis.com/v1/images:annotate?key=${GOOGLE_VISION_API_KEY}`

interface Vertex { x: number; y: number }
interface OcrBlock {
  text: string
  box: { x: number; y: number; w: number; h: number }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function getBox(vertices: any[]): { x: number; y: number; w: number; h: number } {
  const xs = vertices.map((v: any) => v.x || 0)
  const ys = vertices.map((v: any) => v.y || 0)
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  return { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY }
}

// 把每個 paragraph 當作一個獨立的 cell（方框）
function extractBlocks(annotation: Record<string, any>): OcrBlock[] {
  const blocks: OcrBlock[] = []
  const pages = annotation?.fullTextAnnotation?.pages
  if (!Array.isArray(pages)) return blocks

  for (const page of pages) {
    for (const block of page.blocks || []) {
      for (const para of block.paragraphs || []) {
        // 把 paragraph 內所有 symbol 拼成文字
        let paraText = ''
        for (const word of para.words || []) {
          const wordText = (word.symbols || []).map((s: any) => s.text || '').join('')
          paraText += wordText
        }
        const vertices = para.boundingBox?.vertices || []
        if (paraText && vertices.length >= 4) {
          blocks.push({ text: paraText.trim(), box: getBox(vertices) })
        }
      }
    }
  }
  return blocks
}

export async function POST(req: NextRequest) {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res

  if (!GOOGLE_VISION_API_KEY) {
    return NextResponse.json(
      { error: '尚未設定 GOOGLE_VISION_API_KEY，請在 .env.local 中新增' },
      { status: 500 }
    )
  }

  try {
    const { image } = await req.json()
    if (!image || typeof image !== 'string') {
      return NextResponse.json({ error: '缺少圖片資料' }, { status: 400 })
    }
    // 限制輸入大小，避免濫用 Google Vision 配額 / DoS（base64 約 13.3MB ≈ 10MB 圖片）
    if (image.length > 13_300_000) {
      return NextResponse.json({ error: '圖片過大' }, { status: 413 })
    }

    const base64 = image.replace(/^data:image\/\w+;base64,/, '')

    const body = {
      requests: [
        {
          image: { content: base64 },
          features: [{ type: 'DOCUMENT_TEXT_DETECTION', maxResults: 1 }],
          imageContext: {
            languageHints: ['zh-TW', 'en'],
          },
        },
      ],
    }

    const res = await fetch(VISION_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const errText = await res.text()
      console.error('Google Vision API error:', errText)
      return NextResponse.json(
        { error: `Google Vision API 錯誤 (${res.status})` },
        { status: 502 }
      )
    }

    const data = await res.json()
    const annotation = data.responses?.[0]

    if (annotation?.error) {
      return NextResponse.json(
        { error: `Vision API: ${annotation.error.message}` },
        { status: 502 }
      )
    }

    const fullText = annotation?.fullTextAnnotation?.text || ''
    const blocks = extractBlocks(annotation || {})

    return NextResponse.json({ text: fullText, blocks })
  } catch (err: unknown) {
    console.error('OCR route error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '未知錯誤' },
      { status: 500 }
    )
  }
}
