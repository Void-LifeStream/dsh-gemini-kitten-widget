#!/usr/bin/env node
/**
 * sync-check.cjs —— 发布前检查「本地开发目录」与「远端仓库」的差异
 * ============================================================================
 * 为什么需要它：
 *   本机的 `~/.dsh/plugins/<name>` 是**从别处复制出来的开发副本**，不是 git 仓库，
 *   所以它和 GitHub 远端之间**没有任何同步机制**。2026-10-19 发布 dsh-gemini-kitten-widget
 *   时才发现：远端有 `LICENSE` / `CHANGELOG.md` / `.gitignore` / `docs/`，本地一个都没有 ——
 *   而这些问题要到 `npm publish` 那一刻才暴露。
 *
 * 它做什么（**只读，不改任何文件**）：
 *   1. 从 package.json 的 repository 字段读出远端；
 *   2. 用 GitHub trees API 拿远端全部文件路径（一次请求）；
 *   3. 与本地文件列表比对，报告「本地缺 / 远端缺」；加 --deep 才逐个比对内容
 *      （**先归一化换行符**，否则 CRLF/LF 差异会把所有文件都报成"不同"）。
 *
 * 用法：
 *   node tools/sync-check.cjs                     # 快检：只比文件列表（推荐，1 次网络请求）
 *   node tools/sync-check.cjs --deep              # 深检：再逐文件比内容（慢，文件多时慎用）
 *   node tools/sync-check.cjs --repo owner/name   # 指定仓库
 *   node tools/sync-check.cjs --branch master     # 指定分支
 *   node tools/sync-check.cjs --json              # 机器可读输出
 *
 * 退出码：0 = 无差异；1 = 有差异；2 = 无法完成检查（网络/仓库解析失败）
 *
 * ⚠️ 它是**检查**，不是**同步**。看到差异后怎么合并，仍然要人（或 agent）逐个人工确认 ——
 *    自动覆盖是 2026-10-19 那次差点出事的做法。
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

// ---------- 参数 ----------
const argv = process.argv.slice(2)
const arg = (name, fallback = null) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
}
const asJson = argv.includes('--json')
const deep = argv.includes('--deep')

const root = path.resolve(__dirname, '..')
const pkgPath = path.join(root, 'package.json')
if (!fs.existsSync(pkgPath)) {
  console.error('找不到 package.json：', pkgPath)
  process.exit(2)
}
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))

function repoFromPackage() {
  const url = pkg.repository?.url ?? pkg.repository ?? ''
  const m = String(url).match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?$/)
  return m ? `${m[1]}/${m[2]}` : null
}
const repo = arg('--repo', repoFromPackage())
if (!repo) {
  console.error('无法确定仓库：请在 package.json 补 repository.url，或用 --repo owner/name')
  process.exit(2)
}
const branchArg = arg('--branch')

function readToken() {
  try {
    const p = path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', '.secrets', 'github-token')
    if (!fs.existsSync(p)) return null
    const t = fs.readFileSync(p, 'utf8').trim()
    return t || null
  } catch (err) {
    return null
  }
}
const token = readToken()
const headers = { 'user-agent': 'dsh-sync-check' }
if (token) headers.authorization = `Bearer ${token}`

async function gh(url) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(20000) })
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`)
  return r.json()
}

const norm = (s) => s.replace(/\r\n/g, '\n')

function walkLocal(dir, base = '') {
  const out = []
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === '.git' || ent.name === 'node_modules') continue
    if (ent.name.startsWith('.bak') || ent.name.includes('.bak-') || ent.name === '.DS_Store') continue
    const rel = base ? `${base}/${ent.name}` : ent.name
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) out.push(...walkLocal(full, rel))
    else out.push(rel)
  }
  return out
}

const TEXT_RE = /\.(md|txt|json|ya?ml|js|cjs|mjs|ts|tsx|jsx|py|html|css|sh|ps1|gitignore)$/i

async function main() {
  const branch = branchArg ?? (await (async () => {
    try {
      const info = await gh(`https://api.github.com/repos/${repo}`)
      return info.default_branch
    } catch (err) {
      return 'main'
    }
  })())

  let tree
  try {
    const info = await gh(`https://api.github.com/repos/${repo}/git/trees/${branch}?recursive=1`)
    tree = info.tree.filter((n) => n.type === 'blob').map((n) => n.path)
  } catch (err) {
    console.error(`读取远端文件树失败（${repo}@${branch}）：${err.message}`)
    process.exit(2)
  }

  const localFiles = walkLocal(root)
  const remoteSet = new Set(tree)
  const localSet = new Set(localFiles)

  const onlyLocal = localFiles.filter((f) => !remoteSet.has(f))
  // 远端目录里的 .github / docs 之类不算"本地缺"（除非 package.json.files 提到）
  const listedByPackage = new Set(pkg.files ?? [])
  const onlyRemote = tree.filter((f) => !localSet.has(f) && !f.startsWith('.github/'))

  const differing = []
  if (deep) {
    // 只比文本、且限流：并发 6、单个 15 秒
    const targets = localFiles.filter((f) => remoteSet.has(f) && TEXT_RE.test(f))
    const chunk = 6
    for (let i = 0; i < targets.length; i += chunk) {
      const slice = targets.slice(i, i + chunk)
      await Promise.all(slice.map(async (f) => {
        try {
          const lr = await fetch(
            `https://raw.githubusercontent.com/${repo}/${branch}/${f}?t=${Date.now()}`,
            { headers, signal: AbortSignal.timeout(15000) }
          )
          if (!lr.ok) { differing.push({ file: f, reason: `远端取不到（HTTP ${lr.status}）` }); return }
          const remoteText = norm(await lr.text())
          const localText = norm(fs.readFileSync(path.join(root, f), 'utf8'))
          if (remoteText !== localText) differing.push({ file: f, reason: '内容不同' })
        } catch (err) {
          differing.push({ file: f, reason: `比对失败：${err.message}` })
        }
      }))
    }
  }

  const result = {
    repo,
    branch,
    deep,
    localFileCount: localFiles.length,
    remoteFileCount: tree.length,
    onlyLocal,
    onlyRemote,
    differing,
    clean: onlyLocal.length === 0 && onlyRemote.length === 0 && differing.length === 0,
  }

  if (asJson) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log(`\n仓库 ${repo}@${branch}${deep ? '（深检）' : '（快检 · 只比文件列表）'}`)
    console.log(`本地 ${localFiles.length} 个文件 · 远端 ${tree.length} 个文件\n`)
    if (onlyRemote.length) {
      const inFiles = onlyRemote.filter((f) => listedByPackage.has(f))
      console.log(`⬅ 远端有、本地没有（${onlyRemote.length}）：`)
      onlyRemote.forEach((f) => {
        const flag = listedByPackage.has(f) ? '  ⚠ package.json.files 里有它，npm 会报缺文件' : ''
        console.log(`     ${f}${flag}`)
      })
      console.log('')
    }
    if (onlyLocal.length) {
      console.log(`➡ 本地有、远端没有（${onlyLocal.length}）—— 记得一起提交：`)
      onlyLocal.forEach((f) => console.log(`     ${f}`))
      console.log('')
    }
    if (differing.length) {
      console.log(`✎ 两边都有但内容不同（${differing.length}）：`)
      differing.forEach((d) => console.log(`     ${d.file}  — ${d.reason}`))
      console.log('')
    }
    if (result.clean) console.log('✅ 本地与远端文件列表完全一致\n')
    else console.log('⚠️ 存在差异 —— 发布前请人工确认每一处，不要盲目覆盖。\n')
    if (!deep) console.log('（想看内容差异加 --deep）\n')
  }

  process.exit(result.clean ? 0 : 1)
}

main().catch((err) => {
  console.error('检查失败：', err.message)
  process.exit(2)
})
