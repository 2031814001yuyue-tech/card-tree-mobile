/** 四家订阅上游的预设。中继（server.mjs）与 APK（LocalServer.java）里各有一份同构的表，改这里要三处同步。 */

export type ProviderId = 'opencode' | 'zai' | 'kimi' | 'deepseek'

export type ProviderPreset = {
  id: ProviderId
  /** 设置页与引导文案里显示的名字 */
  label: string
  /** 各家接受的推理强度档位 */
  efforts: readonly string[]
  defaultEffort: string
  /** 切到这家时默认选的模型 */
  defaultModel: string
  /** 是否支持推理强度（智谱 Coding 的编码端点未验证，先隐藏） */
  supportsEffort: boolean
  /** 是否发 stream_options.include_usage（智谱未验证，先不发） */
  sendUsageOption: boolean
  /** 一句话说明，设置页展示 */
  note: string
}

export const PROVIDERS: readonly ProviderPreset[] = [
  {
    id: 'opencode',
    label: 'opencode go',
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'high',
    defaultModel: 'deepseek-v4.1-flash',
    supportsEffort: true,
    sendUsageOption: true,
    note: '32 个模型（DeepSeek / GLM / Kimi / Qwen 等）',
  },
  {
    id: 'zai',
    label: '智谱 Coding',
    efforts: [],
    defaultEffort: '',
    defaultModel: 'glm-5.3',
    supportsEffort: false,
    sendUsageOption: false,
    note: 'GLM 系列，需要智谱 Coding 套餐在有效期内',
  },
  {
    id: 'kimi',
    label: 'Kimi Coding',
    efforts: ['low', 'high', 'max'],
    defaultEffort: 'high',
    defaultModel: 'kimi-for-coding',
    supportsEffort: true,
    sendUsageOption: true,
    note: 'K2.8 / K2.7 / K3，支持图片输入',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek 官方',
    efforts: ['low', 'high', 'max'],
    defaultEffort: 'high',
    defaultModel: 'deepseek-flash',
    supportsEffort: true,
    sendUsageOption: true,
    note: 'deepseek-flash / deepseek-v4-pro，按量计费',
  },
]

export const DEFAULT_PROVIDER: ProviderId = 'opencode'

export const PROVIDER_HEADER = 'x-card-tree-provider'

export const isProviderId = (value: unknown): value is ProviderId =>
  typeof value === 'string' && PROVIDERS.some((preset) => preset.id === value)

export const providerById = (id: string): ProviderPreset =>
  PROVIDERS.find((preset) => preset.id === id) ?? PROVIDERS[0]
