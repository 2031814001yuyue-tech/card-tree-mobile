/**
 * 附件读取：把手机里选中的图片压缩成 dataURL，把文本文件读成字符串。
 *
 * 设计取舍：
 * - 图片走 OpenAI 兼容的 `image_url` 内容块，只接受视觉模型（glm-5.3 / gpt-5.6-luna /
 *   claude-haiku-5-5 这类）。压缩到长边 1280、JPEG 0.82，一张通常 120–250 KB。
 * - 文本文件直接拼进用户消息（`【附件：名字】` 后面跟内容），所有模型都能用。
 * - 读进来的东西随卡片存在 IndexedDB 里；导出/自动备份的 JSON 会变胖，这是有意的取舍。
 */

import { createId } from '../utils/id.js'
import type { Attachment } from './tree/types.js'
import {
  MAX_ATTACHMENT_TEXT_CHARS,
  MAX_ATTACHMENTS,
  MAX_IMAGE_EDGE,
} from './tree/types.js'

/** 文本类文件的扩展名白名单（accept 与判断共用） */
const TEXT_EXTENSIONS = [
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'json',
  'jsonl',
  'log',
  'xml',
  'yml',
  'yaml',
  'html',
  'htm',
  'css',
  'js',
  'mjs',
  'ts',
  'tsx',
  'jsx',
  'py',
  'java',
  'kt',
  'c',
  'h',
  'cpp',
  'cs',
  'go',
  'rs',
  'rb',
  'php',
  'sh',
  'ps1',
  'sql',
  'ini',
  'toml',
  'conf',
  'tex',
]

/** 文件选择框的 accept：图片 + 常见文本 */
export const ATTACHMENT_ACCEPT = ['image/*', ...TEXT_EXTENSIONS.map((ext) => `.${ext}`)].join(',')

const extensionOf = (name: string): string => {
  const index = name.lastIndexOf('.')
  return index >= 0 ? name.slice(index + 1).toLowerCase() : ''
}

export const isImageFile = (file: File): boolean => file.type.startsWith('image/')

export const isTextFile = (file: File): boolean =>
  file.type.startsWith('text/') || TEXT_EXTENSIONS.includes(extensionOf(file.name))

export const isSupportedFile = (file: File): boolean => isImageFile(file) || isTextFile(file)

/** 1.2 MB → 1.2 MB；给附件 chip 上显示用 */
export const formatBytes = (size: number): string => {
  if (!Number.isFinite(size) || size <= 0) {
    return '0 B'
  }
  if (size < 1024) {
    return `${Math.round(size)} B`
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

const readAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('读取文件失败'))
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.readAsDataURL(file)
  })

const readAsText = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('读取文件失败'))
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.readAsText(file)
  })

const loadImage = (src: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const image = new Image()
    image.onerror = () => reject(new Error('图片解码失败'))
    image.onload = () => resolve(image)
    image.src = src
  })

/** 压缩一张图片：长边不超过 MAX_IMAGE_EDGE，输出 JPEG（透明区域填白） */
const compressImage = async (file: File): Promise<string> => {
  const source = file.type === 'image/svg+xml' ? await readAsDataUrl(file) : await readAsDataUrl(file)
  const image = await loadImage(source)
  const longest = Math.max(image.naturalWidth, image.naturalHeight) || MAX_IMAGE_EDGE
  const scale = Math.min(1, MAX_IMAGE_EDGE / longest)
  const width = Math.max(1, Math.round(image.naturalWidth * scale))
  const height = Math.max(1, Math.round(image.naturalHeight * scale))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('这个浏览器不支持压缩图片')
  }
  // JPEG 没有透明通道，先把底铺白，否则透明区域会变黑
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, width, height)
  context.drawImage(image, 0, 0, width, height)

  let quality = 0.82
  let dataUrl = canvas.toDataURL('image/jpeg', quality)
  // 极端情况（超长截图之类）再降一档，控制单张在 600 KB 以内
  while (dataUrl.length > 820 * 1024 && quality > 0.45) {
    quality -= 0.12
    dataUrl = canvas.toDataURL('image/jpeg', quality)
  }
  return dataUrl
}

/** 读一个文件；不支持的格式抛错，调用方负责汇总提示 */
export const readAttachment = async (file: File): Promise<Attachment> => {
  const base = {
    id: `a_${createId().replace(/-/g, '')}`,
    name: file.name || (isImageFile(file) ? '图片' : '文本'),
    size: file.size,
    createdAt: Date.now(),
  }
  if (isImageFile(file)) {
    const dataUrl = await compressImage(file)
    return {
      ...base,
      kind: 'image',
      mimeType: 'image/jpeg',
      dataUrl,
    }
  }
  if (isTextFile(file)) {
    const raw = await readAsText(file)
    const truncated = raw.length > MAX_ATTACHMENT_TEXT_CHARS
    return {
      ...base,
      kind: 'text',
      mimeType: file.type || 'text/plain',
      text: truncated
        ? `${raw.slice(0, MAX_ATTACHMENT_TEXT_CHARS)}\n…（文件较长，只读入了前 ${MAX_ATTACHMENT_TEXT_CHARS} 个字符）`
        : raw,
    }
  }
  throw new Error(`「${file.name}」不是图片或文本文件`)
}

/**
 * 读一批文件：返回读成功的附件和失败原因，最多只读 room 个。
 * 图片失败不阻塞文本，尽量把能用的都带上。
 */
export const readAttachmentFiles = async (
  files: File[],
  room: number,
): Promise<{ attachments: Attachment[]; errors: string[] }> => {
  const attachments: Attachment[] = []
  const errors: string[] = []
  const limit = Math.max(0, Math.min(room, MAX_ATTACHMENTS))
  for (const file of files) {
    if (attachments.length >= limit) {
      errors.push(`最多 ${MAX_ATTACHMENTS} 个附件`)
      break
    }
    try {
      attachments.push(await readAttachment(file))
    } catch (error) {
      errors.push(error instanceof Error ? error.message : '读取附件失败')
    }
  }
  return { attachments, errors }
}
