/**
 * 卡片树全览图：手机全屏覆盖层，用 SVG 画出整棵树。
 *
 * 布局不依赖 Card.pos（可能为 null）：按 parentId 递归累加子树宽度，深度决定 y，
 * 同一父节点下按 cards 数组顺序水平排开，整棵树水平居中。交互支持单指平移、双指捏合
 * 缩放、滚轮缩放；点击节点（移动 < 8px 才算点击）回调 onOpen，Escape 关闭。
 * 当前卡片用强调色填充，它的祖先链与根节点用强调色描边、祖先链连线高亮。
 */

import clsx from 'clsx'
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  TouchEvent as ReactTouchEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { MAX_REFS } from '../../services/tree/types.js'
import type { Card, CardMode } from '../../services/tree/types.js'
import { IconButton } from '../base/IconButton.js'
import { IconCloseOutline16 } from '../base/icons.js'
import { showToast } from '../base/toastState.js'
import styles from './Overview.module.css'

export type OverviewProps = {
  cards: Card[]
  activeCardId: string | null
  onOpen: (cardId: string) => void
  onClose: () => void
  /** 拖到另一张卡片上挂成它的子卡片；拖到空白处（parentId=null）摘成根卡片 */
  onReparent: (cardId: string, parentId: string | null) => boolean
  /** 从节点右侧把手拉一条线到另一张卡片，加一条引用 */
  onAddRef: (cardId: string, refId: string) => boolean
}

/** 节点尺寸、层距与兄弟间距（SVG 不设 viewBox，单位即 CSS px） */
const NODE_WIDTH = 128
const NODE_HEIGHT = 40
const NODE_RADIUS = 12
const NODE_PADDING_X = 10
const LEVEL_GAP = 84
const SIBLING_GAP = 20
const ROOT_GAP = 40

/** 初始取景留白：左右各 24，上下留出标题栏与底部提示 */
const FIT_PADDING_X = 48
const FIT_PADDING_Y = 168

/** 缩放范围与 +/− 按钮步进 */
const MIN_SCALE = 0.5
const MAX_SCALE = 2.5
const ZOOM_STEP = 1.4

/** 指针移动超过这个距离就不算点击 */
const TAP_SLOP = 8

/** 节点文字：字号 12px 下按半角宽度截断（中文按 2 宽度算），最多约 9 个汉字 */
const PROMPT_FONT_SIZE = 12
const PROMPT_MAX_UNITS = Math.floor(((NODE_WIDTH - NODE_PADDING_X * 2) / PROMPT_FONT_SIZE) * 2)

const EMPTY_PROMPT = '空白提问'

const MODE_LABEL: Record<CardMode, string> = {
  root: '根',
  child: '深入',
  diverge: '发散',
  branch: '分支',
  isolated: '独立',
}

type Transform = { scale: number; x: number; y: number }

type LayoutNode = { card: Card; x: number; y: number; depth: number }

type LayoutEdge = { from: LayoutNode; to: LayoutNode }

type Layout = {
  nodes: LayoutNode[]
  edges: LayoutEdge[]
  /** 卡片 id -> 布局后的节点 */
  index: Map<string, LayoutNode>
  /** 卡片 id -> 原始卡片，用来沿 parentId 找祖先链 */
  byId: Map<string, Card>
  bbox: { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number }
}

type PanGesture = {
  kind: 'pan'
  /** 鼠标 / 触控笔的 pointerId；触摸手势为 null */
  pointerId: number | null
  startClientX: number
  startClientY: number
  origin: Transform
  /** 是否已经超过点击容差 */
  moved: boolean
  /** 按下时命中的卡片，抬手时未移动就打开它 */
  cardId: string | null
}

type PinchGesture = {
  kind: 'pinch'
  startDistance: number
  startMidX: number
  startMidY: number
  origin: Transform
}

type DragGesture = {
  kind: 'drag'
  /** 鼠标 / 触控笔的 pointerId；触摸手势为 null */
  pointerId: number | null
  /** 被拖动的卡片 */
  cardId: string
  /** true = 从右侧把手拉引用线；false = 拖节点改父级 */
  link: boolean
  startClientX: number
  startClientY: number
  /** 是否已经超过点击容差 */
  moved: boolean
}

type Gesture = { kind: 'idle' } | PanGesture | PinchGesture | DragGesture

