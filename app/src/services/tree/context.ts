/**
 * 卡片树的上下文装配（手机版）。
 *
 * 全部是纯函数：输入项目 / 当前卡片，输出 system prompt、消息数组和预算统计。
 * 语义忠实移植桌面插件 card-tree 的 planContext / buildMessages / buildSystem，
 * 只去掉桌面版才有的工具、附件、多模型分支（手机版一条消息只有字符串 content）。
 */

import type { ChatContentPart, ChatMessage } from '../api/types.js'
import type { Attachment, Card, CardMode, CardSearch, CardStats, FollowUp, Project } from './types.js'
import { MAX_REFS } from './types.js'

/** 祖先链上溯的最大层数，防数据损坏时死循环（桌面版 MAX_CHAIN） */
const MAX_CHAIN = 200

/** 折叠祖先回答后保留的字符数（桌面版 FOLDED_ANSWER_CHARS） */
export const FOLDED_ANSWER_CHARS = 320

/** 引用卡片的回答最多保留的字符数（桌面版 MAX_REF_ANSWER_CHARS） */
export const MAX_REF_ANSWER_CHARS = 2400

/** planContext 里预算下限（桌面版 planContext 的 1200） */
const MIN_PLAN_BUDGET = 1200

/** 上下文预算的兜底下限（桌面版 runStream 的 1500） */
const MIN_CONTEXT_BUDGET = 1500

/** 上下文窗口里留给「问 + 答」的比例（桌面版 CONTEXT_SHARE = 0.55） */
const CONTEXT_SHARE = 0.55

/** 拿不到模型上下文窗口时的兜底值（桌面版 FALLBACK_CONTEXT_WINDOW） */
export const FALLBACK_CONTEXT_WINDOW = 32000

/** 留给模型输出与协议开销的固定预留（桌面版 runStream 的 1200） */
const RESPONSE_RESERVE = 1200

/** 引用回答最多分到的预算占比（桌面版 refBudget = max(500, budget * 0.25)） */
const REF_BUDGET_SHARE = 0.25

/** 引用预算的下限（桌面版 500） */
const MIN_REF_BUDGET = 500

/** 折叠回答时追加的一句中文说明（和桌面版逐字一致） */
const FOLD_SUFFIX = '\n…（后面的内容已省略以节省上下文，完整回答仍在卡片里。）'

/** 一张图片大致占多少 token（按 1280 长边的压缩图粗算，和桌面插件口径一致） */
export const IMAGE_ATTACHMENT_TOKENS = 900

/** 附件大致要占多少 token：图片按张算，文本按字算 */
export const estimateAttachmentTokens = (attachments?: Attachment[]): number => {
  if (!attachments || attachments.length === 0) {
    return 0
  }
  let total = 0
  for (const item of attachments) {
    if (item.kind === 'image' && item.dataUrl) {
      total += IMAGE_ATTACHMENT_TOKENS
    } else {
      total += estimateTokens(item.text ?? '')
    }
  }
  return total
}

/** 把文本附件拼成一段「【附件：xxx】+ 内容」，直接放进用户消息里 */
const attachmentText = (attachments?: Attachment[]): string =>
  (attachments ?? [])
    .filter((item) => item.kind === 'text' && String(item.text ?? '').trim())
    .map((item) => `【附件：${item.name}】\n${String(item.text ?? '').trim()}`)
    .join('\n\n')

/** 图片附件走 OpenAI 兼容的 image_url 内容块 */
const attachmentImages = (attachments?: Attachment[]): Attachment[] =>
  (attachments ?? []).filter((item) => item.kind === 'image' && Boolean(item.dataUrl))

/** 一条来源摘要最多保留多少字符 */
const SEARCH_DIGEST_CHARS = 400

/**
 * 把联网搜索结果拼成一段可读的来源清单，塞在当前问题前面。
 * 编号和来源列表一一对应，回答里让模型引用编号。
 */
export const searchBlock = (search?: CardSearch | null): string => {
  if (!search || search.sources.length === 0) {
    return ''
  }
  const lines = search.sources.map((item, index) => {
    const digest = String(item.summary || item.snippet || '')
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, SEARCH_DIGEST_CHARS)
    const head = `${index + 1}. ${item.title || item.url}（${item.url}）`
    return digest ? `${head}\n   ${digest}` : head
  })
  return [
    `【联网搜索结果 · 搜索词：${search.query}】`,
    '下面是刚刚从网上搜到的资料，请优先结合它们来回答；用到哪条就在句末标出编号（如 [1]），并在回答最后列出参考来源。',
    ...lines,
  ].join('\n')
}

