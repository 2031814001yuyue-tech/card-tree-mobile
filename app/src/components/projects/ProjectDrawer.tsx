import clsx from 'clsx'
import { useEffect } from 'react'
import type { Project } from '../../services/tree/types.js'
import { formatDate } from '../../utils/format.js'
import { IconButton } from '../base/IconButton.js'
import { IconCloseOutline16, IconNewChatOutline20, IconSettingsOutline16 } from '../base/icons.js'
import styles from './ProjectDrawer.module.css'

export type ProjectDrawerProps = {
  open: boolean
  projects: Project[]
  activeProjectId: string | null
  onSelect: (projectId: string) => void
  onCreate: () => void
  onDelete: (projectId: string) => void
  onOpenSettings: () => void
  onClose: () => void
}

/** 左侧抽屉：切换 / 新建 / 删除探索项目 */
export const ProjectDrawer = ({
  open,
  projects,
  activeProjectId,
  onSelect,
  onCreate,
  onDelete,
  onOpenSettings,
  onClose,
}: ProjectDrawerProps) => {
  useEffect(() => {
    if (!open) {
      return
    }
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
    <div className={styles.mask} role="presentation" onClick={onClose}>
      <aside
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label="探索项目"
        onClick={(event) => event.stopPropagation()}
      >
        <div className={styles.head}>
          <span className={styles.brand}>卡片树</span>
          <IconButton icon={<IconCloseOutline16 />} tooltip="关闭" onClick={onClose} />
        </div>

        <button type="button" className={styles.newButton} onClick={onCreate}>
          <IconNewChatOutline20 />
          新的探索
        </button>

        <div className={styles.list}>
          {projects.map((project) => (
            <div
              key={project.id}
              className={clsx(styles.item, project.id === activeProjectId && styles.itemActive)}
            >
              <button
                type="button"
                className={styles.itemMain}
                onClick={() => onSelect(project.id)}
              >
                <span className={styles.itemTitle}>{project.title}</span>
                <span className={styles.itemMeta}>
                  {project.cards.length} 张卡片 · {formatDate(project.updatedAt)}
                </span>
              </button>
              <button
                type="button"
                className={styles.itemDelete}
                aria-label={`删除 ${project.title}`}
                onClick={() => onDelete(project.id)}
              >
                ×
              </button>
            </div>
          ))}
        </div>

        <div className={styles.foot}>
          <button type="button" className={styles.footButton} onClick={onOpenSettings}>
            <IconSettingsOutline16 />
            设置
          </button>
          <p className={styles.footHint}>数据只存在这个浏览器里</p>
        </div>
      </aside>
    </div>
  )
}
