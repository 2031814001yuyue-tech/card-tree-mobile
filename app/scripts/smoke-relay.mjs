#!/usr/bin/env node
/**
 * 中继服务端到端冒烟测试（零依赖，只用 Node 内置能力）。
 *
 * 跑法：cd app && node scripts/smoke-relay.mjs
 *
 * 流程：以 PORT=8799 拉起 app/server.mjs → 等 /api/health 200 →
 *       GET /api/models 断言含 deepseek-v4.1-flash →
 *       POST /api/chat/completions 读 SSE，统计 delta 段数与总字数 →
 *       杀掉中继进程，输出 SMOKE OK。
 * 任何一步失败：打印原因 + 中继日志，输出 SMOKE FAIL 并以 exit 1 退出。
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const appDir = path.resolve(scriptDir, '..')
const PORT = 8799
const BASE_URL = `http://127.0.0.1:${PORT}`
const MODEL = 'deepseek-v4.1-flash'
const HEALTH_TIMEOUT_MS = 20_000
const TOTAL_TIMEOUT_MS = 150_000

class SmokeError extends Error {}

const assert = (condition, message) => {
  if (!condition) {
    throw new SmokeError(message)
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const truncate = (text, limit) =>
  text.length <= limit ? text : `${text.slice(0, limit)}…`

const previewLine = (text) => text.replace(/\s+/g, ' ').trim()

// ── 子进程管理 ──────────────────────────────────────────────

/** 中继进程的 stdout/stderr，失败时打印出来便于定位 */
const serverLogs = []
const collectLog = (line) => {
  const trimmed = line.trim()
  if (!trimmed) {
    return
  }
  serverLogs.push(`[server] ${trimmed}`)
  if (serverLogs.length > 100) {
    serverLogs.shift()
  }
}

let child = null
let childExited = false
let childExitInfo = '(仍在运行)'

const startServer = () => {
  child = spawn(process.execPath, [path.join(appDir, 'server.mjs')], {
    cwd: appDir,
    env: { ...process.env, PORT: String(PORT), HTTPS: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => chunk.split(/\r?\n/).forEach(collectLog))
  child.stderr.on('data', (chunk) => chunk.split(/\r?\n/).forEach(collectLog))
  child.once('error', (error) => {
    childExited = true
    childExitInfo = `spawn 失败：${error.message}`
  })
  child.once('exit', (code, signal) => {
    childExited = true
    childExitInfo = `code=${code ?? 'null'}, signal=${signal ?? 'null'}`
  })
}

const stopServer = async () => {
  if (!child || childExited) {
    return
  }
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve()
    }, 3000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    child.kill('SIGTERM')
  })
}

// ── 各步骤 ─────────────────────────────────────────────────

/** 轮询 /api/health，直到 200 或超时；返回健康检查 body */
const waitForHealth = async () => {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS
  let lastReason = '未知原因'
  while (Date.now() < deadline) {
    if (childExited) {
      throw new SmokeError(`中继进程提前退出（${childExitInfo}），看下面的进程日志`)
    }
    try {
      const response = await fetch(`${BASE_URL}/api/health`, {
        signal: AbortSignal.timeout(3000),
      })
      if (response.ok) {
        return await response.json()
      }
      lastReason = `/api/health 返回 HTTP ${response.status}`
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error)
    }
    await delay(250)
  }
  throw new SmokeError(`等待 /api/health 超时（${HEALTH_TIMEOUT_MS}ms）：${lastReason}`)
}

const checkHealth = async () => {
  const health = await waitForHealth()
  assert(health?.ok === true, `/api/health 没有返回 ok=true（实际 ${JSON.stringify(health)}）`)
  assert(health?.hasKey === true, '/api/health 显示中继没有加载到 API Key')
  assert(typeof health?.keyLength === 'number' && health.keyLength > 0, '/api/health 的 keyLength 异常')
  assert(!('apiKey' in health) && !('key' in health), '/api/health 泄露了 Key 字段')
  console.log(
    `✓ /api/health 200：ok=true，hasKey=true，keyLength=${health.keyLength}，node=${health.node}，upstream=${health.upstream}`
  )
  return health
}

const checkModels = async () => {
  const response = await fetch(`${BASE_URL}/api/models`, { signal: AbortSignal.timeout(20_000) })
  assert(response.ok, `GET /api/models 返回 HTTP ${response.status}`)
  const payload = await response.json()
  const list = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : []
  const ids = list.map((item) => item?.id).filter((id) => typeof id === 'string')
  assert(ids.includes(MODEL), `/api/models 返回的 ${ids.length} 个模型里没有 ${MODEL}`)
  console.log(`✓ /api/models 200：${ids.length} 个模型，包含 ${MODEL}`)
}