/** 拖动过程中要画出来的浮层状态（坐标是视口内的 CSS px） */
type DragState = {
  cardId: string
  link: boolean
  x: number
  y: number
  /** 当前手指/鼠标下面压着的卡片，空白处为 null */
  overId: string | null
  valid: boolean
  /** 底部提示文案：能不能放手、为什么不能 */
  hint: string
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max)

/** 全角字符记 2 个半角宽度，其它记 1（中文、日文、韩文、全角标点、emoji） */
const charUnits = (char: string): number => {
  const codePoint = char.codePointAt(0) ?? 0
  const wide =
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe4f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff)
  return wide ? 2 : 1
}

/** 把问题压成一行并按半角宽度截断，超长补省略号 */
const truncatePrompt = (prompt: string): string => {
  const text = prompt.replace(/\s+/g, ' ').trim()
  if (text.length === 0) {
    return EMPTY_PROMPT
  }
  let units = 0
  let result = ''
  for (const char of text) {
    const nextUnits = units + charUnits(char)
    if (nextUnits > PROMPT_MAX_UNITS) {
      return `${result}…`
    }
    units = nextUnits
    result += char
  }
  return result
}

/** 父节点底部到子节点顶部的三次贝塞尔连线 */
const edgePath = (from: LayoutNode, to: LayoutNode): string => {
  const startX = from.x
  const startY = from.y + NODE_HEIGHT / 2
  const endX = to.x
  const endY = to.y - NODE_HEIGHT / 2
  const middleY = (startY + endY) / 2
  return `M${startX} ${startY}C${startX} ${middleY} ${endX} ${middleY} ${endX} ${endY}`
}

/** 拖动时从源节点连到手指的曲线（世界坐标 → 屏幕坐标后画在覆盖层上） */
const dragLine = (from: LayoutNode, state: DragState, transform: Transform): string => {
  const startX = transform.x + from.x * transform.scale
  const startY = transform.y + from.y * transform.scale
  const middleY = (startY + state.y) / 2
  return `M${startX} ${startY}C${startX} ${middleY} ${state.x} ${middleY} ${state.x} ${state.y}`
}

/** 从事件目标往上找最近的卡片节点，返回它的 id */
const cardIdFromTarget = (target: EventTarget | null): string | null => {
  if (!(target instanceof Element)) {
    return null
  }
  const element = target.closest('[data-card-id]')
  return element === null ? null : element.getAttribute('data-card-id')
}

/** 按在节点右侧把手上 = 拉引用线，按在节点本体 = 改父级 */
const isLinkHandle = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest('[data-link-handle]') !== null

/**
 * 计算卡片树布局：递归累加子树宽度，深度决定 y，兄弟顺序取 cards 数组顺序。
 * 父子数据成环时会退化成「多棵树」，不会递归死掉。
 */
