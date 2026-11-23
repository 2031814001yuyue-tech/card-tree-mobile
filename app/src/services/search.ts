/**
 * 联网搜索（DeepSeek 官方 Search API）。
 *
 * 浏览器不直接打 api.deepseek.com：同源的 `/api/deepseek/search` 由
 * 电脑中继（server.mjs）或 APK 内置的本地服务转发，Key 永远不进网页。
 */

import { normalizeApiBase } from './api/chat.js'
import { ApiError, type ChatTool } from './api/types.js'
import type { SearchSource } from './tree/types.js'

/** 一次搜索等多久（服务端自己还有 20s 超时） */
const SEARCH_TIMEOUT_MS = 25_000

/** 默认要几条来源（服务端上限 10） */
const DEFAULT_COUNT = 5

/** 搜索接口的返回：搜索词 + 来源列表 */
export type SearchOutcome = {
  query: string
  sources: SearchSource[]
}

/** 从错误响应里尽量挖出一句人话 */
const readErrorMessage = async (response: Response): Promise<string> => {
  let text = ''
  try {
    text = await response.text()
  } catch {
    return `HTTP ${response.status}`
  }
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } }
    const message = parsed?.error?.message
    if (typeof message === 'string' && message.trim()) {
      return message.trim()
    }
  } catch {
    // 不是 JSON，退回去用原文
  }
  return text.trim() || `HTTP ${response.status}`
}

/** /api/health 里我们关心的字段：联网搜索有没有 Key、各家订阅有没有 Key */
export type RelayInfo = {
  search: boolean
  providers: Record<string, boolean> | null
}

/** 查一下服务端状态：有没有配 DeepSeek 搜索 Key、各家订阅配了哪几家 */
export const fetchRelayInfo = async (apiBase: string): Promise<RelayInfo | null> => {
  try {
    const response = await fetch(`${normalizeApiBase(apiBase)}/health`)
    if (!response.ok) {
      return null
    }
    const payload = (await response.json()) as { search?: unknown; providers?: unknown }
    const providers =
      typeof payload?.providers === 'object' && payload.providers !== null && !Array.isArray(payload.providers)
        ? Object.fromEntries(
            Object.entries(payload.providers as Record<string, unknown>).map(([key, value]) => [
              key,
              value === true,
            ]),
          )
        : null
    return { search: payload?.search === true, providers }
  } catch {
    return null
  }
}

/** 查一下服务端有没有配 DeepSeek Key（健康检查里的 `search` 字段） */
export const fetchSearchAvailability = async (apiBase: string): Promise<boolean> => {
  const info = await fetchRelayInfo(apiBase)
  return info?.search === true
}

/**
 * 搜一次。
 * @throws ApiError：`auth` = 服务端没有配 DeepSeek Key；`network` = 连不上；
 *   `protocol` = 返回格式不对 / 没搜到；`http` = 上游报错
 */
