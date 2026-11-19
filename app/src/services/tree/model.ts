/**
 * 卡片树的状态更新（手机版）。
 *
 * 全部是纯函数：输入 project / card，返回新的 project，绝不原地修改传入对象。
 * 这里不涉及 React / DOM / 存储 —— store 负责调度、db 负责持久化。
 * 语义对齐桌面插件 card-tree 的 cardCreate / cardFollowCreate / cardUpdate /
 * cardDelete / cardReparent / cardRefs / cardLayout。
 */

import { createId } from '../../utils/id.js'
import { FOLLOW_UP_PREVIEW_CHARS } from './types.js'
import type {
  Attachment,
  Card,
  CardMode,
  CardSearch,
  CardStats,
  FollowUp,
  Project,
  RunStatus,
} from './types.js'
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_TEXT_CHARS,
  MAX_REFS,
  MAX_SEARCH_SOURCES,
} from './types.js'

const CARD_MODES: CardMode[] = ['root', 'child', 'diverge', 'branch', 'isolated']
const RUN_STATUSES: RunStatus[] = ['idle', 'running', 'done', 'partial', 'error']

/** 上溯防环的最大层数（桌面版 MAX_CHAIN） */
const MAX_CHAIN = 200

/** 附件整理：过滤非法项、限个数、文本截断、补默认字段（新建卡片/追问时用） */
export const normalizeAttachments = (value?: Attachment[]): Attachment[] => {
  if (!Array.isArray(value) || value.length === 0) {
    return []
  }
  const result: Attachment[] = []
  for (const item of value) {
    if (!item || (item.kind !== 'image' && item.kind !== 'text')) {
      continue
    }
    const dataUrl = item.kind === 'image' ? String(item.dataUrl ?? '') : ''
    const text = item.kind === 'text' ? String(item.text ?? '') : ''
    if (item.kind === 'image' && !dataUrl.startsWith('data:image/')) {
      continue
    }
    if (item.kind === 'text' && !text.trim()) {
      continue
    }
    result.push({
      id: String(item.id || `a_${createId().replace(/-/g, '')}`),
      kind: item.kind,
      name: String(item.name || (item.kind === 'image' ? '图片' : '文本')).slice(0, 120),
      mimeType: String(item.mimeType || (item.kind === 'image' ? 'image/jpeg' : 'text/plain')),
      size: Number.isFinite(item.size) ? Math.max(0, Math.round(item.size)) : 0,
      ...(item.kind === 'image' ? { dataUrl } : { text: text.slice(0, MAX_ATTACHMENT_TEXT_CHARS) }),
      createdAt: Number.isFinite(item.createdAt) ? item.createdAt : Date.now(),
    })
    if (result.length >= MAX_ATTACHMENTS) {
      break
    }
  }
  return result
}

const MAX_TITLE_CHARS = 120
const MAX_SYSTEM_CHARS = 8000

const DEFAULT_PROJECT_TITLE = '新项目'
const DEFAULT_CARD_TITLE = '未命名卡片'

// 全览图的层序布局参数（手机屏更窄，节点尺寸比桌面版小）
const NODE_WIDTH = 160
const NODE_HEIGHT = 84
const GAP_X = 32
const GAP_Y = 56
const LAYOUT_ORIGIN = 24

const isCardMode = (value: unknown): value is CardMode =>
  typeof value === 'string' && (CARD_MODES as string[]).includes(value)

const isRunStatus = (value: unknown): value is RunStatus =>
  typeof value === 'string' && (RUN_STATUSES as string[]).includes(value)

const now = (): number => Date.now()

const makeId = (prefix: 'p' | 'c' | 'f'): string => `${prefix}_${createId().replace(/-/g, '')}`

const replaceCard = (project: Project, cardId: string, card: Card): Project => ({
  ...project,
  cards: project.cards.map((item) => (item.id === cardId ? card : item)),
})

const findCard = (project: Project, id: string | null): Card | null => {
  if (!id) {
    return null
  }
  return project.cards.find((card) => card.id === id) ?? null
}

