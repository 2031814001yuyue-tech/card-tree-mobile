/**
 * 卡片树领域模型（手机版）。
 *
 * 语义与桌面插件 card-tree 对齐：一张卡片 = 一次「提问 + 回答」，卡片之间靠
 * parentId 连成树；同一张卡片上还可以继续追问（followUps，不生成新节点）。
 */

/** 卡片相对父级的关系。root=根卡片, child=深入, diverge=发散(同层新支线), branch=分支重答, isolated=独立卡片 */
export type CardMode = 'root' | 'child' | 'diverge' | 'branch' | 'isolated'

/** 一次模型调用的状态。partial=流式中断但已存下部分回答 */
export type RunStatus = 'idle' | 'running' | 'done' | 'partial' | 'error'

/** 上下文装配的统计，用于在界面上解释「这一问用了多少上下文」 */
export type CardStats = {
  /** 本次请求大致消耗的 token */
  approxTokens: number
  /** 本次可用的预算 */
  budget: number
  /** 被截断的祖先卡片数 */
  foldedCards: number
  /** 被整张丢掉的祖先卡片数 */
  droppedCards: number
  /** 放不下的引用卡片数 */
  droppedRefs: number
  /** 实际放入的引用卡片数 */
  refs: number
}

/** 一张卡片的附件：图片（压缩后的 base64）或文本文件（已读成字符串） */
export type Attachment = {
  id: string
  kind: 'image' | 'text'
  name: string
  /** image/jpeg、text/plain 之类的 MIME */
  mimeType: string
  /** 原始文件大小（字节）；图片是压缩前的 */
  size: number
  /** 图片：压缩后的 dataURL（带 data:image/jpeg;base64, 前缀） */
  dataUrl?: string
  /** 文本：读出来的内容（超过 MAX_ATTACHMENT_TEXT_CHARS 会截断） */
  text?: string
  createdAt: number
}

/** 一张卡片（或一条追问）最多带几个附件 */
export const MAX_ATTACHMENTS = 4

/** 文本附件最多读多少字符，避免把上下文撑爆 */
export const MAX_ATTACHMENT_TEXT_CHARS = 20000

/** 图片长边压缩到多少像素以内 */
export const MAX_IMAGE_EDGE = 1280

/** 联网搜索得到的一条来源 */
export type SearchSource = {
  title: string
  url: string
  /** 搜索服务给的摘要片段（可能为空） */
  snippet?: string
  /** 搜索结果自带的小结（可能为空，通常比 snippet 完整） */
  summary?: string
  /** 页面发布时间，ISO 字符串；没有就是 null */
  publishedAt?: string | null
}

/** 某一次提问的联网搜索结果，跟着卡片一起存 */
export type CardSearch = {
  /** 实际发出去的搜索词 */
  query: string
  sources: SearchSource[]
  searchedAt: number
}

/** 一次搜索最多留几条来源 */
export const MAX_SEARCH_SOURCES = 10

/** 卡片的一次追问：仍然挂在这张卡片上，不产生新节点 */
export type FollowUp = {
  id: string
  prompt: string
  answer: string
  /** 推理模型的思考过程（OpenAI 兼容的 reasoning_content） */
  thinking: string
  status: RunStatus
  error: string | null
  stats: CardStats | null
  /** 追问自己带的附件（只跟着这一条追问发出去） */
  attachments: Attachment[]
  /** 这一问的联网搜索结果；没联网提问就是 null */
  search: CardSearch | null
  createdAt: number
  updatedAt: number
}

/** 树上的一个节点 */
export type Card = {
  id: string
  /** 父卡片 id；根卡片 / 独立卡片为 null */
  parentId: string | null
  mode: CardMode
  prompt: string
  answer: string
  thinking: string
  status: RunStatus
  error: string | null
  stats: CardStats | null
  /** 这张卡片自己的追问，按时间顺序 */
  followUps: FollowUp[]
  /** 提问时一起发出去的图片 / 文本附件 */
  attachments: Attachment[]
  /** 这一问的联网搜索结果；没联网提问就是 null */
  search: CardSearch | null
  /** 引用的其它卡片 id，最多 MAX_REFS 个 */
  refs: string[]
  /** 全览图上的坐标；null 表示还没排过版 */
  pos: { x: number; y: number } | null
  createdAt: number
  updatedAt: number
}

/** 一个探索项目 = 一棵卡片树 */
export type Project = {
  id: string
  title: string
  /** 项目背景与规则，会拼进 system prompt */
  system: string
  cards: Card[]
  createdAt: number
  updatedAt: number
}

/** 引用卡片上限，和桌面版一致 */
export const MAX_REFS = 8

/** 追问内容的展示上限（列表里折叠） */
export const FOLLOW_UP_PREVIEW_CHARS = 60
