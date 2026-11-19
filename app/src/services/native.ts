/**
 * 与 Android 壳（`window.CardTreeNative`）通信的唯一入口。
 *
 * <p>APK 里由 `MainActivity` 注入这个对象，浏览器 / PWA 里它是 `undefined`；
 * 所有调用都做了兜底，网页在两种环境下跑同一套代码。
 */

export interface CardTreeNativeBridge {
  hasKey(): boolean
  saveKey(key: string): boolean
  clearKey(): void
  saveBackup(json: string, name: string): string | null
  /** 自动备份：写一份全量快照到 下载/CardTree/backups，滚动保留最近 30 份 */
  saveAutoBackup(json: string): string | null
  setChrome(background: string, dark: boolean): void
  version(): string
  /** 联网搜索用的第二把 Key（DeepSeek），和对话 Key 分开存 */
  hasSearchKey(): boolean
  saveSearchKey(key: string): boolean
  clearSearchKey(): void
  /** 各订阅各自的 Key（opencode / zai / kimi / deepseek） */
  hasProviderKey(provider: string): boolean
  saveProviderKey(provider: string, key: string): boolean
  clearProviderKey(provider: string): void
  /** 网页层热更新：当前网页层版本（没热更新过时等于壳版本） */
  getWebVersion(): string
  /** 检查更新，返回 JSON 字符串（见 checkNativeWebUpdate 的返回类型） */
  checkWebUpdate(): string
  /** 开始后台安装更新，已在装时返回 false；进度 / 结束走回调 */
  installWebUpdate(): boolean
  /** 把 PNG dataURL 存进 下载/CardTree（分享长图用）；旧壳没有时返回 null */
  saveImage?(dataUrl: string, name: string): string | null
  /** 设置 / 读取热更新下载镜像前缀（0.3.6 起） */
  setUpdateMirror?(prefix: string): void
  getUpdateMirror?(): string
}

declare global {
  interface Window {
    CardTreeNative?: CardTreeNativeBridge
    /** Android 返回键会调用它；返回 true 表示这次返回已被页面消费 */
    __cardTreeBack?: () => boolean
    /** 原生里保存 / 清除了 Key 之后的回调 */
    __cardTreeKeyChanged?: () => void
    /** 网页层更新进度（仅 APK）：下载 / 校验 / 解压 / 切换 */
    __cardTreeUpdateProgress?: (text: string) => void
    /** 网页层更新结束：ok 时 message 是新版本号，页面随后自动刷新 */
    __cardTreeUpdateDone?: (ok: boolean, message: string) => void
  }
}

export const nativeBridge = (): CardTreeNativeBridge | null => window.CardTreeNative ?? null

export const isNativeApp = (): boolean => nativeBridge() !== null

export const nativeHasKey = (): boolean => {
  try {
    return nativeBridge()?.hasKey() === true
  } catch {
    return false
  }
}

export const saveNativeKey = (key: string): boolean => {
  try {
    return nativeBridge()?.saveKey(key) === true
  } catch {
    return false
  }
}

export const clearNativeKey = (): void => {
  try {
    nativeBridge()?.clearKey()
  } catch {
    // 桥调用失败时忽略：下一次启动会重新判断
  }
}

export const nativeVersion = (): string | null => {
  try {
    return nativeBridge()?.version() ?? null
  } catch {
    return null
  }
}

/**
 * 0.3.5 及以上的壳才有按订阅分存的 Key 方法。
 * 网页版（无桥）永远 true；旧 APK 上返回 false，多订阅 UI 会自动隐藏，
 * 热更新把新网页层推给旧壳时也不至于出现填了存不上的界面。
 */
export const nativeSupportsProviders = (): boolean => {
  const bridge = nativeBridge()
  return bridge === null || typeof bridge.hasProviderKey === 'function'
}