/** 按 id 取卡片；id 为 null 或不存在时返回 null */
export const cardById = (project: Project, id: string | null): Card | null => findCard(project, id)

/** 某个父卡片下的直接子卡片，保持 project.cards 里的数组顺序（= 兄弟顺序） */
export const childrenOf = (project: Project, parentId: string | null): Card[] =>
  project.cards.filter((card) => card.parentId === parentId)

/** 新建一个空项目（title 为空时用「新项目」） */
export const createProject = (title?: string): Project => {
  const time = now()
  const trimmed = typeof title === 'string' ? title.trim() : ''
  return {
    id: makeId('p'),
    title: trimmed.slice(0, MAX_TITLE_CHARS) || DEFAULT_PROJECT_TITLE,
    system: '',
    cards: [],
    createdAt: time,
    updatedAt: time,
  }
}

/** 改项目标题 / 项目规则；没传的字段保持不变 */
export const updateProject = (
  project: Project,
  patch: { title?: string; system?: string },
): Project => {
  const next: Project = { ...project }
  if (typeof patch.title === 'string') {
    next.title = patch.title.slice(0, MAX_TITLE_CHARS)
  }
  if (typeof patch.system === 'string') {
    next.system = patch.system.slice(0, MAX_SYSTEM_CHARS)
  }
  next.updatedAt = now()
  return next
}

/**
 * 五种模式的生长规则：新卡片的 parentId 从哪里来、要不要复制问题。
 * - isolated：永远独立（parentId = null）
 * - 没有选中卡片：退化成根卡片（桌面版 submit 的行为）
 * - diverge：挂到当前卡的父上（同层新支线），问题由用户新写
 * - branch：挂到当前卡的父上，问题复制当前卡的 prompt（换角度重答）
 * - child（默认）：挂到当前卡下面（深入）
 * - root：显式要一张根卡片
 */
export const growthTarget = (
  project: Project,
  current: Card | null,
  mode: CardMode,
): { parentId: string | null; prompt?: string; mode: CardMode } => {
  if (mode === 'isolated') {
    return { parentId: null, mode: 'isolated' }
  }
  const selected = current && cardById(project, current.id) ? current : null
  if (!selected) {
    return { parentId: null, mode: 'root' }
  }
  if (mode === 'diverge') {
    return { parentId: selected.parentId ?? null, mode: 'diverge' }
  }
  if (mode === 'branch') {
    return { parentId: selected.parentId ?? null, mode: 'branch', prompt: selected.prompt }
  }
  if (mode === 'root') {
    return { parentId: null, mode: 'root' }
  }
  return { parentId: selected.id, mode: 'child' }
}

/**
 * 新建一张卡片。
 * mode 为 root / isolated 时强制 parentId = null；其它模式必须挂在一个存在的父卡片下，
 * 否则抛错（问题为空同样抛错，和桌面版 cardCreate 一致）。
 */
export const createCard = (
  project: Project,
  input: { parentId: string | null; mode: CardMode; prompt: string; attachments?: Attachment[] },
): { project: Project; card: Card } => {
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
  if (!prompt) {
    throw new Error('问题不能为空')
  }
  const mode = isCardMode(input.mode) ? input.mode : input.parentId ? 'child' : 'root'
  const parentId = mode === 'root' || mode === 'isolated' ? null : input.parentId
  if (parentId && !findCard(project, parentId)) {
    throw new Error('父卡片不存在')
  }

  const time = now()
  const card: Card = {
    id: makeId('c'),
    parentId,
    mode,
    prompt,
    answer: '',
    thinking: '',
    status: 'idle',
    error: null,
    stats: null,
    followUps: [],
    attachments: normalizeAttachments(input.attachments),
    search: null,
    refs: [],
    pos: null,
    createdAt: time,
    updatedAt: time,
  }
  return {
    project: { ...project, cards: [...project.cards, card], updatedAt: time },
    card,
  }
}

