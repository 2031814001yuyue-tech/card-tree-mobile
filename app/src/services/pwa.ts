/**
 * PWA 注册入口：只在支持 Service Worker、页面处于安全上下文（https / localhost）、
 * 且不在 rspack 开发热更新环境时注册；任何失败只记一条警告，不影响应用启动。
 *
 * <p>APK 里不注册：静态资源就在本机 assets 里，Service Worker 只会让升级后读到旧文件。
 */

import { isNativeApp } from './native.js'

/** 同一个页面里只注册一次，失败也不重试 */
let registered = false

const warn = (error: unknown): void => {
  // eslint-disable-next-line no-console
  console.warn('[pwa] Service Worker 注册失败', error)
}

export const registerServiceWorker = (): void => {
  if (registered) {
    return
  }
  if (!('serviceWorker' in navigator)) {
    return
  }
  if (!window.isSecureContext) {
    return
  }
  if (isNativeApp()) {
    return
  }
  // 开发模式下 import.meta.hot 存在：注册 SW 会缓存静态资源，遮住热更新
  if ((import.meta as ImportMeta & { hot?: unknown }).hot !== undefined) {
    return
  }

  registered = true
  try {
    // 静态文件由 rspack CopyPlugin 拷到 dist 根，故按站点根路径引用
    void navigator.serviceWorker.register('/sw.js').catch(warn)
  } catch (error) {
    warn(error)
  }
}