/** 把导出备份交给原生保存（下载目录），返回落点描述或 null */
export const saveNativeBackup = (json: string, name: string): string | null => {
  try {
    return nativeBridge()?.saveBackup(json, name) ?? null
  } catch {
    return null
  }
}

/** 自动备份：退到后台 / 每 5 分钟写一份，返回落点描述或 null */
export const saveNativeAutoBackup = (json: string): string | null => {
  try {
    return nativeBridge()?.saveAutoBackup(json) ?? null
  } catch {
    return null
  }
}

export const nativeHasSearchKey = (): boolean => {
  try {
    return nativeBridge()?.hasSearchKey() === true
  } catch {
    return false
  }
}

export const saveNativeSearchKey = (key: string): boolean => {
  try {
    return nativeBridge()?.saveSearchKey(key) === true
  } catch {
    return false
  }
}

export const clearNativeSearchKey = (): void => {
  try {
    nativeBridge()?.clearSearchKey()
  } catch {
    // 同上：失败不阻塞界面
  }
}

/** 某家订阅（opencode / zai / kimi / deepseek）在这台手机上有没有配 Key */
export const nativeHasProviderKey = (provider: string): boolean => {
  try {
    return nativeBridge()?.hasProviderKey(provider) === true
  } catch {
    return false
  }
}

/** 保存某家订阅的 Key（Keystore 加密）；成功后原生侧会触发 __cardTreeKeyChanged */
export const saveNativeProviderKey = (provider: string, key: string): boolean => {
  try {
    return nativeBridge()?.saveProviderKey(provider, key) === true
  } catch {
    return false
  }
}

export const clearNativeProviderKey = (provider: string): void => {
  try {
    nativeBridge()?.clearProviderKey(provider)
  } catch {
    // 同上：失败不阻塞界面
  }
}

/** checkWebUpdate 桥方法的返回结构 */
export type WebUpdateCheck = {
  available: boolean
  version?: string
  notes?: string
  size?: number
  error?: string
}

/** 当前网页层版本（没热更新过时等于壳版本）；浏览器里返回 null */
export const nativeWebVersion = (): string | null => {
  try {
    return nativeBridge()?.getWebVersion() ?? null
  } catch {
    return null
  }
}

/** 检查网页层更新；桥不存在 / 返回不合法时返回 null */
export const checkNativeWebUpdate = (): WebUpdateCheck | null => {
  try {
    const raw = nativeBridge()?.checkWebUpdate()
    if (!raw) {
      return null
    }
    return JSON.parse(raw) as WebUpdateCheck
  } catch {
    return null
  }
}

/** 开始安装网页层更新；返回 false 表示已经在装或桥不可用 */
export const installNativeWebUpdate = (): boolean => {
  try {
    return nativeBridge()?.installWebUpdate() === true
  } catch {
    return false
  }
}

/**
 * 把长图 PNG 交给原生保存（下载目录）；旧壳没有这个方法时返回 null，
 * 调用方回退成浏览器下载。
 */
export const saveNativeImage = (dataUrl: string, name: string): string | null => {
  try {
    const bridge = nativeBridge()
    if (!bridge || typeof bridge.saveImage !== 'function') {
      return null
    }
    return bridge.saveImage(dataUrl, name) ?? null
  } catch {
    return null
  }
}

/** 热更新下载镜像前缀（如 `https://ghproxy.net/`）；没配 / 旧壳返回空串 */
export const nativeUpdateMirror = (): string => {
  try {
    const bridge = nativeBridge()
    if (!bridge || typeof bridge.getUpdateMirror !== 'function') {
      return ''
    }
    return bridge.getUpdateMirror() ?? ''
  } catch {
    return ''
  }
}

/** 设置热更新下载镜像前缀；空串表示直连 GitHub */
export const setNativeUpdateMirror = (prefix: string): void => {
  try {
    nativeBridge()?.setUpdateMirror?.(prefix.trim())
  } catch {
    // 失败不阻塞：下一次保存再试
  }
}