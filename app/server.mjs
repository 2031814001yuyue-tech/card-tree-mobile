#!/usr/bin/env node
/**
 * 卡片树手机版 · 本地中继服务（零第三方依赖，只用 Node 内置模块）
 *
 * 为什么需要它：浏览器不能直连 opencode go 上游（POST /chat/completions 的 CORS
 * 预检被挡，浏览器侧只会得到 TypeError: Failed to fetch），所以由本机 Node 进程
 * 转发并注入 API Key；前端默认把请求打到同源的 `/api/*`。
 *
 * 提供的能力：
 *   1. 静态托管 app/dist（SPA：无扩展名路径回退 index.html）
 *   2. GET  /api/health            健康检查（不泄露 Key）
 *   3. GET  /api/models            代理上游模型列表，内存缓存 5 分钟
 *   4. POST /api/chat/completions  代理上游流式聊天，字节级 SSE 透传
 *   5. GET  /ca.pem  /ca.crt       自签根证书下载（手机「装成 App」要先信任它）
 *
 * 启动：node server.mjs
 * 可选环境变量：PORT（默认 8787）、HOST（默认 0.0.0.0）、DIST_DIR、
 *              OPENCODE_GO_API_KEY、OPENCODE_GO_BASE_URL
 *              HTTPS=0 强制 HTTP / HTTPS=1 强制 HTTPS（默认：certs/ 里有证书就 HTTPS）
 *              HTTPS_CERT、HTTPS_KEY 自定义证书路径
 */

