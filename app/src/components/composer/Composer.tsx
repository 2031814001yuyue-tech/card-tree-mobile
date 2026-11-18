import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'
import {
  IconCloseOutline16,
  IconPaperclipOutline16,
  IconSearchOutline16,
  IconSendOutline16,
  IconStopFill16,
} from '../base/icons.js'
import { ATTACHMENT_ACCEPT, formatBytes } from '../../services/attachments.js'
import type { Attachment } from '../../services/tree/types.js'
import styles from './Composer.module.css'

/** 卡片详情里的一次提问方式：追问不新增节点，其余三种会长出新卡片 */
export type AskMode = 'follow' | 'child' | 'diverge' | 'isolated'

export const ASK_MODES: { mode: AskMode; label: string }[] = [
  { mode: 'follow', label: '追问' },
  { mode: 'child', label: '深入' },
  { mode: 'diverge', label: '发散' },
  { mode: 'isolated', label: '独立' },
]

export type ComposerProps = {
  placeholder: string
  /** 传入时显示提问方式选择器，不传就是普通的提问框 */
  modes?: { mode: AskMode; label: string }[] | null
  mode?: AskMode
  onModeChange?: (mode: AskMode) => void
  running: boolean
  autoFocus?: boolean
  /** 没有项目 / 没配置模型时禁用 */
  disabled?: boolean
  /** 已经选好、还没发出去的附件 */
  attachments?: Attachment[]
  /** 选中文件后回调；读取与压缩由调用方做（要按当前余量限个数） */
  onAddFiles?: (files: File[]) => void
  onRemoveAttachment?: (id: string) => void
  /** 服务端有没有配 DeepSeek Key；没有就显示成「未开通」，点了由调用方提示怎么配 */
  searchAvailable?: boolean
  /** 这次提问要不要先联网搜一下 */
  searchOn?: boolean
  /** 不传就不显示联网搜索开关 */
  onToggleSearch?: () => void
  onSend: (text: string, mode: AskMode) => void
  onStop: () => void
}

/** 底部输入框：圆角大输入区 + 上方一排提问方式胶囊 + 附件 */
export const Composer = ({
  placeholder,
  modes = null,
  mode = 'follow',
  onModeChange,
  running,
  autoFocus = false,
  disabled = false,
  attachments = [],
  onAddFiles,
  onRemoveAttachment,
  searchAvailable = false,
  searchOn = false,
  onToggleSearch,
  onSend,
  onStop,
}: ComposerProps) => {
  const [value, setValue] = useState('')
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // 输入框随内容长高，最高 5 行左右
  useEffect(() => {
    const area = areaRef.current
    if (!area) {
      return
    }
    area.style.height = 'auto'
    area.style.height = `${Math.min(area.scrollHeight, 132)}px`
  }, [value])

  useEffect(() => {
    if (autoFocus && !disabled) {
      areaRef.current?.focus()
    }
  }, [autoFocus, disabled])

  const hasAttachment = attachments.length > 0
  const canSend = !disabled && !running && (value.trim().length > 0 || hasAttachment)

  const submit = () => {
    if (!canSend) {
      return
    }
    onSend(value.trim(), mode)
    setValue('')
  }

  return (
    <div className={styles.wrapper}>
      {modes || onToggleSearch ? (
        <div className={styles.bar}>
          {modes ? (
            <div className={styles.modes} role="radiogroup" aria-label="提问方式">
              {modes.map((item) => (
                <button
                  key={item.mode}
                  type="button"
                  role="radio"
                  aria-checked={item.mode === mode}
                  className={clsx(styles.mode, item.mode === mode && styles.modeActive)}
                  onClick={() => onModeChange?.(item.mode)}
                  disabled={running}
                >
                  {item.label}
                </button>
              ))}
            </div>
          ) : null}
          {onToggleSearch ? (
            <button
              type="button"
              className={clsx(
                styles.search,
                searchOn && styles.searchActive,
                !searchAvailable && styles.searchMuted,
              )}
              aria-pressed={searchOn}
              aria-label={searchAvailable ? '联网搜索' : '联网搜索（未开通）'}
              onClick={onToggleSearch}
              disabled={running}
            >
              <IconSearchOutline16 />
              <span>{searchAvailable ? '联网搜索' : '联网（未开通）'}</span>
            </button>
          ) : null}
        </div>
      ) : null}

      {hasAttachment ? (
        <ul className={styles.files} aria-label="待发送的附件">
          {attachments.map((item) => (
            <li key={item.id} className={styles.fileChip}>
              {item.kind === 'image' && item.dataUrl ? (
                <img className={styles.fileThumb} src={item.dataUrl} alt="" />
              ) : (
                <span className={styles.fileIcon} aria-hidden="true">
                  <IconPaperclipOutline16 />
                </span>
              )}
              <span className={styles.fileName}>{item.name}</span>
              <span className={styles.fileSize}>{formatBytes(item.size)}</span>
              <button
                type="button"
                className={styles.fileRemove}
                aria-label={`移除附件 ${item.name}`}
                onClick={() => onRemoveAttachment?.(item.id)}
                disabled={running}
              >
                <IconCloseOutline16 />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className={clsx(styles.box, running && styles.boxRunning)}>
        <button
          type="button"
          className={clsx(styles.attach, !onAddFiles && styles.attachHidden)}
          aria-label="添加图片或文件"
          onClick={() => fileRef.current?.click()}
          disabled={disabled || running}
        >
          <IconPaperclipOutline16 />
        </button>
        <input
          ref={fileRef}
          type="file"
          className={styles.fileInput}
          accept={ATTACHMENT_ACCEPT}
          multiple
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? [])
            event.target.value = ''
            if (files.length > 0) {
              onAddFiles?.(files)
            }
          }}
        />
        <textarea
          ref={areaRef}
          className={styles.area}
          value={value}
          rows={1}
          placeholder={placeholder}
          disabled={disabled}
          enterKeyHint="enter"
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            // 桌面上回车发送，手机上回车换行
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              if (window.matchMedia('(min-width: 768px)').matches) {
                event.preventDefault()
                submit()
              }
            }
          }}
        />
        {running ? (
          <button
            type="button"
            className={clsx(styles.action, styles.stop)}
            onClick={onStop}
            aria-label="停止"
          >
            <IconStopFill16 />
          </button>
        ) : (
          <button
            type="button"
            className={styles.action}
            onClick={submit}
            disabled={!canSend}
            aria-label="发送"
          >
            <IconSendOutline16 />
          </button>
        )}
      </div>
    </div>
  )
}
