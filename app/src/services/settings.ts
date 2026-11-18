import { create } from 'zustand'

/**
 * 本地设置：只存在手机浏览器自己的 localStorage 里，不上传。
 *
 * 手机版不保存 API Key —— 模型请求统一打给同源的 `/api/*` 中继
 * （app/server.mjs），Key 由中继在服务端注入。这样换电脑、换网络都不用重新填 Key，
 * 也避免把 Key 留在随便一台手机上。
 */

export type Locale = 'zh-CN' | 'en-US'
export type ThemePreference = 'light' | 'dark' | 'system'

export type Settings = {
  /** 模型接口地址：默认同源 /api；开发时可填 http://127.0.0.1:8787/api */
  apiBase: string
  /** 当前使用的模型 id */
  model: string
  /** 推理强度，作为 body.reasoning_effort 传给模型 */
  reasoningEffort: string
  themePreference: ThemePreference
  locale: Locale
}

/** opencode go 里默认用的模型：便宜、快，和桌面插件默认一致 */
export const DEFAULT_MODEL = 'deepseek-v4.1-flash'
export const DEFAULT_EFFORT = 'high'
/** 可选推理强度，顺序即选择器里的顺序 */
export const REASONING_EFFORTS = ['low', 'medium', 'high'] as const

const STORAGE_KEY = 'card-tree:settings'

export const DEFAULT_SETTINGS: Settings = {
  apiBase: '/api',
  model: DEFAULT_MODEL,
  reasoningEffort: DEFAULT_EFFORT,
  themePreference: 'system',
  locale: 'zh-CN',
}

export const isChineseBrowser = (): boolean =>
  typeof navigator !== 'undefined' && /^zh\b/i.test(navigator.language || '')

const isThemePreference = (value: unknown): value is ThemePreference =>
  value === 'light' || value === 'dark' || value === 'system'

/** 读设置并逐项校正：存档损坏、字段缺失都回落到默认值，不让界面崩 */
const readSettings = (): Settings => {
  const base: Settings = { ...DEFAULT_SETTINGS, locale: isChineseBrowser() ? 'zh-CN' : 'en-US' }
  if (typeof localStorage === 'undefined') {
    return base
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return base
    }
    const saved = JSON.parse(raw) as Partial<Settings> | null
    if (!saved || typeof saved !== 'object') {
      return base
    }
    return {
      apiBase: typeof saved.apiBase === 'string' && saved.apiBase ? saved.apiBase : base.apiBase,
      model: typeof saved.model === 'string' && saved.model ? saved.model : base.model,
      reasoningEffort:
        typeof saved.reasoningEffort === 'string' && saved.reasoningEffort
          ? saved.reasoningEffort
          : base.reasoningEffort,
      themePreference: isThemePreference(saved.themePreference)
        ? saved.themePreference
        : base.themePreference,
      locale: saved.locale === 'en-US' || saved.locale === 'zh-CN' ? saved.locale : base.locale,
    }
  } catch {
    return base
  }
}

/** 当前设置；组件用 `useSettings((s) => s.model)` 订阅单个字段 */
export const useSettings = create<Settings>(() => readSettings())

const writeSettings = (settings: Settings) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // 隐私模式 / 存储已满：设置只在本次会话生效，不打断使用
  }
}

useSettings.subscribe((state) => writeSettings(state))

/** 批量更新设置，字段级 setter 都走它 */
export const updateSettings = (patch: Partial<Settings>) => {
  useSettings.setState((state) => ({ ...state, ...patch }))
}

export const setApiBase = (apiBase: string) => updateSettings({ apiBase: apiBase.trim() || '/api' })
export const setModel = (model: string) => updateSettings({ model })
export const setReasoningEffort = (reasoningEffort: string) => updateSettings({ reasoningEffort })
export const setThemePreference = (themePreference: ThemePreference) =>
  updateSettings({ themePreference })
export const setLocale = (locale: Locale) => updateSettings({ locale })