import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { homedir, networkInterfaces } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const PORT = Number.parseInt(process.env.PORT ?? '', 10) || 8787
const HOST = process.env.HOST || '0.0.0.0'
/** 上游 OpenAI 兼容服务根地址（不带末尾斜杠） */
const UPSTREAM = (process.env.OPENCODE_GO_BASE_URL || 'https://opencode.ai/zen/go/v1').replace(
  /\/+$/,
  ''
)
/** 前端构建产物目录；DIST_DIR 可覆盖 */
const DIST_DIR = path.resolve(process.env.DIST_DIR || path.join(__dirname, 'dist'))
const CREDENTIALS_FILE = path.join(homedir(), '.dsh', '.credentials.yaml')
/** 只匹配 OPENCODE_GO_API_KEY 这一行，不把其它凭据读进来 */
const API_KEY_PATTERN = /(?:^|\n)\s*OPENCODE_GO_API_KEY\s*:\s*["']?([^"'\r\n#]+)/
const MODELS_CACHE_TTL = 5 * 60 * 1000
const MAX_BODY_BYTES = 8 * 1024 * 1024
const MODELS_TIMEOUT_MS = 20_000

// ── DeepSeek 官方 Search API（联网搜索）──
// 与 opencode go 的订阅 Key 无关，用的是 DeepSeek 账号的 API Key；
// 没配就只是「联网搜索不可用」，不影响聊天。
const DEEPSEEK_KEY_PATTERN = /(?:^|\n)\s*DEEPSEEK_API_KEY\s*:\s*["']?([^"'\r\n#]+)/
const DEEPSEEK_SEARCH_URL = (
  process.env.DEEPSEEK_SEARCH_URL || 'https://api.deepseek.com/v1/tools/search'
).trim()
const SEARCH_DEFAULT_COUNT = 5
const SEARCH_MAX_COUNT = 10
const SEARCH_TIMEOUT_MS = 20_000

/**
 * HTTPS：手机把网页「装成 App」（PWA）必须有安全上下文，而 http://192.168.x.x 不算。
 * app/certs/ 下同时有 cert.pem + key.pem 就自动起 HTTPS（用 `node scripts/make-cert.mjs` 生成）。
 * HTTPS=0 强制 HTTP，HTTPS=1 强制 HTTPS（缺证书就直接报错退出）。
 */
const TLS_DIR = path.join(__dirname, 'certs')
const TLS_CERT_FILE = process.env.HTTPS_CERT || path.join(TLS_DIR, 'cert.pem')
const TLS_KEY_FILE = process.env.HTTPS_KEY || path.join(TLS_DIR, 'key.pem')
const TLS_HAS_FILES = existsSync(TLS_CERT_FILE) && existsSync(TLS_KEY_FILE)
const TLS_ENABLED = process.env.HTTPS === '0' ? false : process.env.HTTPS === '1' ? true : TLS_HAS_FILES
/** 供手机下载安装的根证书（公钥部分，私钥永远不出网） */
const CA_PEM_FILE = path.join(TLS_DIR, 'ca.pem')
const CA_DER_FILE = path.join(TLS_DIR, 'ca.crt')
const SCHEME = TLS_ENABLED ? 'https' : 'http'

/**
 * opencode go 要求每个 chat 请求带 `x-opencode-session`（缺了会 400 MissingSessionID），
 * 并要求客户端用自己的 User-Agent 标识自己。浏览器不知道这些，由中继补上：
 * 客户端显式传了 `x-opencode-session` 就用它的（可按对话区分），否则按「设备指纹」
 * 派生一个稳定 id —— 同一台手机上的所有对话共享一个 session，方便上游做路由/缓存。
 */
const OPENCODE_SESSION_PREFIX = process.env.OPENCODE_GO_SESSION || 'card-tree-mobile'
const RELAY_USER_AGENT = 'card-tree-mobile/0.1 (local relay)'

const sessionForRequest = (req) => {
  const fromClient = req.headers['x-opencode-session']
  if (typeof fromClient === 'string' && fromClient.trim().length > 0) {
    return fromClient.trim().slice(0, 120)
  }
  const fingerprint = `${req.socket.remoteAddress ?? 'local'}|${req.headers['user-agent'] ?? ''}`
  const hash = createHash('sha1').update(fingerprint).digest('hex').slice(0, 12)
  return `${OPENCODE_SESSION_PREFIX}-${hash}`
}

// ─────────────────────────── API Key ───────────────────────────

/**
 * 按 环境变量 → ~/.dsh/.credentials.yaml 的顺序取 Key。
 * 返回 null 时由调用方给出中文提示并退出，绝不静默降级。
 */
const loadApiKey = () => {
  const fromEnv = (process.env.OPENCODE_GO_API_KEY ?? '').trim()
  if (fromEnv) {
    return { key: fromEnv, source: '环境变量 OPENCODE_GO_API_KEY' }
  }
  try {
    const text = readFileSync(CREDENTIALS_FILE, 'utf8')
    const matched = API_KEY_PATTERN.exec(text)
    const fromFile = matched?.[1]?.trim()
    if (fromFile) {
      return { key: fromFile, source: CREDENTIALS_FILE }
    }
  } catch {
    // 文件不存在或不可读：走下面的统一报错
  }
  return null
}

const loadedKey = loadApiKey()
if (!loadedKey) {
  console.error('')
  console.error('✗ 启动失败：没有找到 OPENCODE_GO_API_KEY。')
  console.error('')
  console.error('  任选一种方式配置后重试：')
  console.error('  1) 设置环境变量（当前终端有效）：')
  console.error('     PowerShell:  $env:OPENCODE_GO_API_KEY = "<你的 key>"')
  console.error('     CMD:         set OPENCODE_GO_API_KEY=<你的 key>')
  console.error('  2) 写入 DSH 凭据文件：')
  console.error(`     ${CREDENTIALS_FILE}`)
  console.error('     追加一行：OPENCODE_GO_API_KEY: <你的 key>')
  console.error('')
  process.exit(1)
}
const API_KEY = loadedKey.key

/**
 * DeepSeek 官方 API Key（联网搜索用）。取不到不报错，只是搜索功能不可用。
 * 顺序：环境变量 DEEPSEEK_API_KEY → ~/.dsh/.credentials.yaml。
 */
const loadDeepSeekKey = () => {
  const fromEnv = (process.env.DEEPSEEK_API_KEY ?? '').trim()
  if (fromEnv) {
    return { key: fromEnv, source: '环境变量 DEEPSEEK_API_KEY' }
  }
  try {
    const text = readFileSync(CREDENTIALS_FILE, 'utf8')
    const matched = DEEPSEEK_KEY_PATTERN.exec(text)
    const fromFile = matched?.[1]?.trim()
    if (fromFile) {
      return { key: fromFile, source: CREDENTIALS_FILE }
    }
  } catch {
    // 文件不存在或不可读：当作未配置
  }
  return null
}

const loadedDeepSeekKey = loadDeepSeekKey()
const DEEPSEEK_KEY = loadedDeepSeekKey?.key ?? null

// ─────────────────────────── 小工具 ───────────────────────────

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
}

/** 入口 HTML 与 Service Worker 不缓存，避免更新后仍跑旧版本 */
const NO_STORE_FILES = new Set(['index.html', 'sw.js', 'service-worker.js'])

const contentTypeFor = (filePath) =>
  MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream'

const cacheControlFor = (fileName) => (NO_STORE_FILES.has(fileName) ? 'no-store' : 'no-cache')

const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char
  )

