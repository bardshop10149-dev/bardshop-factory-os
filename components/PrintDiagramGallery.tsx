'use client'

import { useEffect, useState } from 'react'

// ─────────────────────────────────────────────────────────────────────────────
// 示意圖縮圖牆（共用元件）
//
// 資料鏈：/api/purchasing/print-preview（EIP 後端簽 SSO 票證→換 argo token→抓清單）
// → 瀏覽器直接 <img> argo-tool 的縮圖端點（bardshop-argo.com，HTTPS，
//   該端點特准 ?token= 供 <img> 使用；img 不受 CORS 限制）。
// 圖不落地雲端；傳輸走 Cloudflare Tunnel 加密通道（與現場列印示意圖同一條路）。
//
// 用在：採購專區 📷 徽章視窗、SO 訂單詳情視窗下方（Snow 2026-09-02：點單號要
// 一次看到「訂單詳情＋示意圖」）。
// ─────────────────────────────────────────────────────────────────────────────

interface DiagramFile { filename: string; so_folder_name: string; ext: string | null }
interface DiagramGroup { item_name: string | null; files: DiagramFile[] }

export default function PrintDiagramGallery({ so }: { so: string }) {
  const [preview, setPreview] = useState<{ argoBase: string; token: string; groups: DiagramGroup[] } | null>(null)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setErr('')
    setPreview(null)
    fetch(`/api/purchasing/print-preview?so=${encodeURIComponent(so)}`)
      .then((res) => res.json())
      .then((json: { success?: boolean; argoBase?: string; token?: string; groups?: DiagramGroup[]; error?: string }) => {
        if (!alive) return
        if (!json.success) throw new Error(json.error || '查詢失敗')
        setPreview({ argoBase: json.argoBase!, token: json.token!, groups: json.groups ?? [] })
      })
      .catch((e: unknown) => { if (alive) setErr(e instanceof Error ? e.message : '查詢失敗') })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [so])

  const thumbUrl = (f: DiagramFile, dim: number) =>
    `${preview!.argoBase}/api/nas/diagram_thumbnail?so_folder=${encodeURIComponent(f.so_folder_name)}`
    + `&filename=${encodeURIComponent(f.filename)}&max_dim=${dim}&token=${encodeURIComponent(preview!.token)}`

  if (loading) return <p className="text-sm text-slate-500 py-6 text-center">向 ARGO 工具站查詢示意圖中…</p>
  if (err) return <p className="text-sm text-amber-300/90 py-3 text-center">⚠ {err}</p>
  if (!preview || preview.groups.length === 0) {
    return <p className="text-sm text-slate-500 py-3 text-center">NAS 上還沒有這張單的示意圖。</p>
  }

  return (
    <>
      {preview.groups.map((gp) => (
        <div key={gp.item_name ?? ''} className="mb-4 last:mb-0">
          {gp.item_name && <p className="text-xs text-slate-400 mb-2">{gp.item_name}</p>}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {gp.files.map((f) => (
              <a
                key={`${f.so_folder_name}|${f.filename}`}
                href={thumbUrl(f, 1600)}
                target="_blank"
                rel="noopener noreferrer"
                title={`${f.filename}（點開大圖）`}
                className="block rounded-lg border border-slate-700 bg-slate-950 overflow-hidden hover:border-sky-600"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={thumbUrl(f, 360)} alt={f.filename} loading="lazy"
                  className="w-full h-44 object-contain bg-black/30" />
                <div className="px-2 py-1.5 text-[11px] text-slate-400 truncate">{f.filename}</div>
              </a>
            ))}
          </div>
        </div>
      ))}
    </>
  )
}
