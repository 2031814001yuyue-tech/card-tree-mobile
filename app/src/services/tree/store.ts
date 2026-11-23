/**
 * 卡片树的运行时状态：项目、卡片、正在生成的回答，以及所有动作。
 *
 * 设计要点：
 * - 树本身是纯数据（services/tree/model.ts），这里只负责「怎么变、什么时候存、什么时候调模型」。
 * - 流式文本放在 `live` 里，不写进卡片；一轮结束才一次性落到卡片上并落库，
 *   这样中途退出也不会留下半截 running 状态（hydrate 时还会把 running 收成 partial）。
 * - 所有网络请求都经过 `/api/*` 中继，API Key 在电脑上。
 */

import { create } from 'zustand'
import { showToast } from '../../components/base/toastState.js'
import { fetchModels, normalizeApiBase, streamChat } from '../api/chat.js'
import { streamNativeSearchChat } from '../api/anthropic.js'
import { ApiError } from '../api/types.js'
import type { ChatMessage, ChatToolCall, ModelInfo } from '../api/types.js'
import { isNativeApp, saveNativeAutoBackup, saveNativeBackup } from '../native.js'
import { WEB_SEARCH_TOOL, formatToolResult, parseSearchQuery, searchWeb } from '../search.js'
import { useSettings } from '../settings.js'
import {
  FALLBACK_CONTEXT_WINDOW,
  buildMessages,
  buildSearchQuery,
  buildSystem,
  contextBudget,
  estimateAttachmentTokens,
  estimateTokens,
  searchBlock,
} from './context.js'
import * as db from './db.js'
import { downloadJson, exportAllProjectsJson, exportProjectJson, importDesktopState, importProjectJson } from './io.js'
import * as model from './model.js'
import { runKey } from './live.js'
import type { LiveText } from './live.js'
import type { Attachment, CardSearch, CardStats, Project, SearchSource } from './types.js'
import { MAX_SEARCH_SOURCES } from './types.js'

/** 卡片详情页底部输入框能选的四种生长方式（follow 不开新节点） */
export type AskMode = 'follow' | 'child' | 'diverge' | 'isolated'

/** 一次生成的可选开关：这次要不要先联网搜一下 */
export type RunOptions = { search?: boolean }

export type View = 'tree' | 'card'

type RunTarget = {
  /** 这一轮属于哪个项目：切走项目后它仍然写回自己那个项目 */
  projectId: string
  cardId: string
  followUpId: string | null
}

/**
 * 同时最多跑几轮：一张卡正在「深入」回答时，还可以从它长出新枝、追问别的，
 * 但别让手机一次接十来个流把内存和额度都吃掉。
 */
const MAX_CONCURRENT_RUNS = 3

/**
 * 网页版的完成通知（APK 里不发：Java 本地服务会在后台直接发系统通知，比网页层可靠）。
 * 只在页面不可见且浏览器通知已授权时发；没授权 / 不支持就静默跳过。
 */
const notifyAnswerDone = (question: string) => {
  if (isNativeApp() || typeof document === 'undefined' || document.visibilityState !== 'hidden') {
    return
  }
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
    return
  }
  try {
    const brief = question.length > 36 ? `${question.slice(0, 36)}…` : question
    new Notification('卡片树 · 回答完成', { body: `「${brief}」回答完了，回来看看`, tag: 'card-tree-answer' })
  } catch {
    // 个别浏览器构造 Notification 会抛（策略/上下文变化）：忽略
  }
}

/**
 * 联网搜索「工具循环」的限度：最多让模型连续搜 2 轮（每轮最多 2 次搜索），
 * 避免模型反复搜不停把时间/额度耗光。第三轮起只让它直接回答。
 */
const MAX_TOOL_ROUNDS = 2

/** 有些订阅（或模型的某些版本）没有 function calling：按「订阅 id」记住，别再试 */
const TOOL_LESS_KEY = 'card-tree:tool-less'