/** 局域网 IPv4（非 internal），手机用这些地址访问 */
const lanAddresses = () => {
  const addresses = []
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      // Node 18+ 的 family 是字符串，旧版本可能是数字 4
      if ((entry.family === 'IPv4' || entry.family === 4) && !entry.internal) {
        addresses.push(entry.address)
      }
    }
  }
  return addresses
}

const applyCors = (res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-opencode-session')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Max-Age', '86400')
}

const sendJson = (res, status, value) => {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-length', String(body.length))
  res.end(body)
}

const sendText = (res, status, text) => {
  const body = Buffer.from(text, 'utf8')
  res.statusCode = status
  res.setHeader('content-type', 'text/plain; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-length', String(body.length))
  res.end(body)
}

const sendBuffer = (res, status, buffer, contentType) => {
  res.statusCode = status
  res.setHeader('content-type', contentType || 'application/octet-stream')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-length', String(buffer.length))
  res.end(buffer)
}

const methodNotAllowed = (res, allow) => {
  res.setHeader('allow', allow)
  sendJson(res, 405, { error: { message: `只支持 ${allow} 方法` } })
}

/** 把上游非 2xx 响应体压成一行预览，便于在 502 里说明原因 */
const previewBody = (buffer) => {
  const text = buffer.toString('utf8').replace(/\s+/g, ' ').trim()
  return text.length > 300 ? `${text.slice(0, 300)}…` : text || '(空响应体)'
}

const readRequestBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let tooLarge = false
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        tooLarge = true
        chunks.length = 0
        return
      }
      if (!tooLarge) {
        chunks.push(chunk)
      }
    })
    req.on('end', () => {
      if (tooLarge) {
        reject(Object.assign(new Error('请求体过大'), { code: 'BODY_TOO_LARGE' }))
        return
      }
      resolve(Buffer.concat(chunks))
    })
    req.on('error', reject)
  })

// ─────────────────────────── /api/health ───────────────────────────

const healthPayload = () => ({
  ok: true,
  upstream: UPSTREAM,
  hasKey: true,
  // 只暴露长度，Key 本身永远不出现在任何响应、日志或文档里
  keyLength: API_KEY.length,
  node: process.version,
  scheme: SCHEME,
  tls: TLS_ENABLED,
  // 联网搜索：只说明有没有配 Key / 从哪配的，不暴露 Key
  search: DEEPSEEK_KEY !== null,
  searchUpstream: DEEPSEEK_SEARCH_URL,
  searchKeySource: loadedDeepSeekKey?.source ?? null,
})

// ─────────────────────────── /api/models ───────────────────────────

/** 上游模型列表缓存：5 分钟内重复请求不再打上游 */
let modelsCache = null // { expiresAt, status, body: Buffer, contentType }

const handleModels = async (res) => {
  if (modelsCache && modelsCache.expiresAt > Date.now()) {
    sendBuffer(res, modelsCache.status, modelsCache.body, modelsCache.contentType)
    return
  }
  try {
    const upstream = await fetch(`${UPSTREAM}/models`, {
      method: 'GET',
      headers: { authorization: `Bearer ${API_KEY}`, 'user-agent': RELAY_USER_AGENT },
      signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
    })
    const body = Buffer.from(await upstream.arrayBuffer())
    if (!upstream.ok) {
      sendJson(res, 502, {
        error: { message: `上游 /models 返回 HTTP ${upstream.status}：${previewBody(body)}` },
      })
      return
    }
    const contentType = upstream.headers.get('content-type') || 'application/json; charset=utf-8'
    modelsCache = { expiresAt: Date.now() + MODELS_CACHE_TTL, status: 200, body, contentType }
    sendBuffer(res, 200, body, contentType)
  } catch (error) {
    sendJson(res, 502, {
      error: {
        message: `无法访问上游 ${UPSTREAM}/models：${
          error instanceof Error ? error.message : String(error)
        }`,
      },
    })
  }
}

// ─────────────────────────── /api/chat/completions ───────────────────────────

