/**
 * dsh-gemini-kitten-widget —— host 半
 * ============================================================================
 * 职责（只做四件事，越薄越不容易炸 web boot）：
 *   ① 尽早注册「客户端脚本注入行」——桌面端(Electron)唯一的注入通道；
 *   ② 注册三个**只读**路由：
 *        GET /dsh-kitten/widget.js   下发客户端脚本（带 mtime 指纹，改完刷新即生效）
 *        GET /dsh-kitten/art.png     下发形象立绘（ETag 走 mtime）
 *        GET /dsh-kitten/state       返回当前配额 JSON
 *   ③ web 形态补一条 tapIndex 注入（桌面端不走这里）；
 *   ④ 把「各模型还剩几次」发布到 ~/.dsh/facts/gemini-quota-remaining.json（跨会话台账）。
 *
 * 配额口径（**以 Google API 的 429 原文为准**，见 QUOTA_PER_MODEL_PER_DAY 处的长注释）：
 *   免费层 **20 次/模型/天**、**UTC 午夜重置**。
 *   已用次数 = DSH 会话日志里「配额日（UTC）内、model 以 gemini- 开头」的 assistant/message 条数
 *   （= 逐次 API 调用）。账本 events 只做兜底 —— 它是按 turn 聚合的，会严重低估。
 *   —— 本挂件只数得到 **DSH 内部**发起的调用。
 *
 * 安全姿态：本插件所有路由**只读、不含任何凭据、不写任何配置**，所以不做
 *   whale-widget 那套写接口的信任栅栏；只加「跨站标记一律拒」+ 委托宿主栅栏（若可用）。
 * ============================================================================
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = path.resolve(HERE, '..')

const LOG = '[dsh-kitten]'
const ROUTE_BASE = '/dsh-kitten'
const WIDGET_PATH = ROUTE_BASE + '/widget.js'
const STATE_PATH = ROUTE_BASE + '/state'
const ART_PATH = ROUTE_BASE + '/art.png'

/**
 * 免费层配额：**每个模型**每天多少次。
 *
 * 出处 —— Google API 自己的 429 原文（2026-10-15 两次独立实测，见
 *   `~/.dsh/facts/gemini-free-tier-quota.json`）：
 *     "Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests,
 *      limit: 20, model: gemini-3.8-flash"
 *
 * ⚠️ 早先按用户口径写的 250 次/天**是错的**，已按 API 原文改正。
 * 配额是**按模型分别计算**的（3.8-flash 用完不影响 3.7-flash），所以挂件盯着"最紧的那个模型"。
 * 用 DSHK_QUOTA_PER_MODEL 覆盖（配额随时可能变，别把它焊死在代码里）。
 */
const QUOTA_PER_MODEL_PER_DAY = (() => {
  const n = Number(process.env.DSHK_QUOTA_PER_MODEL)
  return isFinite(n) && n > 0 ? n : 20
})()

/**
 * 配额按 **UTC 午夜**重置（= 北京时间次日 08:00）。
 *
 * 出处 —— 同一份 429 原文的 "Please retry in 13h23m35s"：
 *   北京时间 18:36:25 = UTC 10:36:25，加 13h23m35s 恰好是 24:00:00Z。
 *   ⚠️ 早先以为按太平洋午夜重置（PDT 换算本身没错，但重置点不在那儿），**已被实测推翻**。
 */
const QUOTA_TZ = process.env.DSHK_QUOTA_TZ || 'UTC'

/** 客户端脚本候选路径（装成包与本地 link 两种形态都能找到）。 */
const WIDGET_FILE_CANDIDATES = [
  path.join(PACKAGE_ROOT, 'assets', 'kitten.js'),
  path.join(HERE, 'kitten.js'),
  path.join(HERE, 'assets', 'kitten.js'),
]

// ============================================================================
// 配额时间工具（按 QUOTA_TZ，当前 = UTC 午夜重置）
// ============================================================================
const dayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: QUOTA_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})
const clockFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: QUOTA_TZ,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

/** 某个时间戳落在太平洋时间的哪一天 → 'YYYY-MM-DD'。 */
function quotaDayKey(ms) {
  const parts = dayFmt.formatToParts(new Date(ms))
  let y = ''
  let m = ''
  let d = ''
  for (const p of parts) {
    if (p.type === 'year') y = p.value
    else if (p.type === 'month') m = p.value
    else if (p.type === 'day') d = p.value
  }
  return y + '-' + m + '-' + d
}