const buildLayout = (cards: Card[]): Layout => {
  const byId = new Map<string, Card>()
  const ordered: Card[] = []
  for (const card of cards) {
    if (byId.has(card.id)) {
      continue
    }
    byId.set(card.id, card)
    ordered.push(card)
  }

  const childrenOf = new Map<string, Card[]>()
  const roots: Card[] = []
  for (const card of ordered) {
    const parent = card.parentId === null ? undefined : byId.get(card.parentId)
    if (parent !== undefined && parent.id !== card.id) {
      const siblings = childrenOf.get(parent.id)
      if (siblings === undefined) {
        childrenOf.set(parent.id, [card])
      } else {
        siblings.push(card)
      }
    } else {
      roots.push(card)
    }
  }

  // 子树宽度：叶子为一个节点宽；父节点为所有子树宽度之和，节点居中在子树带上
  const widths = new Map<string, number>()
  const widthOf = (card: Card): number => {
    const cached = widths.get(card.id)
    if (cached !== undefined) {
      return cached
    }
    // 先写占位值，父子成环时也能收敛
    widths.set(card.id, NODE_WIDTH)
    const children = childrenOf.get(card.id) ?? []
    let width = NODE_WIDTH
    if (children.length > 0) {
      let total = SIBLING_GAP * (children.length - 1)
      for (const child of children) {
        total += widthOf(child)
      }
      width = Math.max(total, NODE_WIDTH)
    }
    widths.set(card.id, width)
    return width
  }

  const index = new Map<string, LayoutNode>()
  const place = (card: Card, left: number, depth: number): void => {
    if (index.has(card.id)) {
      return
    }
    const node: LayoutNode = {
      card,
      x: left + widthOf(card) / 2,
      y: depth * LEVEL_GAP + NODE_HEIGHT / 2,
      depth,
    }
    // 先登记再递归，环状 parentId 不会无限递归
    index.set(card.id, node)
    const children = (childrenOf.get(card.id) ?? []).filter((child) => !index.has(child.id))
    if (children.length === 0) {
      return
    }
    const childCenters: number[] = []
    let cursor = left
    for (const child of children) {
      place(child, cursor, depth + 1)
      childCenters.push(cursor + widthOf(child) / 2)
      cursor += widthOf(child) + SIBLING_GAP
    }
    node.x = (childCenters[0] + childCenters[childCenters.length - 1]) / 2
  }

  let cursorX = 0
  for (const root of roots) {
    if (index.has(root.id)) {
      continue
    }
    place(root, cursorX, 0)
    cursorX += widthOf(root) + ROOT_GAP
  }
  // 兜底：成环等原因没能从根遍历到的卡片，按独立卡片排在后面
  for (const card of ordered) {
    if (index.has(card.id)) {
      continue
    }
    place(card, cursorX, 0)
    cursorX += widthOf(card) + ROOT_GAP
  }

  const nodes = [...index.values()]
  const edges: LayoutEdge[] = []
  for (const node of nodes) {
    const parentId = node.card.parentId
    if (parentId === null) {
      continue
    }
    const parent = index.get(parentId)
    if (parent === undefined || parent.card.id === node.card.id) {
      continue
    }
    edges.push({ from: parent, to: node })
  }

  let minX = 0
  let minY = 0
  let maxX = 0
  let maxY = 0
  if (nodes.length > 0) {
    minX = Number.POSITIVE_INFINITY
    minY = Number.POSITIVE_INFINITY
    maxX = Number.NEGATIVE_INFINITY
    maxY = Number.NEGATIVE_INFINITY
    for (const node of nodes) {
      minX = Math.min(minX, node.x - NODE_WIDTH / 2)
      minY = Math.min(minY, node.y - NODE_HEIGHT / 2)
      maxX = Math.max(maxX, node.x + NODE_WIDTH / 2)
      maxY = Math.max(maxY, node.y + NODE_HEIGHT / 2)
    }
  }

  return {
    nodes,
    edges,
    index,
    byId,
    bbox: { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY },
  }
}

const IconZoomIn = () => (
  <svg width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path
      d="M7.25 3.25H8.75V7.25H12.75V8.75H8.75V12.75H7.25V8.75H3.25V7.25H7.25V3.25Z"
      fill="currentColor"
    />
  </svg>
)

const IconZoomOut = () => (
  <svg width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M3.25 7.25H12.75V8.75H3.25V7.25Z" fill="currentColor" />
  </svg>
)

