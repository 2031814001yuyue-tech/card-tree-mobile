/**
 * 把一张卡片渲染成可分享的长图（纯 canvas，零依赖）。
 *
 * 目标场景是发到微信/聊天里给别人看：图宽 720（2× 手机逻辑宽，文字清晰），
 * 纸面配色跟当前主题走，问题用墨色大字，回答剥掉 Markdown 只留正文。
 * 超长回答会自动缩小字号；画布上限 14000px 高（再高截断并注明），避免
 * 部分聊天软件打不开超长图。
 */

import type { Card, Project } from './tree/types.js'

const PAGE_WIDTH = 720
const PAGE_PAD = 44
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_PAD * 2
const MAX_HEIGHT = 14000

const LIGHT = {
  paper: '#f4f5f9',
  ink: '#191c23',
  inkSoft: '#5c6273',
  inkFaint: '#8a90a0',
  line: '#e3e6ee',
  blue: '#4d6bfe',
}

const DARK = {
  paper: '#101114',
  ink: '#ecedf3',
  inkSoft: '#a4aaba',
  inkFaint: '#717788',
  line: '#2a2d36',
  blue: '#6b85ff',
}

const FONT_TEXT = `-apple-system, BlinkMacSystemFont, 'PingFang SC', 'HarmonyOS Sans SC', 'Microsoft YaHei', sans-serif`
const FONT_MONO = `ui-monospace, 'SF Mono', 'Cascadia Mono', Menlo, Consolas, monospace`

/** 剥掉 Markdown 标记，保留换行结构：长图里正文以纯文本呈现 */
const stripMarkdown = (raw: string): string => {
  const lines = raw.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let inCode = false
  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      inCode = !inCode
      continue
    }
    let text = line
    if (!inCode) {
      text = text
        // 行内数学 / 公式块整个拿掉
        .replace(/\$\$[\s\S]*?\$\$/g, ' ')
        .replace(/\\[[\](].*?\\[\])]/g, ' ')
        .replace(/\$[^$\n]*\$/g, ' ')
        // 链接只留文字
        .replace(/\[([^\]]*)\]\(([^)]*)\)/g, (_all, label: string) => label)
        .replace(/!\[([^\]]*)\]\(([^)]*)\)/g, '$1')
        // 标题、引用、列表符号
        .replace(/^#{1,6}\s*/g, '')
        .replace(/^>\s?/g, '')
        .replace(/^[-*+]\s+/g, '· ')
        .replace(/^\d+[.)]\s+/g, '· ')
        // 强调
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/__([^_]+)__/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/~~([^~]+)~~/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
    }
    out.push(text.replace(/[ \t]+/g, ' ').trimEnd())
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

type Line = {
  text: string
  font: string
  color: string
  lineHeight: number
  spaceBefore: number
  indent: number
}

/** 逐字符测量换行（中文没有空格断点，只能逐字累计） */
const wrap = (ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] => {
  if (!text) {
    return []
  }
  const rows: string[] = []
  let current = ''
  for (const char of text) {
    const candidate = current + char
    if (ctx.measureText(candidate).width > maxWidth && current.length > 0) {
      rows.push(current)
      current = char === ' ' ? '' : char
    } else {
      current = candidate
    }
  }
  if (current) {
    rows.push(current)
  }
  return rows
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url.replace(/^https?:\/\//, '').split('/')[0] ?? url
  }
}

