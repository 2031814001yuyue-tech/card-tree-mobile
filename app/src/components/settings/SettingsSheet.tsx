import clsx from 'clsx'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ModelInfo } from '../../services/api/types.js'
import { PROVIDERS, providerById } from '../../services/api/providers.js'
import {
  checkNativeWebUpdate,
  clearNativeKey,
  clearNativeProviderKey,
  clearNativeSearchKey,
  installNativeWebUpdate,
  isNativeApp,
  nativeHasKey,
  nativeHasProviderKey,
  nativeHasSearchKey,
  nativeSupportsProviders,
  nativeUpdateMirror,
  nativeVersion,
  nativeWebVersion,
  saveNativeKey,
  saveNativeProviderKey,
  saveNativeSearchKey,
  setNativeUpdateMirror,
} from '../../services/native.js'
import {
  setUpdateState,
  subscribeUpdate,
  updateState,
} from '../../services/update.js'
import {
  FONT_SCALES,
  setApiBase,
  setFontScale,
  setModel,
  setProvider,
  setReasoningEffort,
  setStyleTheme,
  setThemePreference,
  useSettings,
  type StyleTheme,
  type ThemePreference,
} from '../../services/settings.js'
import { showToast } from '../base/toastState.js'
import {
  IconDownloadOutline16,
  IconRefreshOutline16,
  IconUploadOutline14,
} from '../base/icons.js'
import { Select } from '../base/Select.js'
import { Sheet } from '../common/Sheet.js'
import styles from './SettingsSheet.module.css'

const EFFORT_LABEL: Record<string, string> = {
  low: '低',
  medium: '中',
  high: '高',
  max: '最大',
}

const THEMES: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
]

/** 界面风格：只换一层颜色 token，每种都有浅色 / 深色两套 */
const STYLE_THEMES: { value: StyleTheme; label: string }[] = [
  { value: 'index', label: '索引卡' },
  { value: 'plain', label: '素笺' },
  { value: 'parchment', label: '羊皮纸' },
  { value: 'graphite', label: '石墨' },
]

const FONT_LABEL: Record<number, string> = {
  0.9: '小',
  1: '标准',
  1.1: '大',
  1.25: '特大',
}

const Pill = ({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: string
}) => (
  <button
    type="button"
    className={clsx(styles.pill, active && styles.pillActive)}
    aria-pressed={active}
    onClick={onClick}
  >
    {children}
  </button>
)

export type SettingsSheetProps = {
  open: boolean
  onClose: () => void
  models: ModelInfo[]
  modelsLoading: boolean
  modelsError: string | null
  onReloadModels: () => void
  onExportProject: () => void
  /** 导出全部项目（一个文件，含桌面版同构字段，手机/桌面都读得回） */
  onExportAll: () => void
  onImportFile: (file: File) => void
  onClearAll: () => void
  /** 最近一次自动备份的时间（ISO），仅 APK 有效 */
  lastBackupAt: string | null
  /** 立即写一份自动备份 */
  onBackupNow: () => void
  /** 联网搜索 Key 变了：让 App 重新问一次服务端有没有配 */
  onRefreshSearch: () => void
  /** 电脑中继 / APK 上各家订阅有没有配 Key（来自 /api/health），拿不到时为 null */
  relayProviders: Record<string, boolean> | null
}

const formatBackupTime = (value: string | null) => {
  if (!value) {
    return '还没有备份过'
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return '还没有备份过'
  }
  return date.toLocaleString('zh-CN', { hour12: false })
}

const formatSize = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return ''
  }
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 上下文窗口的展示格式：128000 → 128K，1048576 → 1M，1600000 → 1.6M */
const formatContextWindow = (tokens: number): string => {
  if (tokens >= 950000) {
    const millions = tokens / 1000000
    const rounded = Math.round(millions * 10) / 10
    return `${rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1)}M`
  }
  if (tokens >= 1000) {
    return `${Math.round(tokens / 1000)}K`
  }
  return String(tokens)
}