/**
 * 把请求体原样 POST 给上游 /chat/completions，并把响应字节直接写回浏览器。
 * 流式响应不做整段缓冲：上游吐出多少就转发多少；客户端断开时 abort 上游请求。
 */
const handleChat = async (req, res) => {
  let body
  try {
    body = await readRequestBody(req)
  } catch (error) {
    const tooLarge = error?.code === 'BODY_TOO_LARGE'
    sendJson(res, tooLarge ? 413 : 400, {
      error: { message: `读取请求体失败：${error instanceof Error ? error.message : String(error)}` },
    })
    return
  }

  const controller = new AbortController()
  const abortUpstream = () => {
    // 浏览器主动断开（用户点「停止」/关页面）时立刻取消上游请求，别让生成白跑
    if (!res.writableEnded) {
      controller.abort()
    }
  }
  res.on('close', abortUpstream)

  try {
    const upstream = await fetch(`${UPSTREAM}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${API_KEY}`,
        accept: 'text/event-stream',
        // opencode go 必需的两个头：会话 id + 自己的 User-Agent（详见 docs/RELAY.md）
        'x-opencode-session': sessionForRequest(req),
        'user-agent': RELAY_USER_AGENT,
      },
      body,
      signal: controller.signal,
    })
    const contentType = upstream.headers.get('content-type') || 'application/json; charset=utf-8'
    res.statusCode = upstream.status
    res.setHeader('content-type', contentType)
    res.setHeader('cache-control', 'no-store')
    // 关掉 nginx 一类反代的缓冲，保证逐 token 到达手机
    res.setHeader('x-accel-buffering', 'no')

    if (!upstream.ok) {
      // 非 2xx：状态码 + 原始 JSON/文本原样回给浏览器，前端能读出 error.message
      const errorBody = Buffer.from(await upstream.arrayBuffer())
      res.setHeader('content-length', String(errorBody.length))
      res.end(errorBody)
      return
    }
    if (!upstream.body) {
      res.end()
      return
    }
    await pipeline(Readable.fromWeb(upstream.body), res)
  } catch (error) {
    if (controller.signal.aborted || res.destroyed) {
      // 客户端已经走了，没有地方可写
      res.destroy()
      return
    }
    if (!res.headersSent) {
      sendJson(res, 502, {
        error: {
          message: `无法访问上游 ${UPSTREAM}/chat/completions：${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      })
    } else {
      res.destroy()
    }
  } finally {
    res.off('close', abortUpstream)
  }
}

// ─────────────────────── /api/deepseek/search ──────────────────────
// 转发到 DeepSeek 官方 Search API（api.deepseek.com/v1/tools/search）。
// 和聊天用的是两把不同的 Key：聊天走 opencode go 订阅，搜索走 DeepSeek 账号。

const SEARCH_QUERY_MAX_CHARS = 500

const truncate = (text, limit) => (text.length > limit ? `${text.slice(0, limit)}…` : text)

const handleSearch = async (req, res) => {
  let raw
  try {
    raw = await readRequestBody(req)
  } catch (error) {
    const tooLarge = error?.code === 'BODY_TOO_LARGE'
    sendJson(res, tooLarge ? 413 : 400, {
      error: { message: tooLarge ? '搜索请求体过大' : '读取搜索请求体失败' },
    })
    return
  }
  let payload
  try {
    payload = JSON.parse(raw.toString('utf8') || '{}')
  } catch {
    sendJson(res, 400, { error: { message: '搜索请求体不是合法 JSON' } })
    return
  }
  const query = typeof payload?.query === 'string' ? payload.query.trim() : ''
  if (!query) {
    sendJson(res, 400, { error: { message: '缺少 query' } })
    return
  }
  if (DEEPSEEK_KEY === null) {
    sendJson(res, 409, {
      error: {
        code: 'search_unavailable',
        message:
          '这台中继没有配置 DEEPSEEK_API_KEY，联网搜索不可用。在 ~/.dsh/.credentials.yaml 里加一行 DEEPSEEK_API_KEY: <key>，或在启动前设置环境变量，然后重启中继。',
      },
    })
    return
  }
  const requestedCount = Number.isInteger(payload?.count) ? payload.count : SEARCH_DEFAULT_COUNT
  const count = Math.min(Math.max(requestedCount, 1), SEARCH_MAX_COUNT)
  const requestBody = { query: truncate(query, SEARCH_QUERY_MAX_CHARS), count, need_content: false }
  if (typeof payload?.oriQuestion === 'string') {
    const question = payload.oriQuestion.replace(/\s+/gu, ' ').trim().slice(0, 128)
    if (question) requestBody.ori_question = question
  }
  try {
    const upstream = await fetch(DEEPSEEK_SEARCH_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${DEEPSEEK_KEY}`,
        'content-type': 'application/json',
        'user-agent': RELAY_USER_AGENT,
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    })
    const text = await upstream.text()
    if (!upstream.ok) {
      sendJson(res, 502, {
        error: {
          message: `DeepSeek 搜索返回 HTTP ${upstream.status}：${previewBody(Buffer.from(text, 'utf8'))}`,
        },
      })
      return
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      sendJson(res, 502, { error: { message: 'DeepSeek 搜索返回的不是合法 JSON' } })
      return
    }
    const list = Array.isArray(parsed?.results) ? parsed.results : []
    const sources = []
    for (const item of list) {
      if (typeof item?.url !== 'string' || item.url.length === 0) continue
      sources.push({
        title: typeof item.title === 'string' ? item.title : '',
        url: item.url,
        snippet: typeof item.snippet === 'string' ? item.snippet : '',
        summary: typeof item.summary === 'string' ? item.summary : '',
        publishedAt: typeof item.date === 'string' ? item.date : null,
      })
    }
    sendJson(res, 200, { query: requestBody.query, sources })
  } catch (error) {
    sendJson(res, 502, {
      error: {
        message: `无法访问 DeepSeek 搜索 ${DEEPSEEK_SEARCH_URL}：${
          error instanceof Error ? error.message : String(error)
        }`,
      },
    })
  }
}

// ─────────────────────────── 静态文件 ───────────────────────────

/** 尝试发送一个真实文件；返回 false 表示文件不存在（调用方可回退） */
const trySendFile = async (req, res, filePath) => {
  let info
  try {
    info = await stat(filePath)
  } catch {
    return false
  }
  if (!info.isFile()) {
    return false
  }
  res.statusCode = 200
  res.setHeader('content-type', contentTypeFor(filePath))
  res.setHeader('cache-control', cacheControlFor(path.basename(filePath)))
  res.setHeader('content-length', String(info.size))
  res.setHeader('x-content-type-options', 'nosniff')
  if (req.method === 'HEAD') {
    res.end()
    return true
  }
  try {
    await pipeline(createReadStream(filePath), res)
  } catch {
    // 文件在 stat 与读取之间被替换/删除，或客户端提前断开：响应已开始，只能断开
    if (!res.destroyed) {
      res.destroy()
    }
  }
  return true
}

/** dist 还没构建时的说明页（HTTP 200，方便直接打开看「中继本身是通的」） */
const missingDistPage = () => {
  const firstLan = lanAddresses()[0]
  const mobileHint = firstLan
    ? `<p>同一 Wi-Fi 下，手机也可以打开 <code>http://${escapeHtml(firstLan)}:${escapeHtml(
        String(PORT)
      )}/api/health</code> 验证中继连通。</p>`
    : '<p>没探测到局域网 IPv4 地址；手机可尝试 Tailscale / 热点，或把 HOST 设为具体网卡地址。</p>'
  return `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>卡片树 · 中继已启动</title>
<style>
  body { font: 15px/1.65 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
         margin: 0 auto; max-width: 640px; padding: 40px 20px; color: #1f2329; background: #f7f8fa; }
  h1 { font-size: 20px; margin: 0 0 16px; }
  h2 { font-size: 15px; margin: 24px 0 8px; }
  code, pre { font-family: Consolas, "SF Mono", monospace; background: #eceef2; border-radius: 6px; }
  code { padding: 2px 5px; font-size: 13px; word-break: break-all; }
  pre { padding: 12px 14px; overflow-x: auto; font-size: 13px; }
  .ok { color: #0a7d33; font-weight: 600; }
  .muted { color: #6b7280; font-size: 13px; }
</style>
<body>
  <h1><span class="ok">✓</span> 中继服务已启动，但还没有前端静态文件</h1>
  <p>没有找到 <code>${escapeHtml(DIST_DIR)}</code>。只做后端联调或开发调试时这很正常，两种做法任选：</p>
  <h2>开发模式（推荐调前端时用）</h2>
  <pre>cd app
pnpm dev          # rspack serve，浏览器打开 http://localhost:8090</pre>
  <p>然后在应用「设置 → API 地址」里填 <code>http://127.0.0.1:${escapeHtml(
    String(PORT)
  )}/api</code>（手机端填电脑的局域网 IP）。</p>
  <h2>构建后用本中继托管（推荐手机上用）</h2>
  <pre>cd app
pnpm build        # 生成 app/dist
node server.mjs</pre>
  <p>然后浏览器打开 <code>http://&lt;电脑局域网IP&gt;:${escapeHtml(String(PORT))}</code>。${mobileHint}</p>
  <p class="muted">当前 Node ${escapeHtml(process.version)} · 上游 ${escapeHtml(UPSTREAM)}</p>
</body>
</html>`
}

/** `/` 与无扩展名路径都回 index.html；index.html 不存在时给说明页 */
const serveIndexPage = async (req, res) => {
  if (await trySendFile(req, res, path.join(DIST_DIR, 'index.html'))) {
    return
  }
  const html = Buffer.from(missingDistPage(), 'utf8')
  res.statusCode = 200
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-length', String(html.length))
  res.end(html)
}

const serveStatic = async (req, res, pathname) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    methodNotAllowed(res, 'GET, HEAD')
    return
  }
  let decoded
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    sendText(res, 400, '400 Bad Request：URL 编码不正确')
    return
  }
  if (decoded.includes('\0')) {
    sendText(res, 400, '400 Bad Request：路径不合法')
    return
  }
  // pathname 以 / 开头，拼成 './xxx' 后 resolve，再确认没有跑出 DIST_DIR（防目录穿越）
  const filePath = path.resolve(DIST_DIR, `.${decoded}`)
  if (filePath !== DIST_DIR && !filePath.startsWith(DIST_DIR + path.sep)) {
    sendText(res, 403, '403 Forbidden：非法路径')
    return
  }
  if (path.extname(filePath) !== '') {
    if (await trySendFile(req, res, filePath)) {
      return
    }
    sendText(res, 404, '404 Not Found：文件不存在')
    return
  }
  // SPA：/、/settings、/tree/xxx 之类无扩展名路径一律回 index.html
  await serveIndexPage(req, res)
}

