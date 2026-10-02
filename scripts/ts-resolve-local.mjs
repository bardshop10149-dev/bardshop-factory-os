// Node --experimental-strip-types 跑專案 .ts 時，相對匯入沒寫副檔名會找不到；這個 hook 幫它補 .ts
//
// 與 scripts/ts-resolve.mjs 的差別：那支的路徑條件寫死在某個 worktree（/EIP/_quote_wt/lib/）
// 底下，在一般 checkout 裡不會生效。這支只排除 node_modules，任何專案內的相對匯入都補。
import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith('./') || specifier.startsWith('../'))
      && !/\.[a-z]+$/i.test(specifier)
      && context.parentURL?.startsWith('file:')
      && !context.parentURL.includes('node_modules')) {
      const base = new URL(specifier, context.parentURL)
      for (const ext of ['.ts', '.tsx', '.js']) {
        const candidate = new URL(base.href + ext)
        if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context)
      }
    }
    return nextResolve(specifier, context)
  },
})
