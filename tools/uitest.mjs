/**
 * 浏览器交互回归测试（真 Chromium + puppeteer-core）。
 *
 * 起一个本地 HTTP 服务把挂件按真实方式跑起来（脚本、额度接口、立绘都走网络），
 * 覆盖：幂等双注入 / 立绘加载与 SVG 回退 / 额度渲染 / 点击换台词 / 拖拽 / 边缘吸附 /
 *       位置记忆 / 右键复位 / 三档变色 / 控制台干净。
 *
 * 用法（本机 node 不在 PATH 里）：
 *   & "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" tools\uitest.mjs
 *
 * 环境变量：
 *   DSHK_CHROME  —— 指定 chrome.exe；不设则用 puppeteer 缓存里的 Chrome for Testing。
 */
import http from 'node:http'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const require = createRequire(path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'package.json'))
const puppeteer = require('puppeteer-core')

function findChrome() {
  if (process.env.DSHK_CHROME && fs.existsSync(process.env.DSHK_CHROME)) return process.env.DSHK_CHROME
  const root = path.join(os.homedir(), '.cache', 'puppeteer', 'chrome')
  try {
    for (const d of fs.readdirSync(root)) {
      const exe = path.join(root, d, 'chrome-win64', 'chrome.exe')
      if (fs.existsSync(exe)) return exe
    }
  } catch (err) {}
  return null
}

// ===== 假 host：把插件的三个真实端点按同一形状提供出来 =====
let mockUsed = 5
let serveArt = true
// 配额日（UTC）—— 「每配额日只喊一次」这条判据要能跨日测试，所以做成可变的
let mockToday = '2026-10-15'
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0]
  const send = (code, type, body) => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' })
    res.end(body)
  }
  if (url === '/') return send(200, 'text/html; charset=utf-8', fs.readFileSync(path.join(HERE, 'preview.html')))
  if (url === '/assets/kitten.js') return send(200, 'application/javascript; charset=utf-8', fs.readFileSync(path.join(ROOT, 'assets', 'kitten.js')))
  if (url === '/dsh-kitten/art.png') {
    if (!serveArt) return send(404, 'text/plain', 'gone')
    return send(200, 'image/png', fs.readFileSync(path.join(ROOT, 'assets', 'kitten-art.png')))
  }
  if (url === '/dsh-kitten/state') {
    // 与 host 半一致：每模型 20 次/天，UTC 午夜重置；used 指"最紧的那个模型"
    const limit = 20
    const ratio = mockUsed / limit
    return send(200, 'application/json; charset=utf-8', JSON.stringify({
      ok: true,
      today: mockToday,
      tz: 'UTC',
      used: mockUsed,
      limit,
      remaining: Math.max(0, limit - mockUsed),
      ratio,
      level: ratio >= 0.95 ? 'danger' : ratio >= 0.8 ? 'warn' : 'ok',
      bottleneck: 'gemini-3.8-flash',
      exhaustedModels: mockUsed >= limit ? ['gemini-3.8-flash'] : [],
      // 三个型号，用来测"点徽章切换视图"
      perModel: [
        { model: 'gemini-3.8-flash', used: mockUsed, remaining: Math.max(0, limit - mockUsed), exhausted: mockUsed >= limit },
        { model: 'gemini-3.5-flash', used: 17, remaining: 3, exhausted: false },
        { model: 'gemini-3.6-flash', used: 2, remaining: 18, exhausted: false },
      ],
      cost: 0.4353,
      // 今日合计（副行会显示它；缺了也能降级，只是不显示"今日 N 次"）
      totalUsed: mockUsed + 19,
      byModel: { 'gemini-3.8-flash': mockUsed },
      source: 'session-log',
      degraded: false,
      logFiles: 125,
      artVersion: 'v1',
      resetAt: Date.now() + 13 * 3600 * 1000 + 12 * 60 * 1000,
      ts: Date.now(),
    }))
  }
  send(404, 'text/plain', 'not found')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const BASE = 'http://127.0.0.1:' + server.address().port

const CHROME = findChrome()
if (!CHROME) {
  console.error('找不到 chrome.exe，请用 DSHK_CHROME 环境变量指定。')
  process.exit(1)
}

const pass = []
const fail = []
function check(name, ok, detail) {
  ;(ok ? pass : fail).push(name + (detail ? ' → ' + detail : ''))
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail ? ' → ' + detail : ''))
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  // --no-sandbox 是必须的：在 DSH 的进程环境下 Chrome 沙箱起不来（launch 直接 Code 3）
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--no-first-run', '--disable-gpu'],
})
const page = await browser.newPage()
await page.setViewport({ width: 900, height: 700, deviceScaleFactor: 1 })
const errs = []
const warns = []
page.on('pageerror', (e) => errs.push(String(e)))
page.on('console', (m) => {
  if (m.type() === 'error') errs.push('console: ' + m.text())
  if (m.type() === 'warning') warns.push(m.text())
})

