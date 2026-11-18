#!/usr/bin/env node
/**
 * 发布网页层热更新到 GitHub Releases。
 *
 * 用法（在 app/ 目录下）：
 *   node scripts/publish-web.mjs [--notes "这次改了什么"] [--dry-run]
 *
 * 做的事：
 *   1. 读 package.json 的 version，tag 就是 web-v<version>；
 *   2. 把 dist/ 打成 web.zip（纯 Node 写 zip，deflate 压缩，正斜杠路径——
 *      Windows PowerShell 5.1 的 Compress-Archive 会写反斜杠条目，Android 上解不开）；
 *   3. 生成 web.zip.sha256（hex + 文件名，和 sha256sum 的输出同格式）；
 *   4. 调 gh CLI 创建 Release 并上传两个资产。
 *
 * 前提：gh 已登录、dist 已经构建（pnpm build）、tag 不存在。
 */

import { execFileSync } from 'node:child_process'
import { createHash, deflateRawSync, crc32 as zlibCrc32 } from 'node:zlib'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distDir = path.join(appDir, 'dist')
const outDir = path.join(appDir, 'node_modules', '.cache', 'card-tree-publish')

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const notesIndex = args.indexOf('--notes')
const notes =
  notesIndex >= 0 && args[notesIndex + 1] ? args[notesIndex + 1] : '网页层更新'

const repo = '2031814001yuyue-tech/card-tree-mobile'

const fail = (message) => {
  console.error(`publish-web: ${message}`)
  process.exit(1)
}

const run = (file, runArgs) => {
  console.log(`$ ${file} ${runArgs.join(' ')}`)
  return execFileSync(file, runArgs, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  })
}

// ---------------------------------------------------------------- 依赖检查

if (!existsSync(path.join(distDir, 'index.html'))) {
  fail('dist/index.html 不存在：先在 app/ 目录跑 pnpm build')
}

const version = JSON.parse(readFileSync(path.join(appDir, 'package.json'), 'utf8')).version
if (!version) {
  fail('package.json 里没有 version')
}
const tag = `web-v${version}`

try {
  run('gh', ['auth', 'status'])
} catch (error) {
  fail('gh 未登录：先跑 gh auth login')
}

try {
  const existing = run('gh', ['release', 'view', tag, '--repo', repo, '--json', 'tagName']).trim()
  if (existing) {
    fail(`${tag} 已经存在；要重发就先 gh release delete ${tag} --cleanup-tag --repo ${repo}`)
  }
} catch (error) {
  // gh release view 对不存在的 tag 退出码非 0，这里走到 catch 才是想要的
}

// ---------------------------------------------------------------- 收集文件

const walk = (dir, base = '') => {
  const entries = []
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name)
    const rel = base ? `${base}/${name}` : name
    if (statSync(abs).isDirectory()) {
      entries.push(...walk(abs, rel))
    } else {
      entries.push({ rel, abs })
    }
  }
  return entries
}

// ---------------------------------------------------------------- 写 zip

/** 固定的 DOS 时间（2026-01-01 00:00:00）：zip 只用它做展示，不参与校验。 */
const DOS_TIME = ((0 << 9) | (1 << 5)) | 1 // hh<<9 | mm<<5 | ss/2
const DOS_DATE = (((2026 - 1980) << 9) | (1 << 5)) | 1

const writeZip = (files, zipPath) => {
  const chunks = []
  const central = []
  let offset = 0

  for (const file of files) {
    const raw = readFileSync(file.abs)
    const deflated = deflateRawSync(raw, { level: 9 })
    const useDeflate = deflated.length < raw.length
    const data = useDeflate ? deflated : raw
    const method = useDeflate ? 8 : 0
    const crc = zlibCrc32(raw) >>> 0
    const nameBytes = Buffer.from(file.rel, 'utf8')

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0) // local file header
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0, 6) // flags
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28) // extra len

    chunks.push(local, nameBytes, data)

    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0) // central directory header
    entry.writeUInt16LE(20, 4) // version made by
    entry.writeUInt16LE(20, 6) // version needed
    entry.writeUInt16LE(0, 8) // flags
    entry.writeUInt16LE(method, 10)
    entry.writeUInt16LE(DOS_TIME, 12)
    entry.writeUInt16LE(DOS_DATE, 14)
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(data.length, 20)
    entry.writeUInt32LE(raw.length, 24)
    entry.writeUInt16LE(nameBytes.length, 28)
    entry.writeUInt16LE(0, 30) // extra
    entry.writeUInt16LE(0, 32) // comment
    entry.writeUInt16LE(0, 34) // disk
    entry.writeUInt16LE(0, 36) // internal attrs
    entry.writeUInt32LE(0, 38) // external attrs
    entry.writeUInt32LE(offset, 42)
    central.push(Buffer.concat([entry, nameBytes]))

    offset += local.length + nameBytes.length + data.length
  }

  const centralBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4) // disk
  eocd.writeUInt16LE(0, 6) // start disk
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20) // comment len

  writeFileSync(zipPath, Buffer.concat([...chunks, centralBuf, eocd]))
}

// ---------------------------------------------------------------- 打包

await mkdir(outDir, { recursive: true })
const zipPath = path.join(outDir, 'web.zip')
const shaPath = path.join(outDir, 'web.zip.sha256')

const files = walk(distDir).sort((a, b) => a.rel.localeCompare(b.rel))
if (files.length === 0) {
  fail('dist/ 是空的')
}

if (dryRun) {
  console.log('(dry-run) 跳过压缩与发布')
} else {
  writeZip(files, zipPath)
}

const sha256 = (file) => {
  const hash = createHash('sha256')
  hash.update(readFileSync(file))
  return hash.digest('hex')
}

let digest = '(dry-run)'
let size = 0
if (!dryRun) {
  digest = sha256(zipPath)
  size = statSync(zipPath).size
  await writeFile(shaPath, `${digest}  web.zip\n`, 'utf8')
}

console.log(`tag    : ${tag}`)
console.log(`repo   : ${repo}`)
console.log(`files  : ${files.length}`)
console.log(`zip    : ${zipPath}${dryRun ? '' : ` (${(size / 1024 / 1024).toFixed(2)} MB)`}`)
console.log(`sha256 : ${digest}`)
console.log(`notes  : ${notes}`)

if (dryRun) {
  console.log('dry-run 到此为止，没有发布。')
  process.exit(0)
}

// ---------------------------------------------------------------- 发布

run('gh', [
  'release', 'create', tag,
  '--repo', repo,
  '--title', `网页层 ${version}`,
  '--notes', notes,
  zipPath,
  shaPath,
])

console.log(`已发布：${tag} → https://github.com/${repo}/releases/tag/${tag}`)
console.log('手机端：设置 → 关于 → 检查更新。')