/** 模型能力的小字标注：能看图 / 上下文长度；都没有就不标 */
const modelHint = (model: ModelInfo): string => {
  const parts: string[] = []
  if (model.vision) {
    parts.push('能看图')
  }
  if (model.contextWindow !== null) {
    parts.push(`上下文 ${formatContextWindow(model.contextWindow)}`)
  }
  return parts.join(' · ')
}

/** 热更新区块（仅 APK）：当前网页层版本 + 检查 / 安装 + 下载镜像设置。 */
const WebUpdate = () => {
  const state = useSyncExternalStore(subscribeUpdate, updateState)
  const webVersion = nativeWebVersion()
  const [mirrorDraft, setMirrorDraft] = useState(() => nativeUpdateMirror())

  const runCheck = () => {
    setUpdateState({ state: 'checking' })
    // 桥方法是同步的，但里面有网络请求：放宏任务里跑，先把「正在检查」画出来
    setTimeout(() => {
      const result = checkNativeWebUpdate()
      if (!result) {
        setUpdateState({ state: 'error', message: '检查更新失败，稍后再试' })
        return
      }
      if (result.available) {
        setUpdateState({
          state: 'available',
          version: result.version,
          notes: result.notes,
          size: result.size,
        })
        return
      }
      setUpdateState({
        state: 'uptodate',
        message: result.error ?? `网页层已是最新（${webVersion ?? '当前版本'}）`,
      })
    }, 30)
  }

  const runInstall = () => {
    if (installNativeWebUpdate()) {
      setUpdateState({ state: 'installing', version: state.version, message: '正在准备…' })
    } else {
      showToast('更新已经在进行中')
    }
  }

  return (
    <div className={styles.updateRow}>
      <div className={styles.backupInfo}>
        <span className={styles.label}>网页层版本</span>
        <span className={styles.count}>
          {webVersion ?? nativeVersion() ?? '0.3.13'}
          {state.state === 'available' && state.version ? ` → ${state.version}` : ''}
        </span>
      </div>
      {state.state === 'available' ? (
        <button type="button" className={styles.actionButton} onClick={runInstall}>
          <IconDownloadOutline16 />
          {state.size ? `更新到 ${state.version}（${formatSize(state.size)}）` : `更新到 ${state.version}`}
        </button>
      ) : (
        <button
          type="button"
          className={styles.actionButton}
          disabled={state.state === 'checking' || state.state === 'installing'}
          onClick={runCheck}
        >
          <IconRefreshOutline16 />
          {state.state === 'checking' ? '正在检查…' : '检查更新'}
        </button>
      )}
      {state.state === 'installing' ? (
        <p className={styles.hint}>{state.message ?? '正在安装…'}</p>
      ) : null}
      {state.state === 'available' && state.notes ? (
        <p className={styles.hint}>{state.notes}</p>
      ) : null}
      {state.state === 'available' ? (
        <p className={styles.hint}>只更新网页层，不重装 APK；下载失败会自动留在当前版本。</p>
      ) : null}
      {state.state === 'error' ? <p className={styles.error}>{state.message}</p> : null}
      {state.state === 'uptodate' && state.message ? (
        <p className={styles.hint}>{state.message}</p>
      ) : null}
      <label className={styles.label} htmlFor="update-mirror">
        下载镜像（可选）
      </label>
      <input
        id="update-mirror"
        className={styles.input}
        value={mirrorDraft}
        placeholder="https://ghproxy.net/"
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => setMirrorDraft(event.target.value)}
        onBlur={() => setNativeUpdateMirror(mirrorDraft)}
      />
      <p className={styles.hint}>
        GitHub 的下载在国内经常拉不动：填一个加速前缀（比如 `https://ghproxy.net/`），更新包会先走它；
        留空就直连，镜像失败也会自动改回直连重试一次。
      </p>
    </div>
  )
}

