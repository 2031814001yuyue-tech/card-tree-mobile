/**
 * 卡片树的本地持久化（手机版）。
 *
 * 用 idb 把项目整棵树存进 IndexedDB：
 * - projects：keyPath 'id'，每个项目一条记录（整棵树一起存，简单可靠）
 * - meta：keyPath 'key'，存当前打开的项目 id
 *
 * 所有读写都做了兜底：SSR / 隐私模式 / 存储被禁用时返回空数据而不是抛未捕获异常，
 * 避免整个应用因为拿不到数据库而白屏。
 */

import { openDB } from 'idb'
import type { DBSchema, IDBPDatabase } from 'idb'
import type { Project } from './types.js'

const DB_NAME = 'card-tree-mobile'
const DB_VERSION = 1
const PROJECTS_STORE = 'projects'
const META_STORE = 'meta'
const ACTIVE_PROJECT_KEY = 'activeProjectId'

type MetaRecord = {
  key: string
  value: string | null
}

interface CardTreeDatabase extends DBSchema {
  projects: {
    key: string
    value: Project
  }
  meta: {
    key: string
    value: MetaRecord
  }
}

type CardTreeDb = IDBPDatabase<CardTreeDatabase>

let databasePromise: Promise<CardTreeDb> | null = null

const hasIndexedDb = (): boolean => typeof indexedDB !== 'undefined'

const getDatabase = (): Promise<CardTreeDb> => {
  if (databasePromise) {
    return databasePromise
  }
  databasePromise = openDB<CardTreeDatabase>(DB_NAME, DB_VERSION, {
    upgrade(database) {
      if (!database.objectStoreNames.contains(PROJECTS_STORE)) {
        database.createObjectStore(PROJECTS_STORE, { keyPath: 'id' })
      }
      if (!database.objectStoreNames.contains(META_STORE)) {
        database.createObjectStore(META_STORE, { keyPath: 'key' })
      }
    },
  }).catch((error: unknown) => {
    // 打开失败（隐私模式 / 配额 / 版本冲突）时清掉缓存，下次调用重新尝试
    databasePromise = null
    throw error
  })
  return databasePromise
}

/**
 * 统一入口：没有 IndexedDB 或操作失败时返回 fallback，不把异常抛给界面。
 */
const run = async <T>(action: (database: CardTreeDb) => Promise<T>, fallback: T): Promise<T> => {
  if (!hasIndexedDb()) {
    return fallback
  }
  try {
    return await action(await getDatabase())
  } catch {
    return fallback
  }
}

/** 写操作的包装：失败时静默忽略（界面照常工作，下次保存再试） */
const runVoid = async (action: (database: CardTreeDb) => Promise<void>): Promise<void> => {
  await run<boolean>(async (database) => {
    await action(database)
    return true
  }, false)
}

/** 读出全部项目；最近改过的排在前面 */
export const loadAllProjects = (): Promise<Project[]> =>
  run<Project[]>(async (database) => {
    const projects = await database.getAll(PROJECTS_STORE)
    return [...projects].sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
  }, [])

/** 整棵树一起落库（新增或覆盖同一个 id） */
export const saveProject = async (project: Project): Promise<void> => {
  await runVoid(async (database) => {
    await database.put(PROJECTS_STORE, project)
  })
}

/** 删掉一个项目 */
export const deleteProject = async (id: string): Promise<void> => {
  await runVoid(async (database) => {
    await database.delete(PROJECTS_STORE, id)
  })
}

/** 上次打开的项目 id；没有记录时返回 null */
export const loadActiveProjectId = (): Promise<string | null> =>
  run<string | null>(async (database) => {
    const record = await database.get(META_STORE, ACTIVE_PROJECT_KEY)
    return typeof record?.value === 'string' ? record.value : null
  }, null)

/** 记住当前打开的项目；传 null 表示清空 */
export const saveActiveProjectId = async (id: string | null): Promise<void> => {
  await runVoid(async (database) => {
    await database.put(META_STORE, { key: ACTIVE_PROJECT_KEY, value: id })
  })
}

/** 清空全部本地数据（供「清空数据」用） */
export const clearAll = async (): Promise<void> => {
  await runVoid(async (database) => {
    const transaction = database.transaction([PROJECTS_STORE, META_STORE], 'readwrite')
    await Promise.all([
      transaction.objectStore(PROJECTS_STORE).clear(),
      transaction.objectStore(META_STORE).clear(),
      transaction.done,
    ])
  })
}
