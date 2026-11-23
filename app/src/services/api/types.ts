/**
 * 模型接口的类型定义。
 *
 * 手机版只接一种协议：OpenAI 兼容的 /chat/completions（opencode go 订阅就是这个协议）。
 * 浏览器不能直连 opencode.ai（POST 预检被 Cloudflare 挡掉），所以默认走同源的
 * `/api/*` 中继（见仓库根目录 server.mjs）；中继只负责转发和注入 API Key。
 */

export type ApiErrorKind = 'http' | 'stream' | 'network' | 'interrupted' | 'protocol' | 'auth'

export class ApiError extends Error {
  kind: ApiErrorKind
  status: number | null

  constructor(kind: ApiErrorKind, message: string, status?: number | null) {
    super(message)
    this.name = 'ApiError'
    this.kind = kind
    this.status = status ?? null
  }
}

/** /models 返回的模型条目 */
export type ModelInfo = {
  id: string
  ownedBy: string | null
  /** 上游声明支持图片输入（modalities.input 含 image/*）时为 true；没声明就是 false */
  vision: boolean
  /** 上游声明的上下文窗口（token 数）；各家字段名不一，取不到为 null */
  contextWindow: number | null
}

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

/**
 * OpenAI 兼容的多模态内容块。
 * 带图片的问题就用 `image_url`（dataURL 也能直接用）；纯文本仍然可以只传字符串。
 */
export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

/** 模型请求调用的一次工具（OpenAI 兼容的 function calling） */
export type ChatToolCall = {
  id: string
  type?: 'function'
  function: { name: string; arguments: string }
}

/** 发给模型的工具定义 */
export type ChatTool = {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export type ChatMessage = {
  role: ChatRole
  /** tool 消息里是工具结果；assistant 只调工具时可以是 null */
  content: string | ChatContentPart[] | null
  /** assistant 消息带上「我要调这些工具」 */
  tool_calls?: ChatToolCall[]
  /** tool 消息对应哪次调用 */
  tool_call_id?: string
}

/** 一次流式调用里冒出来的事件；text/thinking 都是累计值，直接覆盖渲染 */
export type StreamEvent =
  | { type: 'thinking'; text: string }
  | { type: 'text'; text: string }
  | { type: 'usage'; promptTokens: number | null; completionTokens: number | null }
  /** 这一轮流结束时模型要求调用工具（已拼好完整参数） */
  | { type: 'toolCalls'; calls: ChatToolCall[] }
  | { type: 'done'; finishReason: string | null }

export type ChatRequest = {
  /** 走哪家订阅上游；中继/APK 按它路由（缺省 = opencode，兼容旧调用） */
  provider?: string
  model: string
  messages: ChatMessage[]
  /** 推理强度：opencode go 支持 "high" 之类的档位，走 body.reasoning_effort */
  reasoningEffort?: string
  temperature?: number
  maxTokens?: number
  /** 工具定义；不传就是普通补全 */
  tools?: ChatTool[]
  /** 默认 auto；「必须调工具」有些实现不支持，别用 */
  toolChoice?: 'auto' | 'none'
  signal?: AbortSignal
}