/**
 * 给卡片加一条追问（不生成新节点）。
 * 卡片不存在 / 正在生成 / 追问为空时抛错，和桌面版 cardFollowCreate 一致。
 */
export const addFollowUp = (
  project: Project,
  cardId: string,
  prompt: string,
  attachments?: Attachment[],
): { project: Project; followUp: FollowUp } => {
  const card = findCard(project, cardId)
  if (!card) {
    throw new Error('卡片不存在')
  }
  if (card.status === 'running') {
    throw new Error('这张卡片正在生成中')
  }
  const text = typeof prompt === 'string' ? prompt.trim() : ''
  if (!text) {
    throw new Error('追问不能为空')
  }

  const time = now()
  const followUp: FollowUp = {
    id: makeId('f'),
    prompt: text,
    answer: '',
    thinking: '',
    status: 'idle',
    error: null,
    stats: null,
    attachments: normalizeAttachments(attachments),
    search: null,
    createdAt: time,
    updatedAt: time,
  }
  const nextCard: Card = {
    ...card,
    followUps: [...card.followUps, followUp],
    updatedAt: time,
  }
  return { project: { ...replaceCard(project, card.id, nextCard), updatedAt: time }, followUp }
}

/**
 * 手动改卡片文字（问题 / 回答）。只改文本，不重新生成、不改状态。
 * 问题为空时抛错，卡片不存在时原样返回。
 */
export const updateCard = (
  project: Project,
  cardId: string,
  patch: { prompt?: string; answer?: string },
): Project => {
  const card = findCard(project, cardId)
  if (!card) {
    return project
  }
  const next: Card = { ...card }
  if (typeof patch.prompt === 'string') {
    const prompt = patch.prompt.trim()
    if (!prompt) {
      throw new Error('问题不能为空')
    }
    next.prompt = prompt
  }
  if (typeof patch.answer === 'string') {
    next.answer = patch.answer
  }
  next.updatedAt = now()
  return { ...replaceCard(project, card.id, next), updatedAt: next.updatedAt }
}

/**
 * 手动改追问文字（问题 / 回答）。只改文本，不重新生成、不改状态。
 * 问题为空时抛错；卡片或追问不存在时原样返回。
 */
export const updateFollowUp = (
  project: Project,
  cardId: string,
  followUpId: string,
  patch: { prompt?: string; answer?: string },
): Project => {
  const card = findCard(project, cardId)
  const followUp = card?.followUps.find((item) => item.id === followUpId)
  if (!card || !followUp) {
    return project
  }
  const next: FollowUp = { ...followUp }
  if (typeof patch.prompt === 'string') {
    const prompt = patch.prompt.trim()
    if (!prompt) {
      throw new Error('问题不能为空')
    }
    next.prompt = prompt
  }
  if (typeof patch.answer === 'string') {
    next.answer = patch.answer
  }
  next.updatedAt = now()
  const nextCard: Card = {
    ...card,
    followUps: card.followUps.map((item) => (item.id === followUpId ? next : item)),
  }
  return { ...replaceCard(project, cardId, nextCard), updatedAt: next.updatedAt }
}

/** 联网搜索结果整理：过滤空来源、限条数、裁剪文本（读存档 / 新建时都用它） */
export const normalizeSearch = (value?: CardSearch | null): CardSearch | null => {
  if (!value || !Array.isArray(value.sources) || value.sources.length === 0) {
    return null
  }
  const sources: CardSearch['sources'] = []
  for (const item of value.sources) {
    if (!item || typeof item.url !== 'string' || !item.url.trim()) {
      continue
    }
    sources.push({
      title: typeof item.title === 'string' ? item.title.slice(0, 300) : '',
      url: item.url.trim(),
      snippet: typeof item.snippet === 'string' ? item.snippet.slice(0, 1200) : '',
      summary: typeof item.summary === 'string' ? item.summary.slice(0, 2000) : '',
      publishedAt:
        typeof item.publishedAt === 'string' && item.publishedAt ? item.publishedAt : null,
    })
    if (sources.length >= MAX_SEARCH_SOURCES) {
      break
    }
  }
  if (sources.length === 0) {
    return null
  }
  return {
    query: typeof value.query === 'string' ? value.query.slice(0, 500) : '',
    sources,
    searchedAt: Number.isFinite(value.searchedAt) ? value.searchedAt : now(),
  }
}

