import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { CardView } from '../components/card/CardView.js'
import { IconButton } from '../components/base/IconButton.js'
import { Toast } from '../components/base/Toast.js'
import {
  IconChevronDownOutline14,
  IconChevronRightOutline14,
  IconDataOutline16,
  IconMenuOutline20,
  IconSettingsOutline16,
} from '../components/base/icons.js'
import { showToast } from '../components/base/toastState.js'
import { Sheet } from '../components/common/Sheet.js'
import { ASK_MODES, Composer, type AskMode } from '../components/composer/Composer.js'
import { fetchRelayInfo } from '../services/search.js'
import { Overview } from '../components/overview/Overview.js'
import { ProjectDrawer } from '../components/projects/ProjectDrawer.js'
import { SettingsSheet } from '../components/settings/SettingsSheet.js'
import { readAttachmentFiles } from '../services/attachments.js'
import { providerById } from '../services/api/providers.js'
import {
  isNativeApp,
  nativeHasKey,
  nativeHasProviderKey,
  nativeSupportsProviders,
  saveNativeImage,
  saveNativeKey,
  saveNativeProviderKey,
} from '../services/native.js'
import { downloadCardImage, renderCardImage } from '../services/share.js'
import { setUpdateState } from '../services/update.js'
import { useSettings } from '../services/settings.js'
import type { Attachment } from '../services/tree/types.js'
import { MAX_ATTACHMENTS } from '../services/tree/types.js'
import { useStore, BACKUP_LAST_KEY } from '../services/tree/store.js'
import { canMerge } from '../services/tree/model.js'
import { TreeView } from '../components/tree/TreeView.js'
import { useIsMobile, useMobileViewport, usePreventPageScroll } from './viewport.js'
import styles from './App.module.css'

