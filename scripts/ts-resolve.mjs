// Node --experimental-strip-types 跑專案 .ts 時，相對匯入沒寫副檔名會找不到；這個 hook 幫它補 .ts
import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[a-z]+$/i.test(specifier) && context.parentURL?.startsWith('file:') && context.parentURL.includes('/EIP/_quote_wt/lib/') && !context.parentURL.includes('node_modules')) {
      const base = new URL(specifier, context.parentURL)
      for (const ext of ['.ts', '.tsx', '.js']) {
        const candidate = new URL(base.href + ext)
        if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context)
      }
    }
    return nextResolve(specifier, context)
  },
})
