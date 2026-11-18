import clsx from 'clsx'
import { useMemo, useRef, useState } from 'react'
import type { CSSProperties, MouseEvent } from 'react'
import type { Card, CardMode, Project } from '../../services/tree/types.js'
import { IconChevronRightOutline14, IconCloseOutline16, IconSearchOutline16 } from '../base/icons.js'
import styles from './TreeView.module.css'

const MODE_LABEL: Record<CardMode, string> = {
  root: '根卡片',
  child: '深入',
  diverge: '发散',
  branch: '重答',
  isolated: '独立',
}

const STATUS_LABEL: Record<Card['status'], string> = {
  idle: '待提问',
  running: '生成中',
  done: '',
  partial: '中断',
  error: '出错',
}

/** 从 Markdown 回答里取一段纯文字预览：公式、代码、标记都去掉，只留句子 */
const preview = (text: string, limit: number) => {
  const clean = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\$\$[\s\S]*?\$\$/g, ' ')
    .replace(/\\\[[\s\S]*?\\\]/g, ' ')
    .replace(/\\\([\s\S]*?\\\)/g, ' ')
    .replace(/\$[^$\n]*\$/g, ' ')
    .replace(/\\[a-zA-Z]+/g, ' ')
    .replace(/^\s{0,3}(#{1,6}|>)\s*/gm, '')
    .replace(/^\s{0,3}[-*+]\s+/gm, '')
    .replace(/^\s{0,3}\d+[.)]\s+/gm, '')
    .replace(/\*\*|__|[*_~]/g, '')
    .replace(/[#>{}[\]\\|]/g, ' ')
    .replace(/\s+([，。；：、！？,.;:!?)）」』】])/g, '$1')
    .replace(/([（「『【])\s+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean
}

type NodeProps = {
  card: Card
  /** 在兄弟节点里的序号，用来做很轻的入场错峰 */
  order: number
  childrenOf: (parentId: string) => Card[]
  /** 搜索时只显示命中的卡片 + 它们的祖先链 */
  isVisible: (cardId: string) => boolean
  liveCardId: string | null
  liveAnswer: string
  onOpen: (cardId: string) => void
  onQuickMenu?: (cardId: string) => void
}

const Node = ({
  card,
  order,
  childrenOf,
  isVisible,
  liveCardId,
  liveAnswer,
  onOpen,
  onQuickMenu,
}: NodeProps) => {
  const streaming = liveCardId === card.id
  const answer = streaming ? liveAnswer : card.answer
  const status: Card['status'] = streaming ? 'running' : card.status
  const kids = childrenOf(card.id).filter((kid) => isVisible(kid.id))
  const counts = [
    kids.length ? `${kids.length} 支` : '',
    card.followUps.length ? `${card.followUps.length} 追问` : '',
    card.refs.length ? `${card.refs.length} 引用` : '',
  ].filter(Boolean)

  const timer = useRef<number | null>(null)
  const suppressClick = useRef(false)
  const cancelLongPress = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
  }
  const startLongPress = () => {
    if (!onQuickMenu) {
      return
    }
    cancelLongPress()
    timer.current = window.setTimeout(() => {
      suppressClick.current = true
      onQuickMenu(card.id)
    }, 480)
  }
  const openMenu = (event: MouseEvent) => {
    if (!onQuickMenu) {
      return
    }
    event.preventDefault()
    cancelLongPress()
    suppressClick.current = true
    onQuickMenu(card.id)
  }

  return (
    <li
      className={styles.node}
      style={{ '--node-order': Math.min(order, 8) } as CSSProperties}
    >
      <div className={styles.row}>
        <button
          type="button"
          className={clsx(styles.card, status === 'error' && styles.cardError)}
          onTouchStart={startLongPress}
          onTouchMove={cancelLongPress}
          onTouchEnd={() => {
            cancelLongPress()
            if (suppressClick.current) {
              window.setTimeout(() => {
                suppressClick.current = false
              }, 600)
            }
          }}
          onTouchCancel={cancelLongPress}
          onContextMenu={openMenu}
          onClick={() => {
            if (suppressClick.current) {
              suppressClick.current = false
              return
            }
            onOpen(card.id)
          }}
        >
          <span className={styles.top}>
            <span className={styles.dot} data-status={status} data-mode={card.mode} />
            <span className={styles.mode} data-mode={card.mode}>
              {MODE_LABEL[card.mode]}
            </span>
            {STATUS_LABEL[status] ? <span className={styles.status}>{STATUS_LABEL[status]}</span> : null}
            <span className={styles.trail}>
              {counts.length > 0 ? <span className={styles.counts}>{counts.join(' · ')}</span> : null}
              <span className={styles.chevron}>
                <IconChevronRightOutline14 />
              </span>
            </span>
          </span>
          <span className={styles.prompt}>{card.prompt}</span>
          {answer ? (
            <span className={styles.answer}>{preview(answer, streaming ? 96 : 78)}</span>
          ) : status === 'running' ? (
            <span className={styles.answerEcho}>正在生长…</span>
          ) : null}
        </button>
      </div>

      {kids.length > 0 ? (
        <ul className={styles.children}>
          {kids.map((kid, index) => (
            <Node
              key={kid.id}
              card={kid}
              order={index}
              childrenOf={childrenOf}
              isVisible={isVisible}
              liveCardId={liveCardId}
              liveAnswer={liveAnswer}
              onOpen={onOpen}
              onQuickMenu={onQuickMenu}
            />
          ))}
        </ul>
      ) : null}
    </li>
  )
}

export type TreeViewProps = {
  project: Project
  liveCardId: string | null
  liveAnswer: string
  onOpen: (cardId: string) => void
  /** 长按卡片（或桌面右键）时弹出快捷菜单 */
  onQuickMenu?: (cardId: string) => void
}

/** 卡片树：每一层孩子挂在上张卡片的生长线上，点一张卡片进入详情 */
export const TreeView = ({ project, liveCardId, liveAnswer, onOpen, onQuickMenu }: TreeViewProps) => {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()

  /** 命中的卡片 + 一路向上的祖先，保证搜索结果还能看出它在树里的位置 */
  const visible = useMemo(() => {
    if (!q) {
      return null
    }
    const ids = new Set<string>()
    const byId = new Map(project.cards.map((item) => [item.id, item]))
    for (const item of project.cards) {
      const hit =
        item.prompt.toLowerCase().includes(q) ||
        item.answer.toLowerCase().includes(q) ||
        item.followUps.some(
          (followUp) =>
            followUp.prompt.toLowerCase().includes(q) || followUp.answer.toLowerCase().includes(q),
        )
      if (!hit) {
        continue
      }
      ids.add(item.id)
      const seen = new Set<string>()
      let current: Card | undefined = item
      while (current?.parentId && !seen.has(current.id)) {
        seen.add(current.id)
        const parentId: string = current.parentId
        current = byId.get(parentId)
        if (current) {
          ids.add(current.id)
        }
      }
    }
    return ids
  }, [project.cards, q])

  if (project.cards.length === 0) {
    return (
      <div className={styles.empty}>
        <svg className={styles.emptyGlyph} viewBox="0 0 64 48" aria-hidden="true">
          <path
            d="M32 44V26M32 26 14 13M32 26l18-13"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
          <circle cx="32" cy="44" r="3.2" fill="currentColor" />
          <circle cx="14" cy="11" r="3" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <circle cx="50" cy="11" r="3" fill="none" stroke="currentColor" strokeWidth="1.4" />
        </svg>
        <div className={styles.emptyTitle}>把一个问题，长成一棵树</div>
        <p className={styles.emptyText}>
          在下面问第一个问题，它会是这棵树的根；之后每一张卡片都能继续深入、发散，或者换一个角度重答。
        </p>
        <p className={styles.emptyHint}>从下面开始</p>
      </div>
    )
  }

  const isVisible = (cardId: string) => visible === null || visible.has(cardId)
  const roots = project.cards.filter((card) => card.parentId === null && isVisible(card.id))
  const childrenOf = (parentId: string) => project.cards.filter((card) => card.parentId === parentId)

  return (
    <>
      <div className={styles.search}>
        <span className={styles.searchIcon}>
          <IconSearchOutline16 />
        </span>
        <input
          className={styles.searchInput}
          value={query}
          placeholder="搜索问题或回答…"
          aria-label="搜索卡片"
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
        />
        {query ? (
          <button
            type="button"
            className={styles.searchClear}
            aria-label="清除搜索"
            onClick={() => setQuery('')}
          >
            <IconCloseOutline16 />
          </button>
        ) : null}
      </div>
      {roots.length ? (
        <ul className={styles.list}>
          {roots.map((card, index) => (
            <Node
              key={card.id}
              card={card}
              order={index}
              childrenOf={childrenOf}
              isVisible={isVisible}
              liveCardId={liveCardId}
              liveAnswer={liveAnswer}
              onOpen={onOpen}
              onQuickMenu={onQuickMenu}
            />
          ))}
        </ul>
      ) : (
        <p className={styles.searchEmpty}>没有匹配的卡片，换个词试试。</p>
      )}
    </>
  )
}
