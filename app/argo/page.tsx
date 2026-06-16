'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * ARGO 外掛區：點首頁卡片進來 → 跟後端要 SSO token（記 LOG）→ iframe 嵌入 argo
 * → postMessage 把 token 傳進去 → argo 自動登入（不重登）。
 */
export default function ArgoPage() {
  const router = useRouter()
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const tokenRef = useRef('')
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errMsg, setErrMsg] = useState('')
  const [argoBase, setArgoBase] = useState('')

  useEffect(() => {
    fetch('/api/argo/launch', { method: 'POST' })
      .then(r => r.json())
      .then((d: { ok?: boolean; token?: string; argoBase?: string; error?: string }) => {
        if (!d.ok || !d.token || !d.argoBase) throw new Error(d.error || '無法啟動 ARGO 外掛區')
        tokenRef.current = d.token
        setArgoBase(d.argoBase)
        setStatus('ready')
      })
      .catch((e: unknown) => {
        setErrMsg(e instanceof Error ? e.message : '啟動失敗')
        setStatus('error')
      })
  }, [])

  // iframe 載入完成後，把 token postMessage 進去（argo 收到後自動進主畫面）
  const handleIframeLoad = () => {
    const win = iframeRef.current?.contentWindow
    if (win && tokenRef.current && argoBase) {
      win.postMessage({ type: 'auth', token: tokenRef.current }, argoBase)
    }
  }

  return (
    <div className="h-screen flex flex-col bg-[#050b14] text-slate-300">
      <div className="flex items-center justify-between px-4 py-2 border-b border-slate-800 shrink-0">
        <button
          onClick={() => router.push('/')}
          className="flex items-center gap-2 text-sm text-slate-400 hover:text-cyan-400 transition-colors"
        >
          <span className="text-lg">←</span> 返回首頁
        </button>
        <span className="text-sm font-bold text-white">ARGO 外掛區</span>
        <span className="w-20" />
      </div>

      {status === 'loading' && (
        <div className="flex-1 flex items-center justify-center text-slate-500">連線 ARGO 中…</div>
      )}
      {status === 'error' && (
        <div className="flex-1 flex flex-col items-center justify-center gap-3">
          <p className="text-red-400 text-sm">{errMsg}</p>
          <button onClick={() => router.push('/')} className="text-cyan-400 underline text-sm">返回首頁</button>
        </div>
      )}
      {status === 'ready' && argoBase && (
        <iframe
          ref={iframeRef}
          src={argoBase}
          onLoad={handleIframeLoad}
          className="flex-1 w-full border-0"
          allow="camera"
          title="ARGO 工具"
        />
      )}
    </div>
  )
}