async function load(used) {
  mockUsed = used
  await page.goto(BASE + '/', { waitUntil: 'load' })
  await page.waitForSelector('.dshk-root', { timeout: 6000 })
  await new Promise((r) => setTimeout(r, 800))
}

const center = async (sel) =>
  page.$eval(sel, (n) => {
    const r = n.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })

await load(5)

console.log('\n【1】幂等与挂载')
check('脚本注入两次，只挂载一只猫娘', (await page.$$eval('.dshk-root', (n) => n.length)) === 1)

const info = await page.evaluate(() => {
  const img = document.querySelector('.dshk-img')
  return {
    level: document.querySelector('.dshk-root').getAttribute('data-level'),
    used: document.querySelector('.dshk-used').textContent,
    limit: document.querySelector('.dshk-limit').textContent,
    row2: document.querySelector('.dshk-row2').textContent,
    hasImg: !!img,
    imgOk: !!img && img.complete && img.naturalWidth > 0,
    naturalW: img ? img.naturalWidth : 0,
    hasSvg: !!document.querySelector('.dshk-svg'),
  }
})
check('额度数字渲染', info.used === '5' && info.limit === '/20', info.used + info.limit)
// 副行现在 = 型号 + 该型号剩余 + 今日合计（重置时间已挪进 tooltip）
check('副行显示型号 + 剩余 + 今日合计', /3\.8-flash/.test(info.row2) && /剩/.test(info.row2) && /今日\d+次/.test(info.row2), info.row2)
check('状态分级 = ok', info.level === 'ok')
check('用的是 PNG 立绘（不是 SVG）', info.hasImg && !info.hasSvg)
check('立绘真的加载成功', info.imgOk, 'naturalWidth=' + info.naturalW)

console.log('\n【2】立绘 404 时回退到手写 SVG')
serveArt = false
await load(5)
const fb = await page.evaluate(() => ({
  hasImg: !!document.querySelector('.dshk-img'),
  hasSvg: !!document.querySelector('.dshk-svg'),
  eyes: document.querySelectorAll('.dshk-eye').length,
}))
check('图片拿去后自动回退 SVG', !fb.hasImg && fb.hasSvg && fb.eyes === 2, JSON.stringify(fb))
serveArt = true

console.log('\n【3】点击换台词')
await load(5)
let artBox = await center('.dshk-art')
await page.mouse.click(artBox.x, artBox.y)
await new Promise((r) => setTimeout(r, 400))
const bub = await page.$eval('.dshk-bubble', (n) => ({ text: n.textContent, shown: n.classList.contains('dshk-show') }))
check('单击后气泡显示', bub.shown)
check('单击后有台词内容', bub.text.length > 0, bub.text.slice(0, 24) + '…')

// 挂件默认贴在右边缘 ⇒ 若气泡仍是"居中于挂件"，它会被推出视口右边之外
const bubBox = await page.$eval('.dshk-bubble', (n) => {
  const r = n.getBoundingClientRect()
  return { l: r.left, r: r.right, vw: window.innerWidth, cls: n.className }
})
check(
  '气泡不超出视口边界（贴边时自动改锚点）',
  bubBox.l >= -1 && bubBox.r <= bubBox.vw + 1,
  'left=' + bubBox.l.toFixed(0) + ' right=' + bubBox.r.toFixed(0) + ' vw=' + bubBox.vw + ' class=' + bubBox.cls,
)

console.log('\n【4】拖拽到左侧并吸附')
const before = await page.$eval('.dshk-root', (n) => n.getBoundingClientRect().left)
artBox = await center('.dshk-art')
await page.mouse.move(artBox.x, artBox.y)
await page.mouse.down()
for (let i = 1; i <= 12; i++) {
  await page.mouse.move(artBox.x - (artBox.x - 40) * (i / 12), artBox.y, { steps: 2 })
  await new Promise((r) => setTimeout(r, 12))
}
await page.mouse.up()
await new Promise((r) => setTimeout(r, 350))
const afterDrag = await page.$eval('.dshk-root', (n) => n.getBoundingClientRect().left)
check('拖拽真的移动了挂件', Math.abs(afterDrag - before) > 60, before.toFixed(0) + ' → ' + afterDrag.toFixed(0))
check('松手后吸附到左边缘（left ≈ 10）', Math.abs(afterDrag - 10) < 2, 'left = ' + afterDrag.toFixed(1))
check('位置写入 localStorage', !!(await page.evaluate(() => window.localStorage.getItem('dsh-kitten-widget:pos'))))

console.log('\n【5】刷新后位置记忆')
await page.reload({ waitUntil: 'load' })
await page.waitForSelector('.dshk-root', { timeout: 6000 })
await new Promise((r) => setTimeout(r, 700))
check('刷新后回到吸附位置', Math.abs((await page.$eval('.dshk-root', (n) => n.getBoundingClientRect().left)) - 10) < 3)
check('刷新后仍然只有一只猫娘', (await page.$$eval('.dshk-root', (n) => n.length)) === 1)