/** 时间戳在太平洋时间里「今天已过去多少秒」。 */
function secondsIntoQuotaDay(ms) {
  const parts = clockFmt.formatToParts(new Date(ms))
  let h = 0
  let mi = 0
  let s = 0
  for (const p of parts) {
    if (p.type === 'hour') h = Number(p.value)
    else if (p.type === 'minute') mi = Number(p.value)
    else if (p.type === 'second') s = Number(p.value)
  }
  return h * 3600 + mi * 60 + s
}

/** 下一次配额重置的时刻（太平洋时间下一个午夜）。 */
function nextResetAt(ms) {
  const elapsed = secondsIntoQuotaDay(ms)
  return ms + (86400 - elapsed) * 1000
}

// ============================================================================
// 账本读取（~/.dsh/.dshw-usage.json）
// ============================================================================
function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

// DSHK_LEDGER：整份覆盖（测试隔离用；设了它就**只**读这一个，不回落到默认候选）
const LEDGER_CANDIDATES = process.env.DSHK_LEDGER
  ? [process.env.DSHK_LEDGER]
  : (() => {
      const list = []
      for (const p of [
        path.join(dshHome(), '.dshw-usage.json'),
        path.join(os.homedir(), '.dsh', '.dshw-usage.json'),
      ]) {
        if (!list.includes(p)) list.push(p)
      }
      return list
    })()

/** 账本缓存：按 mtime 判定是否需要重读。 */
let ledgerCache = { mtimeMs: 0, path: '', parsed: null }

/**
 * 读账本。返回 null 表示完全读不到；`stale: true` 表示这次解析失败、
 * 用的是上一次成功的结果（账本常被挂件进程整份重写，读到半截 JSON 是正常的）。
 */
function readLedger() {
  for (const p of LEDGER_CANDIDATES) {
    let st = null
    try {
      st = fs.statSync(p)
    } catch (err) {
      continue
    }
    if (ledgerCache.parsed && ledgerCache.path === p && ledgerCache.mtimeMs === st.mtimeMs) {
      return { parsed: ledgerCache.parsed, path: p, stale: false }
    }
    let parsed = null
    try {
      parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
    } catch (err) {
      if (ledgerCache.parsed) return { parsed: ledgerCache.parsed, path: ledgerCache.path, stale: true }
      continue
    }
    ledgerCache = { mtimeMs: st.mtimeMs, path: p, parsed }
    return { parsed, path: p, stale: false }
  }
  if (ledgerCache.parsed) return { parsed: ledgerCache.parsed, path: ledgerCache.path, stale: true }
  return null
}

// ============================================================================
// 真实调用次数：扫 DSH 会话日志
// ----------------------------------------------------------------------------
// ⚠️ 为什么不能只用账本：`~/.dsh/.dshw-usage.json` 是鲸鱼娘挂件写的，它按
//   **turn 聚合** —— 一个 turn 里 agent 可能调用模型几十次（每次工具调用后都要再问一次），
//   但只在 turn/end 时写 **一条** event。所以"账本条数"≠"API 调用次数"，
//   实测同一时段账本 5 条 vs 真实 8 次，长任务里差距会更大。
//
// 权威口径：DSH 会话日志里每条 `assistant/message` = 一次模型响应 = 一次 API 调用。
//   日志是 zstd **多帧拼接**（逐次追加一个独立帧），必须逐帧解压。
// ============================================================================
const SESSIONS_DIR = process.env.DSHK_SESSIONS_DIR || path.join(dshHome(), 'sessions')
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
/** 多久重扫一次日志（毫秒）。稳态下只会重扫 mtime/size 变过的那 1~2 个活跃文件。 */
const SCAN_TTL_MS = process.env.DSHK_SCAN_TTL_MS !== undefined ? Number(process.env.DSHK_SCAN_TTL_MS) : 30000

/**
 * 把多帧拼接的 zstd 缓冲逐帧解开。
 *
 * 日志是**逐次追加**一个独立 zstd 帧的，所以对"只是变长了"的文件可以只解新追加的部分：
 * 传 `from` = 上次解到的帧边界，就只解后面的帧 —— 这是把稳态开销从 ~250ms 压到 ~5ms 的关键。
 *
 * @returns {{ data: Buffer, endOffset: number }} endOffset = 最后一个**完整解出**的帧的结束位置；
 *   半截帧（正在写入）不会被计入，下次扫描自然补齐。
 */