/** 一条用户消息：没有图片时就是纯文本，有图片时变成 content parts */
const buildUserMessage = (
  prompt: string,
  attachments?: Attachment[],
  search?: CardSearch | null,
): ChatMessage => {
  const text = [searchBlock(search), String(prompt ?? '').trim(), attachmentText(attachments)]
    .filter(Boolean)
    .join('\n\n')
  const images = attachmentImages(attachments)
  if (images.length === 0) {
    return { role: 'user', content: text }
  }
  const parts: ChatContentPart[] = []
  if (text) {
    parts.push({ type: 'text', text })
  }
  for (const image of images) {
    parts.push({ type: 'image_url', image_url: { url: image.dataUrl as string } })
  }
  return { role: 'user', content: parts }
}

/** 项目没有自带 system 时的默认指令（和桌面版 DEFAULT_SYSTEM 逐字一致） */
export const DEFAULT_SYSTEM = [
  '你是一个知识探索助手。用户在「卡片树」里把对话拆成一张张卡片，逐张阅读。',
  '- 直接回答当前问题，结构清晰、自成一体；不要复述此前的对话内容。',
  '- 用简体中文回答，除非问题本身使用其他语言。',
  '- 需要时使用小标题、有序列表和代码块来组织答案，让这张卡片可以独立阅读。',
].join('\n')

/** 五种卡片模式在 system 里的解释文案（和桌面版 MODE_TEXT 逐字一致） */
export const MODE_TEXT: Record<CardMode, string> = {
  root: '根卡片：这是整棵树的第一张卡片。',
  child: '深入卡片：用户希望以上一张卡片的主题继续往下深入。',
  diverge: '发散卡片：与上一张卡片同层，用户开了一条新的支线。',
  branch: '分支重答：用户回到上一张卡片的问题，希望换一个角度重新作答。',
  isolated: '独立卡片：这张卡片有意不与树里其它卡片相连，只围绕它自己的问题作答，不要引用别的卡片。',
}

/** 一次上下文装配的结果：放得下的祖先、放得下的引用，以及预算统计 */
export type ContextPlan = {
  ancestors: { card: Card; answer: string; folded: boolean }[]
  refs: { card: Card; answer: string; folded: boolean }[]
  stats: CardStats
}

/**
 * 粗略估算 token 数：CJK 字符按 1 token/字，其余按 4 字符/token。
 * 和桌面版 estimateTokens 一致（逐码点遍历，>= 0x2e80 视为 CJK）。
 */
export const estimateTokens = (text: string): number => {
  let cjk: number = 0
  let other: number = 0
  for (const character of String(text || '')) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && codePoint >= 0x2e80) {
      cjk += 1
    } else {
      other += 1
    }
  }
  return cjk + Math.ceil(other / 4)
}

/** 超长回答截断到 limit 字，并追加一句中文省略说明（和桌面版 foldAnswer 一致） */
export const foldAnswer = (text: string, limit: number): string => {
  const value = String(text || '')
  const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0
  if (value.length <= max) {
    return value
  }
  return value.slice(0, max) + FOLD_SUFFIX
}

/**
 * 由模型上下文窗口算「问 + 答」可用的预算。
 * 桌面宿主规则：max(1500, floor(window * 0.55) - systemTokens - 1200)。
 * systemTokens 不传时按 0 算，调用方可以先用 estimateTokens(system) 算好再传。
 */
export const contextBudget = (contextWindow: number, systemTokens: number = 0): number => {
  const window = Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : FALLBACK_CONTEXT_WINDOW
  const reserve = Number.isFinite(systemTokens) && systemTokens > 0 ? Math.floor(systemTokens) : 0
  return Math.max(MIN_CONTEXT_BUDGET, Math.floor(window * CONTEXT_SHARE) - reserve - RESPONSE_RESERVE)
}

const findCard = (project: Project, id: string | null): Card | null => {
  if (!id) {
    return null
  }
  return project.cards.find((card) => card.id === id) ?? null
}

/**
 * 从根到父的祖先链，只保留「有回答」的祖先（空回答的卡片不进上下文）。
 * 数据损坏成环时最多上溯 MAX_CHAIN 层。
 */