// ─────────────────────────── 路由 ───────────────────────────

const handleRequest = async (req, res) => {
  let url
  try {
    url = new URL(req.url || '/', 'http://localhost')
  } catch {
    sendText(res, 400, '400 Bad Request')
    return
  }
  const pathname = url.pathname
  const isApi = pathname === '/api' || pathname.startsWith('/api/')
  if (isApi) {
    applyCors(res)
  }
  if (req.method === 'OPTIONS') {
    // 浏览器 CORS 预检：直接 204，不回任何业务数据
    applyCors(res)
    res.statusCode = 204
    res.end()
    return
  }
  if (pathname === '/api/health') {
    sendJson(res, 200, healthPayload())
    return
  }
  if (pathname === '/api/models') {
    if (req.method !== 'GET') {
      methodNotAllowed(res, 'GET')
      return
    }
    await handleModels(res)
    return
  }
  // /api/chat 是 /api/chat/completions 的别名，两个都收
  if (pathname === '/api/chat/completions' || pathname === '/api/chat') {
    if (req.method !== 'POST') {
      methodNotAllowed(res, 'POST')
      return
    }
    await handleChat(req, res)
    return
  }
  if (pathname === '/api/deepseek/search') {
    if (req.method !== 'POST') {
      methodNotAllowed(res, 'POST')
      return
    }
    await handleSearch(req, res)
    return
  }
  if (isApi) {
    sendJson(res, 404, { error: { message: `未知的中继接口：${pathname}` } })
    return
  }
  // 手机「装成 App」要先信任本地 CA：这里只给公钥证书，私钥绝不暴露
  if (pathname === '/ca.pem' || pathname === '/ca.crt') {
    const isDer = pathname === '/ca.crt'
    const file = isDer ? CA_DER_FILE : CA_PEM_FILE
    if (!existsSync(file)) {
      sendText(
        res,
        404,
        '404 Not Found：还没有生成自签证书。先在电脑上跑 node scripts/make-cert.mjs，再重启中继。',
      )
      return
    }
    const body = readFileSync(file)
    res.statusCode = 200
    res.setHeader('content-type', isDer ? 'application/x-x509-ca-cert' : 'application/x-pem-file')
    res.setHeader('content-disposition', `attachment; filename="card-tree-ca${isDer ? '.crt' : '.pem'}"`)
    res.setHeader('cache-control', 'no-store')
    res.setHeader('content-length', String(body.length))
    res.end(body)
    return
  }
  await serveStatic(req, res, pathname)
}

