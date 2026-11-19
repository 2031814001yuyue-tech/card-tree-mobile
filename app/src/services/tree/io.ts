/**
 * 卡片树的导入 / 导出（手机版）。
 *
 * - exportProjectJson / importProjectJson：手机版自己的备份格式（就是 Project 的 JSON）。
 * - importDesktopState：把桌面插件 ~/.dsh/card-tree/state.json 里的项目迁移过来，
 *   丢弃桌面版才有的 tools / steps / attachments / runId 等字段。
 * - downloadJson：浏览器里触发一次 a[download] 下载。
 *
 * 导入的容错原则和桌面版 index.js 的 normalizeImportedCard / projectImport 一致：
 * 能补的字段补默认值、能丢的脏数据丢掉，实在不像备份才抛「不是有效的卡片树备份」。
 */

import { createId } from '../../utils/id.js'
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_TEXT_CHARS, MAX_REFS, MAX_SEARCH_SOURCES } from './types.js'
import type {
  Attachment,
  Card,
  CardMode,
  CardSearch,
  CardStats,
  FollowUp,
  Project,
  RunStatus,
  SearchSource,
} from './types.js'

const BACKUP_ERROR = '不是有效的卡片树备份'
const DEFAULT_PROJECT_TITLE = '导入的项目'
const MAX_TITLE_CHARS = 120
const MAX_SYSTEM_CHARS = 8000

const CARD_MODES: CardMode[] = ['root', 'child', 'diverge', 'branch', 'isolated']
const RUN_STATUSES: RunStatus[] = ['idle', 'running', 'done', 'partial', 'error']

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asString = (value: unknown): string => (typeof value === 'string' ? value : '')

const makeId = (prefix: 'p' | 'c' | 'f'): string => `${prefix}_${createId().replace(/-/g, '')}`

const isCardMode = (value: unknown): value is CardMode =>
  typeof value === 'string' && (CARD_MODES as string[]).includes(value)

const isRunStatus = (value: unknown): value is RunStatus =>
  typeof value === 'string' && (RUN_STATUSES as string[]).includes(value)

/** 取一个没被占用的 id；原 id 不合法或被占用时新生成，避免同项目里 id 冲突 */
const uniqueId = (value: unknown, prefix: 'p' | 'c' | 'f', used: Set<string>): string => {
  const trimmed = asString(value).trim()
  if (trimmed && !used.has(trimmed)) {
    used.add(trimmed)
    return trimmed
  }
  let id = makeId(prefix)
  while (used.has(id)) {
    id = makeId(prefix)
  }
  used.add(id)
  return id
}

/** 时间戳兼容毫秒数与 ISO 字符串，解析不出来就用兜底值 */
const parseTimestamp = (value: unknown, fallback: number): number => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(value)
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) {
      return fallback
    }
    const numeric = Number(trimmed)
    if (Number.isFinite(numeric)) {
      return Math.round(numeric)
    }
    const parsed = Date.parse(trimmed)
    if (!Number.isNaN(parsed)) {
      return parsed
    }
  }
  return fallback
}

const toCount = (value: unknown): number => {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0
  }
  return Math.floor(numeric)
}

/** 补齐 stats 的每个数值字段；完全不是对象时给 null（界面按「没有统计」处理） */
const sanitizeStats = (value: unknown): CardStats | null => {
  if (!isRecord(value)) {
    return null
  }
  return {
    approxTokens: toCount(value.approxTokens),
    budget: toCount(value.budget),
    foldedCards: toCount(value.foldedCards),
    droppedCards: toCount(value.droppedCards),
    droppedRefs: toCount(value.droppedRefs),
    refs: toCount(value.refs),
  }
}

/** 非法 status 按「有回答算 done，否则 idle」兜底；导入时 running 视为中断（error） */
const normalizeStatus = (value: unknown, answer: string): RunStatus => {
  if (isRunStatus(value)) {
    return value === 'running' ? 'error' : value
  }
  return answer ? 'done' : 'idle'
}

/** 缺省 mode 按有没有父卡片推断；非法 mode 归为 child（和任务约定一致） */
const normalizeMode = (value: unknown, parentId: string | null): CardMode => {
  if (isCardMode(value)) {
    return value
  }
  if (value === undefined || value === null || value === '') {
    return parentId ? 'child' : 'root'
  }
  return 'child'
}

const sanitizePos = (value: unknown): { x: number; y: number } | null => {
  if (!isRecord(value)) {
    return null
  }
  const x = Number(value.x)
  const y = Number(value.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null
  }
  return { x, y }
}

/** refs 只保留非空字符串，卡内去重并截断到 MAX_REFS */
const sanitizeRefs = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return []
  }
  const refs: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') {
      continue
    }
    const id = item.trim()
    if (!id || refs.includes(id)) {
      continue
    }
    if (refs.length >= MAX_REFS) {
      break
    }
    refs.push(id)
  }
  return refs
}