/** 渲染一张卡片的长图，返回 PNG 的 dataURL；canvas 不可用时返回 null */
export const renderCardImage = (project: Project, card: Card): string | null => {
  if (typeof document === 'undefined') {
    return null
  }
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    return null
  }
  const dark = document.body.hasAttribute('data-ds-dark-theme')
  const palette = dark ? DARK : LIGHT

  // 两种字号方案：正文长了自动换小字，尽量在画布上限内装下
  const plans = [
    { body: 27, bodyLine: 44, question: 33, questionLine: 48, small: 20, smallLine: 32 },
    { body: 22, bodyLine: 35, question: 30, questionLine: 43, small: 17, smallLine: 26 },
  ]

  for (const plan of plans) {
    canvas.width = PAGE_WIDTH
    ctx.textBaseline = 'top'

    const lines: Line[] = []
    const pushWrapped = (
      text: string,
      font: string,
      color: string,
      lineHeight: number,
      spaceBefore: number,
      indent = 0,
    ) => {
      ctx.font = font
      for (const row of wrap(ctx, text, CONTENT_WIDTH - indent)) {
        lines.push({ text: row, font, color, lineHeight, spaceBefore, indent })
      }
    }

    // 问题
    pushWrapped(
      card.prompt,
      `600 ${plan.question}px ${FONT_TEXT}`,
      palette.ink,
      plan.questionLine,
      0,
    )
    // 正文
    const bodyFont = `400 ${plan.body}px ${FONT_TEXT}`
    ctx.font = bodyFont
    const bodyText = stripMarkdown(card.answer)
    const paragraphs = bodyText.split('\n')
    for (const paragraph of paragraphs) {
      pushWrapped(paragraph, bodyFont, palette.inkSoft, plan.bodyLine, plan.bodyLine * 0.7)
    }
    // 来源
    if (card.search && card.search.sources.length > 0) {
      pushWrapped(
        '参考来源',
        `600 ${plan.small + 3}px ${FONT_TEXT}`,
        palette.inkFaint,
        plan.smallLine,
        plan.bodyLine * 2,
      )
      for (const source of card.search.sources.slice(0, 5)) {
        const label = `${source.title || source.url} · ${hostOf(source.url)}`
        pushWrapped(
          label,
          `400 ${plan.small}px ${FONT_MONO}`,
          palette.inkFaint,
          plan.smallLine * 0.9,
          plan.smallLine * 0.35,
          14,
        )
      }
    }

    const headerH = 132
    const footerH = 100
    const bodyH = lines.reduce((sum, line) => sum + line.spaceBefore + line.lineHeight, 0)
    const total = headerH + bodyH + footerH
    if (total > MAX_HEIGHT && plan === plans[0]) {
      continue // 大字号放不下，换小字号方案重排
    }
    canvas.height = Math.min(total, MAX_HEIGHT)

    // 纸面
    ctx.fillStyle = palette.paper
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    // 头部：品牌 + 日期
    ctx.font = `600 22px ${FONT_TEXT}`
    ctx.fillStyle = palette.blue
    ctx.fillText('卡片树', PAGE_PAD, 42)
    ctx.font = `400 18px ${FONT_MONO}`
    ctx.fillStyle = palette.inkFaint
    const date = new Date(card.updatedAt || Date.now())
    ctx.fillText(
      `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} · ${project.title.slice(0, 18)}`,
      PAGE_PAD + 86,
      45,
    )
    // 问题与正文的分隔：一小段品牌色
    ctx.fillStyle = palette.blue
    ctx.fillRect(PAGE_PAD, 96, 40, 3)

    // 正文
    let y = headerH
    let truncated = false
    for (const line of lines) {
      y += line.spaceBefore
      if (y + line.lineHeight > canvas.height - footerH) {
        truncated = true
        break
      }
      ctx.font = line.font
      ctx.fillStyle = line.color
      if (line.text) {
        ctx.fillText(line.text, PAGE_PAD + line.indent, y)
      }
      y += line.lineHeight
    }

    if (truncated) {
      ctx.font = `400 ${plans[1].small}px ${FONT_TEXT}`
      ctx.fillStyle = palette.inkFaint
      ctx.fillText('（回答太长，长图已截断，完整内容在 App 里）', PAGE_PAD, y)
    }

    // 底部水印
    ctx.fillStyle = palette.line
    ctx.fillRect(PAGE_PAD, canvas.height - 56, CONTENT_WIDTH, 1)
    ctx.font = `400 16px ${FONT_TEXT}`
    ctx.fillStyle = palette.inkFaint
    ctx.fillText('由「卡片树」生成 · 一问一答长成树的笔记 App', PAGE_PAD, canvas.height - 40)

    return canvas.toDataURL('image/png')
  }
  return null
}

/** 网页版：直接下载 PNG */
export const downloadCardImage = (dataUrl: string, title: string): void => {
  const safe = title.replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 40) || 'card'
  const anchor = document.createElement('a')
  anchor.href = dataUrl
  anchor.download = `${safe}.png`
  if (document.body) {
    document.body.appendChild(anchor)
  }
  anchor.click()
  anchor.remove()
}