function decompressMultiFrame(buf, from) {
  let start = Math.max(0, Number(from) || 0)
  // 防御：start 必须落在一个帧的 magic 上，否则退回全量
  if (start > 0) {
    if (start >= buf.length || !buf.subarray(start, start + 4).equals(ZSTD_MAGIC)) start = 0
  }
  const parts = []
  let i = start
  let endOffset = start
  let guard = 0
  while (i < buf.length && guard++ < 2000000) {
    let j = buf.indexOf(ZSTD_MAGIC, i + 4)
    if (j === -1) j = buf.length
    let ok = false
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(i, j)))
      i = j
      endOffset = j
      ok = true
    } catch (err) {
      // 切到了压缩数据里的伪 magic，合并下一帧再试
    }
    if (!ok) {
      const k = buf.indexOf(ZSTD_MAGIC, j + 4)
      const kk = k === -1 ? buf.length : k
      try {
        parts.push(zlib.zstdDecompressSync(buf.subarray(i, kk)))
        i = kk
        endOffset = kk
        ok = true
      } catch (err) {}
    }
    if (!ok) {
      // 解不出来：多半是正在写入的半截帧 → 停在这里，下次再补
      break
    }
  }
  return { data: Buffer.concat(parts), endOffset }
}

/** 递归列出今天改动过的会话日志（更早的文件不可能含今天的调用）。 */
function listTodaysSessionLogs(dayStartMs) {
  const out = []
  const stack = [SESSIONS_DIR]
  let guard = 0
  while (stack.length && guard++ < 20000) {
    const dir = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (err) {
      continue
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        stack.push(p)
      } else if (e.name.endsWith('.jsonl.zstd')) {
        try {
          if (fs.statSync(p).mtimeMs >= dayStartMs) out.push(p)
        } catch (err) {}
      }
    }
  }
  return out
}

/** 按 mtime+size 做的文件级缓存：{ path -> { size, mtimeMs, count } }。 */
let logFileCache = new Map()
/** 上一次扫描的汇总：{ at, day, count, byModel, files }。 */
let logScanCache = { at: 0, day: '', count: 0, byModel: {}, degraded: false }

/** 太平洋时间某天的起点（毫秒）—— 用来只扫"今天可能相关的"日志文件。 */
function quotaDayStartMs(nowMs) {
  return nowMs - secondsIntoQuotaDay(nowMs) * 1000
}

function scanTodayGeminiCalls(nowMs) {
  const day = quotaDayKey(nowMs)
  if (logScanCache.day === day && nowMs - logScanCache.at < SCAN_TTL_MS) return logScanCache
  // 跨天：文件级缓存里存的是"那一天"的计数，直接清空重来
  if (logScanCache.day !== day) logFileCache = new Map()

  const dayStart = quotaDayStartMs(nowMs)
  const files = listTodaysSessionLogs(dayStart)
  const nextCache = new Map()
  const byModel = {}
  let count = 0
  let degraded = false

  for (const f of files) {
    let st
    try {
      st = fs.statSync(f)
    } catch (err) {
      continue
    }
    const hit = logFileCache.get(f)
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) {
      nextCache.set(f, hit)
      count += hit.count
      for (const [m, n] of Object.entries(hit.byModel || {})) byModel[m] = (byModel[m] || 0) + n
      continue
    }
    // 变了（多半是正在写入的当前会话）→ 只重扫这一个文件。
    // 文件只是**变长**时，只解新追加的帧，计数在旧值上累加。
    let raw
    let res
    try {
      raw = fs.readFileSync(f)
      const from = hit && hit.endOffset > 0 && raw.length > hit.size ? hit.endOffset : 0
      res = decompressMultiFrame(raw, from)
      var incrementalFrom = from
    } catch (err) {
      degraded = true
      continue
    }
    const text = res.data.toString('utf8')
    const incremental = incrementalFrom > 0 && !!hit
    const myByModel = incremental ? Object.assign({}, hit.byModel || {}) : {}
    const myHeaders = incremental ? Object.assign({}, hit.headers || {}) : {}
    let myCount = incremental ? hit.count : 0
    for (const line of text.split('\n')) {
      // 便宜的预筛：绝大多数行既不含事件名也不含模型名
      if (!line || line.indexOf('gemini') === -1) continue
      const isMsg = line.indexOf('assistant/message') !== -1
      const isHdr = line.indexOf('request/header') !== -1
      if (!isMsg && !isHdr) continue
      let o
      try {
        o = JSON.parse(line)
      } catch (err) {
        continue
      }
      const ts = Number(o.time)
      if (!isFinite(ts) || quotaDayKey(ts) !== day) continue
      if (o.type === 'request/header') {
        // 每个 request/header 代表该会话**至少**发起过一次调用 —— 用来给只发过一两次、
        // 没留下 step/assistant 记录的调用（探活、被中断的 turn）兜底。
        const m = o.data && o.data.header && o.data.header.config && o.data.header.config.model
        if (typeof m === 'string' && /^gemini/i.test(m)) myHeaders[m] = (myHeaders[m] || 0) + 1
        continue
      }
      if (o.type !== 'assistant/message') continue
      const model = findModelIn(o.data)
      if (!model || !/^gemini-/i.test(model)) continue
      myCount++
      myByModel[model] = (myByModel[model] || 0) + 1
    }
    // 单个文件内：同一模型取 max(响应条数, 请求头条数) —— 两者是不同事件，不可相加
    for (const m of Object.keys(myHeaders)) {
      myByModel[m] = Math.max(myByModel[m] || 0, myHeaders[m])
    }
    myCount = Object.values(myByModel).reduce((a, b) => a + b, 0)
    const entry = { size: raw.length, mtimeMs: st.mtimeMs, count: myCount, byModel: myByModel, headers: myHeaders, endOffset: res.endOffset }
    nextCache.set(f, entry)
    count += myCount
    for (const [m, n] of Object.entries(myByModel)) byModel[m] = (byModel[m] || 0) + n
  }

  logFileCache = nextCache
  logScanCache = { at: nowMs, day, count, byModel, degraded, files: files.length }
  return logScanCache
}

