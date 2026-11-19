import clsx from 'clsx'
import { useState } from 'react'
import type { ReactNode } from 'react'
import type { LiveText } from '../../services/tree/live.js'
import type { Attachment, Card, CardMode, CardSearch, Project } from '../../services/tree/types.js'
import { formatBytes } from '../../services/attachments.js'
import { copyText } from '../../utils/clipboard.js'
import { Button } from '../base/Button.js'
import {
  IconChevronDownOutline14,
  IconCopyOutline16,
  IconDownloadOutline16,
  IconEditOutline16,
  IconLinkOutline14,
  IconPaperclipOutline16,
  IconRefreshOutline16,
  IconSearchOutline16,
  IconThinkOutline16,
  IconTrashOutline16,
} from '../base/icons.js'
import { showToast } from '../base/toastState.js'
import { Markdown } from '../markdown/Markdown.js'
import styles from './CardView.module.css'

/** 附件展示：图片直接显示缩略大图，文本文件可以展开看内容（回答发送时它们已经在上下文里了） */
const AttachmentList = ({ items }: { items: Attachment[] }) => {
  if (items.length === 0) {
    return null
  }
  return (
    <div className={styles.files}>
      {items.map((item) =>
        item.kind === 'image' && item.dataUrl ? (
          <img
            key={item.id}
            className={styles.fileImage}
            src={item.dataUrl}
            alt={item.name}
            loading="lazy"
          />
        ) : (
          <details key={item.id} className={styles.fileBlock}>
            <summary className={styles.fileSummary}>
              <span className={styles.fileIcon} aria-hidden="true">
                <IconPaperclipOutline16 />
              </span>
              <span className={styles.fileName}>{item.name}</span>
              <span className={styles.fileSize}>{formatBytes(item.size)}</span>
            </summary>
            <pre className={styles.fileText}>{item.text}</pre>
          </details>
        ),
      )}
    </div>
  )
}
/** 从 URL 里取个好看的域名，取不到就退回去掉协议头的原文 */
const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url.replace(/^https?:\/\//, '').split('/')[0] ?? url
  }
}

/** 这次回答用到的联网来源：只显示标题和域名，点开去原文 */
const SourceList = ({ search }: { search: CardSearch | null | undefined }) => {
  if (!search || search.sources.length === 0) {
    return null
  }
  return (
    <div className={styles.sources}>
      <p className={styles.sourcesHead}>
        <IconSearchOutline16 />
        <span>联网搜索 · {search.sources.length} 条来源</span>
      </p>
      <ol className={styles.sourceList}>
        {search.sources.map((source, index) => (
          <li key={`${source.url}:${index}`} className={styles.sourceItem}>
            <a
              className={styles.sourceLink}
              href={source.url}
              target="_blank"
              rel="noreferrer"
            >
              <span className={styles.sourceIndex}>{index + 1}</span>
              <span className={styles.sourceText}>
                <span className={styles.sourceTitle}>{source.title || source.url}</span>
                <span className={styles.sourceHost}>{hostOf(source.url)}</span>
              </span>
            </a>
          </li>
        ))}
      </ol>
    </div>
  )
}

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

const statsLine = (card: Pick<Card, 'stats'>) => {
  if (!card.stats) {
    return null
  }
  const { approxTokens, budget, foldedCards, droppedCards, droppedRefs, refs } = card.stats
  const parts = [`${approxTokens} / ${budget} tokens`]
  if (foldedCards > 0) {
    parts.push(`折叠 ${foldedCards}`)
  }
  if (droppedCards > 0) {
    parts.push(`丢弃 ${droppedCards}`)
  }
  if (droppedRefs > 0) {
    parts.push(`引用放不下 ${droppedRefs}`)
  }
  if (refs > 0) {
    parts.push(`引用 ${refs}`)
  }
  return parts.join(' · ')
}

/** 一张卡片在树里的深度（根 = 0） */
const depthOf = (project: Project, card: Card): number => {
  const seen = new Set<string>()
  let depth = 0
  let current: Card | undefined = card
  while (current?.parentId) {
    if (seen.has(current.id)) {
      break
    }
    seen.add(current.id)
    const parentId: string = current.parentId
    current = project.cards.find((item) => item.id === parentId)
    if (!current) {
      break
    }
    depth += 1
  }
  return depth
}

