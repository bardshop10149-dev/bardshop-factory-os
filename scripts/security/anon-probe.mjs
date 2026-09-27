#!/usr/bin/env node
/**
 * anon 曝險探針（唯讀、只數筆數、不讀任何列內容）。
 *
 * 用瀏覽器會拿到的公開 anon key，對每張表送 HEAD + `Prefer: count=exact`，
 * 只看回應的 Content-Range 尾端筆數。任何一張表回 200/206 且筆數 > 0，
 * 就代表「不登入的任何人」能把這張表整個 dump 下來。
 *
 * 用法：
 *   node scripts/security/anon-probe.mjs                # 讀 .env.local
 *   node scripts/security/anon-probe.mjs --env .env.prod
 *   node scripts/security/anon-probe.mjs --tables a,b   # 只查指定表
 *
 * 預期（sql/20260927_lockdown_anon.sql 套用後）：每張表都是 401/403/404 或筆數 0。
 * 不輸出任何金鑰。
 */
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const argOf = (flag) => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}
const envFile = argOf('--env') ?? '.env.local'
const onlyTables = argOf('--tables')?.split(',').map(s => s.trim()).filter(Boolean)

const envText = fs.readFileSync(path.resolve(process.cwd(), envFile), 'utf8')
const env = Object.fromEntries(
  envText.split(/\r?\n/).filter(l => /^[A-Z_]+=/.test(l)).map(l => {
    const i = l.indexOf('=')
    return [l.slice(0, i), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
  })
)
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY
if (!URL_ || !ANON) {
  console.error(`缺少 NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY（${envFile}）`)
  process.exit(2)
}

// 表清單：程式碼裡出現過的 .from('<table>') + sql/ 裡 create/alter 過的表（去重）
function collectTables() {
  const set = new Set()
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === 'node_modules' || ent.name === '.next' || ent.name.startsWith('.git')) continue
      const p = path.join(dir, ent.name)
      if (ent.isDirectory()) walk(p)
      else if (/\.(ts|tsx|js|mjs|sql)$/.test(ent.name)) {
        const s = fs.readFileSync(p, 'utf8')
        for (const m of s.matchAll(/\.from\(\s*['"`]([a-z][a-z0-9_]*)['"`]\s*\)/g)) set.add(m[1])
        for (const m of s.matchAll(/(?:create|alter)\s+table\s+(?:if\s+not\s+exists\s+)?(?:only\s+)?(?:public\.)?([a-z][a-z0-9_]*)/gi)) set.add(m[1].toLowerCase())
      }
    }
  }
  for (const d of ['app', 'components', 'context', 'lib', 'sql', 'scripts']) {
    if (fs.existsSync(d)) walk(d)
  }
  return [...set].sort()
}

const tables = onlyTables ?? collectTables()
const H = { apikey: ANON, Authorization: `Bearer ${ANON}` }

let exposed = 0
const rows = []
for (const t of tables) {
  let status = 'ERR', count = ''
  try {
    const r = await fetch(`${URL_}/rest/v1/${encodeURIComponent(t)}?select=*`, {
      method: 'HEAD',
      headers: { ...H, Prefer: 'count=exact', Range: '0-0' },
    })
    status = String(r.status)
    const cr = r.headers.get('content-range') || ''
    count = cr.includes('/') ? cr.split('/')[1] : ''
  } catch (e) {
    count = String(e?.message ?? e)
  }
  const n = Number(count)
  const flag = (status === '200' || status === '206') && Number.isFinite(n) && n > 0 ? '  ← anon 可讀' : ''
  if (flag) exposed++
  rows.push(`${t.padEnd(44)} ${status.padEnd(5)} ${String(count).padStart(8)}${flag}`)
}

console.log(`${'table'.padEnd(44)} ${'http'.padEnd(5)} ${'anon筆數'.padStart(6)}`)
console.log(rows.join('\n'))
console.log(`\n共 ${tables.length} 張表，anon 可讀且有資料：${exposed} 張`)
process.exit(exposed > 0 ? 1 : 0)