/** 从 assistant/message 的 data 里挖出模型名（它在 message.source 里，位置不固定）。 */
function findModelIn(o, depth = 0, seen = null) {
  if (!o || typeof o !== 'object' || depth > 6) return null
  if (!seen) seen = new Set()
  if (seen.has(o)) return null
  seen.add(o)
  for (const [k, v] of Object.entries(o)) {
    if (k === 'model' && typeof v === 'string' && v) return v
    const r = findModelIn(v, depth + 1, seen)
    if (r) return r
  }
  return null
}

// ============================================================================
// 数字口径说明（写进状态里，让前端能如实告诉用户数据从哪来）
// ============================================================================
/**
 * 权威计数优先级：
 *   ① 会话日志 assistant/message 条数（= 真实 API 调用次数）
 *   ② 日志不可用 → 退回账本 events 条数（会低估，标 degraded）
 */

/** 组装对外的状态对象（客户端只认这个形状）。 */
function computeState() {
  const now = Date.now()
  const today = quotaDayKey(now)
  const resetAt = nextResetAt(now)

  // ① 权威口径：会话日志里 assistant/message 的条数 = 真实 API 调用次数
  let scan = null
  try {
    scan = scanTodayGeminiCalls(now)
  } catch (err) {
    console.error(LOG + ' 会话日志扫描失败，退回账本口径', err)
  }

  // ② 账本：给出花费金额；日志不可用时作为次数兜底（会低估）
  let ledgerUsed = 0
  let ledgerCost = 0
  const ledgerByModel = {}
  let ledgerReadable = false
  let ledgerStale = false
  const led = readLedger()
  if (led) {
    ledgerReadable = true
    ledgerStale = !!led.stale
    const events = Array.isArray(led.parsed && led.parsed.events) ? led.parsed.events : []
    for (const e of events) {
      if (!e || typeof e !== 'object') continue
      const model = typeof e.model === 'string' ? e.model : ''
      // 只统计 Gemini 系列（gemma-* 不在免费层这套 gemini-* 配额口径内）
      if (!/^gemini-/i.test(model)) continue
      const ts = Number(e.ts)
      if (!isFinite(ts) || quotaDayKey(ts) !== today) continue
      ledgerUsed++
      ledgerCost += Number(e.cost) || 0
      ledgerByModel[model] = (ledgerByModel[model] || 0) + 1
    }
  }

  if (!ledgerReadable && !scan) {
    return {
      ok: false,
      error: 'no-source',
      today,
      used: null,
      limit: QUOTA_PER_MODEL_PER_DAY,
      remaining: null,
      level: 'unknown',
      resetAt,
      ts: now,
    }
  }

  const logUsed = scan ? scan.count : 0
  const fromLog = logUsed >= ledgerUsed
  const byModelRaw = fromLog ? ((scan && scan.byModel) || {}) : ledgerByModel
  // 账本口径要剔除"日志已经数过"的重复：这里只做防御性合并，正常走日志
  const byModel = Object.assign({}, byModelRaw)

  // —— 配额是**按模型**算的 ⇒ 主显示盯"最紧的那个模型"（用得最多 = 剩得最少）——
  // —— 实测覆盖层（最高权威）——
  // 429 是 Google 亲口给的结论，比任何本地估算都可信：本地日志**永远**可能偏低
  // （探活调用、被中断的 turn、重试都可能不落 step/assistant 记录）。
  // 另外把"本机主动探测"真实吃掉的那几次也补进用量里。
  const exhaustedModels = []
  try {
    const pj = JSON.parse(fs.readFileSync(PROBE_FILE, 'utf8'))
    const latest = {}
    for (const p of pj.probes || []) {
      if (!p || typeof p.model !== 'string' || !/^(gemini|gemma)/i.test(p.model)) continue
      if (quotaDayKey(Date.parse(p.at)) !== today) continue
      const n = Number(p.consumed) || 0
      if (n > 0) byModel[p.model] = (byModel[p.model] || 0) + n
      if (!latest[p.model] || Date.parse(p.at) > Date.parse(latest[p.model].at)) latest[p.model] = p
    }
    for (const [m, p] of Object.entries(latest)) {
      if (p && p.status === 429) exhaustedModels.push(m)
    }
  } catch (err) {
    // 没有探测记录是常态（探测要花配额），静默即可
  }

  const limit = QUOTA_PER_MODEL_PER_DAY
  const models = Object.keys(byModel).sort((a, b) => {
    const ea = exhaustedModels.includes(a) ? 1 : 0
    const eb = exhaustedModels.includes(b) ? 1 : 0
    if (ea !== eb) return eb - ea // 已用尽的排最前（最紧）
    return byModel[b] - byModel[a] || a.localeCompare(b)
  })
  const bottleneck = models.length ? models[0] : null
  const bottleneckExhausted = !!(bottleneck && exhaustedModels.includes(bottleneck))
  const usedRaw = bottleneck ? byModel[bottleneck] : 0
  // 实测用尽 ⇒ 直接按满额呈现（本地估算偏低时也不会显示"还剩着"）
  const used = bottleneckExhausted ? limit : usedRaw
  const totalUsed = models.reduce((sum, m) => sum + byModel[m], 0)
  const remaining = bottleneckExhausted ? 0 : Math.max(0, limit - usedRaw)
  const ratio = limit > 0 ? used / limit : 0
  const level = ratio >= 0.95 ? 'danger' : ratio >= 0.8 ? 'warn' : 'ok'
  const perModel = models.map((m) => {
    const ex = exhaustedModels.includes(m)
    return {
      model: m,
      used: ex ? limit : byModel[m],
      remaining: ex ? 0 : Math.max(0, limit - byModel[m]),
      exhausted: ex,
    }
  })
  return {
    ok: true,
    stale: ledgerStale,
    today,
    tz: QUOTA_TZ,
    // used/remaining/ratio/level 都是"最紧的那个模型"的
    used,
    limit,
    remaining,
    ratio,
    level,
    bottleneck,
    exhaustedModels,
    totalUsed,
    perModel,
    // 金额只可能来自账本（它是唯一记 cost 的地方）
    cost: Math.round(ledgerCost * 1e6) / 1e6,
    byModel,
    // 数据出处：session-log = 逐次调用（准）；ledger = 按 turn 聚合（会低估）
    source: fromLog ? 'session-log' : 'ledger',
    degraded: !!(scan && scan.degraded) || !fromLog,
    logFiles: scan ? scan.files : 0,
    // 形象立绘的版本（客户端据此决定是否要重新拉图）
    artVersion: (loadArt() || {}).version || '',
    // 自定义台词（梗库里的私货；客户端追加在内置台词后面，不覆盖）
    customLines: loadCustomLines(),
    resetAt,
    ts: now,
  }
}

