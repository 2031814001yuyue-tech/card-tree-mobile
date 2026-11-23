/** 正在流式生成的文本（不写进 IndexedDB，只在内存里随 token 覆盖） */
export type LiveText = {
  cardId: string
  /** 追问的 id；null 表示这条流是这张卡片本身的主回答 */
  followUpId: string | null
  /** 累计正文 */
  answer: string
  /** 累计思考过程 */
  thinking: string
  /** 联网搜索正在进行（UI 显示「正在搜索…」；搜完开始流式时自动消失） */
  searching?: boolean
  /** 正在搜的那句话（工具循环里模型自己给的搜索词），UI 显示「正在搜索「…」」 */
  searchingQuery?: string
}

/**
 * 一轮生成在 map 里的键：一张卡的主回答和它每条追问的回答都是独立的轮次，
 * 可以同时跑（用户可能一边深入回答、一边追问）。
 */
export const runKey = (cardId: string, followUpId: string | null): string =>
  `${cardId}::${followUpId ?? ''}`