/** 应用外壳：头部 + 内容区 + 底部输入框 + 各种浮层 */
export const App = () => {
  const isMobile = useIsMobile()
  const frameRef = useMobileViewport(isMobile)
  usePreventPageScroll(isMobile)

  /** 主滚动容器：流式跟随、进卡片 / 回树的滚动恢复都挂在它上面 */
  const mainRef = useRef<HTMLElement | null>(null)
  /** 离开树视图时记下滚动位置，回来时还原 */
  const treeScrollRef = useRef(0)
  /** 流式生成时是否自动跟随：用户往回翻就停，重新滚到底部又恢复 */
  const followRef = useRef(true)
  /** 用户手指正压在内容区上：这期间绝不程序化滚动（修"往上拖又被拉回底部"的跳页） */
  const userTouchRef = useRef(false)
  /** 最近看过的一张卡：树视图左滑回去 / 抽屉里回来时用 */
  const lastCardIdRef = useRef<string | null>(null)

  /** 同步浮动按钮的两个状态（在底部？内容超一屏？）；只在值变化时 setState */
  const syncJumpState = (el: HTMLElement) => {
    const nextBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    const nextOverflow = el.scrollHeight - el.clientHeight > 80
    setAtBottom((current) => (current === nextBottom ? current : nextBottom))
    setPageOverflow((current) => (current === nextOverflow ? current : nextOverflow))
  }

  const ready = useStore((state) => state.ready)
  const projects = useStore((state) => state.projects)
  const activeProjectId = useStore((state) => state.activeProjectId)
  const view = useStore((state) => state.view)
  const activeCardId = useStore((state) => state.activeCardId)
  const live = useStore((state) => state.live)
  const running = useStore((state) => state.running)
  const models = useStore((state) => state.models)
  const modelsLoading = useStore((state) => state.modelsLoading)
  const modelsError = useStore((state) => state.modelsError)
  const authRequired = useStore((state) => state.authRequired)

  const hydrate = useStore((state) => state.hydrate)
  const loadModels = useStore((state) => state.loadModels)
  const selectProject = useStore((state) => state.selectProject)
  const createProject = useStore((state) => state.createProject)
  const deleteProject = useStore((state) => state.deleteProject)
  const renameProject = useStore((state) => state.renameProject)
  const openCard = useStore((state) => state.openCard)
  const backToTree = useStore((state) => state.backToTree)
  const askRoot = useStore((state) => state.askRoot)
  const ask = useStore((state) => state.ask)
  const branch = useStore((state) => state.branch)
  const retry = useStore((state) => state.retry)
  const stop = useStore((state) => state.stop)
  const deleteCard = useStore((state) => state.deleteCard)
  const addRef = useStore((state) => state.addRef)
  const removeRef = useStore((state) => state.removeRef)
  const reparent = useStore((state) => state.reparent)
  const refLink = useStore((state) => state.refLink)
  const mergeCard = useStore((state) => state.mergeCard)
  const exportActive = useStore((state) => state.exportActive)
  const exportAll = useStore((state) => state.exportAll)
  const importFile = useStore((state) => state.importFile)
  const clearAll = useStore((state) => state.clearAll)
  const setProjectSystem = useStore((state) => state.setProjectSystem)
  const continueCard = useStore((state) => state.continueCard)
  const continueFollowUp = useStore((state) => state.continueFollowUp)
  const editCard = useStore((state) => state.editCard)
  const editFollowUp = useStore((state) => state.editFollowUp)
  const backupNow = useStore((state) => state.backupNow)
  const clearAuthRequired = useStore((state) => state.clearAuthRequired)

  const apiBase = useSettings((state) => state.apiBase)
  const locale = useSettings((state) => state.locale)
  const provider = useSettings((state) => state.provider)

  const [drawerOpen, setDrawerOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [overviewOpen, setOverviewOpen] = useState(false)
  const [refPickerOpen, setRefPickerOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [systemValue, setSystemValue] = useState('')
  /** 正在编辑文字的目标（卡片本身，或卡片里的某条追问；null = 没打开编辑面板） */
  const [editTarget, setEditTarget] = useState<{ cardId: string; followUpId: string | null } | null>(
    null,
  )
  const [editPrompt, setEditPrompt] = useState('')
  const [editAnswer, setEditAnswer] = useState('')
  /** 长按某张卡片弹出的快捷菜单 */
  const [quickCardId, setQuickCardId] = useState<string | null>(null)
  /** 合并选择器正在把哪张卡并出去（null = 没打开） */
  const [mergeSourceId, setMergeSourceId] = useState<string | null>(null)
  const [lastBackupAt, setLastBackupAt] = useState<string | null>(() => {
    try {
      return localStorage.getItem(BACKUP_LAST_KEY)
    } catch {
      return null
    }
  })
  /** 数据有改动、还没写自动备份时为 true */
  const dirtyBackup = useRef(false)
  const [mode, setMode] = useState<AskMode>('follow')
  /** 已经选好、还没发出去的附件（发送后随卡片一起存库） */
  const [draftAttachments, setDraftAttachments] = useState<Attachment[]>([])
  /** 中继 / APK 里有没有配 DeepSeek Key（决定联网开关是否可用） */
  const [searchAvailable, setSearchAvailable] = useState(false)
  /** 中继 / APK 里各家订阅有没有配 Key（设置页展示用） */
  const [relayProviders, setRelayProviders] = useState<Record<string, boolean> | null>(null)
  /** 这次提问要不要先联网搜 */
  const [searchOn, setSearchOn] = useState(false)
  /** 浮动跳转按钮：当前是否停在页面底部（决定箭头朝下还是朝上） */
  const [atBottom, setAtBottom] = useState(true)
  /** 页面内容是否超过一屏（没得滚就不显示浮动按钮） */
  const [pageOverflow, setPageOverflow] = useState(false)
  /** APK 首次启动、当前订阅还没有 Key 时，强制先填一次 */
  const [keyNeeded, setKeyNeeded] = useState(() => {
    if (!isNativeApp()) {
      return false
    }
    const provider = useSettings.getState().provider
    return nativeSupportsProviders() ? !nativeHasProviderKey(provider) : !nativeHasKey()
  })
  const [keyValue, setKeyValue] = useState('')
  /** 左右滑切换后新视图的入场方向（'left' = 左滑前进，新页从右滑入；'right' = 右滑返回，新页从左滑入）；动画结束回 null */
  const [slideDir, setSlideDir] = useState<'left' | 'right' | null>(null)
  /** 滑动手势跟手拖动的内容层（直接操作 transform，不走 React state） */
  const paneRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    void hydrate()
  }, [hydrate])

  // 换接口地址（比如从 /api 改成直连地址）后重新拉模型
  useEffect(() => {
    if (ready) {
      void loadModels()
    }
  }, [apiBase, ready, loadModels])

  // 中继/APK 有没有配 DeepSeek Key：决定联网搜索开关是实心可用还是「未开通」；
  // 顺带把各家订阅有没有配 Key 拿回来给设置页展示
  useEffect(() => {
    let alive = true
    void fetchRelayInfo(apiBase).then((info) => {
      if (alive) {
        setSearchAvailable(info?.search === true)
        setRelayProviders(info?.providers ?? null)
      }
    })
    return () => {
      alive = false
    }
  }, [apiBase])

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  // ── 滚动体验 ──
  // 打开卡片前记下树视图的滚动位置，回树时还原；进卡片从顶部开始
  const handleOpenCard = (cardId: string) => {
    const el = mainRef.current
    if (el && view === 'tree') {
      treeScrollRef.current = el.scrollTop
    }
    lastCardIdRef.current = cardId
    openCard(cardId)
  }

  useEffect(() => {
    const el = mainRef.current
    if (!el) {
      return
    }
    if (view === 'tree') {
      el.scrollTop = treeScrollRef.current
    } else {
      el.scrollTop = 0
      // 新卡片从顶部开始看，流式时默认继续跟随
      followRef.current = true
    }
    syncJumpState(el)
  }, [view, activeCardId])

  // 流式自动跟随（仿 DeepSeek 手机端）：
  // - 用户手指在屏幕上时绝不自动滚动（Android WebView 的 scroll 事件是异步节流的，
  //   只靠 scroll 事件判断"用户往上翻了"会慢半拍，出现"往上拖又被拉回底部"的跳页）
  // - 手一松，离底 <120px 才算"愿意跟随"；往回翻过就停，滚回底部附近自动恢复
  // 依赖 ready：hydrate 完成前 <main> 还没渲染、mainRef 是 null，监听必须在 ready 后挂
  useEffect(() => {
    if (!ready) {
      return
    }
    const el = mainRef.current
    if (!el) {
      return
    }
    const onScroll = () => {
      followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
      syncJumpState(el)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    const onResize = () => syncJumpState(el)
    window.addEventListener('resize', onResize)
    // 初始就同步一次：内容超一屏（树很长）时浮动按钮立即正确
    syncJumpState(el)
    return () => {
      el.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onResize)
    }
  }, [ready])

  // 流式输出时自动跟随；内容长高也会让"停在半路"的页面重新判定浮动按钮方向
  useEffect(() => {
    const el = mainRef.current
    if (!el) {
      return
    }
    if (live && view === 'card' && followRef.current && !userTouchRef.current) {
      el.scrollTop = el.scrollHeight
    }
    syncJumpState(el)
  }, [live, view])

  // 左右滑切换（仿手机 App 的层级手势）：
  //   项目抽屉 ←[右滑] 树视图 [左滑]→ 卡片内容 [左滑]→ 全览
  // 浮层开着的时候：右滑 = 关掉最上层浮层（和 Android 返回键同一套逻辑），左滑忽略
  // 依赖 ready：mount 时 <main> 还没渲染，监听必须在 ready 后挂
  useEffect(() => {
    const el = mainRef.current
    if (!ready || !el) {
      return
    }
    let startX = 0
    let startY = 0
    let horizontal = false
    let tracking = false
    /** 手势期间内容层被跟手拖过（松手时决定要不要弹回） */
    let dragged = false
    const overlayOpen =
      drawerOpen ||
      overviewOpen ||
      settingsOpen ||
      refPickerOpen ||
      renameOpen ||
      editTarget !== null ||
      quickCardId !== null ||
      mergeSourceId !== null ||
      keyNeeded
    /** 松手后内容层复位：spring = 带弹回动画（没滑够阈值），否则瞬清（马上要切视图） */
    const resetPane = (spring: boolean) => {
      const pane = paneRef.current
      if (!pane) {
        return
      }
      if (spring && dragged) {
        pane.style.transition = 'transform 200ms var(--ct-ease, ease)'
        pane.style.transform = ''
      } else {
        pane.style.transition = ''
        pane.style.transform = ''
      }
      pane.style.willChange = ''
      dragged = false
    }
    const onTouchStart = (event: TouchEvent) => {
      userTouchRef.current = true
      if (event.touches.length !== 1) {
        tracking = false
        return
      }
      const touch = event.touches[0]
      startX = touch.clientX
      startY = touch.clientY
      horizontal = false
      tracking = true
    }
    const onTouchMove = (event: TouchEvent) => {
      if (!tracking || event.touches.length !== 1) {
        return
      }
      const dx = event.touches[0].clientX - startX
      const dy = event.touches[0].clientY - startY
      if (!horizontal && Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy)) {
        horizontal = true
      }
      // 判定为水平滑动后压掉默认行为，避免同时触发纵向滚动
      if (horizontal) {
        event.preventDefault()
      }
      // 跟手拖动内容层（0.38 阻尼）：transform 走合成器线程，纵滚不受影响
      if (horizontal && !overlayOpen) {
        const pane = paneRef.current
        if (pane) {
          if (!dragged) {
            pane.style.willChange = 'transform'
            dragged = true
          }
          pane.style.transition = 'none'
          pane.style.transform = `translateX(${(dx * 0.38).toFixed(1)}px)`
        }
      }
    }
    const onTouchEnd = (event: TouchEvent) => {
      userTouchRef.current = false
      if (!tracking) {
        return
      }
      tracking = false
      const touch = event.changedTouches[0]
      if (!touch) {
        resetPane(true)
        return
      }
      const dx = touch.clientX - startX
      const dy = touch.clientY - startY
      if (!horizontal || Math.abs(dx) < 64 || Math.abs(dy) >= 48 || Math.abs(dy) * 1.5 > Math.abs(dx)) {
        // 没滑够阈值：内容层弹回原位
        resetPane(true)
        return
      }
      if (dx > 0) {
        if (overlayOpen) {
          // 右滑关浮层：main 没拖（浮层盖着），无需动画
          resetPane(true)
          window.__cardTreeBack?.()
          return
        }
        if (view === 'card') {
          // 卡片 → 树：新视图（树）从左滑入
          resetPane(false)
          setSlideDir('right')
          useStore.getState().backToTree()
        } else {
          // 树 → 抽屉：内容层弹回，抽屉自带滑入动画
          resetPane(true)
          setDrawerOpen(true)
        }
        return
      }
      if (overlayOpen) {
        resetPane(true)
        return
      }
      if (view === 'card') {
        // 卡片视图左滑不做任何事（用户反馈：这里滑出全览容易误触，去掉）
        resetPane(true)
      } else if (lastCardIdRef.current) {
        // 树 → 卡片（最近看过的）：新视图（卡）从右滑入
        resetPane(false)
        setSlideDir('left')
        const target = lastCardIdRef.current
        if (el.scrollTop > 0) {
          treeScrollRef.current = el.scrollTop
        }
        useStore.getState().openCard(target)
      } else {
        resetPane(true)
      }
    }
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: false })
    el.addEventListener('touchend', onTouchEnd)
    el.addEventListener('touchcancel', onTouchEnd)
    return () => {
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
      el.removeEventListener('touchcancel', onTouchEnd)
    }
  }, [
    ready,
    view,
    drawerOpen,
    overviewOpen,
    settingsOpen,
    refPickerOpen,
    renameOpen,
    editTarget,
    quickCardId,
    mergeSourceId,
    keyNeeded,
  ])

  // 项目抽屉打开时，在抽屉面板上右滑关抽屉（main 被遮罩盖住收不到事件，所以单独挂 window）
  useEffect(() => {
    if (!drawerOpen) {
      return
    }
    let startX = 0
    let tracking = false
    let horizontal = false
    const onTouchStart = (event: TouchEvent) => {
      tracking = event.touches.length === 1
      horizontal = false
      if (tracking) {
        startX = event.touches[0].clientX
      }
    }
    const onTouchMove = (event: TouchEvent) => {
      if (!tracking || event.touches.length !== 1) {
        return
      }
      const dx = event.touches[0].clientX - startX
      if (!horizontal && Math.abs(dx) > 12) {
        horizontal = true
      }
    }
    const onTouchEnd = (event: TouchEvent) => {
      if (!tracking) {
        return
      }
      tracking = false
      const touch = event.changedTouches[0]
      if (!touch || !horizontal) {
        return
      }
      if (touch.clientX - startX > 64) {
        setDrawerOpen(false)
      }
    }
    window.addEventListener('touchstart', onTouchStart, { passive: true })
    window.addEventListener('touchmove', onTouchMove, { passive: true })
    window.addEventListener('touchend', onTouchEnd)
    return () => {
      window.removeEventListener('touchstart', onTouchStart)
      window.removeEventListener('touchmove', onTouchMove)
      window.removeEventListener('touchend', onTouchEnd)
    }
  }, [drawerOpen])

  // 给 Android 返回键用：先关浮层，再回树，都不满足就交给系统退出
  useEffect(() => {
    window.__cardTreeBack = () => {
      if (keyNeeded) {
        setKeyNeeded(false)
        return true
      }
      if (quickCardId) {
        setQuickCardId(null)
        return true
      }
      if (editTarget) {
        setEditTarget(null)
        return true
      }
      if (mergeSourceId) {
        setMergeSourceId(null)
        return true
      }
      if (refPickerOpen) {
        setRefPickerOpen(false)
        return true
      }
      if (renameOpen) {
        setRenameOpen(false)
        return true
      }
      if (overviewOpen) {
        setOverviewOpen(false)
        return true
      }
      if (settingsOpen) {
        setSettingsOpen(false)
        return true
      }
      if (drawerOpen) {
        setDrawerOpen(false)
        return true
      }
      if (view === 'card') {
        backToTree()
        return true
      }
      return false
    }
    return () => {
      window.__cardTreeBack = undefined
    }
  }, [
    keyNeeded,
    quickCardId,
    editTarget,
    mergeSourceId,
    refPickerOpen,
    renameOpen,
    overviewOpen,
    settingsOpen,
    drawerOpen,
    view,
    backToTree,
  ])

  // 原生里保存 / 清除 Key 之后重新拉模型
  useEffect(() => {
    window.__cardTreeKeyChanged = () => {
      void loadModels()
    }
    return () => {
      window.__cardTreeKeyChanged = undefined
    }
  }, [loadModels])

  // 网页层热更新的进度与结果（仅 APK）：结束后刷新页面加载新版本
  useEffect(() => {
    window.__cardTreeUpdateProgress = (text) => {
      setUpdateState((current) => ({
        state: 'installing',
        version: current.state === 'available' ? current.version : undefined,
        message: text,
      }))
    }
    window.__cardTreeUpdateDone = (ok, message) => {
      if (ok) {
        setUpdateState({ state: 'idle' })
        showToast(`网页层已更新到 ${message}，即将刷新`)
        // 给 toast 一点时间，然后整页刷新加载新网页层
        window.setTimeout(() => window.location.reload(), 900)
      } else {
        setUpdateState({ state: 'error', message })
      }
    }
    return () => {
      window.__cardTreeUpdateProgress = undefined
      window.__cardTreeUpdateDone = undefined
    }
  }, [])

  // 数据一有改动就记一笔，等退到后台或每 5 分钟写一份自动备份
  useEffect(() => {
    dirtyBackup.current = true
  }, [projects])

  useEffect(() => {
    if (!isNativeApp()) {
      return
    }
    const flush = () => {
      if (!dirtyBackup.current) {
        return
      }
      const saved = useStore.getState().backupNow()
      if (saved) {
        dirtyBackup.current = false
        setLastBackupAt(new Date().toISOString())
      }
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        flush()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', flush)
    const timer = window.setInterval(flush, 5 * 60 * 1000)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', flush)
      window.clearInterval(timer)
    }
  }, [])

  // 401 时直接引导去重新填 Key，而不是只留一句「模型列表加载失败」
  useEffect(() => {
    if (!authRequired) {
      return
    }
    if (isNativeApp()) {
      setKeyNeeded(true)
    }
    showToast(modelsError ?? 'API Key 无效或缺失（401）')
    clearAuthRequired()
  }, [authRequired, modelsError, clearAuthRequired])

  const project = useMemo(
    () => projects.find((item) => item.id === activeProjectId) ?? projects[0] ?? null,
    [projects, activeProjectId],
  )
  const card = useMemo(
    () => (project && activeCardId ? project.cards.find((item) => item.id === activeCardId) ?? null : null),
    [project, activeCardId],
  )
  const isRunning = running !== null
  const cardRunning = Boolean(card && running && running.cardId === card.id)
  const cardLive = card && live && live.cardId === card.id ? live : null
  /** 首次启动引导 Sheet 展示的订阅名 */
  const providerLabel = providerById(provider).label

  /** 引用选择器里能选的卡片：自己和已有的引用都排除掉 */
  const refCandidates = useMemo(() => {
    if (!project || !card) {
      return []
    }
    const taken = new Set(card.refs)
    return project.cards.filter((item) => item.id !== card.id && !taken.has(item.id))
  }, [project, card])

  const quickCard = quickCardId
    ? project?.cards.find((item) => item.id === quickCardId) ?? null
    : null

  /** 合并选择器的源卡（正在把这张并出去） */
  const mergeSource = mergeSourceId
    ? project?.cards.find((item) => item.id === mergeSourceId) ?? null
    : null

  /** 合并选择器里能选的目标卡：自己和祖先、子孙、生成中的卡都不能并 */
  const mergeCandidates = useMemo(() => {
    if (!project || !mergeSource) {
      return []
    }
    return project.cards.filter((item) => canMerge(project, mergeSource.id, item.id))
  }, [project, mergeSource])

  /** 选好文件：压缩图片 / 读文本，最多 MAX_ATTACHMENTS 个；失败的文件用 toast 说明 */
  const addDraftFiles = (files: File[]) => {
    if (files.length === 0) {
      return
    }
    const room = MAX_ATTACHMENTS - draftAttachments.length
    if (room <= 0) {
      showToast(`最多 ${MAX_ATTACHMENTS} 个附件，先移除一个再选`)
      return
    }
    void readAttachmentFiles(files, room).then(({ attachments, errors }) => {
      if (attachments.length > 0) {
        setDraftAttachments((current) => [...current, ...attachments].slice(0, MAX_ATTACHMENTS))
      }
      if (errors.length > 0) {
        showToast(errors[0])
      }
    })
  }

  const removeDraftAttachment = (id: string) => {
    setDraftAttachments((current) => current.filter((item) => item.id !== id))
  }

  /** 发出去之后清空草稿；附件本体已经在卡片里了 */
  const takeDraft = (): Attachment[] => {
    const attachments = draftAttachments
    setDraftAttachments([])
    return attachments
  }
  /** 重新问一次服务端：联网搜索的 Key 配好了没、各家订阅配了哪几家 */
  const refreshSearch = () => {
    void fetchRelayInfo(useSettings.getState().apiBase).then((info) => {
      setSearchAvailable(info?.search === true)
      setRelayProviders(info?.providers ?? null)
    })
  }

  /** 联网搜索开关：服务端没配 DeepSeek Key 时，引导去设置里配 */
  const toggleSearch = () => {
    if (!searchAvailable) {
      showToast(
        isNativeApp()
          ? '联网搜索还没开通：到「设置 → 联网搜索」填一把 DeepSeek API Key'
          : '联网搜索还没开通：电脑上的中继需要配置 DEEPSEEK_API_KEY 后重启',
      )
      setSettingsOpen(true)
      return
    }
    setSearchOn((current) => !current)
  }

  const openEdit = (cardId: string, followUpId: string | null = null) => {
    const target = project?.cards.find((item) => item.id === cardId)
    if (!target) {
      return
    }
    const source =
      followUpId === null
        ? { prompt: target.prompt, answer: target.answer }
        : target.followUps.find((item) => item.id === followUpId)
    if (!source) {
      return
    }
    setQuickCardId(null)
    setEditTarget({ cardId, followUpId })
    setEditPrompt(source.prompt)
    setEditAnswer(source.answer)
  }

  /** 把一张卡片（问题 + 回答 + 来源）生成长图：APK 里存进「下载/CardTree」，网页里直接下载 */
  const handleShareCard = (cardId: string) => {
    if (!project) {
      return
    }
    const target = project.cards.find((item) => item.id === cardId)
    if (!target) {
      return
    }
    const dataUrl = renderCardImage(project, target)
    if (!dataUrl) {
      showToast('生成长图失败')
      return
    }
    const saved = saveNativeImage(dataUrl, 'card.png')
    if (saved) {
      showToast(`长图已保存到 ${saved}`)
      return
    }
    downloadCardImage(dataUrl, target.prompt)
  }

  const confirmAction = (message: string, action: () => void) => {
    // oxlint-disable-next-line no-alert -- 删除类操作需要一个系统级确认，移动端原生 confirm 最省事
    if (window.confirm(message)) {
      action()
    }
  }

  if (!ready || !project) {
    return (
      <div className={styles.loading} role="status">
        正在打开卡片树…
      </div>
    )
  }

  const headerTitle = view === 'card' && card ? card.prompt : project.title

  return (
    <div ref={frameRef} className={styles.frame}>
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          {view === 'card' ? (
            <IconButton
              icon={
                <span className={styles.backIcon}>
                  <IconChevronRightOutline14 />
                </span>
              }
              size="m"
              tooltip="返回树"
              onClick={backToTree}
            />
          ) : (
            <IconButton
              icon={<IconMenuOutline20 />}
              size="m"
              tooltip="探索项目"
              onClick={() => setDrawerOpen(true)}
            />
          )}
          <button
            type="button"
            className={styles.title}
            title={headerTitle}
            onClick={() => {
              if (view === 'tree') {
                setRenameValue(project.title)
                setSystemValue(project.system ?? '')
                setRenameOpen(true)
              }
            }}
          >
            {headerTitle}
          </button>
          {view === 'tree' ? (
            <span className={styles.titleCount}>{project.cards.length} 张</span>
          ) : null}
        </div>
        <div className={styles.headerRight}>
          {view === 'tree' && project.cards.length > 0 ? (
            <IconButton
              icon={<IconDataOutline16 />}
              size="m"
              tooltip="全览"
              onClick={() => setOverviewOpen(true)}
            />
          ) : null}
          <IconButton
            icon={<IconSettingsOutline16 />}
            size="m"
            tooltip="设置"
            onClick={() => setSettingsOpen(true)}
          />
        </div>
      </header>

      <main className={styles.main} ref={mainRef}>
        <div
          ref={paneRef}
          className={styles.slidePane}
          data-dir={slideDir ?? undefined}
          onAnimationEnd={() => {
            if (slideDir !== null) {
              setSlideDir(null)
            }
          }}
        >
        {view === 'card' && card ? (
          <CardView
            project={project}
            card={card}
            live={cardLive}
            running={cardRunning}
            onBranch={() => branch(card.id)}
            onRetry={() => retry(card.id)}
            onDelete={() =>
              confirmAction('删除这张卡片？它下面的卡片会一起被删掉。', () => deleteCard(card.id))
            }
            onEdit={() => openEdit(card.id)}
            onEditFollowUp={(followUpId) => openEdit(card.id, followUpId)}
            onContinueFollowUp={(followUpId) => continueFollowUp(card.id, followUpId)}
            onShare={() => handleShareCard(card.id)}
            onContinue={() => continueCard(card.id)}
            onMerge={() => setMergeSourceId(card.id)}
            onOpenRef={(refId) => openCard(refId)}
            onRemoveRef={(refId) => removeRef(card.id, refId)}
            onAddRef={() => setRefPickerOpen(true)}
            onOpenCard={(cardId) => openCard(cardId)}
          />
        ) : (
          <TreeView
            project={project}
            liveCardId={live?.cardId ?? null}
            liveAnswer={live?.answer ?? ''}
            onOpen={handleOpenCard}
            onQuickMenu={setQuickCardId}
          />
        )}
        </div>
      </main>

      {pageOverflow &&
      !drawerOpen &&
      !overviewOpen &&
      !settingsOpen &&
      !refPickerOpen &&
      !renameOpen &&
      !editTarget &&
      !quickCardId &&
      !mergeSourceId &&
      !keyNeeded ? (
        <button
          type="button"
          className={styles.jumpButton}
          aria-label={atBottom ? '回到顶部' : '跳到底部'}
          onClick={() => {
            const el = mainRef.current
            if (!el) {
              return
            }
            if (atBottom) {
              el.scrollTo({ top: 0 })
              followRef.current = false
            } else {
              el.scrollTo({ top: el.scrollHeight })
              followRef.current = true
            }
          }}
        >
          <span className={clsx(atBottom && styles.jumpIconUp)}>
            <IconChevronDownOutline14 />
          </span>
        </button>
      ) : null}

      <footer className={styles.footer}>
        {view === 'card' && card ? (
          <Composer
            placeholder={mode === 'follow' ? '接着这张卡片追问…' : '这个问题会从当前卡片长出新枝…'}
            modes={ASK_MODES}
            mode={mode}
            onModeChange={setMode}
            running={cardRunning}
            attachments={draftAttachments}
            onAddFiles={addDraftFiles}
            onRemoveAttachment={removeDraftAttachment}
            searchAvailable={searchAvailable}
            searchOn={searchOn}
            onToggleSearch={toggleSearch}
            onSend={(text, nextMode) => ask(text, nextMode, takeDraft(), { search: searchOn })}
            onStop={stop}
          />
        ) : (
          <Composer
            placeholder={
              project.cards.length
                ? '问一个不相关的问题，开一张独立卡片…'
                : '问点什么，长出这棵树的第一张卡片…'
            }
            running={isRunning}
            attachments={draftAttachments}
            onAddFiles={addDraftFiles}
            onRemoveAttachment={removeDraftAttachment}
            searchAvailable={searchAvailable}
            searchOn={searchOn}
            onToggleSearch={toggleSearch}
            onSend={(text) => askRoot(text, takeDraft(), { search: searchOn })}
            onStop={stop}
          />
        )}
      </footer>

      <ProjectDrawer
        open={drawerOpen}
        projects={projects}
        activeProjectId={project.id}
        onSelect={(projectId) => {
          selectProject(projectId)
          setDrawerOpen(false)
        }}
        onCreate={() => {
          createProject()
          setDrawerOpen(false)
        }}
        onDelete={(projectId) =>
          confirmAction('删除这个探索项目？里面所有卡片都会一起删掉。', () => deleteProject(projectId))
        }
        onOpenSettings={() => {
          setDrawerOpen(false)
          setSettingsOpen(true)
        }}
        onClose={() => setDrawerOpen(false)}
      />

      <SettingsSheet
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        models={models}
        modelsLoading={modelsLoading}
        modelsError={modelsError}
        onReloadModels={() => void loadModels()}
        onExportProject={exportActive}
        onExportAll={exportAll}
        onImportFile={(file) => {
          void file
            .text()
            .then((text) => {
              const count = importFile(text)
              showToast(`已导入 ${count} 个项目`)
              setSettingsOpen(false)
            })
            .catch((error: unknown) => {
              showToast(error instanceof Error ? `导入失败：${error.message}` : '导入失败')
            })
        }}
        onClearAll={() =>
          confirmAction('清空这个浏览器里的所有项目和卡片？无法撤销。', () => {
            void clearAll().then(() => {
              showToast('已清空')
              setSettingsOpen(false)
            })
          })
        }
        lastBackupAt={lastBackupAt}
        relayProviders={relayProviders}
        onRefreshSearch={refreshSearch}
        onBackupNow={() => {
          const saved = backupNow()
          if (saved) {
            dirtyBackup.current = false
            setLastBackupAt(new Date().toISOString())
            showToast(`已备份到 ${saved}`)
          } else {
            showToast('备份失败，可以在「导出当前项目」里手动导出')
          }
        }}
      />

      {overviewOpen ? (
        <Overview
          cards={project.cards}
          activeCardId={activeCardId}
          onOpen={(cardId) => {
            handleOpenCard(cardId)
            setOverviewOpen(false)
          }}
          onClose={() => setOverviewOpen(false)}
          onReparent={(cardId, parentId) => reparent(cardId, parentId)}
          onAddRef={(cardId, refId) => refLink(cardId, refId)}
        />
      ) : null}

      <Sheet
        open={refPickerOpen}
        title="引用一张卡片"
        onClose={() => setRefPickerOpen(false)}
      >
        {refCandidates.length ? (
          <div className={styles.picker}>
            {refCandidates.map((item) => (
              <button
                key={item.id}
                type="button"
                className={styles.pickerItem}
                onClick={() => {
                  try {
                    if (card) {
                      addRef(card.id, item.id)
                    }
                  } catch (error) {
                    showToast(error instanceof Error ? error.message : '引用失败')
                  }
                  setRefPickerOpen(false)
                }}
              >
                <span className={styles.pickerText}>{item.prompt}</span>
                {item.answer ? <span className={styles.pickerMeta}>已回答</span> : null}
              </button>
            ))}
          </div>
        ) : (
          <p className={styles.pickerEmpty}>没有可以引用的其它卡片了</p>
        )}
      </Sheet>

      <Sheet
        open={mergeSourceId !== null}
        title="并入哪张卡片"
        onClose={() => setMergeSourceId(null)}
      >
        {mergeSource ? (
          <p className={styles.keyFine}>
            把「{mergeSource.prompt}」并入你在下面点的那张卡片：
            源卡片会被删掉，它的追问、子卡片和引用都会转到目标卡片上，两个回答会拼在一起。
          </p>
        ) : null}
        {mergeCandidates.length ? (
          <div className={styles.picker}>
            {mergeCandidates.map((item) => (
              <button
                key={item.id}
                type="button"
                className={styles.pickerItem}
                onClick={() => {
                  if (!mergeSource) {
                    return
                  }
                  const sourcePrompt = mergeSource.prompt
                  const targetPrompt = item.prompt
                  confirmAction(
                    `把「${sourcePrompt}」并入「${targetPrompt}」？源卡片会被删掉，它的追问、子卡片和引用都会转到目标卡片上。`,
                    () => {
                      const ok = mergeCard(mergeSource.id, item.id)
                      setMergeSourceId(null)
                      showToast(ok ? '已并入' : '这两张卡片不能合并')
                    },
                  )
                }}
              >
                <span className={styles.pickerText}>{item.prompt}</span>
                {item.answer ? <span className={styles.pickerMeta}>已回答</span> : null}
              </button>
            ))}
          </div>
        ) : (
          <p className={styles.pickerEmpty}>
            没有可以并入的其它卡片：自己、祖先和子孙不能并，正在生成的卡片也不行。
          </p>
        )}
      </Sheet>

      <Sheet open={renameOpen} title="项目设置" onClose={() => setRenameOpen(false)}>
        <form
          className={styles.editForm}
          onSubmit={(event) => {
            event.preventDefault()
            renameProject(project.id, renameValue)
            setProjectSystem(project.id, systemValue)
            setRenameOpen(false)
            showToast('项目设置已保存')
          }}
        >
          <label className={styles.editLabel} htmlFor="project-title">
            项目名称
          </label>
          <input
            id="project-title"
            className={styles.editInput}
            value={renameValue}
            autoFocus
            onChange={(event) => setRenameValue(event.target.value)}
          />
          <label className={styles.editLabel} htmlFor="project-system">
            项目背景与规则
          </label>
          <textarea
            id="project-system"
            className={styles.systemInput}
            value={systemValue}
            rows={4}
            placeholder="比如：用高中生能懂的语言解释；每次都给一个具体例子。"
            onChange={(event) => setSystemValue(event.target.value)}
          />
          <p className={styles.keyFine}>
            这段文字会加在每次提问的最前面，作为这个探索项目里所有卡片的共同约定。留空就用默认规则。
          </p>
          <div className={styles.editActions}>
            <button type="submit" className={styles.keyButton}>
              保存
            </button>
          </div>
        </form>
      </Sheet>

      <Sheet
        open={editTarget !== null}
        title={editTarget?.followUpId ? '编辑追问文字' : '编辑卡片文字'}
        onClose={() => setEditTarget(null)}
      >
        <form
          className={styles.editForm}
          onSubmit={(event) => {
            event.preventDefault()
            const target = editTarget
            if (!target) {
              return
            }
            try {
              if (target.followUpId === null) {
                editCard(target.cardId, { prompt: editPrompt, answer: editAnswer })
              } else {
                editFollowUp(target.cardId, target.followUpId, {
                  prompt: editPrompt,
                  answer: editAnswer,
                })
              }
              setEditTarget(null)
              showToast('已更新')
            } catch (error) {
              showToast(error instanceof Error ? error.message : '保存失败')
            }
          }}
        >
          <label className={styles.editLabel} htmlFor="edit-prompt">
            问题
          </label>
          <textarea
            id="edit-prompt"
            className={styles.systemInput}
            value={editPrompt}
            rows={2}
            onChange={(event) => setEditPrompt(event.target.value)}
          />
          <label className={styles.editLabel} htmlFor="edit-answer">
            回答（可以直接改，不会重新调用模型）
          </label>
          <textarea
            id="edit-answer"
            className={styles.systemInput}
            value={editAnswer}
            rows={7}
            onChange={(event) => setEditAnswer(event.target.value)}
          />
          <div className={styles.editActions}>
            <button type="button" className={styles.quickItem} onClick={() => setEditTarget(null)}>
              取消
            </button>
            <button type="submit" className={styles.keyButton}>
              保存
            </button>
          </div>
        </form>
      </Sheet>

      <Sheet
        open={quickCard !== null}
        title={quickCard ? quickCard.prompt : '卡片操作'}
        onClose={() => setQuickCardId(null)}
      >
        <div className={styles.quickList}>
          <button
            type="button"
            className={styles.quickItem}
            onClick={() => {
              if (quickCard) {
                handleOpenCard(quickCard.id)
              }
              setQuickCardId(null)
            }}
          >
            打开卡片
          </button>
          <button
            type="button"
            className={styles.quickItem}
            onClick={() => {
              if (quickCard) {
                openEdit(quickCard.id)
              }
            }}
          >
            编辑文字
          </button>
          {quickCard?.answer ? (
            <button
              type="button"
              className={styles.quickItem}
              onClick={() => {
                if (quickCard) {
                  handleShareCard(quickCard.id)
                }
                setQuickCardId(null)
              }}
            >
              分享成长图
            </button>
          ) : null}
          <button
            type="button"
            className={styles.quickItem}
            onClick={() => {
              if (quickCard) {
                handleOpenCard(quickCard.id)
                setQuickCardId(null)
                setRefPickerOpen(true)
              }
            }}
          >
            引用一张卡片…
          </button>
          <button
            type="button"
            className={styles.quickItem}
            onClick={() => {
              if (quickCard) {
                branch(quickCard.id)
              }
              setQuickCardId(null)
            }}
          >
            换角度重答
          </button>
          {quickCard && project.cards.some((item) => canMerge(project, quickCard.id, item.id)) ? (
            <button
              type="button"
              className={styles.quickItem}
              onClick={() => {
                setQuickCardId(null)
                setMergeSourceId(quickCard.id)
              }}
            >
              并入另一张卡…
            </button>
          ) : null}
          {quickCard?.status === 'partial' ? (
            <button
              type="button"
              className={styles.quickItem}
              onClick={() => {
                if (quickCard) {
                  continueCard(quickCard.id)
                }
                setQuickCardId(null)
              }}
            >
              继续生成
            </button>
          ) : null}
          <button
            type="button"
            className={clsx(styles.quickItem, styles.quickDanger)}
            onClick={() => {
              const cardId = quickCard?.id
              setQuickCardId(null)
              if (cardId) {
                confirmAction('删除这张卡片？它下面的卡片会一起被删掉。', () => deleteCard(cardId))
              }
            }}
          >
            删除卡片
          </button>
        </div>
      </Sheet>

      <Sheet open={keyNeeded} title={`先连上 ${providerLabel}`} onClose={() => setKeyNeeded(false)}>
        <form
          className={styles.keyForm}
          onSubmit={(event) => {
            event.preventDefault()
            const value = keyValue.trim()
            if (!value) {
              showToast('先粘贴一下 API Key')
              return
            }
            const saved = nativeSupportsProviders()
              ? saveNativeProviderKey(useSettings.getState().provider, value)
              : saveNativeKey(value)
            if (!saved) {
              showToast('保存失败，再试一次')
              return
            }
            setKeyValue('')
            setKeyNeeded(false)
            showToast('已保存，开始用吧')
            void loadModels()
          }}
        >
          <p className={styles.keyHint}>
            把 {providerLabel} 的 API Key 粘在这里。它会加密保存在这台手机上（Android Keystore），
            之后打开就能直接提问，不需要电脑。其它订阅可以之后在「设置 → 订阅与模型」里切换并各自填 Key。
          </p>
          <input
            className={styles.keyInput}
            type="password"
            value={keyValue}
            placeholder="sk-…"
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setKeyValue(event.target.value)}
          />
          <button type="submit" className={styles.keyButton}>
            保存并开始
          </button>
          <p className={styles.keyFine}>没有 Key？可以在对应订阅的官网 / 客户端账号页生成。</p>
        </form>
      </Sheet>

      <Toast />
    </div>
  )
}
