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
import { ApiError } from '../api/types.js'
import type { ChatMessage, ModelInfo } from '../api/types.js'
import { isNativeApp, saveNativeAutoBackup, saveNativeBackup } from '../native.js'
import { searchWeb } from '../search.js'
import { useSettings } from '../settings.js'
import {
  FALLBACK_CONTEXT_WINDOW,
  buildMessages,
  buildSystem,
  contextBudget,
  estimateAttachmentTokens,
  estimateTokens,
  searchBlock,
} from './context.js'
import * as db from './db.js'
import { downloadJson, exportProjectJson, importDesktopState, importProjectJson } from './io.js'
import * as model from './model.js'
import type { LiveText } from './live.js'
import type { Attachment, CardSearch, CardStats, Project } from './types.js'

/** 卡片详情页底部输入框能选的四种生长方式（follow 不开新节点） */
export type AskMode = 'follow' | 'child' | 'diverge' | 'isolated'

/** 一次生成的可选开关：这次要不要先联网搜一下 */
export type RunOptions = { search?: boolean }

export type View = 'tree' | 'card'

type RunTarget = { cardId: string; followUpId: string | null }

export type Store = {
  ready: boolean
  projects: Project[]
  activeProjectId: string | null
  view: View
  activeCardId: string | null
  /** 正在流式输出的文本（不落库） */
  live: LiveText | null
  /** 当前正在跑的那一轮 */
  running: RunTarget | null
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
  stop: () => void

  deleteCard: (cardId: string) => void
  /** 手动改卡片的问题 / 回答文字，不重新生成 */
  editCard: (cardId: string, patch: { prompt?: string; answer?: string }) => void
  addRef: (cardId: string, refId: string) => void
  removeRef: (cardId: string, refId: string) => void
  /** 全览图拖动：改父级（parentId=null 表示摘成根卡片），返回是否真的改了 */
  reparent: (cardId: string, parentId: string | null) => boolean
  /** 全览图拉线：加一条引用，返回是否真的加了 */
  refLink: (cardId: string, refId: string) => boolean
  layout: () => void

  exportActive: () => void
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

let controller: AbortController | null = null

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

  const finish = (target: RunTarget, patch: Parameters<typeof model.writeAnswer>[2]) => {
    controller = null
    const state = get()
    const project = activeProject(state)
    if (!project) {
      set({ running: null, live: null })
      return
    }
    const next = target.followUpId
      ? model.writeFollowUp(project, target.cardId, target.followUpId, patch)
      : model.writeAnswer(project, target.cardId, patch)
    set({ projects: replaceProject(state.projects, next), running: null, live: null })
    void db.saveProject(next).catch(() => {
      showToast('保存失败：浏览器存储可能已满')
    })
  }

  const run = async (
    cardId: string,
    followUpId: string | null,
    options?: { continueFrom?: string; search?: boolean },
  ) => {
    const state = get()
    const project = activeProject(state)
    if (!project || state.running) {
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

    // 联网搜索：先搜、把来源写到卡片上，再带着搜索结果去问模型。
    // 搜索失败（没配 DeepSeek Key / 网络问题）只提示一声，仍按不联网继续回答。
    let searchResult: CardSearch | null = null
    const question = String(followUp ? followUp.prompt : card.prompt).trim()
    if (options?.search && question) {
      controller = null
      set({ running: { cardId, followUpId }, live: { cardId, followUpId, answer: '', thinking: '' } })
      try {
        const outcome = await searchWeb(normalizeApiBase(settings.apiBase), question)
        searchResult = { query: outcome.query, sources: outcome.sources, searchedAt: Date.now() }
        commit((current) => model.setSearch(current, cardId, followUpId, searchResult))
      } catch (error) {
        showToast(
          error instanceof ApiError
            ? `联网搜索失败：${error.message}`
            : '联网搜索失败，这次先按不联网回答',
        )
      }
    }
    // 重答 / 换角度 / 继续生成时，沿用这张卡上次搜到的来源，不重复花钱再搜一遍
    if (!searchResult) {
      searchResult = (followUp ? followUp.search : card.search) ?? null
    }

    const system = buildSystem(project, card, { followUp })
    const attachments = (followUp ? followUp.attachments : card.attachments) ?? []
    const budget = Math.max(
      1200,
      contextBudget(FALLBACK_CONTEXT_WINDOW, estimateTokens(system)) -
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

    controller = new AbortController()
    const signal = controller.signal
    const target: RunTarget = { cardId, followUpId }
    set({ running: target, live: { cardId, followUpId, answer: prefix, thinking: '' } })

    let answer = ''
    let thinking = ''
    let failure: unknown = null
    const finalAnswer = () => prefix + answer
    try {
      for await (const event of streamChat(normalizeApiBase(settings.apiBase), {
        provider: settings.provider,
        model: settings.model,
        reasoningEffort: settings.reasoningEffort,
        messages: requestMessages,
        signal,
      })) {
        if (event.type === 'text') {
          answer = event.text
        } else if (event.type === 'thinking') {
          thinking = event.text
        }
        if (event.type === 'text' || event.type === 'thinking') {
          set({ live: { cardId, followUpId, answer: finalAnswer(), thinking } })
        }
      }
    } catch (error) {
      failure = error
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
    live: null,
    running: null,
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
      if (state.running || !state.projects.some((project) => project.id === projectId)) {
        return
      }
      set({ activeProjectId: projectId, view: 'tree', activeCardId: null, live: null })
      void db.saveActiveProjectId(projectId)
    },

    createProject: () => {
      const state = get()
      if (state.running) {
        return
      }
      const project = model.createProject()
      set({
        projects: [project, ...state.projects],
        activeProjectId: project.id,
        view: 'tree',
        activeCardId: null,
        live: null,
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
      if (state.running) {
        return
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
      if (!project || !prompt || state.running) {
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
      if (!project || !cardId || !prompt || state.running) {
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
      if (!project || state.running) {
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
      if (!project || state.running) {
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
      if (!project || state.running) {
        return
      }
      const card = model.cardById(project, cardId)
      if (!card || card.status !== 'partial' || !card.answer.trim()) {
        return
      }
      void run(cardId, null, { continueFrom: card.answer })
    },

    stop: () => {
      controller?.abort()
    },

    deleteCard: (cardId) => {
      const state = get()
      if (state.running?.cardId === cardId) {
        controller?.abort()
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
      controller?.abort()
      await db.clearAll()
      const project = model.createProject()
      set({
        projects: [project],
        activeProjectId: project.id,
        view: 'tree',
        activeCardId: null,
        live: null,
        running: null,
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