// ============================================================================
// 配额台账：把"各模型还剩多少次"发布到 ~/.dsh/facts/gemini-quota-remaining.json
// ----------------------------------------------------------------------------
// 为什么落在这里：本机有多个 DSH 会话同时跑，每个会话开工都会跑
//   `~/.dsh/tools/inflight.ps1`，而它会**自动读 ~/.dsh/facts/*.json 并带新鲜度展示**。
//   于是"哈基米还剩几次"这一条不需要任何人记着去查 —— 派子代理前瞄一眼 inflight 就知道，
//   不会再有会话一头撞进 429。
//
// 写入节流：指纹（限额/重置点/各模型用量）没变就最多每 5 分钟刷一次 checkedAt，
//   避免每 30 秒一次无谓的磁盘写。
// ============================================================================
const FACTS_FILE = path.join(dshHome(), 'facts', 'gemini-quota-remaining.json')
/** 本机主动探测（429/200）的记录；由 ~/.dsh/tools/gemini-quota.cjs 与人工探测写入。 */
const PROBE_FILE = process.env.DSHK_PROBES || path.join(dshHome(), 'gemini-quota-probes.json')
/**
 * 自定义台词库（梗库）：`~/.dsh/widget-lines.json` 的 `kitten` 段。
 * 核心台词写死在客户端，这里是**追加**的私货 —— 未来的会话想加梗，只改那个 json、刷新页面即可，
 * 不用碰插件源码。格式：{ "kitten": { "ok": ["…"], "warn": […], "danger": […], "unknown": […] } }
 */