console.log('\n【6】右键复位')
artBox = await center('.dshk-art')
await page.mouse.click(artBox.x, artBox.y, { button: 'right' })
await new Promise((r) => setTimeout(r, 350))
const afterReset = await page.evaluate(() => {
  const r = document.querySelector('.dshk-root').getBoundingClientRect()
  return { left: Math.round(r.left), fromRight: Math.round(window.innerWidth - r.right) }
})
check('右键后回到右下角默认位', afterReset.fromRight < 20 && afterReset.left > 700, JSON.stringify(afterReset))

console.log('\n【7】三档额度变色（每模型 20 次：<16 ok / 16-18 warn / ≥19 danger）')
for (const [used, want] of [[5, 'ok'], [17, 'warn'], [20, 'danger']]) {
  await load(used)
  const lv = await page.$eval('.dshk-root', (n) => n.getAttribute('data-level'))
  check('used=' + used + ' → level=' + want, lv === want, '实际 ' + lv)
}

console.log('\n【8】点徽章切换型号（配额按模型算，一轮只放得下一行）')
await load(5)
const badgeState = () => page.evaluate(() => ({
  used: document.querySelector('.dshk-used').textContent,
  row2: document.querySelector('.dshk-row2').textContent,
  level: document.querySelector('.dshk-root').getAttribute('data-level'),
}))
let bs = await badgeState()
check('默认盯最紧的型号', /3\.8-flash/.test(bs.row2) && bs.used === '5', JSON.stringify(bs))

const bb = await center('.dshk-badge')
await page.mouse.click(bb.x, bb.y)
await new Promise((r) => setTimeout(r, 300))
bs = await badgeState()
check('点一次 → 3.5-flash（17/20 = 85%）', bs.used === '17' && /3\.5-flash/.test(bs.row2), JSON.stringify(bs))
check('色级跟着切到 warn（不再被最紧的那个染红）', bs.level === 'warn', bs.level)

await page.mouse.click(bb.x, bb.y)
await new Promise((r) => setTimeout(r, 300))
bs = await badgeState()
check('再点 → 3.6-flash（2/20），不再跟着飘红', bs.used === '2' && bs.level === 'ok' && /3\.6-flash/.test(bs.row2), JSON.stringify(bs))

await page.mouse.click(bb.x, bb.y)
await new Promise((r) => setTimeout(r, 300))
bs = await badgeState()
check('点满一轮 → 回到最紧的型号', /3\.8-flash/.test(bs.row2) && bs.used === '5', JSON.stringify(bs))

// 点徽章应当播报"切换提示"（而不是让猫娘本体抢去换随机台词）
const bubText = await page.$eval('.dshk-bubble', (n) => ({ t: n.textContent, shown: n.classList.contains('dshk-show') }))
check('气泡播报的是切换提示', bubText.shown && /还剩 \d+ 次/.test(bubText.t), bubText.t)

console.log('\n【10】阈值主动提醒（用尽 / 80% / 每配额日只喊一次）')
const bubbleText = () =>
  page.$eval('.dshk-bubble', (n) => ({ t: n.textContent, shown: n.classList.contains('dshk-show') }))

// (a) 3.8-flash 实测用尽 ⇒ 一上线就该喊，且优先于"本喵上线了"
await page.evaluate(() => window.localStorage.clear())
mockToday = '2026-10-15'
await load(20)
let ab = await bubbleText()
check('实测用尽 → 主动喊"用光"（优先于上线语）', ab.shown && /用光/.test(ab.t), ab.t)

// (b) 同一个配额日再刷新 ⇒ 不重复喊（否则 30 秒刷一次就喊一次，会烦死人）
await load(20)
ab = await bubbleText()
check('同一配额日不重复喊', !/用光/.test(ab.t), 'shown=' + ab.shown + ' | ' + ab.t)

// (c) 跨配额日 ⇒ 去重状态作废，重新提醒
mockToday = '2026-10-16'
await load(20)
ab = await bubbleText()
check('跨配额日后重新提醒', ab.shown && /用光/.test(ab.t), ab.t)

// (d) 到了 80% 但没用尽 ⇒ 提醒还剩几次
await page.evaluate(() => window.localStorage.clear())
mockToday = '2026-10-17'
await load(17)
ab = await bubbleText()
check('到 80% → 提醒还剩几次', ab.shown && /只剩 3 次/.test(ab.t), ab.t)

// 收尾：别把告警状态与配额日留给后面的用例
await page.evaluate(() => window.localStorage.clear())
mockToday = '2026-10-15'

console.log('\n【9】控制台')
// 资源 404 要排除：那是【2】故意关掉图片服务造出来的，属于预期
const realErrs = errs.filter((e) => !/Failed to load resource/.test(e))
check('无 pageerror / console.error（回退测试故意造的 404 除外）', realErrs.length === 0, realErrs.slice(0, 2).join(' | ') || 'none')

await browser.close()
server.close()
console.log('\n===== 结果: ' + pass.length + ' 通过, ' + fail.length + ' 失败 =====')
if (fail.length) {
  for (const f of fail) console.log('FAIL: ' + f)
  process.exitCode = 1
}