/** 附件清洗：只认 image/text，图片必须是 data:image/*，文本截断；桌面版的 sha256 附件会被丢掉 */
const sanitizeAttachments = (value: unknown, fallbackTime: number): Attachment[] => {
  if (!Array.isArray(value)) {
    return []
  }
  const result: Attachment[] = []
  for (const item of value) {
    if (!isRecord(item)) {
      continue
    }
    const kind = item.kind === 'image' ? 'image' : item.kind === 'text' ? 'text' : null
    if (!kind) {
      continue
    }
    const dataUrl = kind === 'image' ? asString(item.dataUrl) : ''
    const text = kind === 'text' ? asString(item.text) : ''
    if (kind === 'image' && !dataUrl.startsWith('data:image/')) {
      continue
    }
    if (kind === 'text' && !text.trim()) {
      continue
    }
    const size = Number(item.size)
    result.push({
      id: `a_${createId().replace(/-/g, '')}`,
      kind,
      name: (asString(item.name) || (kind === 'image' ? '图片' : '文本')).slice(0, 120),
      mimeType: asString(item.mimeType) || (kind === 'image' ? 'image/jpeg' : 'text/plain'),
      size: Number.isFinite(size) ? Math.max(0, Math.round(size)) : 0,
      ...(kind === 'image' ? { dataUrl } : { text: text.slice(0, MAX_ATTACHMENT_TEXT_CHARS) }),
      createdAt: parseTimestamp(item.createdAt, fallbackTime),
    })
    if (result.length >= MAX_ATTACHMENTS) {
      break
    }
  }
  return result
}

/** 联网搜索来源清洗：没有 url 的条目直接丢掉，文本字段限长，最多 MAX_SEARCH_SOURCES 条 */
const sanitizeSearchSources = (value: unknown): SearchSource[] => {
  if (!Array.isArray(value)) {
    return []
  }
  const sources: SearchSource[] = []
  for (const item of value) {
    if (!isRecord(item)) {
      continue
    }
    const url = asString(item.url).trim()
    if (!url) {
      continue
    }
    sources.push({
      title: asString(item.title).slice(0, 300),
      url,
      snippet: asString(item.snippet).slice(0, 1200),
      summary: asString(item.summary).slice(0, 2000),
      publishedAt: typeof item.publishedAt === 'string' ? item.publishedAt : null,
    })
    if (sources.length >= MAX_SEARCH_SOURCES) {
      break
    }
  }
  return sources
}

/** 卡片/追问上存的那次搜索（导入旧备份时不会有，返回 null） */
const sanitizeSearch = (value: unknown, fallbackTime: number): CardSearch | null => {
  if (!isRecord(value)) {
    return null
  }
  const sources = sanitizeSearchSources(value.sources)
  if (sources.length === 0) {
    return null
  }
  const searchedAt = parseTimestamp(value.searchedAt, fallbackTime)
  return {
    query: asString(value.query).slice(0, 500),
    sources,
    searchedAt,
  }
}

const sanitizeFollowUp = (
  value: unknown,
  now: number,
  usedIds: Set<string>,
): FollowUp | null => {
  if (!isRecord(value)) {
    return null
  }
  const answer = asString(value.answer)
  const createdAt = parseTimestamp(value.createdAt, now)
  return {
    id: uniqueId(value.id, 'f', usedIds),
    prompt: asString(value.prompt),
    answer,
    thinking: asString(value.thinking),
    status: normalizeStatus(value.status, answer),
    error: typeof value.error === 'string' ? value.error : null,
    stats: sanitizeStats(value.stats),
    attachments: sanitizeAttachments(value.attachments, createdAt),
    search: sanitizeSearch(value.search, createdAt),
    createdAt,
    updatedAt: parseTimestamp(value.updatedAt, createdAt),
  }
}

const sanitizeFollowUps = (value: unknown, now: number): FollowUp[] => {
  if (!Array.isArray(value)) {
    return []
  }
  const usedIds = new Set<string>()
  const followUps: FollowUp[] = []
  for (const item of value) {
    const followUp = sanitizeFollowUp(item, now, usedIds)
    if (followUp) {
      followUps.push(followUp)
    }
  }
  return followUps
}

const sanitizeCard = (value: unknown, now: number, usedIds: Set<string>): Card => {
  const raw = isRecord(value) ? value : {}
  const id = uniqueId(raw.id, 'c', usedIds)
  const rawParentId = asString(raw.parentId).trim()
  const parentId = rawParentId && rawParentId !== id ? rawParentId : null
  const answer = asString(raw.answer)
  const createdAt = parseTimestamp(raw.createdAt, now)
  return {
    id,
    parentId,
    mode: normalizeMode(raw.mode, parentId),
    prompt: asString(raw.prompt),
    answer,
    thinking: asString(raw.thinking),
    status: normalizeStatus(raw.status, answer),
    error: typeof raw.error === 'string' ? raw.error : null,
    stats: sanitizeStats(raw.stats),
    followUps: sanitizeFollowUps(raw.followUps, now),
    attachments: sanitizeAttachments(raw.attachments, createdAt),
    search: sanitizeSearch(raw.search, createdAt),
    refs: sanitizeRefs(raw.refs),
    pos: sanitizePos(raw.pos),
    createdAt,
    updatedAt: parseTimestamp(raw.updatedAt, createdAt),
  }
}