/** 把某次搜索结果写到卡片 / 追问上（生成前先写，模型失败时来源也还在） */
export const setSearch = (
  project: Project,
  cardId: string,
  followUpId: string | null,
  search: CardSearch | null,
): Project => {
  const card = findCard(project, cardId)
  if (!card) {
    return project
  }
  const next = normalizeSearch(search)
  const time = now()
  if (followUpId) {
    if (!card.followUps.some((item) => item.id === followUpId)) {
      return project
    }
    const followUps = card.followUps.map((item) =>
      item.id === followUpId ? { ...item, search: next, updatedAt: time } : item,
    )
    return { ...replaceCard(project, card.id, { ...card, followUps, updatedAt: time }), updatedAt: time }
  }
  return { ...replaceCard(project, card.id, { ...card, search: next, updatedAt: time }), updatedAt: time }
}

/** 运行结果里允许写回的字段 */
export type AnswerPatch = {
  answer?: string
  thinking?: string
  status?: RunStatus
  error?: string | null
  stats?: CardStats | null
  mode?: CardMode
}

type AnswerFields = {
  answer: string
  thinking: string
  status: RunStatus
  error: string | null
  stats: CardStats | null
}

const applyAnswerPatch = <T extends AnswerFields>(target: T, patch: AnswerPatch): T => {
  const next: T = { ...target }
  if (typeof patch.answer === 'string') {
    next.answer = patch.answer
  }
  if (typeof patch.thinking === 'string') {
    next.thinking = patch.thinking
  }
  if (isRunStatus(patch.status)) {
    next.status = patch.status
  }
  if (patch.error !== undefined) {
    next.error = typeof patch.error === 'string' ? patch.error : null
  }
  if (patch.stats !== undefined) {
    next.stats = patch.stats ?? null
  }
  return next
}

/** 写回卡片这一轮的生成结果（流式过程中反复调用，answer 是累计值） */
export const writeAnswer = (project: Project, cardId: string, patch: AnswerPatch): Project => {
  const card = findCard(project, cardId)
  if (!card) {
    return project
  }
  const time = now()
  const next: Card = { ...applyAnswerPatch(card, patch), updatedAt: time }
  if (isCardMode(patch.mode)) {
    next.mode = patch.mode
  }
  return { ...replaceCard(project, card.id, next), updatedAt: time }
}

/** 写回某条追问的生成结果 */
export const writeFollowUp = (
  project: Project,
  cardId: string,
  followUpId: string,
  patch: AnswerPatch,
): Project => {
  const card = findCard(project, cardId)
  if (!card) {
    return project
  }
  const followUp = card.followUps.find((item) => item.id === followUpId)
  if (!followUp) {
    return project
  }
  const time = now()
  const nextFollowUp: FollowUp = { ...applyAnswerPatch(followUp, patch), updatedAt: time }
  const nextCard: Card = {
    ...card,
    followUps: card.followUps.map((item) => (item.id === followUpId ? nextFollowUp : item)),
    updatedAt: time,
  }
  return { ...replaceCard(project, card.id, nextCard), updatedAt: time }
}

/**
 * 删除一张卡片及其整棵子树，并把其它卡片指向这些卡片的引用一并清掉
 * （和桌面版 cardDelete 一致；引用清掉后这些卡不会在上下文里变成死 id）。
 */
