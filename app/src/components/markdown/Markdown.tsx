import { memo, useMemo } from 'react'
import { toMdAst } from '../../services/markdown/parse.js'
import { MarkdownAstRenderer } from './MarkdownAstRenderer.js'
import { useThrottleMarkdownRender } from './useThrottleMarkdownRender.js'
import './markdown.css'
import './highlight.css'

const noop = () => {}

/**
 * 渲染链路：节流 → 解析 AST → 渲染。
 * 卡片回答可能很长，流式输出时用节流降低解析频率。
 */
export const Markdown = memo(function Markdown({
  content,
  loading = false,
  cacheKey,
  className,
  disableLink = false,
}: {
  content: string
  loading?: boolean
  cacheKey: string
  className?: string
  disableLink?: boolean
}) {
  const throttledMarkdown = useThrottleMarkdownRender(content, loading)
  const ast = useMemo(
    () => (throttledMarkdown ? toMdAst(throttledMarkdown, { sources: undefined, disableLink }) : null),
    [throttledMarkdown, disableLink]
  )
  return ast ? (
    <MarkdownAstRenderer
      key={cacheKey}
      className={className}
      ast={ast}
      loading={loading}
      onUpdate={noop}
    />
  ) : null
})
