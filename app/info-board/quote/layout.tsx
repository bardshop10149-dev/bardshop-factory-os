import type { ReactNode } from 'react'
import { IBM_Plex_Mono, Noto_Sans_TC, Noto_Serif_TC } from 'next/font/google'

/**
 * 報價計算機 layout：只做兩件事——載三套字型、包 `.q-page` wrapper。
 *
 * - 三套字型各司其職（設計書 §12.4）：Serif 只給標題（≥16px）、Sans 給內文、Plex Mono 給所有數字。
 * - CJK 字型一定 `preload:false`：Noto TC 被切成上百片 unicode-range，preload 會把首屏塞爆。
 * - Sans 用 `display:'optional'`：第一次落系統字、之後全走快取，永遠不會出現中文標籤整排重排。
 * - wrapper 帶 `lang="zh-Hant-TW"`（根 layout 是 lang="en"，不自帶 lang 會被 Han unification 挑到日文字形）。
 * - token 全掛在 `.q-page`（globals.css 最末端），不進 @theme、不動 body，其他頁完全看不到。
 */
const serif = Noto_Serif_TC({
  weight: ['600'],
  subsets: ['latin'],
  display: 'swap',
  preload: false,
  variable: '--font-noto-serif-tc',
})

const sans = Noto_Sans_TC({
  weight: ['400', '500', '700'],
  subsets: ['latin'],
  display: 'optional',
  preload: false,
  variable: '--font-noto-sans-tc',
})

const mono = IBM_Plex_Mono({
  weight: ['400', '500', '600'],
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-ibm-plex-mono',
})

export default function QuoteLayout({ children }: { children: ReactNode }) {
  return (
    <div className={`q-page ${serif.variable} ${sans.variable} ${mono.variable}`} lang="zh-Hant-TW">
      {children}
    </div>
  )
}
