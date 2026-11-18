/**
 * OpenAI 兼容协议的浏览器端客户端（opencode go 订阅即是这个协议）。
 *
 * 浏览器不能直连 opencode.ai：POST /chat/completions 的 CORS 预检被上游挡掉，
 * 只会得到 `TypeError: Failed to fetch`。所以默认把请求打到同源 `/api/*`，
 * 由本机中继（app/server.mjs）转发并注入 API Key。
 *
 * 这个文件只做两件事：拼请求、解析 SSE；往上抛的错误统一是 `ApiError`。
 */

import { ApiError, type ChatRequest, type ModelInfo, type StreamEvent } from './types.js'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const toFiniteNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

/**
 * 规范化 API 地址：空串或 `/` 表示同源中继 `/api`；绝对地址去掉末尾斜杠。
 * 例：`''` → `/api`，`'/'` → `/api`，`'http://127.0.0.1:8787/api/'` → `'http://127.0.0.1:8787/api'`
 */
export const normalizeApiBase = (value: string): string => {
  const base = value.trim().replace(/\/+$/, '')
  return base === '' ? '/api' : base
}

/** 从上游错误响应体里尽量取出可读的中文/英文原因 */
const readErrorMessage = (text: string, fallback: string): string => {
  try {
    const body: unknown = JSON.parse(text)
    if (
      isRecord(body) &&
      isRecord(body.error) &&
      typeof body.error.message === 'string' &&
      body.error.message.length > 0
    ) {
      return body.error.message
    }
    if (isRecord(body) && typeof body.message === 'string' && body.message.length > 0) {
      return body.message
    }
  } catch {
    // 非 JSON 错误体：直接用原文
  }
  return text.trim() || fallback
}

/** 统一的 fetch 包装：网络失败/被中止都转成 ApiError */
const fetchOrThrow = async (
  url: string,
  init: RequestInit,
  signal?: AbortSignal
): Promise<Response> => {
  try {
    return await fetch(url, init)
  } catch (error) {
    if (signal?.aborted) {
      throw new ApiError('interrupted', '已停止')
    }
    throw new ApiError('network', error instanceof Error ? error.message : String(error))
  }
}

const httpErrorKind = (status: number): 'auth' | 'http' =>
  status === 401 || status === 403 ? 'auth' : 'http'

/** 解析上游 SSE 的 `data:` 负载；空行/注释/event 等字段忽略，不产出 */
const parseSseLine = (line: string): string | null => {
  if (line === '' || line.startsWith(':')) {
    return null
  }
  if (!line.startsWith('data:')) {
    return null
  }
  // 规范：`data:` 后最多去掉一个前导空格
  return line.slice(5).replace(/^ /, '')
}

/**
 * 把字节流按行切成 SSE 的 `data:` 负载。
 * 只处理 OpenAI 兼容接口实际会用的部分：`data:` 行 + `[DONE]` 哨兵；
 * 保活注释（`: keep-alive`）和 event/id/retry 字段都忽略。
 */
async function* readSseData(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let finished = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        buffer += decoder.decode()
        finished = true
        break
      }
      buffer += decoder.decode(value, { stream: true })
      let lineBreak = buffer.indexOf('\n')
      while (lineBreak !== -1) {
        const line = buffer.slice(0, lineBreak).replace(/\r$/, '')
        buffer = buffer.slice(lineBreak + 1)
        const data = parseSseLine(line)
        if (data !== null) {
          yield data
        }
        lineBreak = buffer.indexOf('\n')
      }
    }
    // 末尾没有换行的残行也尝试解析；JSON 不完整时上层会跳过
    if (buffer.length > 0) {
      const data = parseSseLine(buffer.replace(/\r$/, ''))
      if (data !== null) {
        yield data
      }
    }
  } finally {
    if (!finished) {
      try {
        await reader.cancel()
      } catch {
        // 流已经出错/被取消，忽略
      }
    }
    reader.releaseLock()
  }
}

/**
 * GET `${base}/models`：取上游模型列表。
 * 返回 `{ id, ownedBy }`；非 2xx、响应不是 JSON、缺列表时抛 ApiError。
 */