export const ancestorChain = (project: Project, card: Card): Card[] => {
  const byId = new Map<string, Card>(project.cards.map((item) => [item.id, item]))
  const chain: Card[] = []
  let currentId: string | null = card.parentId
  let guard = 0
  while (currentId && guard < MAX_CHAIN) {
    const parent = byId.get(currentId)
    if (!parent) {
      break
    }
    chain.unshift(parent)
    currentId = parent.parentId
    guard += 1
  }
  return chain.filter((item) => Boolean(item && item.answer))
}

/** 这张卡片显式引用、且真的有回答的其它卡片（最多 MAX_REFS 张） */
export const resolvedRefs = (project: Project, card: Card): Card[] => {
  const byId = new Map<string, Card>(project.cards.map((item) => [item.id, item]))
  const refs: Card[] = []
  for (const refId of card.refs) {
    if (refs.length >= MAX_REFS) {
      break
    }
    const target = byId.get(refId)
    if (!target || target.id === card.id || !target.answer) {
      continue
    }
    refs.push(target)
  }
  return refs
}

/**
 * 预算分配：先给引用卡片（最多 25%），再按「从老到新」的顺序折叠 / 丢弃祖先，
 * 直到塞进 budget 为止。stats.approxTokens 会再加上本卡 prompt/answer 与 system。
 */
export const planContext = (
  project: Project,
  card: Card,
  options: { budget: number; system?: string },
): ContextPlan => {
  const budget = Math.max(MIN_PLAN_BUDGET, Math.floor(Number(options.budget) || 0))
  const stats: CardStats = {
    approxTokens: 0,
    budget,
    foldedCards: 0,
    droppedCards: 0,
    droppedRefs: 0,
    refs: 0,
  }

  const refBudget = Math.max(MIN_REF_BUDGET, Math.floor(budget * REF_BUDGET_SHARE))
  const refs: ContextPlan['refs'] = []
  let refTokens = 0
  for (const ref of resolvedRefs(project, card)) {
    const answer = foldAnswer(ref.answer, MAX_REF_ANSWER_CHARS)
    const cost = estimateTokens(ref.prompt) + estimateTokens(answer)
    if (refTokens + cost > refBudget) {
      stats.droppedRefs += 1
      continue
    }
    refTokens += cost
    refs.push({ card: ref, answer, folded: answer.length < String(ref.answer || '').length })
  }
  stats.refs = refs.length

  const entries = ancestorChain(project, card).map((ancestor) => ({
    card: ancestor,
    answer: String(ancestor.answer || ''),
    folded: false,
    dropped: false,
  }))

  let used = entries.reduce(
    (total, entry) => total + estimateTokens(entry.card.prompt) + estimateTokens(entry.answer),
    refTokens,
  )

  // 从最老的祖先开始：先尝试把回答折叠短；折叠省不下 token 就整张丢掉。
  for (let index = 0; index < entries.length && used > budget; index += 1) {
    const entry = entries[index]
    const before = estimateTokens(entry.card.prompt) + estimateTokens(entry.answer)
    const foldedAnswer = foldAnswer(entry.answer, FOLDED_ANSWER_CHARS)
    const after = estimateTokens(entry.card.prompt) + estimateTokens(foldedAnswer)
    if (after < before) {
      entry.answer = foldedAnswer
      entry.folded = true
      used -= before - after
      stats.foldedCards += 1
    } else {
      entry.dropped = true
      used -= before
      stats.droppedCards += 1
    }
  }

  stats.approxTokens =
    used + estimateTokens(card.prompt) + estimateTokens(card.answer) + estimateTokens(options.system ?? '')

  return {
    ancestors: entries
      .filter((entry) => !entry.dropped)
      .map((entry) => ({ card: entry.card, answer: entry.answer, folded: entry.folded })),
    refs,
    stats,
  }
}

/** 这张卡片上「当前追问之前、已经答完」的追问，按时间顺序 */
const answeredFollowUps = (card: Card, untilId: string): FollowUp[] => {
  const items: FollowUp[] = []
  for (const followUp of card.followUps) {
    if (followUp.id === untilId) {
      break
    }
    if (followUp.answer) {
      items.push(followUp)
    }
  }
  return items
}

/**
 * 拼出一次调用的业务消息（不含 system）。
 * 顺序：祖先链（user 问 / assistant 答）→ 引用卡片（【引用卡片·…】 / 答）→
 * 本卡问题 → 本卡回答 → 已答追问 → 当前追问。
 * 传入 options.stats 时会把 planContext 的统计对象浅拷贝进去（和桌面版一致）。
 */