export const removeCard = (project: Project, cardId: string): Project => {
  if (!findCard(project, cardId)) {
    return project
  }

  const doomed = new Set<string>([cardId])
  let grew = true
  while (grew) {
    grew = false
    for (const card of project.cards) {
      if (card.parentId && doomed.has(card.parentId) && !doomed.has(card.id)) {
        doomed.add(card.id)
        grew = true
      }
    }
  }

  const time = now()
  const cards = project.cards
    .filter((card) => !doomed.has(card.id))
    .map((card) => {
      const refs = card.refs.filter((refId) => !doomed.has(refId))
      if (refs.length === card.refs.length) {
        return card
      }
      return { ...card, refs, updatedAt: time }
    })
  return { ...project, cards, updatedAt: time }
}

/** 从 cardId 往上走，看 ancestorId 是不是它的祖先（防环用） */
const isDescendant = (project: Project, ancestorId: string, cardId: string): boolean => {
  const byId = new Map<string, Card>(project.cards.map((card) => [card.id, card]))
  const seen = new Set<string>()
  let currentId: string | null = cardId
  let guard = 0
  while (currentId && guard < MAX_CHAIN) {
    if (seen.has(currentId)) {
      break
    }
    seen.add(currentId)
    const card = byId.get(currentId)
    if (!card) {
      break
    }
    if (card.parentId === ancestorId) {
      return true
    }
    currentId = card.parentId
    guard += 1
  }
  return false
}

/**
 * 能不能把卡片挪到 parentId 下面（UI 用来判断是否禁用「改为上级」等入口）。
 * 拒绝：卡片不存在 / 正在生成 / 挂到自己 / 挂到自己的子孙 / 根卡片加父级。
 */
export const canReparent = (
  project: Project,
  cardId: string,
  parentId: string | null,
): boolean => {
  const card = findCard(project, cardId)
  if (!card || card.status === 'running') {
    return false
  }
  if (parentId === card.id) {
    return false
  }
  if (parentId === null) {
    return true
  }
  if (!findCard(project, parentId)) {
    return false
  }
  // 根卡片也可以再挂到别的卡片下面（手机上全览图就是用来改树结构的；
  // 挂上去之后 mode 会变成 child，原来的「根」身份由新的顶层卡片接替）
  if (isDescendant(project, card.id, parentId)) {
    return false
  }
  return true
}

/**
 * 改父级：挂到新父卡片下（mode 变成 child），或摘成根卡片（mode 变成 root）。
 * 非法请求不抛错，原样返回 project（store 可以先用 canReparent 判断并提示）。
 */
export const reparentCard = (
  project: Project,
  cardId: string,
  parentId: string | null,
): Project => {
  if (!canReparent(project, cardId, parentId)) {
    return project
  }
  const card = findCard(project, cardId)
  if (!card || card.parentId === parentId) {
    return project
  }
  const time = now()
  const next: Card = {
    ...card,
    parentId,
    mode: parentId ? 'child' : 'root',
    updatedAt: time,
  }
  return { ...replaceCard(project, card.id, next), updatedAt: time }
}

/**
 * 加一条引用。拒绝自引用 / 目标不存在 / 已达 MAX_REFS；已经连过（任一方向）也算连过，直接返回。
 * 引用是「这张卡在读别卡」，只往 card.refs 里加一条，不写反向。
 */
export const addRef = (project: Project, cardId: string, refId: string): Project => {
  const card = findCard(project, cardId)
  const targetId = typeof refId === 'string' ? refId.trim() : ''
  if (!card || !targetId) {
    return project
  }
  const target = findCard(project, targetId)
  if (!target || target.id === card.id) {
    return project
  }
  if (card.refs.includes(targetId) || target.refs.includes(card.id)) {
    return project
  }
  if (card.refs.length >= MAX_REFS) {
    return project
  }
  const time = now()
  const next: Card = { ...card, refs: [...card.refs, targetId], updatedAt: time }
  return { ...replaceCard(project, card.id, next), updatedAt: time }
}

/**
 * 删一条引用：两个方向一起清（桌面版只清一个方向，会在另一张卡的上下文里留下幽灵引用，
 * 手机版没有理由保留这个不对称）。没有这条引用时原样返回。
 */
