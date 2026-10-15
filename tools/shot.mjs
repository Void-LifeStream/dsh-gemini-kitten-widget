/**
 * 给挂件出预览图（真 Chromium 渲染 + 本地 HTTP 服务，与真实运行方式一致）。
 *
 * 用法：
 *   & "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" tools\shot.mjs [输出目录]
 * 默认输出到 <工作区>/kitten-widget-preview/
 */
import http from 'node:http'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const OUT_DIR = process.argv[2] || path.join(process.cwd(), 'kitten-widget-preview')

const require = createRequire(path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'package.json'))
const puppeteer = require('puppeteer-core')

function findChrome() {
  if (process.env.DSHK_CHROME && fs.existsSync(process.env.DSHK_CHROME)) return process.env.DSHK_CHROME
  const root = path.join(os.homedir(), '.cache', 'puppeteer', 'chrome')
  for (const d of fs.readdirSync(root)) {
    const exe = path.join(root, d, 'chrome-win64', 'chrome.exe')
    if (fs.existsSync(exe)) return exe
  }
  return null
}

let mockUsed = 5
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0]
  const send = (code, type, body) => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' })
    res.end(body)
  }
  if (url === '/') return send(200, 'text/html; charset=utf-8', fs.readFileSync(path.join(HERE, 'preview.html')))
  if (url === '/assets/kitten.js') return send(200, 'application/javascript; charset=utf-8', fs.readFileSync(path.join(ROOT, 'assets', 'kitten.js')))
  if (url === '/dsh-kitten/art.png') return send(200, 'image/png', fs.readFileSync(path.join(ROOT, 'assets', 'kitten-art.png')))
  if (url === '/dsh-kitten/state') {
    const limit = 20
    const ratio = mockUsed / limit
    return send(200, 'application/json; charset=utf-8', JSON.stringify({
      ok: true, used: mockUsed, limit, remaining: Math.max(0, limit - mockUsed), ratio,
      level: ratio >= 0.95 ? 'danger' : ratio >= 0.8 ? 'warn' : 'ok',
      bottleneck: 'gemini-3.8-flash',
      exhaustedModels: mockUsed >= limit ? ['gemini-3.8-flash'] : [],
      perModel: [
        { model: 'gemini-3.8-flash', used: mockUsed, remaining: Math.max(0, limit - mockUsed), exhausted: mockUsed >= limit },
        { model: 'gemini-3.5-flash', used: 17, remaining: 3, exhausted: false },
        { model: 'gemini-3.6-flash', used: 2, remaining: 18, exhausted: false },
      ],
      byModel: {}, resetAt: Date.now() + 13 * 3600 * 1000 + 25 * 60 * 1000, source: 'session-log',
    }))
  }
  send(404, 'text/plain', 'not found')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const BASE = 'http://127.0.0.1:' + server.address().port

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--no-first-run', '--disable-gpu'],
})
fs.mkdirSync(OUT_DIR, { recursive: true })

const cases = [
  { name: '01-quota-ok', used: 8, click: false },
  { name: '02-quota-warn', used: 17, click: false },
  { name: '03-quota-danger', used: 20, click: false },
  { name: '04-click-line', used: 8, click: true },
  // 点徽章换个型号看（配额按模型独立，一轮只放得下一行）
  { name: '05-badge-switch', used: 20, click: 'badge', taps: 2 },
]
for (const c of cases) {
  mockUsed = c.used
  const page = await browser.newPage()
  await page.setViewport({ width: 460, height: 560, deviceScaleFactor: 2 })
  await page.goto(BASE + '/', { waitUntil: 'load' })
  await page.waitForSelector('.dshk-root', { timeout: 6000 })
  await new Promise((r) => setTimeout(r, 700))
  if (c.click === 'badge') {
    const bb = await page.$eval('.dshk-badge', (n) => { const r = n.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })
    for (let i = 0; i < (c.taps || 1); i++) {
      await page.mouse.click(bb.x, bb.y)
      await new Promise((r) => setTimeout(r, 320))
    }
  } else if (c.click) {
    const box = await page.$eval('.dshk-art', (n) => { const r = n.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })
    await page.mouse.click(box.x, box.y)
    await new Promise((r) => setTimeout(r, 700))
  }
  // 截图范围要把**气泡**也算进来：气泡现在会按挂件位置改锚点（贴边时右/左对齐），
  // 只按 .dshk-root 取框会把气泡裁掉（2026-10-15 踩到）。
  const box = await page.evaluate(() => {
    const root = document.querySelector('.dshk-root').getBoundingClientRect()
    const bub = document.querySelector('.dshk-bubble').getBoundingClientRect()
    const l = Math.min(root.left, bub.left)
    const t = Math.min(root.top, bub.top)
    const r = Math.max(root.right, bub.right)
    const b = Math.max(root.bottom, bub.bottom)
    return { x: l, y: t, width: r - l, height: b - t }
  })
  const pad = 24
  await page.screenshot({
    path: path.join(OUT_DIR, c.name + '.png'),
    clip: {
      x: Math.max(0, box.x - pad),
      y: Math.max(0, box.y - pad),
      width: Math.min(460, box.width + pad * 2),
      height: Math.min(560, box.height + pad * 2),
    },
  })
  console.log(c.name, Math.round(box.width) + 'x' + Math.round(box.height))
  await page.close()
}
await browser.close()
server.close()
console.log('输出目录:', OUT_DIR)
