/**
 * 会话日志计数器的针对性测试（增量解帧逻辑容易出错，必须有回归）。
 *
 * 造一个假的 sessions 目录，写入 zstd 多帧日志，验证：
 *   ① 首次（冷扫）计数正确、按太平洋日期过滤、只认 gemini-*
 *   ② 追加一个帧后，增量重扫把新调用累加进去（不重复计旧帧）
 *   ③ 文件被截断重写时，计数正确重置（不能沿用增量）
 *   ④ 半截帧（写入中）不被计数，写完整后补齐
 *
 * 用法：
 *   & "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" tools\logtest.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HOST_ENTRY = path.join(HERE, '..', 'lib', 'index.js')

// —— 造假环境：临时 sessions 目录 + TTL=0（每次都真的重扫，才能测到增量路径）——
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dshk-logtest-'))
const SESS = path.join(TMP, 'sessions')
fs.mkdirSync(path.join(SESS, '--proj--', 'session-test'), { recursive: true })
const LOG = path.join(SESS, '--proj--', 'session-test', 'session.v4.jsonl.zstd')
process.env.DSHK_SESSIONS_DIR = SESS
process.env.DSHK_SCAN_TTL_MS = '0'
// 隔离真实账本：指向一个不存在的文件 ⇒ readLedger() 返回 null ⇒ 只信日志口径
process.env.DSHK_LEDGER = path.join(TMP, 'no-such-ledger.json')
// 隔离真实探测记录：否则本机真实的"3.8-flash 已用尽"会把计数强制拉满，测试就失真了
process.env.DSHK_PROBES = path.join(TMP, 'no-such-probes.json')

const pass = []
const fail = []
function check(name, ok, detail) {
  ;(ok ? pass : fail).push(name + (detail ? ' → ' + detail : ''))
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail ? ' → ' + detail : ''))
}

// —— 造日志帧 ——
const LA_TODAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date())
/** 太平洋时间今天中午的 UTC 毫秒（保证落在"今天"，不受当前时刻影响） */
function laNoonTodayUtc() {
  // 从今天洛杉矶日期反推：先猜一个 UTC 时刻，再按偏移修正到当地 12:00
  const guess = Date.now()
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(guess))
  const h = Number(parts.find((p) => p.type === 'hour').value)
  const m = Number(parts.find((p) => p.type === 'minute').value)
  return guess - (h * 3600 + m * 60) * 1000 + 12 * 3600 * 1000
}
const LA_NOON = laNoonTodayUtc()
const YESTERDAY = LA_NOON - 26 * 3600 * 1000

function frame(obj) {
  return zlib.zstdCompressSync(Buffer.from(JSON.stringify(obj) + '\n', 'utf8'))
}
function msg(ts, model, turn = 1, step = 1) {
  return frame({
    type: 'assistant/message',
    seq: turn * 10 + step,
    time: ts,
    data: { turn, step, message: { role: 'assistant', source: { provider: 'google', model } }, usage: { totalTokens: 100 } },
  })
}

// —— 假插件 ctx ——
const routes = new Map()
const listeners = new Map()
const fakeCtx = {
  get: () => null,
  webServer: {
    register(route) {
      routes.set(route.kind + ' ' + route.path, route)
      return () => {}
    },
    tapIndex() { return () => {} },
  },
}
const plugin = (await import(pathToFileURL(HOST_ENTRY).href)).default
plugin.apply({
  on(ev, cb) { listeners.set(ev, cb); return () => {} },
  inject(deps, cb) { cb(fakeCtx) },
  effect() { return () => {} },
})

async function readState() {
  const route = routes.get('exact /dsh-kitten/state')
  let out = null
  await route.handler({ headers: {} }, { writeHead() {}, end(b) { out = JSON.parse(b) } })
  return out
}

