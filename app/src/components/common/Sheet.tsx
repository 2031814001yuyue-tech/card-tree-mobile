import clsx from 'clsx'
import { useEffect, useRef, type ReactNode } from 'react'
import { IconButton } from '../base/IconButton.js'
import { IconCloseOutline16 } from '../base/icons.js'
import styles from './Sheet.module.css'

export type SheetProps = {
  open: boolean
  title?: string
  onClose: () => void
  children: ReactNode
  /** auto：按内容高度；full：几乎占满屏幕（设置、长表单） */
  size?: 'auto' | 'full'
}

/** 浮层刚打开的这点时间里，长按手势抬手会合成一次落点在遮罩上的 click——忽略它 */
const OPEN_GRACE_MS = 350

/** 底部弹出的半屏面板，点遮罩或 Esc 关闭 */
export const Sheet = ({ open, title, onClose, children, size = 'auto' }: SheetProps) => {
  const openedAt = useRef(0)

  useEffect(() => {
    if (!open) {
      return
    }
    openedAt.current = Date.now()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open) {
    return null
  }
  return (
    <div
      className={styles.mask}
      role="presentation"
      onClick={() => {
        if (Date.now() - openedAt.current < OPEN_GRACE_MS) {
          return
        }
        onClose()
      }}
    >
      <div
        className={clsx(styles.sheet, size === 'full' && styles.full)}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <div className={styles.grabber} />
        {title ? (
          <div className={styles.header}>
            <h2 className={styles.title}>{title}</h2>
            <IconButton icon={<IconCloseOutline16 />} tooltip="关闭" onClick={onClose} />
          </div>
        ) : null}
        <div className={styles.body}>{children}</div>
      </div>
    </div>
  )
}