// 同一套 handler 给 http / https 共用；起 https 只是换一个 listener
const handleIncoming = (req, res) => {
  handleRequest(req, res).catch((error) => {
    console.error('[relay] 处理请求时出现未捕获异常:', error)
    if (!res.headersSent) {
      sendJson(res, 500, { error: { message: '中继内部错误，详见中继进程日志' } })
    } else if (!res.destroyed) {
      res.destroy()
    }
  })
}

let server
if (TLS_ENABLED) {
  let tlsOptions
  try {
    tlsOptions = { cert: readFileSync(TLS_CERT_FILE), key: readFileSync(TLS_KEY_FILE) }
  } catch (error) {
    console.error('✗ 读取 HTTPS 证书失败：', TLS_CERT_FILE, '或', TLS_KEY_FILE)
    console.error('  重新生成：node scripts/make-cert.mjs（或跑 HTTPS=0 node server.mjs 先用 HTTP）')
    console.error(' ', error?.message ?? error)
    process.exit(1)
  }
  server = createHttpsServer(tlsOptions, handleIncoming)
} else {
  server = createServer(handleIncoming)
}

// 兜底：单个请求/回调里的异常不让整个中继进程退出
process.on('uncaughtException', (error) => {
  console.error('[relay] 未捕获异常（进程继续运行）:', error)
})
process.on('unhandledRejection', (reason) => {
  console.error('[relay] 未处理的 Promise 拒绝（进程继续运行）:', reason)
})