const LINES_FILE = process.env.DSHK_LINES || path.join(dshHome(), 'widget-lines.json')

function loadCustomLines() {
  try {
    const j = JSON.parse(fs.readFileSync(LINES_FILE, 'utf8'))
    const k = j && j.kitten
    if (!k || typeof k !== 'object') return {}
    const out = {}
    for (const pool of ['ok', 'warn', 'danger', 'unknown']) {
      if (Array.isArray(k[pool])) {
        const list = k[pool].filter((s) => typeof s === 'string' && s.trim()).slice(0, 80)
        if (list.length) out[pool] = list
      }
    }
    return out
  } catch (err) {
    // 没有这个文件是常态（用户没写过私货），静默即可
    return {}
  }
}
const FACTS_REFRESH_MS = 5 * 60 * 1000
let factsFingerprint = ''
let factsWrittenAt = 0

function publishQuotaFact(state) {
  try {
    if (!state || state.ok !== true) return
    const models = (state.perModel || []).map((m) => ({
      model: m.model,
      used: m.used,
      remaining: m.remaining,
    }))
    const fingerprint = JSON.stringify({ limit: state.limit, day: state.today, models })
    const now = Date.now()
    if (fingerprint === factsFingerprint && now - factsWrittenAt < FACTS_REFRESH_MS) return

    const payload = {
      key: 'gemini-quota-remaining',
      value: {
        limitPerModelPerDay: state.limit,
        quotaDay: state.today,
        resetAtUtc: new Date(state.resetAt).toISOString(),
        resetInHours: Math.round(((state.resetAt - now) / 3600000) * 10) / 10,
        // 429 实测出来的「已用尽」—— 别的会话最该先看到的就是这一条
        exhaustedModels: state.exhaustedModels || [],
        // 只剩最紧的几个（台账是给人瞄一眼的，不是全量报表）
        tightest: models.slice(0, 6),
        totalCallsToday: state.totalUsed,
        scope:
          'DSH 内部调用（会话日志回放：step 计数与 request/header 取较大者）；'
          + '「已用尽」来自本机 429 实测（权威），数字为估算且可能偏低',
      },
      checkedAt: new Date(now).toISOString(),
      checkedBy: 'dsh-gemini-kitten-widget（挂件自动维护，DSH 运行时每 5 分钟或状态变化时刷新）',
      ttlHours: 1,
      evidence:
        '计数来源：~/.dsh/sessions/**/session.v4.jsonl.zstd 里每条 assistant/message = 一次模型响应 = 一次 API 调用；'
        + '配额日按 UTC。限额 20/模型/天 的出处见 facts/gemini-free-tier-quota.json（Google 429 原文）。',
      howToRecheck:
        '立即重算：node ~/.dsh/tools/gemini-quota.cjs ；或看挂件悬停详情。'
        + '真值兜底：对某模型发一次最小请求，429 的 message 会直接印出 limit 与 retry 时间。',
      conflicts: null,
    }
    fs.mkdirSync(path.dirname(FACTS_FILE), { recursive: true })
    fs.writeFileSync(FACTS_FILE, JSON.stringify(payload, null, 2) + '\n', 'utf8')
    factsFingerprint = fingerprint
    factsWrittenAt = now
  } catch (err) {
    console.error(LOG + ' 写配额台账失败（不影响挂件本身）', err)
  }
}