const readToolLess = (): string[] => {
  try {
    const raw = localStorage.getItem(TOOL_LESS_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

const markToolLess = (provider: string) => {
  try {
    const list = readToolLess()
    if (!list.includes(provider)) {
      localStorage.setItem(TOOL_LESS_KEY, JSON.stringify([...list, provider]))
    }
  } catch {
    // 存不进去也无所谓：下次再试一次工具而已
  }
}

/** 上游明确拒绝工具调用（400/422 且提到 tool/function）时算「这家不支持工具」 */
const isToolRejection = (error: unknown): boolean => {
  if (!(error instanceof ApiError)) {
    return false
  }
  const status = error.status ?? 0
  return (status === 400 || status === 404 || status === 422) && /tool|function/i.test(error.message)
}

export type Store = {
  ready: boolean
  projects: Project[]
  activeProjectId: string | null
  view: View
  activeCardId: string | null
  /** 正在流式输出的文本（不落库），按「轮次」分开存：可以同时有好几轮在跑 */
  live: Record<string, LiveText>
  /** 正在跑的那些轮次，键是 live 里的同一个 key */
  running: Record<string, RunTarget>
  models: ModelInfo[]
  modelsLoading: boolean
  modelsError: string | null
  /** 上游返回 401：API Key 没了/失效，App 会弹一次填 Key 的引导 */
  authRequired: boolean

  hydrate: () => Promise<void>
  loadModels: () => Promise<void>
  clearAuthRequired: () => void

  selectProject: (projectId: string) => void
  createProject: () => void
  renameProject: (projectId: string, title: string) => void
  setProjectSystem: (projectId: string, system: string) => void
  deleteProject: (projectId: string) => void

  openCard: (cardId: string) => void
  backToTree: () => void

  askRoot: (text: string, attachments?: Attachment[], options?: RunOptions) => void
  ask: (text: string, mode: AskMode, attachments?: Attachment[], options?: RunOptions) => void
  branch: (cardId: string) => void
  retry: (cardId: string) => void
  /** partial 卡片：把已生成的文本带进上下文，让模型接着往下写 */
  continueCard: (cardId: string) => void
  /** partial 追问：把已生成的文本带进上下文，让模型接着往下写 */
  continueFollowUp: (cardId: string, followUpId: string) => void
  /**
   * 停止生成：给定卡片（和追问）就只停那一轮的，不给就停全部。
   * 一张卡可以同时跑「主回答」和若干条追问，所以不能只按卡片停。
   */
  stop: (cardId?: string, followUpId?: string | null) => void

  deleteCard: (cardId: string) => void
  /** 手动改卡片的问题 / 回答文字，不重新生成 */
  editCard: (cardId: string, patch: { prompt?: string; answer?: string }) => void
  /** 手动改追问的问题 / 回答文字，不重新生成 */
  editFollowUp: (
    cardId: string,
    followUpId: string,
    patch: { prompt?: string; answer?: string },
  ) => void
  addRef: (cardId: string, refId: string) => void
  removeRef: (cardId: string, refId: string) => void
  /** 全览图拖动：改父级（parentId=null 表示摘成根卡片），返回是否真的改了 */
  reparent: (cardId: string, parentId: string | null) => boolean
  /** 全览图拉线：加一条引用，返回是否真的加了 */
  refLink: (cardId: string, refId: string) => boolean
  /** 合并：把 sourceId 并入 targetId（源卡删除，追问/子卡/引用都转过去），返回是否真的并了 */
  mergeCard: (sourceId: string, targetId: string) => boolean
  layout: () => void

  exportActive: () => void
  /** 导出全部项目：桌面 state.json 同构格式（手机「导入备份」能读回） */
  exportAll: () => void
  importFile: (text: string) => number
  clearAll: () => Promise<void>
  /** 把全部项目写一份滚动备份（仅 APK；返回落点描述，网页版返回 null） */
  backupNow: () => string | null
}

/** 自动备份的格式与桌面 state.json 的 projects 数组兼容，可以直接用「导入备份」读回来 */
export const BACKUP_LAST_KEY = 'card-tree:last-backup'

const emptyStats = (): CardStats => ({
  approxTokens: 0,
  budget: 0,
  foldedCards: 0,
  droppedCards: 0,
  droppedRefs: 0,
  refs: 0,
})

const activeProject = (state: Store): Project | null =>
  state.projects.find((project) => project.id === state.activeProjectId) ?? null

const replaceProject = (projects: Project[], next: Project): Project[] =>
  projects.map((project) => (project.id === next.id ? next : project))

/** 上次关掉页面时还在生成的卡片，统一收成「已中断」，避免下次进来一直转圈 */
const normalizeProject = (project: Project): Project => {
  let changed = false
  const cards = project.cards.map((card) => {
    const followUps = card.followUps.map((followUp) => {
      if (followUp.status !== 'running') {
        return followUp
      }
      changed = true
      return { ...followUp, status: 'partial' as const }
    })
    if (card.status !== 'running') {
      return followUps === card.followUps ? card : { ...card, followUps }
    }
    changed = true
    return {
      ...card,
      followUps,
      status: card.answer ? ('partial' as const) : ('idle' as const),
    }
  })
  return changed ? { ...project, cards } : project
}

/** 每一轮生成都有自己的 AbortController，键和 live/running 一致 */
const controllers = new Map<string, AbortController>()

export const useStore = create<Store>((set, get) => {
  /** 改动当前项目：更新内存 + 落库 */
  const commit = (fn: (project: Project) => Project): Project | null => {
    const state = get()
    const project = activeProject(state)
    if (!project) {
      return null
    }
    const next = fn(project)
    set({ projects: replaceProject(state.projects, next) })
    void db.saveProject(next).catch(() => {
      showToast('保存失败：浏览器存储可能已满')
    })
    return next
  }

  /**
   * 改动指定项目：一轮生成可能在你切走项目之后才结束，
   * 它必须写回自己那个项目，不能用「当前项目」。
   */
  const commitProject = (projectId: string, fn: (project: Project) => Project): Project | null => {
    const state = get()
    const project = state.projects.find((item) => item.id === projectId)
    if (!project) {
      return null
    }
    const next = fn(project)
    set({ projects: replaceProject(state.projects, next) })
    void db.saveProject(next).catch(() => {
      showToast('保存失败：浏览器存储可能已满')
    })
    return next
  }

  /** 只更新某一轮的流式文本，不动其它正在跑的轮次 */
  const patchLive = (key: string, patch: Partial<Omit<LiveText, 'cardId' | 'followUpId'>>) => {
    set((state) => {
      const current = state.live[key]
      if (!current) {
        return {}
      }
      return { live: { ...state.live, [key]: { ...current, ...patch } } }
    })
  }

  /** 从「按轮次分存」的 map 里去掉一轮 */
  const withoutKey = <T,>(map: Record<string, T>, key: string): Record<string, T> =>
    Object.fromEntries(Object.entries(map).filter(([itemKey]) => itemKey !== key))

  const finish = (target: RunTarget, patch: Parameters<typeof model.writeAnswer>[2]) => {
    const key = runKey(target.cardId, target.followUpId)
    controllers.delete(key)
    set((state) => {
      const project = state.projects.find((item) => item.id === target.projectId)
      if (!project) {
        return {}
      }
      const next = target.followUpId
        ? model.writeFollowUp(project, target.cardId, target.followUpId, patch)
        : model.writeAnswer(project, target.cardId, patch)
      void db.saveProject(next).catch(() => {
        showToast('保存失败：浏览器存储可能已满')
      })
      return {
        projects: replaceProject(state.projects, next),
        live: withoutKey(state.live, key),
        running: withoutKey(state.running, key),
      }
    })
  }

  const run = async (
    cardId: string,
    followUpId: string | null,
    options?: { continueFrom?: string; search?: boolean },
  ) => {
    const state = get()
    const project = activeProject(state)
    if (!project) {
      return
    }
    const key = runKey(cardId, followUpId)
    // 同一轮重复触发（双击「重答」之类）：已经在跑就别再开一条
    if (state.running[key]) {
      return
    }
    if (Object.keys(state.running).length >= MAX_CONCURRENT_RUNS) {
      showToast(`同时最多 ${MAX_CONCURRENT_RUNS} 个回答在生成，等一个完成再问`)
      return
    }
    const card = model.cardById(project, cardId)
    if (!card) {
      return
    }
    const followUp = followUpId ? card.followUps.find((item) => item.id === followUpId) ?? null : null
    if (followUpId && !followUp) {
      return
    }

    const settings = useSettings.getState()
    const question = String(followUp ? followUp.prompt : card.prompt).trim()

    // 联网搜索分三种，机制不一样：
    // - DeepSeek 官方订阅 = 原生模式：走 Anthropic 协议 + web_search 服务端工具，
    //   模型自己决定搜什么、搜几轮，搜索穿插在流式回答里（和 DeepSeek 手机端同款）；
    //   来源在流里收集，结束后写到卡片上。
    // - 其它订阅 = 工具循环：带上 web_search 工具问一次，模型先吐 tool_calls，
    //   App 调 Search API 再把结果作为 tool 消息塞回去，模型基于结果继续回答（最多两轮）。
    // - 不支持工具的订阅 = 退回前置搜索：先把问题补全成搜索词搜一次，摘要拼进上下文再问。
    const nativeSearch =
      options?.search === true && question.length > 0 && settings.provider === 'deepseek'
    const searchEnabled = options?.search === true && question.length > 0
    const priorSearch = (followUp ? followUp.search : card.search) ?? null
    // 不联网时沿用上次搜到的来源；联网时由这一轮自己决定（工具循环/原生搜索都不拼旧摘要）
    let searchResult: CardSearch | null = nativeSearch || searchEnabled ? null : priorSearch

    const system = buildSystem(project, card, { followUp })
    const attachments = (followUp ? followUp.attachments : card.attachments) ?? []
    // 上下文预算按「当前模型真实声明的窗口」算（/models 的 limit.context）；
    // 查不到（比如原生联网搜索用 Anthropic 端点的 deepseek-chat，不在 OpenAI 模型表里）
    // 时：原生模式用 64K 保守值，其余退回 32K 兜底。
    const currentModels = get().models
    const contextWindow =
      currentModels.find((item) => item.id === settings.model)?.contextWindow ??
      (nativeSearch ? 64_000 : FALLBACK_CONTEXT_WINDOW)
    const budget = Math.max(
      1200,
      contextBudget(contextWindow, estimateTokens(system)) -
        estimateAttachmentTokens(attachments) -
        estimateTokens(searchBlock(searchResult)),
    )
    const stats = emptyStats()
    const messages = buildMessages(project, card, {
      budget,
      system,
      followUp: followUp ?? undefined,
      stats,
      attachments,
      search: searchResult,
    })
    /** 「继续生成」时把已写出的半截回答作为 assistant 消息带回去，让模型接着写 */
    const prefix = options?.continueFrom ?? ''
    const requestMessages: ChatMessage[] = prefix
      ? [
          ...messages,
          { role: 'assistant', content: prefix },
          {
            role: 'user',
            content:
              '【继续生成】你上一次的回答写到一半被中断了。请从中断处直接接着写，不要重复上面已经写出的内容，不要写「接上文」「继续」之类的说明，也不要重新回答整张卡片的问题。',
          },
        ]
      : messages

    const projectId = project.id
    const controller = new AbortController()
    controllers.set(key, controller)
    const signal = controller.signal
    const target: RunTarget = { projectId, cardId, followUpId }
    // 原生模式先亮「正在搜索…」，等模型吐第一段正文才熄灭
    set((current) => ({
      running: { ...current.running, [key]: target },
      live: {
        ...current.live,
        [key]: {
          cardId,
          followUpId,
          answer: prefix,
          thinking: '',
          ...(nativeSearch ? { searching: true } : {}),
        },
      },
    }))

    let answer = ''
    let thinking = ''
    let failure: unknown = null
    const finalAnswer = () => prefix + answer
    const nativeSources: SearchSource[] = []
    // 流式期间每 3 秒把已生成的文字快照落库：App 退到后台被系统杀掉（或网页被冻结）
    // 后重启，卡片已带着大半回答，normalizeProject 会把 running 收敛成「已中断」（partial），
    // 直接点「继续生成」接着写，不至于整段丢失。
    const snapshotTimer = setInterval(() => {
      const snapshotAnswer = finalAnswer()
      if (!snapshotAnswer && !thinking) {
        return
      }
      commitProject(projectId, (current) =>
        followUpId
          ? model.writeFollowUp(current, cardId, followUpId, { answer: snapshotAnswer, thinking })
          : model.writeAnswer(current, cardId, { answer: snapshotAnswer, thinking }),
      )
    }, 3000)
    try {
      if (nativeSearch) {
        for await (const event of streamNativeSearchChat(
          normalizeApiBase(settings.apiBase),
          {
            // Anthropic 端点只认 deepseek-chat / deepseek-reasoner
            model: 'deepseek-chat',
            system,
            messages: requestMessages,
            signal,
          },
          {
            onSearching: () => {
              patchLive(key, { answer: finalAnswer(), thinking, searching: true })
            },
            onSources: (sources) => {
              for (const source of sources) {
                if (!nativeSources.some((item) => item.url === source.url)) {
                  nativeSources.push(source)
                }
              }
            },
          },
        )) {
          if (event.type === 'text') {
            answer = event.text
          } else if (event.type === 'thinking') {
            thinking = event.text
          }
          if (event.type === 'text' || event.type === 'thinking') {
            patchLive(key, {
              answer: finalAnswer(),
              thinking,
              searching: false,
              searchingQuery: undefined,
            })
          }
        }
      } else {
        const base = normalizeApiBase(settings.apiBase)
        const provider = settings.provider ?? 'opencode'
        // 这家订阅是否还用工具调用：试过一次被上游明确拒绝就记住，之后直接走前置搜索
        let toolMode = searchEnabled && !readToolLess().includes(provider)
        const toolSources: SearchSource[] = []
        const toolQueries: string[] = []
        const collectSources = (list: SearchSource[]) => {
          for (const source of list) {
            if (!toolSources.some((item) => item.url === source.url)) {
              toolSources.push(source)
            }
          }
        }
        /** 跑一轮：这一轮的正文/思考写进 live，返回模型这轮想调的工具 */
        const runRound = async (
          roundMessages: ChatMessage[],
          withTools: boolean,
        ): Promise<{ text: string; calls: ChatToolCall[] }> => {
          let roundText = ''
          let roundThinking = ''
          let calls: ChatToolCall[] = []
          for await (const event of streamChat(base, {
            provider: settings.provider,
            model: settings.model,
            reasoningEffort: settings.reasoningEffort,
            messages: roundMessages,
            signal,
            ...(withTools ? { tools: [WEB_SEARCH_TOOL] } : {}),
          })) {
            if (event.type === 'text') {
              roundText = event.text
            } else if (event.type === 'thinking') {
              roundThinking = event.text
            } else if (event.type === 'toolCalls') {
              calls = event.calls
            }
            if (event.type === 'text' || event.type === 'thinking') {
              answer = roundText
              thinking = roundThinking
              patchLive(key, {
                answer: finalAnswer(),
                thinking,
                searching: false,
                searchingQuery: undefined,
              })
            }
          }
          answer = roundText
          thinking = roundThinking
          return { text: roundText, calls }
        }
        const roundMessages: ChatMessage[] = [...requestMessages]
        let rounds = 0
        try {
          for (;;) {
            const round = await runRound(roundMessages, toolMode)
            if (!toolMode || round.calls.length === 0 || rounds >= MAX_TOOL_ROUNDS) {
              break
            }
            const toolMessages: ChatMessage[] = []
            for (const call of round.calls.slice(0, 2)) {
              const query =
                parseSearchQuery(call.function.arguments) ||
                buildSearchQuery(project, card, followUp, question)
              toolQueries.push(query)
              // 模型自己要搜：先亮「正在搜索「…」」，搜完再让它接着写
              patchLive(key, {
                answer: finalAnswer(),
                thinking,
                searching: true,
                searchingQuery: query,
              })
              try {
                const outcome = await searchWeb(base, query, { oriQuestion: question })
                collectSources(outcome.sources)
                toolMessages.push({
                  role: 'tool',
                  tool_call_id: call.id,
                  content: formatToolResult(outcome.query, outcome.sources),
                })
              } catch (error) {
                toolMessages.push({
                  role: 'tool',
                  tool_call_id: call.id,
                  content: `搜索「${query}」失败了：${error instanceof Error ? error.message : '未知错误'}。可以换个搜索词再搜一次，或者直接基于已有信息回答。`,
                })
              }
            }
            roundMessages.push(
              { role: 'assistant', content: round.text || null, tool_calls: round.calls },
              ...toolMessages,
            )
            rounds += 1
            patchLive(key, { answer: '', thinking: '', searching: true, searchingQuery: undefined })
          }
        } catch (error) {
          if (!toolMode || !isToolRejection(error)) {
            throw error
          }
          // 这家订阅不认工具调用：记住它，退回「先搜一次、把结果拼进上下文再问」
          markToolLess(provider)
          toolMode = false
          const fallbackQuery = buildSearchQuery(project, card, followUp, question)
          patchLive(key, { answer: '', thinking: '', searching: true, searchingQuery: fallbackQuery })
          try {
            const outcome = await searchWeb(base, fallbackQuery, { oriQuestion: question })
            collectSources(outcome.sources)
            toolQueries.push(outcome.query)
            roundMessages.push({
              role: 'user',
              content: `${formatToolResult(outcome.query, outcome.sources)}\n\n请基于上面的搜索结果回答最后这个问题。`,
            })
          } catch (searchError) {
            showToast(
              searchError instanceof ApiError
                ? `联网搜索失败：${searchError.message}`
                : '联网搜索失败，这次先按不联网回答',
            )
          }
          await runRound(roundMessages, false)
        }
        if (toolSources.length > 0) {
          searchResult = {
            query: toolQueries[toolQueries.length - 1] ?? question,
            sources: toolSources.slice(0, MAX_SEARCH_SOURCES),
            searchedAt: Date.now(),
          }
          commitProject(projectId, (current) => model.setSearch(current, cardId, followUpId, searchResult))
        }
      }
    } catch (error) {
      failure = error
    }
    clearInterval(snapshotTimer)

    // 原生模式：把这一轮流里搜到的来源写到卡片上（结束时一次写，流中不抢渲染）
    if (nativeSearch && nativeSources.length > 0) {
      const nativeSearchResult: CardSearch = {
        query: question,
        sources: nativeSources.slice(0, MAX_SEARCH_SOURCES),
        searchedAt: Date.now(),
      }
      commitProject(projectId, (current) => model.setSearch(current, cardId, followUpId, nativeSearchResult))
    }

    if (signal.aborted) {
      finish(target, {
        answer: finalAnswer() || followUp?.answer || card.answer,
        thinking: thinking || followUp?.thinking || card.thinking,
        status: answer ? 'partial' : card.answer ? 'partial' : 'idle',
        error: null,
        stats,
      })
      return
    }
    if (!failure) {
      finish(target, { answer: finalAnswer(), thinking, status: 'done', error: null, stats })
      notifyAnswerDone(question)
      return
    }
    const aborted = failure instanceof ApiError && failure.kind === 'interrupted'
    if (aborted) {
      finish(target, {
        answer: finalAnswer() || followUp?.answer || card.answer,
        thinking,
        status: 'partial',
        error: null,
        stats,
      })
      return
    }
    const message = failure instanceof Error ? failure.message : '生成失败，请重试'
    finish(target, {
      answer: finalAnswer(),
      thinking,
      status: 'error',
      error: message,
      stats,
    })
  }

  return {
    ready: false,
    projects: [],
    activeProjectId: null,
    view: 'tree',
    activeCardId: null,
    live: {},
    running: {},
    models: [],
    modelsLoading: false,
    modelsError: null,
    authRequired: false,

    hydrate: async () => {
      if (get().ready) {
        return
      }
      const stored = (await db.loadAllProjects()).map(normalizeProject)
      let activeId = await db.loadActiveProjectId()

      if (!stored.length) {
        const project = model.createProject()
        set({ ready: true, projects: [project], activeProjectId: project.id })
        await db.saveProject(project)
        await db.saveActiveProjectId(project.id)
      } else {
        const active = stored.find((project) => project.id === activeId) ?? stored[0]
        activeId = active.id
        set({ ready: true, projects: stored, activeProjectId: active.id })
        await db.saveActiveProjectId(active.id)
      }
      void get().loadModels()
    },

    loadModels: async () => {
      set({ modelsLoading: true, modelsError: null })
      try {
        const settings = useSettings.getState()
        const models = await fetchModels(normalizeApiBase(settings.apiBase), settings.provider)
        set({ models, modelsLoading: false })
      } catch (error) {
        const isAuth = error instanceof ApiError && (error.status === 401 || error.kind === 'auth')
        set({
          modelsLoading: false,
          modelsError: isAuth
            ? '当前订阅的 API Key 无效或缺失：APK 里到「设置 → 连接」重新粘贴；网页版请检查电脑中继里这家的 API Key 后重启'
            : error instanceof Error
              ? error.message
              : '获取模型列表失败',
          authRequired: isAuth,
        })
      }
    },

    clearAuthRequired: () => set({ authRequired: false }),

    selectProject: (projectId) => {
      const state = get()
      if (!state.projects.some((project) => project.id === projectId)) {
        return
      }
      // 别的项目里还在跑的回答不受影响：它们按 projectId 写回自己那个项目
      set({ activeProjectId: projectId, view: 'tree', activeCardId: null })
      void db.saveActiveProjectId(projectId)
    },

    createProject: () => {
      const state = get()
      const project = model.createProject()
      set({
        projects: [project, ...state.projects],
        activeProjectId: project.id,
        view: 'tree',
        activeCardId: null,
      })
      void db.saveProject(project)
      void db.saveActiveProjectId(project.id)
    },

    renameProject: (projectId, title) => {
      const trimmed = title.trim()
      if (!trimmed) {
        return
      }
      const state = get()
      const project = state.projects.find((item) => item.id === projectId)
      if (!project) {
        return
      }
      const next = model.updateProject(project, { title: trimmed })
      set({ projects: replaceProject(state.projects, next) })
      void db.saveProject(next).catch(() => {
        showToast('保存失败：浏览器存储可能已满')
      })
    },

    setProjectSystem: (projectId, system) => {
      const state = get()
      const project = state.projects.find((item) => item.id === projectId)
      if (!project) {
        return
      }
      const next = model.updateProject(project, { system })
      set({ projects: replaceProject(state.projects, next) })
      void db.saveProject(next).catch(() => {
        showToast('保存失败：浏览器存储可能已满')
      })
    },

    deleteProject: (projectId) => {
      const state = get()
      // 这个项目里正在跑的轮次先停掉：否则它们结束时会写回一个已经不存在的项目
      for (const [key, target] of Object.entries(state.running)) {
        if (target.projectId === projectId) {
          controllers.get(key)?.abort()
        }
      }
      const rest = state.projects.filter((project) => project.id !== projectId)
      void db.deleteProject(projectId)
      if (!rest.length) {
        const project = model.createProject()
        set({ projects: [project], activeProjectId: project.id, view: 'tree', activeCardId: null })
        void db.saveProject(project)
        void db.saveActiveProjectId(project.id)
        return
      }
      const stillActive = state.activeProjectId === projectId
      set({
        projects: rest,
        activeProjectId: stillActive ? rest[0].id : state.activeProjectId,
        view: stillActive ? 'tree' : state.view,
        activeCardId: stillActive ? null : state.activeCardId,
      })
      if (stillActive) {
        void db.saveActiveProjectId(rest[0].id)
      }
    },

    openCard: (cardId) => {
      const project = activeProject(get())
      if (!project || !model.cardById(project, cardId)) {
        return
      }
      set({ view: 'card', activeCardId: cardId })
    },

    backToTree: () => set({ view: 'tree', activeCardId: null }),

    askRoot: (text, attachments, options) => {
      const state = get()
      const project = activeProject(state)
      const prompt = text.trim()
      if (!project || !prompt) {
        return
      }
      const mode = project.cards.length ? ('isolated' as const) : ('root' as const)
      const { project: next, card } = model.createCard(project, {
        parentId: null,
        mode,
        prompt,
        attachments,
      })
      set({
        projects: replaceProject(state.projects, next),
        view: 'card',
        activeCardId: card.id,
      })
      void db.saveProject(next)
      void run(card.id, null, options)
    },

    ask: (text, mode, attachments, options) => {
      const state = get()
      const project = activeProject(state)
      const cardId = state.activeCardId
      const prompt = text.trim()
      if (!project || !cardId || !prompt) {
        return
      }
      const card = model.cardById(project, cardId)
      if (!card) {
        return
      }

      if (mode === 'follow') {
        const { project: next, followUp } = model.addFollowUp(project, cardId, prompt, attachments)
        set({ projects: replaceProject(state.projects, next) })
        void db.saveProject(next)
        void run(cardId, followUp.id, options)
        return
      }

      const target = model.growthTarget(project, card, mode)
      const { project: next, card: created } = model.createCard(project, {
        parentId: target.parentId,
        mode: target.mode,
        prompt,
        attachments,
      })
      set({
        projects: replaceProject(state.projects, next),
        view: 'card',
        activeCardId: created.id,
      })
      void db.saveProject(next)
      void run(created.id, null, options)
    },

    branch: (cardId) => {
      const state = get()
      const project = activeProject(state)
      if (!project) {
        return
      }
      const card = model.cardById(project, cardId)
      if (!card) {
        return
      }
      const target = model.growthTarget(project, card, 'branch')
      const { project: next, card: created } = model.createCard(project, {
        parentId: target.parentId,
        mode: 'branch',
        prompt: card.prompt,
      })
      set({
        projects: replaceProject(state.projects, next),
        view: 'card',
        activeCardId: created.id,
      })
      void db.saveProject(next)
      void run(created.id, null)
    },

    retry: (cardId) => {
      const state = get()
      const project = activeProject(state)
      if (!project) {
        return
      }
      const card = model.cardById(project, cardId)
      if (!card) {
        return
      }
      void run(cardId, null)
    },

    continueCard: (cardId) => {
      const state = get()
      const project = activeProject(state)
      if (!project) {
        return
      }
      const card = model.cardById(project, cardId)
      if (!card || card.status !== 'partial' || !card.answer.trim()) {
        return
      }
      void run(cardId, null, { continueFrom: card.answer })
    },

    continueFollowUp: (cardId, followUpId) => {
      const state = get()
      const project = activeProject(state)
      if (!project) {
        return
      }
      const card = model.cardById(project, cardId)
      const followUp = card?.followUps.find((item) => item.id === followUpId) ?? null
      if (!followUp || followUp.status !== 'partial' || !followUp.answer.trim()) {
        return
      }
      void run(cardId, followUpId, { continueFrom: followUp.answer })
    },

    stop: (cardId, followUpId) => {
      if (cardId === undefined) {
        // 不给目标：停掉所有正在跑的轮次
        for (const item of controllers.values()) {
          item.abort()
        }
        return
      }
      if (followUpId === undefined) {
        // 只给卡片：停这张卡的主回答 + 它所有追问的回答
        for (const [key, target] of Object.entries(get().running)) {
          if (target.cardId === cardId) {
            controllers.get(key)?.abort()
          }
        }
        return
      }
      controllers.get(runKey(cardId, followUpId))?.abort()
    },

    deleteCard: (cardId) => {
      const state = get()
      // 这张卡上正在跑的轮次（主回答 / 追问）先停掉，别让它们写回已经删掉的卡
      for (const [key, target] of Object.entries(state.running)) {
        if (target.cardId === cardId) {
          controllers.get(key)?.abort()
        }
      }
      const next = commit((project) => model.removeCard(project, cardId))
      if (!next) {
        return
      }
      if (state.activeCardId === cardId) {
        set({ view: 'tree', activeCardId: null })
      }
    },

    editCard: (cardId, patch) => {
      commit((project) => model.updateCard(project, cardId, patch))
    },

    editFollowUp: (cardId, followUpId, patch) => {
      commit((project) => model.updateFollowUp(project, cardId, followUpId, patch))
    },

    addRef: (cardId, refId) => {
      commit((project) => model.addRef(project, cardId, refId))
    },

    removeRef: (cardId, refId) => {
      commit((project) => model.removeRef(project, cardId, refId))
    },

    reparent: (cardId, parentId) => {
      const project = activeProject(get())
      if (!project || !model.canReparent(project, cardId, parentId)) {
        return false
      }
      const moved = model.reparentCard(project, cardId, parentId)
      if (moved === project) {
        return false
      }
      // 改了层级顺手重排一下坐标：全览图自己算布局，但导出给桌面版时 pos 别太离谱
      commit(() => model.layoutCards(moved))
      return true
    },

    refLink: (cardId, refId) => {
      const project = activeProject(get())
      if (!project) {
        return false
      }
      const next = model.addRef(project, cardId, refId)
      if (next === project) {
        return false
      }
      commit(() => next)
      return true
    },

    mergeCard: (sourceId, targetId) => {
      const project = activeProject(get())
      if (!project || !model.canMerge(project, sourceId, targetId)) {
        return false
      }
      const next = model.mergeCards(project, sourceId, targetId)
      if (next === project) {
        return false
      }
      const state = get()
      const stillThere = next.cards.some((card) => card.id === sourceId)
      commit(() => model.layoutCards(next))
      // 源卡没了：如果正停在被并掉的那张卡上，回到树
      if (!stillThere && state.activeCardId === sourceId) {
        set({ view: 'tree', activeCardId: null })
      }
      return true
    },

    layout: () => {
      commit((project) => model.layoutCards(project))
    },

    exportActive: () => {
      const project = activeProject(get())
      if (!project) {
        return
      }
      const safe = project.title.replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 40) || 'card-tree'
      const json = exportProjectJson(project)
      const saved = saveNativeBackup(json, `${safe}.json`)
      if (saved) {
        showToast(`已导出到 ${saved}`)
        return
      }
      downloadJson(`${safe}.json`, json)
    },

    exportAll: () => {
      const state = get()
      if (!state.projects.length) {
        showToast('还没有项目可以导出')
        return
      }
      const json = exportAllProjectsJson(state.projects, state.activeProjectId)
      const saved = saveNativeBackup(json, 'card-tree-all.json')
      if (saved) {
        showToast(`已导出到 ${saved}`)
        return
      }
      downloadJson('card-tree-all.json', json)
    },

    importFile: (text) => {
      const parsed = JSON.parse(text) as { projects?: unknown; cards?: unknown }
      const imported = Array.isArray(parsed.projects)
        ? importDesktopState(text)
        : [importProjectJson(text)]
      if (!imported.length) {
        throw new Error('文件里没有找到可以导入的项目')
      }
      const state = get()
      set({
        projects: [...imported, ...state.projects],
        activeProjectId: imported[0].id,
        view: 'tree',
        activeCardId: null,
      })
      for (const project of imported) {
        void db.saveProject(project)
      }
      void db.saveActiveProjectId(imported[0].id)
      return imported.length
    },

    clearAll: async () => {
      for (const item of controllers.values()) {
        item.abort()
      }
      controllers.clear()
      await db.clearAll()
      const project = model.createProject()
      set({
        projects: [project],
        activeProjectId: project.id,
        view: 'tree',
        activeCardId: null,
        live: {},
        running: {},
      })
      await db.saveProject(project)
      await db.saveActiveProjectId(project.id)
    },

    backupNow: () => {
      if (!isNativeApp()) {
        return null
      }
      const projects = get().projects
      if (!projects.length) {
        return null
      }
      const json = JSON.stringify(
        { version: 1, exportedAt: new Date().toISOString(), projects },
        null,
        2,
      )
      const saved = saveNativeAutoBackup(json)
      if (saved) {
        try {
          localStorage.setItem(BACKUP_LAST_KEY, new Date().toISOString())
        } catch {
          // localStorage 不可用时不影响备份本身
        }
      }
      return saved
    },
  }
})
