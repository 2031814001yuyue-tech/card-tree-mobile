/**
 * DeepSeek 官方 Anthropic 协议客户端 —— 「原生联网搜索」。
 *
 * DeepSeek 手机端 App 的搜索是服务端工具：请求里挂上 `web_search_20250305`，
 * 模型自己决定搜不搜、搜什么、搜几轮，搜索穿插在流式回答里。
 * 这个文件把那套 Anthropic 事件流翻译成本项目统一的 StreamEvent，
 * 让 store.run 不用关心协议差异；搜索到的来源通过 onSources 回调交出去。
 *
 * 端点只认 deepseek-chat / deepseek-reasoner；调用方负责选对模型。
 */

import { ApiError, type ChatMessage, type StreamEvent } from './types.js'
import type { SearchSource } from '../tree/types.js'
import { normalizeApiBase, readErrorMessage, fetchOrThrow } from './chat.js'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const toFiniteNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

/** Anthropic 的流里除了 data: 负载还带 event: 行；我们只需要 data 的 JSON */
const parseSseLine = (line: string): string | null => {
  if (line === '' || line.startsWith(':')) {
    return null
  }
  if (!line.startsWith('data:')) {
    return null
  }
  return line.slice(5).replace(/^ /, '')
}

/** 按行切 SSE（与 chat.ts 同款逻辑，独立一份避免相互牵连） */
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
        // 流已结束/被取消
      }
    }
    reader.releaseLock()
  }
}

/** 把统一 ChatMessage 转成 Anthropic 格式：文本直传，图片 dataURL 转 image block */
const toAnthropicContent = (message: ChatMessage): string | Array<Record<string, unknown>> => {
  if (message.content === null) {
    // 只调工具、没有正文的 assistant 消息：Anthropic 侧这边用不到（原生模式不带工具）
    return ''
  }
  if (typeof message.content === 'string') {
    return message.content
  }
  const blocks: Array<Record<string, unknown>> = []
  for (const part of message.content) {
    if (part.type === 'text') {
      blocks.push({ type: 'text', text: part.text })
    } else {
      // image_url 的 dataURL 形如 data:image/jpeg;base64,xxxx
      const url = part.image_url.url
      const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.*)$/s.exec(url)
      if (!match) {
        // 不是标准 dataURL：退化成占位文本，不让整次请求挂掉
        blocks.push({ type: 'text', text: '[图片无法解析]' })
        continue
      }
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: match[1], data: match[2] },
      })
    }
  }
  return blocks
}

export type NativeSearchRequest = {
  /** Anthropic 端点只认 deepseek-chat / deepseek-reasoner */
  model: string
  /** 顶层 system（项目背景与规则） */
  system?: string
  messages: ChatMessage[]
  maxTokens?: number
  signal?: AbortSignal
}

export type NativeSearchCallbacks = {
  /** 模型开始一轮搜索时回调（「正在搜索…」状态） */
  onSearching?: () => void
  /** 每次拿到一批搜索来源就回调（title/url） */
  onSources?: (sources: SearchSource[]) => void
}

/**
 * POST `${base}/deepseek/messages`（中继/APK 里的 DeepSeek Anthropic 端点）。
 * 产出与 streamChat 相同语义的 StreamEvent（text/thinking 是累计值），
 * 最后产 done；来源通过 callbacks.onSources 累积交出。
 */
export async function* streamNativeSearchChat(
  apiBase: string,
  request: NativeSearchRequest,
  callbacks: NativeSearchCallbacks = {}
): AsyncGenerator<StreamEvent> {
  const { signal } = request
  if (signal?.aborted) {
    throw new ApiError('interrupted', '已停止')
  }

  const body: Record<string, unknown> = {
    model: request.model,
    max_tokens: request.maxTokens ?? 8192,
    stream: true,
    messages: request.messages.map((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: toAnthropicContent(message),
    })),
    ...(request.system ? { system: request.system } : {}),
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
  }

  const response = await fetchOrThrow(
    `${normalizeApiBase(apiBase)}/deepseek/messages`,
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
      response.status === 401 || response.status === 403 || response.status === 409
        ? 'auth'
        : 'http',
      readErrorMessage(text, `请求失败（HTTP ${response.status}）`),
      response.status
    )
  }
  if (!response.body) {
    throw new ApiError('stream', '连接中断，没有收到回答')
  }

  let text = ''
  let thinking = ''
  let sawData = false
  let promptTokens: number | null = null
  let completionTokens: number | null = null

  try {
    for await (const data of readSseData(response.body)) {
      let payload: unknown
      try {
        payload = JSON.parse(data)
      } catch {
        continue
      }
      if (!isRecord(payload)) {
        continue
      }
      sawData = true
      const type = typeof payload.type === 'string' ? payload.type : ''

      // Anthropic 会在 200 的流里塞 error 事件（限流、余额等）
      if (type === 'error') {
        const error = isRecord(payload.error) ? payload.error : null
        const message =
          error && typeof error.message === 'string' && error.message.length > 0
            ? error.message
            : '上游在流中报错'
        throw new ApiError('stream', message)
      }

      if (type === 'message_start') {
        const message = isRecord(payload.message) ? payload.message : null
        const usage = message && isRecord(message.usage) ? message.usage : null
        if (usage) {
          promptTokens = toFiniteNumber(usage.input_tokens) ?? promptTokens
        }
        continue
      }

      if (type === 'content_block_start') {
        const block = isRecord(payload.content_block) ? payload.content_block : null
        const blockType = block && typeof block.type === 'string' ? block.type : ''
        if (blockType === 'server_tool_use') {
          callbacks.onSearching?.()
          continue
        }
        if (blockType === 'web_search_tool_result') {
          const content = block && Array.isArray(block.content) ? block.content : []
          const sources: SearchSource[] = []
          for (const item of content) {
            if (!isRecord(item) || item.type !== 'web_search_result') {
              continue
            }
            if (typeof item.url !== 'string' || item.url.length === 0) {
              continue
            }
            sources.push({
              title: typeof item.title === 'string' ? item.title : '',
              url: item.url,
              snippet: '',
              summary: '',
              publishedAt: null,
            })
          }
          if (sources.length > 0) {
            callbacks.onSources?.(sources)
          }
          continue
        }
        continue
      }

      if (type === 'content_block_delta') {
        const delta = isRecord(payload.delta) ? payload.delta : null
        if (!delta) {
          continue
        }
        const deltaType = typeof delta.type === 'string' ? delta.type : ''
        if (deltaType === 'text_delta' && typeof delta.text === 'string' && delta.text.length > 0) {
          text += delta.text
          yield { type: 'text', text }
        } else if (
          deltaType === 'thinking_delta' &&
          typeof delta.thinking === 'string' &&
          delta.thinking.length > 0
        ) {
          thinking += delta.thinking
          yield { type: 'thinking', text: thinking }
        }
        continue
      }

      if (type === 'message_delta') {
        const usage = isRecord(payload.usage) ? payload.usage : null
        if (usage) {
          completionTokens = toFiniteNumber(usage.output_tokens) ?? completionTokens
          yield { type: 'usage', promptTokens, completionTokens }
        }
        continue
      }

      if (type === 'message_stop') {
        break
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
  yield { type: 'done', finishReason: null }
}