// ============================================================================
// 客户端脚本下发（mtime 指纹：改了代码刷新页面即生效，无需重启 DSH）
// ============================================================================
let widgetCache = null // { text, mtimeMs, path }
let widgetVersion = ''

function loadWidgetJs() {
  for (const p of WIDGET_FILE_CANDIDATES) {
    try {
      const st = fs.statSync(p)
      if (widgetCache && widgetCache.path === p && widgetCache.mtimeMs === st.mtimeMs) {
        widgetVersion = 'v' + Math.round(st.mtimeMs)
        return widgetCache.text
      }
      const text = fs.readFileSync(p, 'utf8')
      widgetCache = { text, mtimeMs: st.mtimeMs, path: p }
      widgetVersion = 'v' + Math.round(st.mtimeMs)
      return text
    } catch (err) {
      // 试下一个候选路径
    }
  }
  return widgetCache ? widgetCache.text : ''
}

function widgetQuery() {
  if (!widgetVersion) {
    try {
      loadWidgetJs()
    } catch (err) {}
  }
  return widgetVersion ? '?v=' + widgetVersion : ''
}

// ============================================================================
// 形象立绘下发（本地生成的 Q 版猫娘，透明 PNG）
// ============================================================================
const ART_FILE_CANDIDATES = [
  path.join(PACKAGE_ROOT, 'assets', 'kitten-art.png'),
  path.join(HERE, 'kitten-art.png'),
]
let artCache = null // { bytes, mtimeMs, path, version }

function loadArt() {
  for (const p of ART_FILE_CANDIDATES) {
    try {
      const st = fs.statSync(p)
      if (artCache && artCache.path === p && artCache.mtimeMs === st.mtimeMs) return artCache
      const bytes = fs.readFileSync(p)
      artCache = { bytes, mtimeMs: st.mtimeMs, path: p, version: 'v' + Math.round(st.mtimeMs) }
      return artCache
    } catch (err) {}
  }
  return artCache
}

/**
 * 桌面端注入行的内容：**内联 script**（不是 script-src 行）。
 * 理由同 whale-widget issue #154：页面侧对 script-src 行是"加载失败即 reject 整个 boot"，
 * 而插件可能在运行期被关掉、路由随之注销 → 404 → 应用起不来。内联行由我们自己建
 * <script src> 并吞掉 onerror，宿主永远不会因为我们而启动失败。
 */
function bootstrapText() {
  return '(function(){try{'
    + 'if(window.__dshKittenBooted)return;window.__dshKittenBooted=1;'
    + 'var d=document.body||document.head||document.documentElement;if(!d)return;'
    + 'var s=document.createElement("script");s.async=true;s.src="' + WIDGET_PATH + widgetQuery() + '";'
    + 's.onerror=function(){try{console.error("[dsh-kitten] widget.js 加载失败（路由是否已注销？）")}catch(e){}};'
    + 'd.appendChild(s)'
    + '}catch(e){try{console.error("[dsh-kitten] bootstrap 抛异常",e)}catch(e2){}}})()'
}