/** 可折叠的思考过程 */
const Thinking = ({ text, live }: { text: string; live: boolean }) => {
  const [open, setOpen] = useState(live)
  if (!text) {
    return null
  }
  return (
    <div className={styles.thinking}>
      <button
        type="button"
        className={styles.thinkingToggle}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <IconThinkOutline16 />
        <span>{live ? '正在思考…' : '思考过程'}</span>
        <span className={styles.thinkingCount}>{text.length} 字</span>
        <span className={clsx(styles.chevron, open && styles.chevronOpen)}>
          <IconChevronDownOutline14 />
        </span>
      </button>
      {open ? <div className={styles.thinkingBody}>{text}</div> : null}
    </div>
  )
}

type ActionItem = {
  label: string
  icon: ReactNode
  onClick: () => void
  danger?: boolean
  disabled?: boolean
}

export type CardViewProps = {
  project: Project
  card: Card
  live: LiveText | null
  running: boolean
  onBranch: () => void
  onRetry: () => void
  onDelete: () => void
  /** 只改问题 / 回答的文字，不重新调用模型 */
  onEdit: () => void
  /** 只改某条追问的问题 / 回答文字，不重新调用模型 */
  onEditFollowUp: (followUpId: string) => void
  /** 把这张卡片（问题 + 回答 + 来源）生成长图分享 */
  onShare: () => void
  /** 从中断处接着生成（仅 partial 卡片） */
  onContinue: () => void
  onOpenRef: (cardId: string) => void
  onRemoveRef: (cardId: string) => void
  onAddRef: () => void
  onOpenCard: (cardId: string) => void
}

