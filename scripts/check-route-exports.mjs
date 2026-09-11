#!/usr/bin/env node
/**
 * 檢查 app/api/**\/route.ts 只匯出 Next.js 允許的名稱。
 *
 * 背景：route 檔多匯出一個常數（例如 `export const CSV_H1 = ...`），turbopack 打包不會抱怨、
 * Vercel 照常部署，但 `next build --webpack` 的型別驗證會整個失敗——2026-08/09 已連續踩到三次
 * （exchange-csv、order-sketch、schedule-confirm/notes）。這支在 `npm run build` 最前面先擋，
 * 錯誤訊息直接指出檔案與名稱，不用等到打包尾端才看到一頁 OmitWithTag 型別錯誤。
 *
 * 用法：node scripts/check-route-exports.mjs   （無輸出＝通過；有問題回傳非 0）
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// Next.js App Router route.ts 允許的匯出（HTTP method + 路由設定）
const ALLOWED = new Set([
  'GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS',
  'dynamic', 'dynamicParams', 'revalidate', 'fetchCache', 'runtime', 'preferredRegion', 'maxDuration',
  'generateStaticParams', 'config',
])

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/^route\.(ts|tsx|js|mjs)$/.test(name)) out.push(full)
  }
  return out
}

const root = process.cwd()
const files = walk(join(root, 'app', 'api'))
const problems = []

for (const file of files) {
  const src = readFileSync(file, 'utf8')
  // 逐行找「值」匯出：export const/let/var/function/async function/class/enum NAME
  // （type / interface 是純型別，編譯後不存在，Next 的 route 型別驗證只看值匯出，不算違規）
  const re = /^export\s+(?:async\s+)?(?:const|let|var|function\*?|class|enum)\s+([A-Za-z_$][\w$]*)/gm
  let m
  while ((m = re.exec(src))) {
    const name = m[1]
    if (!ALLOWED.has(name)) {
      const line = src.slice(0, m.index).split('\n').length
      problems.push(`${relative(root, file)}:${line}  export "${name}"`)
    }
  }
  // export { a, b } 形式（export type { ... } 是型別，略過）
  const reList = /^export\s*\{([^}]*)\}/gm
  while ((m = reList.exec(src))) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim()
      if (name && !ALLOWED.has(name)) {
        const line = src.slice(0, m.index).split('\n').length
        problems.push(`${relative(root, file)}:${line}  export { ${name} }`)
      }
    }
  }
}

if (problems.length) {
  console.error('\n✖ route.ts 只能匯出 HTTP method 與路由設定，以下匯出會讓 next build 型別驗證失敗：\n')
  for (const p of problems) console.error('   ' + p)
  console.error('\n  修法：拿掉 export（常數只在檔內用），或把它搬到 lib/ 再 import。\n')
  process.exit(1)
}