export const Overview = ({
  cards,
  activeCardId,
  onOpen,
  onClose,
  onReparent,
  onAddRef,
}: OverviewProps) => {
  const titleId = useId()
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const gestureRef = useRef<Gesture>({ kind: 'idle' })
  const dragRef = useRef<DragState | null>(null)
  const nodeRefs = useRef(new Map<string, SVGGElement>())
  const [view, setView] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }))
  const [userTransform, setUserTransform] = useState<Transform | null>(null)
  const [drag, setDrag] = useState<DragState | null>(null)

  const layout = useMemo(() => buildLayout(cards), [cards])


  // 当前卡片 + 祖先链：顺着 parentId 走到根，环状数据靠 ids 判重兜住
  const chainIds = useMemo(() => {
    const ids = new Set<string>()
    let cursor = activeCardId
    while (cursor !== null && !ids.has(cursor)) {
      ids.add(cursor)
      cursor = layout.byId.get(cursor)?.parentId ?? null
    }
    return ids
  }, [layout, activeCardId])

  // 挂载时（以及 activeCardId 变化时）算初始缩放平移：整棵树尽量放进视口，
  // 再把当前卡片落到视口中间偏下；用户一旦手动平移/缩放就以 userTransform 为准
  const autoTransform = useMemo<Transform>(() => {
    const { nodes, bbox, index } = layout
    if (nodes.length === 0) {
      return { scale: 1, x: 0, y: 0 }
    }
    const fitScale = clamp(
      Math.min(
        (view.width - FIT_PADDING_X) / Math.max(bbox.width, 1),
        (view.height - FIT_PADDING_Y) / Math.max(bbox.height, 1),
        1
      ),
      MIN_SCALE,
      1
    )
    const active = activeCardId === null ? undefined : index.get(activeCardId)
    if (active !== undefined) {
      return {
        scale: fitScale,
        x: view.width / 2 - active.x * fitScale,
        y: view.height * 0.62 - active.y * fitScale,
      }
    }
    return {
      scale: fitScale,
      x: view.width / 2 - ((bbox.minX + bbox.maxX) / 2) * fitScale,
      y: view.height / 2 - ((bbox.minY + bbox.maxY) / 2) * fitScale,
    }
  }, [layout, view, activeCardId])

  // 当前卡片变了（比如在树里点了另一张卡）就丢掉手动视图，重新按新卡片取景
  useEffect(() => {
    setUserTransform(null)
  }, [activeCardId])

  const transform = userTransform ?? autoTransform
  // 手势事件里要读最新变换：渲染时同步到 ref，事件里先写 ref 再 setState，连续手势不丢帧
  const transformRef = useRef(transform)
  transformRef.current = transform

  const applyTransform = useCallback((next: Transform) => {
    transformRef.current = next
    setUserTransform(next)
  }, [])

  const setDragState = (next: DragState | null) => {
    dragRef.current = next
    setDrag(next)
  }

  /** 顺着 parentId 往上走，判断 candidateId 是不是 cardId 自己或它的子孙（环状数据用 seen 兜住） */
  const isSelfOrDescendant = useCallback(
    (cardId: string, candidateId: string): boolean => {
      let cursor: string | null = candidateId
      const seen = new Set<string>()
      while (cursor !== null && !seen.has(cursor)) {
        if (cursor === cardId) {
          return true
        }
        seen.add(cursor)
        cursor = layout.byId.get(cursor)?.parentId ?? null
      }
      return false
    },
    [layout]
  )

  /** 算出「松手会发生什么」：目标卡、能不能放、提示语 */
  const describeDrop = useCallback(
    (cardId: string, overId: string | null, link: boolean): Omit<DragState, 'x' | 'y'> => {
      const source = layout.byId.get(cardId)
      const target = overId === null ? undefined : layout.byId.get(overId)
      const base = { cardId, link, overId }
      if (source === undefined) {
        return { ...base, valid: false, hint: '' }
      }
      if (link) {
        if (target === undefined) {
          return { ...base, valid: false, hint: '拉到一个卡片上，建立引用' }
        }
        if (target.id === source.id) {
          return { ...base, valid: false, hint: '不能引用自己' }
        }
        if (source.refs.includes(target.id) || target.refs.includes(source.id)) {
          return { ...base, valid: false, hint: '这两张卡片已经有引用了' }
        }
        if (source.refs.length >= MAX_REFS) {
          return { ...base, valid: false, hint: `引用已满（最多 ${MAX_REFS} 张）` }
        }
        return { ...base, valid: true, hint: '松手，把这张卡片加进引用' }
      }
      if (source.status === 'running') {
        return { ...base, valid: false, hint: '正在生成的卡片不能移动' }
      }
      if (target === undefined) {
        if (source.parentId === null) {
          return { ...base, valid: false, hint: '把卡片拖到另一张卡片上，就能改上级' }
        }
        return { ...base, valid: true, hint: '松手，移出这棵树，变成一张根卡片' }
      }
      if (target.id === source.id) {
        return { ...base, valid: false, hint: '不能挂到自己下面' }
      }
      if (source.parentId === target.id) {
        return { ...base, valid: false, hint: '它已经在这张卡片下面了' }
      }
      if (isSelfOrDescendant(source.id, target.id)) {
        return { ...base, valid: false, hint: '不能挂到自己的子卡片下面' }
      }
      return { ...base, valid: true, hint: '松手，挂到这张卡片下面' }
    },
    [layout, isSelfOrDescendant]
  )

  /** 松手：按当前拖拽状态落库，并给一句反馈 */
  const commitDrop = () => {
    const state = dragRef.current
    setDragState(null)
    if (state === null || !state.valid) {
      return
    }
    if (state.overId === null) {
      if (onReparent(state.cardId, null)) {
        showToast('已移出这棵树')
      }
      return
    }
    const target = layout.byId.get(state.overId)
    if (target === undefined) {
      return
    }
    if (state.link) {
      if (onAddRef(state.cardId, target.id)) {
        showToast(`已引用「${truncatePrompt(target.prompt)}」`)
      }
      return
    }
    if (onReparent(state.cardId, target.id)) {
      showToast(`已挂到「${truncatePrompt(target.prompt)}」下面`)
    }
  }

  const zoomAround = useCallback(
    (factor: number, centerX: number, centerY: number) => {
      const current = transformRef.current
      const nextScale = clamp(current.scale * factor, MIN_SCALE, MAX_SCALE)
      if (nextScale === current.scale) {
        return
      }
      // 以 (centerX, centerY) 为锚：锚点下的世界坐标保持不动
      const ratio = nextScale / current.scale
      applyTransform({
        scale: nextScale,
        x: centerX - (centerX - current.x) * ratio,
        y: centerY - (centerY - current.y) * ratio,
      })
    },
    [applyTransform]
  )

  // 覆盖层虽然 inset: 0，仍精确测量画布可用区域（标题栏、底部提示、旋屏、键盘弹出）
  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (viewport === null) {
      return
    }
    const update = () => {
      const width = viewport.clientWidth
      const height = viewport.clientHeight
      setView((previous) =>
        previous.width === width && previous.height === height ? previous : { width, height }
      )
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [])

  // 打开后把焦点收进对话框
  useEffect(() => {
    overlayRef.current?.focus()
  }, [])

  // Escape 关闭（桌面调试用）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return
      }
      onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  // 滚轮缩放：react 的 onWheel 是 passive 的，这里手动挂原生监听才能 preventDefault
  useEffect(() => {
    const viewport = viewportRef.current
    if (viewport === null) {
      return
    }
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = viewport.getBoundingClientRect()
      // 触控板捏合会带 ctrlKey，尺度更细
      const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0015))
      zoomAround(factor, event.clientX - rect.left, event.clientY - rect.top)
    }
    viewport.addEventListener('wheel', onWheel, { passive: false })
    return () => viewport.removeEventListener('wheel', onWheel)
  }, [zoomAround])

  const localPoint = (clientX: number, clientY: number): { x: number; y: number } => {
    const viewport = viewportRef.current
    if (viewport === null) {
      return { x: clientX, y: clientY }
    }
    const rect = viewport.getBoundingClientRect()
    return { x: clientX - rect.left, y: clientY - rect.top }
  }

  /**
   * 手指比卡片大得多（缩到 0.4 时一个节点只有几十像素），
   * 所以除了「正好按在卡片上」，还允许落在卡片附近——离得最近且不超过 30px 就算命中。
   */
  const nearestCardId = (clientX: number, clientY: number): string | null => {
    let bestId: string | null = null
    let bestDistance = 30
    nodeRefs.current.forEach((element, id) => {
      if (!element.isConnected) {
        return
      }
      const rect = element.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) {
        return
      }
      const dx =
        clientX < rect.left ? rect.left - clientX : clientX > rect.right ? clientX - rect.right : 0
      const dy =
        clientY < rect.top ? rect.top - clientY : clientY > rect.bottom ? clientY - rect.bottom : 0
      const distance = Math.hypot(dx, dy)
      if (distance <= bestDistance) {
        bestDistance = distance
        bestId = id
      }
    })
    return bestId
  }

  /** 先按元素命中，再按屏幕距离兜底（手机上更容易拖对） */
  const hitCardIdFromTarget = (
    target: EventTarget | null,
    clientX: number,
    clientY: number
  ): string | null => cardIdFromTarget(target) ?? nearestCardId(clientX, clientY)

  const resetGesture = () => {
    gestureRef.current = { kind: 'idle' }
    setDragState(null)
  }

  const handleTouchStart = (event: ReactTouchEvent<HTMLDivElement>) => {
    const first = event.touches.item(0)
    const second = event.touches.item(1)
    if (first !== null && second !== null) {
      // 双指：记录两指中点与距离，后续以中点为锚缩放，同时允许双指平移
      setDragState(null)
      const middle = localPoint(
        (first.clientX + second.clientX) / 2,
        (first.clientY + second.clientY) / 2
      )
      gestureRef.current = {
        kind: 'pinch',
        startDistance: Math.max(
          Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY),
          1
        ),
        startMidX: middle.x,
        startMidY: middle.y,
        origin: transformRef.current,
      }
      return
    }
    if (first === null) {
      return
    }
    // 按在卡片上：准备拖动（松手前移动不超过 8px 仍算点击，走 onOpen）
    const hitCardId = hitCardIdFromTarget(event.target, first.clientX, first.clientY)
    if (hitCardId !== null) {
      gestureRef.current = {
        kind: 'drag',
        pointerId: null,
        cardId: hitCardId,
        link: isLinkHandle(event.target),
        startClientX: first.clientX,
        startClientY: first.clientY,
        moved: false,
      }
      return
    }
    gestureRef.current = {
      kind: 'pan',
      pointerId: null,
      startClientX: first.clientX,
      startClientY: first.clientY,
      origin: transformRef.current,
      moved: false,
      cardId: null,
    }
  }

  const handleTouchMove = (event: ReactTouchEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current
    if (gesture.kind === 'pinch') {
      const first = event.touches.item(0)
      const second = event.touches.item(1)
      if (first === null || second === null) {
        return
      }
      const distance = Math.max(
        Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY),
        1
      )
      const middle = localPoint(
        (first.clientX + second.clientX) / 2,
        (first.clientY + second.clientY) / 2
      )
      const nextScale = clamp(
        gesture.origin.scale * (distance / gesture.startDistance),
        MIN_SCALE,
        MAX_SCALE
      )
      // 让开始时按住的「世界坐标点」始终跟着当前两指中点
      const worldX = (gesture.startMidX - gesture.origin.x) / gesture.origin.scale
      const worldY = (gesture.startMidY - gesture.origin.y) / gesture.origin.scale
      applyTransform({
        scale: nextScale,
        x: middle.x - worldX * nextScale,
        y: middle.y - worldY * nextScale,
      })
      return
    }
    if (gesture.kind === 'drag') {
      const touch = event.touches.item(0)
      if (touch === null) {
        return
      }
      const deltaX = touch.clientX - gesture.startClientX
      const deltaY = touch.clientY - gesture.startClientY
      if (!gesture.moved && Math.hypot(deltaX, deltaY) < TAP_SLOP) {
        return
      }
      gesture.moved = true
      const point = localPoint(touch.clientX, touch.clientY)
      const overId = hitCardIdFromTarget(
        document.elementFromPoint(touch.clientX, touch.clientY),
        touch.clientX,
        touch.clientY
      )
      setDragState({
        ...describeDrop(gesture.cardId, overId, gesture.link),
        x: point.x,
        y: point.y,
      })
      return
    }
    if (gesture.kind !== 'pan') {
      return
    }
    const touch = event.touches.item(0)
    if (touch === null) {
      return
    }
    const deltaX = touch.clientX - gesture.startClientX
    const deltaY = touch.clientY - gesture.startClientY
    if (!gesture.moved && Math.hypot(deltaX, deltaY) < TAP_SLOP) {
      // 手抖容忍：移动不足 8px 不算拖动也不平移，保证点击稳定
      return
    }
    gesture.moved = true
    applyTransform({
      scale: gesture.origin.scale,
      x: gesture.origin.x + deltaX,
      y: gesture.origin.y + deltaY,
    })
  }

  const handleTouchEnd = (event: ReactTouchEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current
    if (gesture.kind === 'drag') {
      gestureRef.current = { kind: 'idle' }
      if (!gesture.moved) {
        setDragState(null)
        onOpen(gesture.cardId)
        return
      }
      commitDrop()
      return
    }
    if (gesture.kind === 'pinch') {
      const remaining = event.touches.item(0)
      if (remaining === null) {
        resetGesture()
        return
      }
      // 捏合结束但还有一根手指在屏幕上：接着用这根手指平移
      gestureRef.current = {
        kind: 'pan',
        pointerId: null,
        startClientX: remaining.clientX,
        startClientY: remaining.clientY,
        origin: transformRef.current,
        moved: true,
        cardId: null,
      }
      return
    }
    if (gesture.kind !== 'pan') {
      return
    }
    resetGesture()
    if (!gesture.moved && gesture.cardId !== null) {
      onOpen(gesture.cardId)
    }
  }

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'touch' || event.button !== 0) {
      return
    }
    if (gestureRef.current.kind !== 'idle') {
      return
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    const hitCardId = hitCardIdFromTarget(event.target, event.clientX, event.clientY)
    if (hitCardId !== null) {
      gestureRef.current = {
        kind: 'drag',
        pointerId: event.pointerId,
        cardId: hitCardId,
        link: isLinkHandle(event.target),
        startClientX: event.clientX,
        startClientY: event.clientY,
        moved: false,
      }
      return
    }
    gestureRef.current = {
      kind: 'pan',
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      origin: transformRef.current,
      moved: false,
      cardId: null,
    }
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current
    if (gesture.kind === 'drag' && gesture.pointerId === event.pointerId) {
      const deltaX = event.clientX - gesture.startClientX
      const deltaY = event.clientY - gesture.startClientY
      if (!gesture.moved && Math.hypot(deltaX, deltaY) < TAP_SLOP) {
        return
      }
      gesture.moved = true
      const point = localPoint(event.clientX, event.clientY)
      const overId = hitCardIdFromTarget(
        document.elementFromPoint(event.clientX, event.clientY),
        event.clientX,
        event.clientY
      )
      setDragState({
        ...describeDrop(gesture.cardId, overId, gesture.link),
        x: point.x,
        y: point.y,
      })
      return
    }
    if (gesture.kind !== 'pan' || gesture.pointerId !== event.pointerId) {
      return
    }
    const deltaX = event.clientX - gesture.startClientX
    const deltaY = event.clientY - gesture.startClientY
    if (!gesture.moved && Math.hypot(deltaX, deltaY) < TAP_SLOP) {
      return
    }
    gesture.moved = true
    applyTransform({
      scale: gesture.origin.scale,
      x: gesture.origin.x + deltaX,
      y: gesture.origin.y + deltaY,
    })
  }

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current
    if (gesture.kind === 'drag' && gesture.pointerId === event.pointerId) {
      gestureRef.current = { kind: 'idle' }
      if (!gesture.moved) {
        setDragState(null)
        onOpen(gesture.cardId)
        return
      }
      commitDrop()
      return
    }
    if (gesture.kind !== 'pan' || gesture.pointerId !== event.pointerId) {
      return
    }
    resetGesture()
    if (!gesture.moved && gesture.cardId !== null) {
      onOpen(gesture.cardId)
    }
  }

  const dragSource = drag === null ? undefined : layout.index.get(drag.cardId)

  const renderedEdges = layout.edges.map((edge) => (
    <path
      key={`${edge.from.card.id}-${edge.to.card.id}`}
      className={clsx(
        styles.edge,
        chainIds.has(edge.from.card.id) && chainIds.has(edge.to.card.id) && styles.chainEdge
      )}
      d={edgePath(edge.from, edge.to)}
    />
  ))

  const renderedNodes = layout.nodes.map((node) => {
    const { card, depth, x, y } = node
    const isActive = card.id === activeCardId
    const isAncestor = !isActive && chainIds.has(card.id)
    // 根节点也带强调色描边，方便在森林里辨认每棵树的起点
    const isAccent = !isActive && (isAncestor || depth === 0)
    const prompt = truncatePrompt(card.prompt)
    const isDragSource = drag !== null && drag.cardId === card.id
    const isDropTarget = drag !== null && drag.overId === card.id
    const dropClass =
      isDropTarget && drag !== null
        ? drag.valid
          ? styles.dropOk
          : styles.dropBad
        : undefined
    return (
      <g
        key={card.id}
        ref={(element: SVGGElement | null) => {
          if (element === null) {
            nodeRefs.current.delete(card.id)
          } else {
            nodeRefs.current.set(card.id, element)
          }
        }}
        className={clsx(styles.node, isDragSource && styles.dragSource, dropClass)}
        data-card-id={card.id}
        transform={`translate(${x - NODE_WIDTH / 2} ${y - NODE_HEIGHT / 2})`}
        role="button"
        tabIndex={0}
        aria-label={`打开卡片：${prompt}`}
        onKeyDown={(event: ReactKeyboardEvent<SVGGElement>) => {
          if (event.key !== 'Enter' && event.key !== ' ') {
            return
          }
          event.preventDefault()
          onOpen(card.id)
        }}
      >
        <title>{card.prompt.trim() === '' ? EMPTY_PROMPT : card.prompt.trim()}</title>
        <rect
          className={clsx(
            styles.nodeRect,
            isAccent && styles.accentRect,
            isActive && styles.activeRect
          )}
          width={NODE_WIDTH}
          height={NODE_HEIGHT}
          rx={NODE_RADIUS}
        />
        <text
          className={clsx(styles.nodePrompt, isActive && styles.activePrompt)}
          x={NODE_PADDING_X}
          y={17}
        >
          {prompt}
        </text>
        <text
          className={clsx(
            styles.nodeMode,
            isActive ? styles.activeMode : isAncestor && styles.accentMode
          )}
          data-mode={card.mode}
          x={NODE_PADDING_X}
          y={31}
        >
          {MODE_LABEL[card.mode]}
        </text>
        <g
          className={styles.linkHandle}
          data-link-handle="true"
          transform={`translate(${NODE_WIDTH + 12} ${NODE_HEIGHT / 2})`}
        >
          <circle className={styles.linkHandleHit} r={16} />
          <circle className={styles.linkHandleDot} r={7} />
          <path className={styles.linkHandleMark} d="M-2.5 0H2.5M0 -2.5V2.5" />
        </g>
      </g>
    )
  })

  return createPortal(
    <div
      ref={overlayRef}
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
    >
      <header className={styles.header}>
        <IconButton
          className={styles.headerLeft}
          size="m"
          icon={<IconCloseOutline16 />}
          aria-label="关闭全览"
          onClick={onClose}
        />
        <h1 id={titleId} className={styles.title}>
          全览
        </h1>
        <div className={styles.zoomGroup}>
          <IconButton
            size="m"
            icon={<IconZoomOut />}
            aria-label="缩小"
            disabled={transform.scale <= MIN_SCALE}
            onClick={() => zoomAround(1 / ZOOM_STEP, view.width / 2, view.height / 2)}
          />
          <IconButton
            size="m"
            icon={<IconZoomIn />}
            aria-label="放大"
            disabled={transform.scale >= MAX_SCALE}
            onClick={() => zoomAround(ZOOM_STEP, view.width / 2, view.height / 2)}
          />
        </div>
      </header>
      <div
        ref={viewportRef}
        className={styles.viewport}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={resetGesture}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={resetGesture}
      >
        <svg className={styles.canvas} xmlns="http://www.w3.org/2000/svg">
          <g transform={`translate(${transform.x} ${transform.y}) scale(${transform.scale})`}>
            <g aria-hidden="true">{renderedEdges}</g>
            {renderedNodes}
          </g>
          {drag === null ? null : (
            <g className={styles.dragLayer} aria-hidden="true">
              {dragSource === undefined ? null : (
                <path
                  className={clsx(
                    styles.dragLine,
                    drag.link && styles.dragLineLink,
                    !drag.valid && styles.dragLineBad
                  )}
                  d={dragLine(dragSource, drag, transform)}
                />
              )}
              <g transform={`translate(${drag.x - NODE_WIDTH / 2} ${drag.y - NODE_HEIGHT - 34})`}>
                <rect
                  className={clsx(
                    styles.dragGhost,
                    drag.link && styles.dragGhostLink,
                    !drag.valid && styles.dragGhostBad
                  )}
                  width={NODE_WIDTH}
                  height={NODE_HEIGHT}
                  rx={NODE_RADIUS}
                />
                <text className={styles.dragGhostText} x={NODE_PADDING_X} y={17}>
                  {truncatePrompt(layout.byId.get(drag.cardId)?.prompt ?? '')}
                </text>
                <text className={styles.dragGhostMode} x={NODE_PADDING_X} y={31}>
                  {drag.link ? '引用到' : '挂到'}
                </text>
              </g>
              <circle
                className={clsx(styles.dragPoint, !drag.valid && styles.dragPointBad)}
                cx={drag.x}
                cy={drag.y}
                r={5}
              />
            </g>
          )}
        </svg>
        {layout.nodes.length === 0 ? <div className={styles.empty}>还没有卡片</div> : null}
      </div>
      <p className={styles.hint}>
        {drag === null
          ? '拖卡片改上级 · 从右侧把手指到另一张卡片建引用 · 双指缩放'
          : drag.hint}
      </p>
    </div>,
    document.body
  )
}
