/** 正在流式生成的文本（不写进 IndexedDB，只在内存里随 token 覆盖） */
export type LiveText = {
  cardId: string
  /** 追问的 id；null 表示这条流是这张卡片本身的主回答 */
  followUpId: string | null
  /** 累计正文 */
  answer: string
  /** 累计思考过程 */
  thinking: string
}