/** 悬空 parentId 变 null；根层非 isolated 一律 root；引用里指向已删卡片 / 自己的清掉 */
const repairCards = (cards: Card[]): Card[] => {
  const byId = new Map<string, Card>(cards.map((card) => [card.id, card]))
  return cards.map((card) => {
    const parentId =
      card.parentId && byId.has(card.parentId) && card.parentId !== card.id ? card.parentId : null
    let mode = card.mode
    if (!parentId) {
      mode = card.mode === 'isolated' ? 'isolated' : 'root'
    } else if (mode === 'root' || mode === 'isolated') {
      mode = 'child'
    }
    const refs = card.refs
      .filter((refId) => refId !== card.id && byId.has(refId))
      .slice(0, MAX_REFS)
    const modeChanged = mode !== card.mode
    const parentChanged = parentId !== card.parentId
    const refsChanged =
      refs.length !== card.refs.length || refs.some((refId, index) => refId !== card.refs[index])
    if (!modeChanged && !parentChanged && !refsChanged) {
      return card
    }
    return { ...card, parentId, mode, refs }
  })
}

/** 把一个未知对象整理成合法的 Project（导入视为「刚更新」，updatedAt 用当前时间） */
const sanitizeProject = (
  value: Record<string, unknown>,
  now: number,
  usedProjectIds: Set<string>,
): Project => {
  const createdAt = parseTimestamp(value.createdAt, now)
  const usedCardIds = new Set<string>()
  const rawCards = Array.isArray(value.cards) ? value.cards : []
  const cards = rawCards.map((item) => sanitizeCard(item, now, usedCardIds))
  const title = asString(value.title).trim().slice(0, MAX_TITLE_CHARS)
  return {
    id: uniqueId(value.id, 'p', usedProjectIds),
    title: title || DEFAULT_PROJECT_TITLE,
    system: asString(value.system).slice(0, MAX_SYSTEM_CHARS),
    cards: repairCards(cards),
    createdAt,
    updatedAt: now,
  }
}

const parseJson = (text: string): unknown => {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error(BACKUP_ERROR)
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error(BACKUP_ERROR)
  }
}

/** 把项目导出成格式化 JSON 文本（手机版备份格式） */
export const exportProjectJson = (project: Project): string => JSON.stringify(project, null, 2)

/**
 * 把全部项目导出成桌面插件 state.json 同构的格式：
 * `{ version, revision, savedAt, activeProjectId, sessions, model, projects }`。
 * 手机的「导入备份」按 projects 数组读回；桌面版理论上可以拿它整体替换
 * state.json（字段命名一致，但没在桌面端实测过，见 README 的说明）。
 */
export const exportAllProjectsJson = (projects: Project[], activeProjectId: string | null): string =>
  JSON.stringify(
    {
      version: 1,
      revision: 0,
      savedAt: new Date().toISOString(),
      activeProjectId,
      sessions: {},
      model: {},
      projects,
    },
    null,
    2,
  )

/**
 * 解析手机版备份。接受 Project 本身，也接受 `{ project: Project }` 这种包装。
 * 不是合法备份时抛 `Error('不是有效的卡片树备份')`。
 */
export const importProjectJson = (text: string): Project => {
  const parsed = parseJson(text)
  const candidate = isRecord(parsed) && isRecord(parsed.project) ? parsed.project : parsed
  if (!isRecord(candidate) || !Array.isArray(candidate.cards)) {
    throw new Error(BACKUP_ERROR)
  }
  return sanitizeProject(candidate, Date.now(), new Set<string>())
}

/**
 * 解析桌面插件 state.json（`{ projects: [...] }`），逐个映射成手机版 Project。
 * 只取项目 / 卡片 / 追问本身，丢掉 sessions、model、tools、steps、attachments 等。
 * 结构不对时抛 `Error('不是有效的卡片树备份')`。
 */
export const importDesktopState = (text: string): Project[] => {
  const parsed = parseJson(text)
  if (!isRecord(parsed) || !Array.isArray(parsed.projects)) {
    throw new Error(BACKUP_ERROR)
  }
  const now = Date.now()
  const usedProjectIds = new Set<string>()
  const projects: Project[] = []
  for (const item of parsed.projects) {
    if (!isRecord(item)) {
      continue
    }
    projects.push(sanitizeProject(item, now, usedProjectIds))
  }
  return projects
}

/** 浏览器里下载一段文本（文件名没带 .json 时自动补上） */
export const downloadJson = (filename: string, text: string): void => {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof Blob === 'undefined') {
    return
  }
  const name = /\.json$/i.test(filename) ? filename : `${filename}.json`
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  if (document.body) {
    document.body.appendChild(anchor)
  }
  anchor.click()
  anchor.remove()
  setTimeout(() => {
    URL.revokeObjectURL(url)
  }, 0)
}