/** 一张卡片的详情：问题、思考、回答、追问、引用 */
export const CardView = ({
  project,
  card,
  live,
  running,
  onBranch,
  onRetry,
  onDelete,
  onEdit,
  onEditFollowUp,
  onShare,
  onContinue,
  onOpenRef,
  onRemoveRef,
  onAddRef,
  onOpenCard,
}: CardViewProps) => {
  const mainLive = live && live.cardId === card.id && live.followUpId === null ? live : null
  const answer = mainLive ? mainLive.answer : card.answer
  const thinking = mainLive ? mainLive.thinking : card.thinking
  const status: Card['status'] = mainLive ? 'running' : card.status
  const depth = depthOf(project, card)
  const children = project.cards.filter((item) => item.parentId === card.id)

  const handleCopy = async (text: string) => {
    if (!text) {
      return
    }
    if (await copyText(text)) {
      showToast('回答已复制')
    } else {
      showToast('复制失败')
    }
  }

  const actions: ActionItem[] = [
    { label: '重答', icon: <IconRefreshOutline16 />, onClick: onBranch, disabled: running },
    { label: '编辑', icon: <IconEditOutline16 />, onClick: onEdit, disabled: running },
    { label: '分享', icon: <IconDownloadOutline16 />, onClick: onShare, disabled: !answer },
    { label: '引用', icon: <IconLinkOutline14 />, onClick: onAddRef, disabled: running },
    {
      label: '复制',
      icon: <IconCopyOutline16 />,
      onClick: () => void handleCopy(answer),
      disabled: !answer,
    },
    { label: '删除', icon: <IconTrashOutline16 />, onClick: onDelete, danger: true, disabled: running },
  ]

  const refs = card.refs
    .map((refId) => project.cards.find((item) => item.id === refId))
    .filter((item): item is Card => Boolean(item))

  return (
    <div className={styles.page}>
      {/* 一张卡片就是一张纸：签、问题、回答、操作都落在同一张纸面上 */}
      <article key={card.id} className={styles.sheet}>
        {/* 索引卡的「签」：卡片在树里的身份与层级，做成从卡片上沿探出的小标签 */}
        <span className={styles.tab}>
          <span className={styles.tabMode} data-mode={card.mode}>
            {MODE_LABEL[card.mode]}
          </span>
          <span className={styles.tabLevel}>L{depth}</span>
        </span>

        <header className={styles.head}>
          <p className={styles.question}>{card.prompt}</p>
          <div className={styles.headMeta}>
            <span>{depth === 0 ? '这棵树的起点' : `第 ${depth + 1} 层`}</span>
            {refs.length > 0 ? <span>{refs.length} 张引用</span> : null}
            {STATUS_LABEL[status] ? (
              <span className={styles.headStatus} data-status={status}>
                {STATUS_LABEL[status]}
              </span>
            ) : null}
          </div>
        </header>

        <AttachmentList items={card.attachments ?? []} />

        <div className={styles.body}>
          <Thinking text={thinking} live={Boolean(mainLive)} />
          {answer ? (
            <Markdown
              content={answer}
              loading={status === 'running'}
              cacheKey={`${card.id}:answer`}
              disableLink={false}
            />
          ) : status === 'running' ? (
            <div className={styles.typing} aria-label="正在生成">
              <span />
              <span />
              <span />
            </div>
          ) : null}
          {status === 'error' && card.error ? (
            <div className={styles.errorBox} role="alert">
              <p className={styles.errorText}>{card.error}</p>
              <Button size="s" variant="outlined" onClick={onRetry}>
                重新生成
              </Button>
            </div>
          ) : null}
          {status === 'partial' && !running ? (
            <div className={styles.partialBox}>
              <p className={styles.partialText}>
                这次回答被中断了，已经写出的内容还在。可以接着往下写，不用重问一遍。
              </p>
              <Button size="s" variant="outlined" onClick={onContinue}>
                继续生成
              </Button>
            </div>
          ) : null}
          {card.stats ? <p className={styles.stats}>{statsLine(card)}</p> : null}
          <SourceList search={card.search} />
        </div>

        <div className={styles.actions}>
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              className={clsx(styles.action, action.danger && styles.actionDanger)}
              onClick={action.onClick}
              disabled={action.disabled}
            >
              <span className={styles.actionIcon}>{action.icon}</span>
              {action.label}
            </button>
          ))}
        </div>
      </article>

      {refs.length > 0 ? (
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <span>引用的卡片</span>
          </div>
          <div className={styles.refList}>
            {refs.map((ref) => (
              <span key={ref.id} className={styles.refChip}>
                <button type="button" className={styles.refOpen} onClick={() => onOpenRef(ref.id)}>
                  {ref.prompt.slice(0, 18) || '（无问题）'}
                </button>
                <button
                  type="button"
                  className={styles.refRemove}
                  aria-label="取消引用"
                  onClick={() => onRemoveRef(ref.id)}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        </section>
      ) : null}

      {card.followUps.length > 0 ? (
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <span>追问 · {card.followUps.length}</span>
          </div>
          <div className={styles.followUps}>
            {card.followUps.map((followUp) => {
              const followLive =
                live && live.cardId === card.id && live.followUpId === followUp.id ? live : null
              const followAnswer = followLive ? followLive.answer : followUp.answer
              const followThinking = followLive ? followLive.thinking : followUp.thinking
              return (
                <div key={followUp.id} className={styles.followUp}>
                  <p className={styles.followQuestion}>{followUp.prompt}</p>
                  <AttachmentList items={followUp.attachments ?? []} />
                  <Thinking text={followThinking} live={Boolean(followLive)} />
                  {followAnswer ? (
                    <Markdown
                      content={followAnswer}
                      loading={Boolean(followLive)}
                      cacheKey={`${card.id}:${followUp.id}`}
                      disableLink={false}
                    />
                  ) : followUp.status === 'running' ? (
                    <div className={styles.typing}>
                      <span />
                      <span />
                      <span />
                    </div>
                  ) : null}
                  {followUp.status === 'error' && followUp.error ? (
                    <p className={styles.errorText}>{followUp.error}</p>
                  ) : null}
                  <SourceList search={followUp.search} />
                  <div className={styles.followUpFoot}>
                    <button
                      type="button"
                      className={styles.followUpEdit}
                      onClick={() => onEditFollowUp(followUp.id)}
                      disabled={Boolean(followLive)}
                    >
                      <IconEditOutline16 />
                      编辑
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      ) : null}

      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <span>从这张卡片长出去{children.length > 0 ? ` · ${children.length}` : ''}</span>
        </div>
        {children.length > 0 ? (
          <div className={styles.children}>
            {children.map((child) => (
              <button
                key={child.id}
                type="button"
                className={styles.child}
                onClick={() => onOpenCard(child.id)}
              >
                <span className={styles.childMode} data-mode={child.mode}>
                  {MODE_LABEL[child.mode]}
                </span>
                <span className={styles.childText}>{child.prompt}</span>
                <span className={styles.childArrow}>›</span>
              </button>
            ))}
          </div>
        ) : (
          <p className={styles.hint}>这张卡片还能继续长 —— 在下面选一种方式提问就好。</p>
        )}
      </section>
    </div>
  )
}