export const searchWeb = async (
  apiBase: string,
  query: string,
  options?: { count?: number; oriQuestion?: string },
): Promise<SearchOutcome> => {
  const base = normalizeApiBase(apiBase)
  const question = query.trim()
  if (!question) {
    throw new ApiError('protocol', '搜索词不能为空')
  }
  // ori_question 只放用户的原话（≤128 字），query 才是真正拿去搜的、可能带上下文的词
  const origin = (options?.oriQuestion ?? query).trim().slice(0, 128)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(`${base}/deepseek/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: question,
        count: options?.count ?? DEFAULT_COUNT,
        // 中继读 oriQuestion，DeepSeek 原生接口读 ori_question：两个都发，谁认哪个都行
        oriQuestion: origin,
        ori_question: origin,
        need_content: false,
      }),
      signal: controller.signal,
    })
  } catch (error) {
    const aborted = error instanceof DOMException && error.name === 'AbortError'
    throw new ApiError(
      aborted ? 'interrupted' : 'network',
      aborted ? '联网搜索超时了，稍后再试' : `连不上搜索服务：${error instanceof Error ? error.message : String(error)}`,
    )
  } finally {
    clearTimeout(timer)
  }
  if (!response.ok) {
    const message = await readErrorMessage(response)
    const kind = response.status === 409 ? 'auth' : response.status >= 500 ? 'http' : 'protocol'
    throw new ApiError(kind, message, response.status)
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new ApiError('protocol', '搜索服务返回的不是合法 JSON')
  }
  const record = (payload ?? {}) as { query?: unknown; sources?: unknown; results?: unknown }
  // 中继返回 {sources}，APK 内置服务直连 DeepSeek 时返回 {results}：两种都认
  const raw = Array.isArray(record.sources)
    ? record.sources
    : Array.isArray(record.results)
      ? record.results
      : []
  const list: unknown[] = raw
  const sources: SearchSource[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') {
      continue
    }
    const entry = item as Record<string, unknown>
    if (typeof entry.url !== 'string' || !entry.url.trim()) {
      continue
    }
    const publishedAt =
      typeof entry.publishedAt === 'string'
        ? entry.publishedAt
        : typeof entry.date === 'string'
          ? entry.date
          : null
    sources.push({
      title: typeof entry.title === 'string' ? entry.title : '',
      url: entry.url.trim(),
      snippet: typeof entry.snippet === 'string' ? entry.snippet : '',
      summary: typeof entry.summary === 'string' ? entry.summary : '',
      publishedAt,
    })
  }
  if (sources.length === 0) {
    throw new ApiError('protocol', '这次没有搜到可用的结果，换个问法再试')
  }
  return {
    query: typeof record.query === 'string' && record.query.trim() ? record.query : question,
    sources,
  }
}

/**
 * 交给模型的工具定义：让模型自己决定搜不搜、搜什么（和 DeepSeek 手机端的网页搜索同一种机制）。
 * 只给一个简单函数，参数只有 query，各家兼容实现的 tool calling 都能认。
 */
export const WEB_SEARCH_TOOL: ChatTool = {
  type: 'function',
  function: {
    name: 'web_search',
    description:
      '联网搜索网页。当问题涉及最新消息、实时数据、你不确定或可能已经变化的事实（新闻、天气、价格、版本、政策、比赛结果、人物近况等），先调用它搜索，再基于结果回答。用一句具体、能直接拿去搜索引擎里查的话作为 query；不要搜「举个例子」「继续」这类需要上下文的碎片。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '完整、可独立检索的搜索词，例如「2026年11月杭州天气」',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
}

/** 从模型给的 tool_call arguments 里取出 query；解析不出来就返回空串 */
export const parseSearchQuery = (rawArguments: string): string => {
  try {
    const parsed: unknown = JSON.parse(rawArguments)
    if (parsed && typeof parsed === 'object') {
      const query = (parsed as Record<string, unknown>).query
      if (typeof query === 'string') {
        return query.trim().slice(0, 120)
      }
    }
  } catch {
    // 有的实现给的不是严格 JSON：退化成直接把原文当查询
    return rawArguments.trim().slice(0, 120)
  }
  return ''
}

/**
 * 把搜索结果折成一条 tool 消息。带编号，方便模型在回答里用 [1][2] 标来源；
 * 内容截断，避免把上下文塞爆（每条 snippet ≤220 字）。
 */
export const formatToolResult = (query: string, sources: SearchSource[]): string => {
  const lines = sources.slice(0, 8).map((source, index) => {
    const snippet = (source.summary || source.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 220)
    const date = source.publishedAt ? ` · ${source.publishedAt.slice(0, 10)}` : ''
    return `[${index + 1}] ${source.title || '无标题'}${date}\n${source.url}${snippet ? `\n${snippet}` : ''}`
  })
  return `搜索「${query}」，共 ${lines.length} 条结果：\n\n${lines.join('\n\n')}`
}
