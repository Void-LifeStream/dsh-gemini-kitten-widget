/**
 * 离线自测：用假的 cordis ctx 把 host 半跑起来，验证
 *   ① 模块能 import（= 语法/ESM 正确）
 *   ② webserver/index-inject 注入行内容正确、幂等
 *   ③ /dsh-kitten/state 的额度算法正确（拿真实账本复算）
 *   ④ /dsh-kitten/widget.js 能取到客户端脚本
 * 不写任何文件、不改任何配置。
 *
 * 用法（本机 node 不在 PATH 里）：
 *   & "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" tools\selftest.mjs
 */
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HOST_ENTRY = path.join(HERE, '..', 'lib', 'index.js')

const plugin = (await import(pathToFileURL(HOST_ENTRY).href)).default

const routes = new Map()
const listeners = new Map()

const fakeCtx = {
  get: () => null,
  webServer: {
    register(route) {
      const key = route.kind + ' ' + route.path
      if (routes.has(key)) throw new Error('duplicate route ' + key)
      routes.set(key, route)
      return () => routes.delete(key)
    },
    tapIndex() {
      return () => {}
    },
  },
}

const root = {
  on(ev, cb) {
    listeners.set(ev, cb)
    return () => listeners.delete(ev)
  },
  inject(deps, cb) {
    cb(fakeCtx)
  },
  effect() {
    return () => {}
  },
}

plugin.apply(root)
console.log('① 模块加载 OK, plugin.name =', plugin.name)

const table = []
listeners.get('webserver/index-inject')(table)
listeners.get('webserver/index-inject')(table) // 再来一次，验幂等
console.log('② 注入行条数 =', table.length, '(应为 1)')
console.log('   kind =', table[0] && table[0].kind, '| placement =', table[0] && table[0].placement)
console.log('   text =', table[0] && table[0].text)

function makeRes(kind) {
  return {
    writeHead(code) {
      this.code = code
    },
    end(body) {
      if (kind === 'state') {
        console.log('③ /state HTTP', this.code)
        const d = JSON.parse(body)
        console.log('   ok=' + d.ok, 'today=' + d.today, 'tz=' + d.tz)
        console.log('   used=' + d.used + '/' + d.limit, 'remaining=' + d.remaining, 'level=' + d.level)
        console.log('   bottleneck=' + d.bottleneck, 'exhausted=' + JSON.stringify(d.exhaustedModels || []))
        console.log('   resetAt=' + new Date(d.resetAt).toISOString(), '(' + d.tz + ' 下一个午夜)')
        console.log('   byModel=' + JSON.stringify(d.byModel), 'stale=' + d.stale)
        // 梗库（~/.dsh/widget-lines.json 的 kitten 段）有没有被读到
        const cl = d.customLines || {}
        const counts = Object.keys(cl).map((k) => k + ':' + cl[k].length).join(' ') || '(空/无文件)'
        console.log('   customLines=' + counts)
      } else {
        console.log('④ /widget.js HTTP', this.code, '| bytes =', String(body).length)
      }
    },
  }
}

console.log('   注册的路由:', [...routes.keys()].join(' , '))
await routes.get('exact /dsh-kitten/state').handler({ headers: {} }, makeRes('state'))
await routes.get('exact /dsh-kitten/widget.js').handler({ headers: {} }, makeRes('widget'))

// 附：账本里 gemini-* 事件逐条列出（人工核对口径）
const ledgerPath = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), '.dshw-usage.json')
const led = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'))
const bj = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium' })
const la = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', dateStyle: 'short', timeStyle: 'medium' })
console.log('\n账本里所有 gemini-* 事件（本地时间 / 太平洋时间）:')
for (const e of led.events) {
  if (!/^gemini-/i.test(String(e.model || ''))) continue
  console.log('  ', e.model, '| 北京', bj.format(new Date(e.ts)), '| 太平洋', la.format(new Date(e.ts)))
}