export const removeRef = (project: Project, cardId: string, refId: string): Project => {
  const targetId = typeof refId === 'string' ? refId.trim() : ''
  if (!cardId || !targetId || cardId === targetId) {
    return project
  }
  let changed = false
  const time = now()
  const cards = project.cards.map((card) => {
    if (card.id === cardId && card.refs.includes(targetId)) {
      changed = true
      return { ...card, refs: card.refs.filter((id) => id !== targetId), updatedAt: time }
    }
    if (card.id === targetId && card.refs.includes(cardId)) {
      changed = true
      return { ...card, refs: card.refs.filter((id) => id !== cardId), updatedAt: time }
    }
    return card
  })
  if (!changed) {
    return project
  }
  return { ...project, cards, updatedAt: time }
}

/**
 * 简单层序布局，写回每张卡的 pos：x 由层内兄弟下标决定（同层居中），y 由深度决定。
 * 纯展示操作，不改 updatedAt —— 调用方决定要不要把结果存库。
 */
export const layoutCards = (project: Project): Project => {
  const byId = new Map<string, Card>(project.cards.map((card) => [card.id, card]))
  const roots: Card[] = []
  const children = new Map<string, Card[]>()
  for (const card of project.cards) {
    const parentId =
      card.parentId && byId.has(card.parentId) && card.parentId !== card.id ? card.parentId : null
    if (!parentId) {
      roots.push(card)
      continue
    }
    const siblings = children.get(parentId)
    if (siblings) {
      siblings.push(card)
    } else {
      children.set(parentId, [card])
    }
  }

  const ordered: { card: Card; depth: number }[] = []
  const placed = new Set<string>()
  const visit = (card: Card, depth: number): void => {
    if (placed.has(card.id)) {
      return
    }
    placed.add(card.id)
    ordered.push({ card, depth })
    for (const child of children.get(card.id) ?? []) {
      visit(child, depth + 1)
    }
  }
  for (const root of roots) {
    visit(root, 0)
  }
  // 数据损坏成环时这些卡不在任何根下面，当成额外的根，避免它们没有坐标
  for (const card of project.cards) {
    if (!placed.has(card.id)) {
      visit(card, 0)
    }
  }

  const levels = new Map<number, Card[]>()
  for (const entry of ordered) {
    const list = levels.get(entry.depth) ?? []
    list.push(entry.card)
    levels.set(entry.depth, list)
  }
  let widest = 1
  for (const list of levels.values()) {
    widest = Math.max(widest, list.length)
  }

  const positions = new Map<string, { x: number; y: number }>()
  for (const [depth, list] of levels) {
    const offset = ((widest - list.length) * (NODE_WIDTH + GAP_X)) / 2
    list.forEach((card, index) => {
      positions.set(card.id, {
        x: Math.round(LAYOUT_ORIGIN + offset + index * (NODE_WIDTH + GAP_X)),
        y: Math.round(LAYOUT_ORIGIN + depth * (NODE_HEIGHT + GAP_Y)),
      })
    })
  }

  const cards = project.cards.map((card) => {
    const pos = positions.get(card.id)
    return pos ? { ...card, pos } : card
  })
  return { ...project, cards }
}

/** 列表里显示用的标题：问题首行，超过 60 字截断 */
export const describeCard = (card: Card): string => {
  const firstLine = String(card.prompt || '')
    .split('\n')[0]
    .trim()
  if (!firstLine) {
    return DEFAULT_CARD_TITLE
  }
  return firstLine.length > FOLLOW_UP_PREVIEW_CHARS
    ? `${firstLine.slice(0, FOLLOW_UP_PREVIEW_CHARS)}…`
    : firstLine
}

/** 追问在列表里的单行预览 */
export const describeFollowUp = (followUp: FollowUp): string => {
  const firstLine = String(followUp.prompt || '')
    .split('\n')[0]
    .trim()
  if (!firstLine) {
    return '（空追问）'
  }
  return firstLine.length > FOLLOW_UP_PREVIEW_CHARS
    ? `${firstLine.slice(0, FOLLOW_UP_PREVIEW_CHARS)}…`
    : firstLine
}