// ===== ① 冷扫 =====
// 3 次今天的 gemini + 1 次昨天的 gemini + 2 次今天的 deepseek（不该被计）
const f1 = Buffer.concat([
  frame({ type: 'session', version: '4', id: 'session-test' }),
  msg(LA_NOON - 5000, 'gemini-3.8-flash', 1, 1),
  msg(LA_NOON - 4000, 'gemini-3.8-flash', 1, 2),
  msg(LA_NOON - 3000, 'deepseek-flash', 1, 3),
  msg(LA_NOON - 2000, 'gemini-3.7-flash', 2, 1),
  msg(YESTERDAY, 'gemini-3.8-flash', 3, 1),
])
fs.writeFileSync(LOG, f1)
let st = await readState()
// 注意语义：used = **最紧的那个模型**的用量；totalUsed = 所有模型合计
check('冷扫：瓶颈模型 3.8-flash 计 2 次', st.used === 2, 'used=' + st.used + ' bottleneck=' + st.bottleneck)
check('冷扫：所有模型合计 3 次', st.totalUsed === 3, 'totalUsed=' + st.totalUsed)
check('冷扫：来源标为 session-log', st.source === 'session-log', st.source)
check('冷扫：按模型分组正确', JSON.stringify(st.byModel) === '{"gemini-3.8-flash":2,"gemini-3.7-flash":1}', JSON.stringify(st.byModel))
check('冷扫：昨天的调用没被计入', st.totalUsed === 3, 'totalUsed=' + st.totalUsed)

const t1 = Date.now()
await readState()
const warm = Date.now() - t1
check('TTL=0 强制重扫，但仍命中"文件未变"的快路径', warm < 60, warm + 'ms')

// ===== ② 追加一帧（增量）=====
fs.appendFileSync(LOG, msg(LA_NOON + 1000, 'gemini-3.8-flash', 4, 1))
fs.appendFileSync(LOG, msg(LA_NOON + 2000, 'gemini-3.8-flash', 4, 2))
st = await readState()
check('追加 2 次后瓶颈模型 = 4（增量累加，旧帧不重复计）', st.used === 4, 'used=' + st.used)
check('追加后合计 = 5', st.totalUsed === 5, 'totalUsed=' + st.totalUsed)
check('追加后分组 = 3.8:4 / 3.7:1', JSON.stringify(st.byModel) === '{"gemini-3.8-flash":4,"gemini-3.7-flash":1}', JSON.stringify(st.byModel))

// ===== ③ 半截帧 =====
const full = msg(LA_NOON + 3000, 'gemini-3.8-flash', 5, 1)
fs.appendFileSync(LOG, full.subarray(0, Math.floor(full.length / 2)))
st = await readState()
check('半截帧不被计数（瓶颈仍为 4）', st.used === 4, 'used=' + st.used)
fs.appendFileSync(LOG, full.subarray(Math.floor(full.length / 2)))
st = await readState()
check('补齐后计到 5', st.used === 5, 'used=' + st.used)

// ===== ④ 截断重写 =====
fs.writeFileSync(LOG, Buffer.concat([
  frame({ type: 'session', version: '4', id: 'session-test' }),
  msg(LA_NOON + 4000, 'gemini-3.7-flash', 9, 1),
]))
st = await readState()
check('文件被重写后计数重置为 1（没沿用增量）', st.used === 1, 'used=' + st.used)

// ===== ⑤ 空目录 / 只有非 gemini =====
fs.writeFileSync(LOG, Buffer.concat([
  frame({ type: 'session', version: '4', id: 'session-test' }),
  msg(LA_NOON, 'deepseek-flash', 1, 1),
]))
st = await readState()
check('只有 deepseek 时计 0（不是 1）', st.used === 0, 'used=' + st.used + ' source=' + st.source)

fs.rmSync(TMP, { recursive: true, force: true })
console.log('\n===== 结果: ' + pass.length + ' 通过, ' + fail.length + ' 失败 =====')
if (fail.length) {
  for (const f of fail) console.log('FAIL: ' + f)
  process.exitCode = 1
}