// ============================================================================
// 插件本体
// ============================================================================
export default {
  name: 'gemini-kitten-widget',
  apply(root) {
    const disposeAll = []

    // ① 注入行：**必须最早注册**。桌面端(Electron)的注入表是宿主启动时一次性收集的，
    //    晚一步这一行就永远进不了表 = 桌面端挂件完全不出现。此步不依赖任何服务。
    try {
      disposeAll.push(root.on('webserver/index-inject', (table) => {
        try {
          if (!Array.isArray(table)) return
          for (const row of table) {
            if (!row) continue
            if (row.kind === 'script' && typeof row.text === 'string' && row.text.indexOf(WIDGET_PATH) >= 0) return
            if (row.kind === 'script-src' && row.src === WIDGET_PATH) return
          }
          table.push({ kind: 'script', placement: 'body', text: bootstrapText() })
        } catch (err) {
          console.error(LOG + ' index-inject 行注册失败', err)
        }
      }))
    } catch (err) {
      console.error(LOG + ' 无法订阅 webserver/index-inject', err)
    }

    // ② 其余逻辑：等 webServer 就绪（不再拖住 ①）
    root.inject(['webServer'], (ctx) => {
      const disposers = []
      disposeAll.push(() => {
        for (const d of disposers) {
          try {
            d()
          } catch (err) {}
        }
      })

      /** 跨站读一律拒（本机/局域网/隧道同站访问不受影响）。 */
      function crossSite(req) {
        const site = String((req && req.headers && req.headers['sec-fetch-site']) || '').toLowerCase()
        return site === 'cross-site'
      }

      /** 委托宿主的浏览器信任栅栏（存在就用，返回码照用）。 */
      function hostRejection(req) {
        try {
          const conn = ctx.get('connection')
          if (conn && typeof conn.requestRejection === 'function') {
            const code = conn.requestRejection(req)
            if (code === undefined || code === null || code === false) return null
            return typeof code === 'number' ? code : 403
          }
        } catch (err) {
          // 栅栏自身异常：本插件路由全只读、无凭据，放行。
        }
        return null
      }

      function route(kind, p, handler) {
        const dispose = ctx.webServer.register({
          kind,
          path: p,
          handler: async (req, res) => {
            try {
              if (crossSite(req)) {
                res.writeHead(403)
                res.end()
                return
              }
              const denied = hostRejection(req)
              if (denied) {
                res.writeHead(denied)
                res.end()
                return
              }
              await handler(req, res)
            } catch (err) {
              console.error(LOG + ' 路由处理失败 ' + p, err)
              try {
                res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
                res.end('internal error')
              } catch (err2) {}
            }
          },
        })
        disposers.push(dispose)
      }

      // —— 客户端脚本 ——
      route('exact', WIDGET_PATH, (req, res) => {
        const text = loadWidgetJs()
        if (!text) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('kitten.js not found')
          return
        }
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        res.end(text)
      })

      // —— 形象立绘（ETag 走 mtime：换了图浏览器会自动取新的）——
      route('exact', ART_PATH, (req, res) => {
        const art = loadArt()
        if (!art) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('art not found')
          return
        }
        const etag = '"' + art.version + '"'
        if (String((req.headers && req.headers['if-none-match']) || '') === etag) {
          res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' })
          res.end()
          return
        }
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Cache-Control': 'no-cache',
          ETag: etag,
        })
        res.end(art.bytes)
      })

      // —— 额度状态 ——
      route('exact', STATE_PATH, (req, res) => {
        let payload
        try {
          payload = computeState()
          publishQuotaFact(payload)
        } catch (err) {
          console.error(LOG + ' computeState 抛异常', err)
          payload = { ok: false, error: 'compute-failed', ts: Date.now() }
        }
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        })
        res.end(JSON.stringify(payload))
      })

      // —— 台账保鲜：即使没人打开页面，也每 5 分钟重算一次并发布 ——
      //   否则用户关掉挂件/没人看页面时，~/.dsh/facts/gemini-quota-remaining.json 会一直变旧，
      //   别的会话跑 inflight 时看到的就是 STALE 的过期配额。
      try {
        let factTimer = null
        const tick = () => {
          try {
            publishQuotaFact(computeState())
          } catch (err) {
            console.error(LOG + ' 台账定时刷新失败', err)
          }
        }
        tick()
        factTimer = setInterval(tick, FACTS_REFRESH_MS)
        if (factTimer && typeof factTimer.unref === 'function') factTimer.unref()
        disposers.push(() => {
          if (factTimer) clearInterval(factTimer)
        })
      } catch (err) {
        console.error(LOG + ' 台账定时器启动失败', err)
      }

      // —— web 形态注入（桌面端不走这里，两条通道各自去重）——
      try {
        disposers.push(ctx.webServer.tapIndex((html) => {
          if (typeof html !== 'string') return html
          if (html.indexOf(WIDGET_PATH) !== -1) return html
          const tag = '<script defer src="' + WIDGET_PATH + widgetQuery() + '"></script>'
          if (html.indexOf('</body>') !== -1) return html.replace('</body>', tag + '</body>')
          return html + tag
        }))
      } catch (err) {
        console.error(LOG + ' tapIndex 注册失败', err)
      }

      console.log(LOG + ' 已就绪：' + WIDGET_PATH + ' + ' + STATE_PATH)
    })

    root.effect(() => () => {
      for (const d of disposeAll) {
        try {
          d()
        } catch (err) {}
      }
    })
  },
}