/** 读 SSE 流，按 data 行取 delta；返回 { segments, totalChars } */
const streamChat = async () => {
  const body = {
    model: MODEL,
    messages: [{ role: 'user', content: '用一句话解释什么是树' }],
    stream: true,
    max_tokens: 120,
  }
  const response = await fetch(`${BASE_URL}/api/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new SmokeError(`POST /api/chat/completions 返回 HTTP ${response.status}：${text.slice(0, 300)}`)
  }
  const contentType = response.headers.get('content-type') ?? ''
  assert(
    contentType.includes('text/event-stream'),
    `流式响应的 content-type 不是 text/event-stream（实际 "${contentType}"）`
  )
  assert(response.body, '流式响应没有 body')

  const decoder = new TextDecoder()
  const textSegments = []
  const thinkingSegments = []
  let textChars = 0
  let thinkingChars = 0
  let sawUsage = false
  let sawDone = false
  let buffer = ''

  // 这个 while 结构既处理跨 chunk 的字节解码，也处理一行被拆成多个 chunk 的情况
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true })
    let lineBreak = buffer.indexOf('\n')
    while (lineBreak !== -1) {
      const line = buffer.slice(0, lineBreak).replace(/\r$/, '')
      buffer = buffer.slice(lineBreak + 1)
      lineBreak = buffer.indexOf('\n')
      if (!line.startsWith('data:')) {
        continue
      }
      const data = line.slice(5).replace(/^ /, '').trim()
      if (data === '[DONE]') {
        sawDone = true
        continue
      }
      let payload
      try {
        payload = JSON.parse(data)
      } catch {
        continue
      }
      if (payload?.error?.message) {
        throw new SmokeError(`上游在流里返回错误：${payload.error.message}`)
      }
      const delta = payload?.choices?.[0]?.delta
      const content = typeof delta?.content === 'string' ? delta.content : ''
      const reasoning =
        typeof delta?.reasoning_content === 'string'
          ? delta.reasoning_content
          : typeof delta?.reasoning === 'string'
            ? delta.reasoning
            : ''
      if (reasoning.length > 0) {
        thinkingSegments.push(reasoning)
        thinkingChars += reasoning.length
      }
      if (typeof payload?.usage === 'object' && payload.usage !== null) {
        sawUsage = true
      }
      if (content.length > 0) {
        textSegments.push(content)
        textChars += content.length
      }
    }
  }

  assert(sawDone, 'SSE 流没有收到 [DONE] 结束标记')

  // deepseek-v4.1-flash 是推理模型：max_tokens=120 时有时先吐满 reasoning_content
  // 就耗尽额度，一个正文 delta 都没有。所以「收到了 delta」按正文 + 思考合计判断。
  const totalChars = textChars + thinkingChars
  const deltaSegments = textSegments.length + thinkingSegments.length
  console.log(
    `✓ /api/chat/completions 流式返回：content-type=${contentType}，delta 段数=${deltaSegments}（正文 ${textSegments.length} / 思考 ${thinkingSegments.length}），正文字数=${textChars}，思考字数=${thinkingChars}，总字数=${totalChars}${sawUsage ? '，含 usage 帧' : ''}`
  )
  // 优先展示正文片段；只有思考内容时展示思考片段（同样是 delta 流）
  const samples = textSegments.length > 0 ? textSegments : thinkingSegments
  const sampleLabel = textSegments.length > 0 ? '段' : '思考段'
  samples.slice(0, 3).forEach((segment, index) => {
    console.log(`  ${sampleLabel} ${index + 1}: ${previewLine(truncate(segment, 80))}`)
  })
  assert(totalChars > 0, '流式回答总字数为 0，没有拿到任何 delta（正文和思考都为空）')
  return { textSegments, thinkingSegments, totalChars }
}

/** 顺手验证 CORS 预检，浏览器跨源调用依赖它 */
const checkCorsPreflight = async () => {
  const response = await fetch(`${BASE_URL}/api/chat/completions`, {
    method: 'OPTIONS',
    headers: {
      origin: 'http://127.0.0.1:8090',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization, content-type',
    },
  })
  const allowOrigin = response.headers.get('access-control-allow-origin')
  assert(response.status === 204, `OPTIONS 预检应返回 204，实际 ${response.status}`)
  assert(allowOrigin === '*', `OPTIONS 预检的 access-control-allow-origin 应为 *，实际 ${allowOrigin}`)
  console.log('✓ CORS 预检 204：access-control-allow-origin=*')
}

// ── 主流程 ─────────────────────────────────────────────────

let failure = null
const watchdog = setTimeout(() => {
  console.error(`✗ 冒烟测试整体超时（${TOTAL_TIMEOUT_MS}ms）`)
  child?.kill('SIGKILL')
  console.log('SMOKE FAIL')
  process.exit(1)
}, TOTAL_TIMEOUT_MS)

try {
  console.log(`→ 启动中继：node server.mjs（PORT=${PORT}）`)
  startServer()
  await checkHealth()
  await checkCorsPreflight()
  await checkModels()
  await streamChat()
} catch (error) {
  failure = error
} finally {
  clearTimeout(watchdog)
  await stopServer()
}

if (failure) {
  console.error(`✗ ${failure instanceof Error ? failure.message : String(failure)}`)
  if (serverLogs.length > 0) {
    console.error('--- 中继进程日志 ---')
    serverLogs.forEach((line) => console.error(line))
  }
  console.log('SMOKE FAIL')
  process.exit(1)
}

console.log('SMOKE OK')