export const buildMessages = (
  project: Project,
  card: Card,
  options: {
    budget: number
    system?: string
    followUp?: FollowUp
    stats?: CardStats
    /** 这一问自带附件：文本拼进用户消息，图片转成 content parts（只作用于当前这一问） */
    attachments?: Attachment[]
    /** 这一问的联网搜索结果（只作用于当前这一问） */
    search?: CardSearch | null
  },
): ChatMessage[] => {
  const plan = planContext(project, card, options)
  if (options.stats) {
    Object.assign(options.stats, plan.stats)
  }

  const messages: ChatMessage[] = []
  for (const ancestor of plan.ancestors) {
    if (ancestor.card.prompt) {
      messages.push({ role: 'user', content: ancestor.card.prompt })
    }
    messages.push({ role: 'assistant', content: ancestor.answer })
  }
  for (const ref of plan.refs) {
    messages.push({ role: 'user', content: `【引用卡片·${ref.card.prompt || ''}】` })
    messages.push({ role: 'assistant', content: ref.answer })
  }

  const followUp = options.followUp
  if (!followUp) {
    if (card.prompt) {
      messages.push(buildUserMessage(card.prompt, options.attachments, options.search))
    }
    return messages
  }

  if (card.prompt) {
    messages.push({ role: 'user', content: card.prompt })
  }
  if (card.answer) {
    messages.push({ role: 'assistant', content: card.answer })
  }
  for (const item of answeredFollowUps(card, followUp.id)) {
    if (item.prompt) {
      messages.push({ role: 'user', content: item.prompt })
    }
    if (item.answer) {
      messages.push({ role: 'assistant', content: item.answer })
    }
  }
  messages.push(buildUserMessage(followUp.prompt, options.attachments, options.search))
  return messages
}

/**
 * 拼 system prompt：默认指令 + 项目规则 + 「我在树里的位置」说明。
 * card 为 null（还没建卡 / 预览）时只输出前两段。
 */
export const buildSystem = (
  project: Project,
  card: Card | null,
  options?: { followUp?: FollowUp | null },
): string => {
  const parts: string[] = [DEFAULT_SYSTEM]
  const projectSystem = String(project?.system || '').trim()
  if (projectSystem) {
    parts.push(`项目背景与规则：\n${projectSystem}`)
  }
  if (!project || !card) {
    return parts.join('\n\n')
  }

  const chain = ancestorChain(project, card)
  const depth = chain.length + 1
  const parent = findCard(project, card.parentId)
  const followUp = options?.followUp ?? null
  const refs = resolvedRefs(project, card)
  const lines: string[] = [
    '【你在对话树里的位置】',
    `这个会话不是聊天窗口，而是一棵卡片树：每个问题是一张独立卡片，卡片通过父子关系连成树，整棵树属于项目《${project.title || '未命名'}》。`,
    `当前卡片是第 ${depth} 层，共 ${project.cards ? project.cards.length : 0} 张卡片。`,
    MODE_TEXT[card.mode] || '',
  ]

  if (followUp) {
    lines.push(
      '这次不是新卡片，而是用户对「当前这张卡片」的追问：回答要接着这张卡片已有的结论往下说，可以直接引用卡片里的内容，但不要重复它已经讲过的段落。',
    )
  }
  if (parent && parent.prompt) {
    lines.push(`上级卡片的问题：${String(parent.prompt).replace(/\s+/g, ' ').slice(0, 160)}`)
  }
  if (chain.length > 0) {
    lines.push('上游上下文是以「用户问 / 你的回答」成对出现的卡片链，按从根到父的顺序排列。')
  }
  if (refs.length > 0) {
    lines.push(
      `这张卡片还引用了 ${refs.length} 张其它卡片（它们不在你的父链上）。它们的「问 / 回答」会以【引用卡片·…】的形式出现在用户消息里，按需参考，不要整段复述。`,
    )
  }
  lines.push(
    followUp
      ? '回答要求：只回答这条追问；接着卡片已有的结论展开，不要重新介绍背景，也不要写「如前所述」这类依赖聊天顺序的话。'
      : '回答要求：只回答当前这张卡片的问题；写成一个可以独立阅读的结论，不要写「如前所述」「上面提到」「接着上文」这类依赖聊天顺序的话；需要引用上游内容时，用一句话复述要点。',
  )

  parts.push(lines.filter((line) => Boolean(line && line.trim())).join('\n'))
  return parts.join('\n\n')
}
