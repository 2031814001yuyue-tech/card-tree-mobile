/**
 * 网页层热更新的 UI 状态（仅 APK 里有效）。
 *
 * <p>真正的检查 / 下载 / 校验 / 解压都在 Java 侧（WebUpdater），网页只负责：
 * 发起检查（桥的同步方法）、展示进度（`__cardTreeUpdateProgress` 回调）、
 * 在完成时刷新页面（`__cardTreeUpdateDone` 回调，App.tsx 里注册）。
 *
 * <p>状态放在模块里而不是组件里，是因为设置面板可能中途关掉——
 * 装到一半关掉设置再打开，进度还在；App.tsx 里注册的完成回调也一直有效。
 */

export type UpdateUiState = {
  state: 'idle' | 'checking' | 'uptodate' | 'available' | 'installing' | 'error'
  version?: string
  notes?: string
  size?: number
  message?: string
}

let state: UpdateUiState = { state: 'idle' }
const listeners = new Set<() => void>()

export const updateState = (): UpdateUiState => state

export const setUpdateState = (next: UpdateUiState | ((current: UpdateUiState) => UpdateUiState)): void => {
  state = typeof next === 'function' ? next(state) : next
  listeners.forEach((listener) => {
    listener()
  })
}

export const subscribeUpdate = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