export const fetchModels = async (apiBase: string, signal?: AbortSignal): Promise<ModelInfo[]> => {
  const response = await fetchOrThrow(
    `${normalizeApiBase(apiBase)}/models`,
    { method: 'GET', signal },
    signal
  )
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new ApiError(
      httpErrorKind(response.status),
      readErrorMessage(text, `获取模型列表失败（HTTP ${response.status}）`),
      response.status
    )
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new ApiError('protocol', '模型列表响应不是合法 JSON')
  }
  if (!isRecord(payload)) {
    throw new ApiError('protocol', '模型列表响应格式不正确')
  }
  // OpenAI 用 { data: [...] }；部分兼容实现用 { models: [...] }
  const list = Array.isArray(payload.data)
    ? payload.data
    : Array.isArray(payload.models)
      ? payload.models
      : null
  if (!list) {
    throw new ApiError('protocol', '模型列表响应格式不正确（缺少 data/models 数组）')
  }
  const models: ModelInfo[] = []
  for (const item of list) {
    if (!isRecord(item) || typeof item.id !== 'string' || item.id.length === 0) {
      continue
    }
    models.push({
      id: item.id,
      ownedBy: typeof item.owned_by === 'string' ? item.owned_by : null,
    })
  }
  return models
}

/**
 * POST `${base}/chat/completions`（stream: true），逐个产出内部统一事件。
 *
 * 事件语义：
 * - `text` / `thinking` 都是累计值，调用方直接覆盖渲染即可；
 * - `usage` 在上游给出 usage 帧时出现一次（`stream_options.include_usage` 触发的最后一帧）；
 * - `done` 在 `[DONE]` 或读取自然结束时最后产出一次。
 *
 * 中止（request.signal.aborted）抛 `ApiError('interrupted')`；
 * 非 2xx 抛 `ApiError('auth' | 'http')`；网络失败抛 `ApiError('network')`；
 * 连一个 data 帧都没收到就结束抛 `ApiError('stream')`。
 */
export async function* streamChat(
  apiBase: string,
  request: ChatRequest
): AsyncGenerator<StreamEvent> {
  const { signal } = request
  if (signal?.aborted) {
    throw new ApiError('interrupted', '已停止')
  }

  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(request.reasoningEffort ? { reasoning_effort: request.reasoningEffort } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
  }

  const response = await fetchOrThrow(
    `${normalizeApiBase(apiBase)}/chat/completions`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal,
    },
    signal
  )

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new ApiError(
      httpErrorKind(response.status),
      readErrorMessage(text, `请求失败（HTTP ${response.status}）`),
      response.status
    )
  }
  if (!response.body) {
    throw new ApiError('stream', '连接中断，没有收到回答')
  }

  let text = ''
  let thinking = ''
  let finishReason: string | null = null
  let sawData = false

  try {
    for await (const data of readSseData(response.body)) {
      if (data.trim() === '[DONE]') {
        break
      }
      sawData = true
      let payload: unknown
      try {
        payload = JSON.parse(data)
      } catch {
        // 单个坏帧不影响整条流
        continue
      }
      if (!isRecord(payload)) {
        continue
      }
      // 少数兼容实现会在 200 的流里塞错误帧（限流、余额、内容审核等）
      if (isRecord(payload.error) && typeof payload.error.message === 'string') {
        throw new ApiError('stream', payload.error.message)
      }

      const choices = Array.isArray(payload.choices) ? payload.choices : []
      const choice = choices[0]
      if (isRecord(choice)) {
        const delta = isRecord(choice.delta) ? choice.delta : null
        if (delta) {
          // 思考内容：标准字段是 reasoning_content，部分实现叫 reasoning
          const reasoning = delta.reasoning_content ?? delta.reasoning
          if (typeof reasoning === 'string' && reasoning.length > 0) {
            thinking += reasoning
            yield { type: 'thinking', text: thinking }
          }
          if (typeof delta.content === 'string' && delta.content.length > 0) {
            text += delta.content
            yield { type: 'text', text }
          }
        }
        if (typeof choice.finish_reason === 'string' && choice.finish_reason.length > 0) {
          finishReason = choice.finish_reason
        }
      }

      const usage = isRecord(payload.usage) ? payload.usage : null
      if (usage) {
        yield {
          type: 'usage',
          promptTokens: toFiniteNumber(usage.prompt_tokens),
          completionTokens: toFiniteNumber(usage.completion_tokens),
        }
      }
    }
  } catch (error) {
    if (signal?.aborted) {
      throw new ApiError('interrupted', '已停止')
    }
    if (error instanceof ApiError) {
      throw error
    }
    throw new ApiError('stream', error instanceof Error ? error.message : String(error))
  }

  if (!sawData) {
    throw new ApiError('stream', '连接中断，没有收到回答')
  }
  yield { type: 'done', finishReason }
}
