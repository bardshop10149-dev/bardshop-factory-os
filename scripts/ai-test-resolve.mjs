// 給 `npm run test:ai` 用的模組解析 hook：Node --experimental-strip-types 直接跑專案 .ts 時，
//   - '@/…' 路徑別名（tsconfig paths）Node 不認得 → 補成專案根目錄
//   - 相對匯入沒寫副檔名（bundler 風格）→ 試 .ts／.tsx／.js
//   - 'next/server' 這類子路徑：next 的 package.json 沒有 exports map，Node ESM 找不到 → 補成 node_modules/next/server.js
// 只處理專案原始碼；node_modules 內部不碰。專案根目錄由本檔位置推導（scripts/ 的上一層），不寫死絕對路徑。
import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..') + '/'
const ROOT_URL = pathToFileURL(ROOT).href

registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL ?? ''
    if (parent.includes('node_modules')) return nextResolve(specifier, context)
    let base = null
    if (specifier.startsWith('@/')) base = pathToFileURL(ROOT + specifier.slice(2))
    else if ((specifier.startsWith('./') || specifier.startsWith('../')) && parent.startsWith(ROOT_URL) && !/\.[a-z]+$/i.test(specifier)) base = new URL(specifier, parent)
    else if (/^next\/[a-z-]+$/.test(specifier)) base = pathToFileURL(ROOT + 'node_modules/' + specifier)
    if (base) {
      for (const ext of ['.ts', '.tsx', '.js']) {
        const candidate = new URL(base.href + ext)
        if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context)
      }
    }
    return nextResolve(specifier, context)
  },
})