export const SettingsSheet = ({
  open,
  onClose,
  models,
  modelsLoading,
  modelsError,
  onReloadModels,
  onExportProject,
  onExportAll,
  onImportFile,
  onClearAll,
  lastBackupAt,
  onBackupNow,
  onRefreshSearch,
  relayProviders,
}: SettingsSheetProps) => {
  const settings = useSettings()
  const [apiBase, setApiBaseInput] = useState(settings.apiBase)
  const fileRef = useRef<HTMLInputElement>(null)
  const native = isNativeApp()
  // 0.3.5 起壳里才有按订阅分存的 Key 方法；旧壳上隐藏多订阅 UI，避免出现存不上的输入框
  const providersReady = nativeSupportsProviders()
  const provider = settings.provider
  const preset = providerById(provider)
  const [hasNativeKey, setHasNativeKey] = useState(() =>
    providersReady ? nativeHasProviderKey(provider) : nativeHasKey(),
  )
  const [keyDraft, setKeyDraft] = useState('')
  const [hasSearchKey, setHasSearchKey] = useState(() => nativeHasSearchKey())
  const [searchDraft, setSearchDraft] = useState('')

  useEffect(() => {
    if (open) {
      setApiBaseInput(useSettings.getState().apiBase)
      setHasNativeKey(providersReady ? nativeHasProviderKey(provider) : nativeHasKey())
      setKeyDraft('')
      setHasSearchKey(nativeHasSearchKey())
      setSearchDraft('')
    }
  }, [open, provider, providersReady])

  const version = nativeVersion() ?? '0.3.13'

  // 模型列表还没回来时，也把当前模型显示出来；hint 标注能力（能看图 / 上下文）
  const options: ModelInfo[] = models.some((item) => item.id === settings.model)
    ? models
    : [
        { id: settings.model, ownedBy: null, vision: false, contextWindow: null },
        ...models,
      ]

  const optionEntries = options.map((item) => ({
    value: item.id,
    label: item.id,
    hint: modelHint(item) || undefined,
  }))

  const saveKeyForProvider = (value: string): boolean =>
    providersReady ? saveNativeProviderKey(provider, value) : saveNativeKey(value)

  const clearKeyForProvider = () => {
    if (providersReady) {
      clearNativeProviderKey(provider)
    } else {
      clearNativeKey()
    }
  }

  return (
    <Sheet open={open} title="设置" onClose={onClose} size="full">
      {native ? (
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>连接</h3>
          <div className={styles.row}>
            <span className={styles.label}>{preset.label} 的 Key</span>
            <span className={styles.count}>{hasNativeKey ? '已配置，加密保存在本机' : '还没有配置'}</span>
          </div>
          <div className={styles.field}>
            <input
              className={styles.input}
              type="password"
              value={keyDraft}
              placeholder={
                hasNativeKey
                  ? '粘贴新的 Key 可以替换'
                  : `粘贴 ${preset.label} 的 API Key`
              }
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setKeyDraft(event.target.value)}
            />
          </div>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.actionButton}
              disabled={!keyDraft.trim()}
              onClick={() => {
                const value = keyDraft.trim()
                if (!value) {
                  return
                }
                if (!saveKeyForProvider(value)) {
                  showToast('保存失败，再试一次')
                  return
                }
                setKeyDraft('')
                setHasNativeKey(true)
                showToast(`已保存 ${preset.label} 的 Key`)
                onReloadModels()
              }}
            >
              保存 Key
            </button>
            {hasNativeKey ? (
              <button
                type="button"
                className={styles.actionButton}
                onClick={() => {
                  clearKeyForProvider()
                  setHasNativeKey(false)
                  showToast(`已清除 ${preset.label} 的 Key`)
                  onReloadModels()
                }}
              >
                清除 Key
              </button>
            ) : null}
          </div>
          <p className={styles.hint}>
            Key 用 Android Keystore 加密后存在这台手机里，不上传、不随备份导出；换手机需要重新粘贴。
            {provider === 'deepseek'
              ? ' DeepSeek 官方订阅与下面的联网搜索共用同一把 Key。'
              : ''}
          </p>
        </section>
      ) : null}

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>订阅与模型</h3>
        <div className={styles.row}>
          <span className={styles.label}>模型订阅</span>
          <div className={styles.pills}>
            {PROVIDERS.map((item) => (
              <Pill
                key={item.id}
                active={provider === item.id}
                onClick={() => {
                  setProvider(item.id)
                  onReloadModels()
                }}
              >
                {item.label}
              </Pill>
            ))}
          </div>
        </div>
        {relayProviders ? (
          <p className={styles.hint}>
            服务端已配置 Key 的订阅：
            {PROVIDERS.filter((item) => relayProviders[item.id]).map((item) => ` ${item.label}`)}
            {PROVIDERS.every((item) => !relayProviders[item.id]) ? '（一家都没有）' : ''}
          </p>
        ) : null}
        <div className={styles.field}>
          <span className={styles.label}>当前模型</span>
          <Select
            className={styles.modelSelect}
            value={settings.model}
            options={optionEntries}
            onChange={setModel}
            ariaLabel="当前模型"
          />
        </div>
        {preset.supportsEffort ? (
          <div className={styles.row}>
            <span className={styles.label}>推理强度</span>
            <div className={styles.pills}>
              {preset.efforts.map((effort) => (
                <Pill
                  key={effort}
                  active={settings.reasoningEffort === effort}
                  onClick={() => setReasoningEffort(effort)}
                >
                  {EFFORT_LABEL[effort] ?? effort}
                </Pill>
              ))}
            </div>
          </div>
        ) : null}
        <p className={styles.hint}>{preset.note}</p>
        {native ? null : (
          <>
            <label className={styles.field}>
              <span className={styles.label}>接口地址</span>
              <input
                className={styles.input}
                value={apiBase}
                spellCheck={false}
                onChange={(event) => setApiBaseInput(event.target.value)}
                onBlur={() => setApiBase(apiBase)}
              />
            </label>
            <p className={styles.hint}>
              默认 <code>/api</code> 表示走你电脑上的中继（app/server.mjs），API Key 只存在电脑上，不会进手机。
            </p>
          </>
        )}
        <div className={styles.row}>
          <button type="button" className={styles.linkButton} onClick={onReloadModels}>
            <IconRefreshOutline16 />
            {modelsLoading ? '正在获取模型…' : '刷新模型列表'}
          </button>
          <span className={styles.count}>{models.length} 个可用</span>
        </div>
        {modelsError ? <p className={styles.error}>{modelsError}</p> : null}
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>联网搜索</h3>
        <div className={styles.row}>
          <span className={styles.label}>DeepSeek Search API</span>
          <span className={styles.count}>
            {native ? (hasSearchKey ? '已配置，加密保存在本机' : '还没有配置') : '由电脑上的中继提供'}
          </span>
        </div>
        {native ? (
          <>
            <div className={styles.field}>
              <input
                className={styles.input}
                type="password"
                value={searchDraft}
                placeholder={
                  hasSearchKey ? '粘贴新的 DeepSeek Key 可以替换' : '粘贴 DeepSeek 的 API Key（sk-…）'
                }
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => setSearchDraft(event.target.value)}
              />
            </div>
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.actionButton}
                disabled={!searchDraft.trim()}
                onClick={() => {
                  const value = searchDraft.trim()
                  if (!value) {
                    return
                  }
                  if (!saveNativeSearchKey(value)) {
                    showToast('保存失败，再试一次')
                    return
                  }
                  setSearchDraft('')
                  setHasSearchKey(true)
                  onRefreshSearch()
                  showToast('联网搜索已开通')
                }}
              >
                保存搜索 Key
              </button>
              {hasSearchKey ? (
                <button
                  type="button"
                  className={styles.actionButton}
                  onClick={() => {
                    clearNativeSearchKey()
                    setHasSearchKey(false)
                    onRefreshSearch()
                    showToast('已关闭联网搜索')
                  }}
                >
                  清除
                </button>
              ) : null}
            </div>
            <p className={styles.hint}>
              联网搜索走 DeepSeek 官方 Search API，按搜索次数计费；这把 Key 和对话用的 Key
              分开存，同样用 Android Keystore 加密，不上传、不随备份导出。
            </p>
          </>
        ) : (
          <p className={styles.hint}>
            网页版的联网搜索由电脑上的中继转发：启动中继前设好环境变量{' '}
            <code>DEEPSEEK_API_KEY</code>，或写进 <code>~/.dsh/.credentials.yaml</code>，重启后生效。
          </p>
        )}
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>外观</h3>
        <div className={styles.row}>
          <span className={styles.label}>主题</span>
          <div className={styles.pills}>
            {THEMES.map((theme) => (
              <Pill
                key={theme.value}
                active={settings.themePreference === theme.value}
                onClick={() => setThemePreference(theme.value)}
              >
                {theme.label}
              </Pill>
            ))}
          </div>
        </div>
        <div className={styles.row}>
          <span className={styles.label}>风格</span>
          <div className={styles.pills}>
            {STYLE_THEMES.map((style) => (
              <Pill
                key={style.value}
                active={settings.styleTheme === style.value}
                onClick={() => setStyleTheme(style.value)}
              >
                {style.label}
              </Pill>
            ))}
          </div>
        </div>
        <div className={styles.row}>
          <span className={styles.label}>字号</span>
          <div className={styles.pills}>
            {FONT_SCALES.map((scale) => (
              <Pill
                key={scale}
                active={settings.fontScale === scale}
                onClick={() => setFontScale(scale)}
              >
                {FONT_LABEL[scale] ?? String(scale)}
              </Pill>
            ))}
          </div>
        </div>
        <p className={styles.hint}>风格只换纸面和墨色，主题管深浅；字号只缩放卡片正文、树上的文字和输入框，不影响按钮大小。三者可以任意组合。</p>
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>数据</h3>
        <div className={styles.actions}>
          <button type="button" className={styles.actionButton} onClick={onExportProject}>
            <IconDownloadOutline16 />
            导出当前项目
          </button>
          <button type="button" className={styles.actionButton} onClick={onExportAll}>
            <IconDownloadOutline16 />
            导出全部项目
          </button>
          <button type="button" className={styles.actionButton} onClick={() => fileRef.current?.click()}>
            <IconUploadOutline14 />
            导入备份
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) {
              onImportFile(file)
            }
            event.target.value = ''
          }}
        />
        <p className={styles.hint}>
          支持导入桌面版插件导出的 <code>state.json</code>（会拆成多个项目），以及本应用导出的项目备份。
        </p>
        {native ? (
          <div className={styles.backupRow}>
            <div className={styles.backupInfo}>
              <span className={styles.label}>自动备份</span>
              <span className={styles.count}>上次：{formatBackupTime(lastBackupAt)}</span>
            </div>
            <button type="button" className={styles.actionButton} onClick={() => onBackupNow()}>
              立即备份
            </button>
            <p className={styles.hint}>
              退到后台或每 5 分钟自动写一份到「下载 / CardTree / backups」，滚动保留最近 30 份；就算卸载 App，这些文件也还在手机上。
            </p>
          </div>
        ) : null}
        <button type="button" className={styles.dangerButton} onClick={onClearAll}>
          清空本机所有数据
        </button>
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>关于</h3>
        <p className={styles.about}>
          卡片树 {version} · 把对话拆成一张张卡片，长成一棵可以回看的树。界面参考 DeepSeek App
          的移动端风格，模型走 opencode go / 智谱 Coding / Kimi Coding / DeepSeek 官方订阅。
        </p>
        <p className={styles.hint}>
          {native
            ? '数据保存在这个 App 自己的本地存储里；卸载 App 会一起删除，重要项目记得导出备份。'
            : '数据保存在浏览器 IndexedDB 里；换浏览器、清理网站数据都会丢失，重要项目记得导出备份。'}
        </p>
        {!native && typeof Notification !== 'undefined' && Notification.permission !== 'granted' ? (
          <button
            type="button"
            className={styles.actionButton}
            onClick={() => {
              void Notification.requestPermission().then((result) => {
                showToast(result === 'granted' ? '通知已开启：App 退到后台后回答完成会提醒你' : '没有授权，跳过；之后想要可以再来这里点')
              })
            }}
          >
            开启系统通知（回答完成提醒）
          </button>
        ) : null}
        {native ? <WebUpdate /> : null}
      </section>
    </Sheet>
  )
}