server.on('error', (error) => {
  if (error?.code === 'EADDRINUSE') {
    console.error(`✗ 端口 ${PORT} 已被占用。换一个端口：PORT=8788 node server.mjs`)
  } else {
    console.error('✗ 中继服务启动失败:', error)
  }
  process.exit(1)
})

const printStartup = () => {
  const distReady = existsSync(path.join(DIST_DIR, 'index.html'))
  const lan = lanAddresses()
  console.log('')
  console.log('  卡片树手机版 · 本地中继')
  console.log('  ────────────────────────────────────────────')
  console.log(`  API Key   : 已加载（来自 ${loadedKey.source}，长度 ${API_KEY.length}）`)
  console.log(`  上游地址  : ${UPSTREAM}`)
  console.log('  上游请求头: 自动注入 Authorization、x-opencode-session、User-Agent（浏览器不用管）')
  console.log(
    DEEPSEEK_KEY === null
      ? '  联网搜索  : 未配置 DEEPSEEK_API_KEY（搜索开关会置灰，聊天不受影响）'
      : `  联网搜索  : 可用（Key 来自 ${loadedDeepSeekKey?.source}，上游 ${DEEPSEEK_SEARCH_URL}）`
  )
  console.log(
    `  静态目录  : ${DIST_DIR}${
      distReady ? '' : '（还没有 index.html，先 pnpm build；本页会显示说明）'
    }`
  )
  console.log(`  监听      : ${HOST}:${PORT}`)
  if (TLS_ENABLED) {
    console.log(`  访问协议  : HTTPS（自签证书：${TLS_CERT_FILE}）`)
    console.log('             电脑浏览器第一次会警告「不安全」，信任后即可；手机同理')
    console.log(`  装成 App  : 手机先打开 ${SCHEME}://127.0.0.1:${PORT}/ca.pem 下载并信任根证书`)
    console.log('             然后浏览器菜单里「添加到主屏幕 / 安装应用」')
  } else {
    console.log('  访问协议  : HTTP')
    console.log('  装成 App  : 想要「安装到主屏幕」，先跑 node scripts/make-cert.mjs 再重启（切成 HTTPS）')
  }
  console.log(`  本机访问  : ${SCHEME}://127.0.0.1:${PORT}`)
  if (lan.length > 0) {
    for (const address of lan) {
      console.log(`  局域网访问: ${SCHEME}://${address}:${PORT}    ← 手机用这个（同一 Wi-Fi）`)
    }
  } else {
    console.log('  局域网访问: 未探测到 IPv4 局域网地址（可用 Tailscale / 热点）')
  }
  console.log(`  健康检查  : ${SCHEME}://127.0.0.1:${PORT}/api/health`)
  console.log('')
}

server.listen(PORT, HOST, printStartup)
