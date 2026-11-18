import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from '@rspack/cli'
import { rspack, type Configuration } from '@rspack/core'

// 用命令行判断是否开发服务器，Windows 上不依赖 NODE_ENV=production 这种前缀写法
const dev = process.argv.includes('serve')
const targets = ['chrome >= 105', 'edge >= 105', 'safari >= 16', 'firefox >= 110']
const root = path.dirname(fileURLToPath(import.meta.url))
const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8')
) as { version: string }

/** 中继端口，和 app/server.mjs 保持一致 */
const RELAY_PORT = Number(process.env.PORT || 8787)
/** 中继协议：certs/ 里有证书时 server.mjs 会自动走 HTTPS，开发代理要跟着切 */
const RELAY_TLS =
  process.env.RELAY_TLS !== undefined
    ? process.env.RELAY_TLS === '1'
    : existsSync(path.resolve(root, 'certs', 'cert.pem'))

const cssLoader = {
  loader: 'builtin:lightningcss-loader',
  options: { targets },
}

type ConfigOptions = {
  /** 模型接口地址，注入为 __API_ORIGIN__；默认同源 /api 走本机中继 */
  apiOrigin?: string
  /** 开发服务器配置 */
  devServer?: Configuration['devServer']
}

/** 创建构建配置，支持自定义接口地址和开发服务器选项 */
export const createConfig = ({
  apiOrigin = '/api',
  devServer,
}: ConfigOptions = {}): Configuration => ({
  mode: dev ? 'development' : 'production',
  entry: './src/main.tsx',
  output: {
    path: path.resolve(root, 'dist'),
    // 运行时按当前脚本地址推导资源路径，file:// 下异步 chunk、字体都按相对位置加载
    publicPath: 'auto',
    filename: 'static/js/[name].[contenthash:8].js',
    chunkFilename: 'static/js/async/[name].[contenthash:8].js',
    cssFilename: 'static/css/[name].[contenthash:8].css',
    cssChunkFilename: 'static/css/async/[name].[contenthash:8].css',
    assetModuleFilename: 'static/media/[name].[contenthash:8][ext]',
    clean: true,
  },
  devtool: dev ? 'cheap-module-source-map' : false,
  // 开发模式预编译异步模块，保持首次加载代码高亮和公式时的页面状态
  lazyCompilation: false,
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
    // 将 .js 导入路径解析到同名 .ts、.tsx 或 .js 文件
    extensionAlias: { '.js': ['.ts', '.tsx', '.js'] },
  },
  module: {
    // CSS Modules 使用默认导出：`import styles from './x.module.css'`
    parser: { 'css/module': { namedExports: false } },
    generator: { 'css/module': { localIdentName: '[local]-[hash:6]' } },
    rules: [
      { test: /\.module\.css$/, type: 'css/module', use: [cssLoader] },
      { test: /\.css$/, exclude: /\.module\.css$/, type: 'css', use: [cssLoader] },
      {
        test: /\.(j|t)sx?$/,
        exclude: /[\\/]node_modules[\\/]/,
        loader: 'builtin:swc-loader',
        options: {
          jsc: {
            parser: { syntax: 'typescript', tsx: true },
            transform: { react: { runtime: 'automatic', development: dev } },
            externalHelpers: true,
          },
          env: { targets },
        },
        type: 'javascript/auto',
      },
      { test: /\.(woff2?|ttf)$/, type: 'asset/resource' },
    ],
  },
  plugins: [
    // 经典 defer 脚本支持 file:// 页面的资源加载
    new rspack.HtmlRspackPlugin({
      template: './src/index.html',
      scriptLoading: 'defer',
      meta: { 'application-version': version },
    }),
    new rspack.DefinePlugin({ __API_ORIGIN__: JSON.stringify(apiOrigin) }),
    // PWA 资源（manifest / service worker / 图标）原样放到 dist 根目录
    new rspack.CopyRspackPlugin({
      patterns: [
        { from: path.resolve(root, 'static'), to: '.', noErrorOnMissing: true },
        { from: path.resolve(root, 'LICENSE'), to: 'LICENSE', toType: 'file', noErrorOnMissing: true },
      ],
    }),
  ],
  performance: { hints: false },
  devServer: {
    port: 8090,
    // 开发时把 /api 转发到本机中继（中继切了 HTTPS 时这里也走 https，自签证书不校验）
    proxy: [
      {
        context: ['/api'],
        target: `${RELAY_TLS ? 'https' : 'http'}://127.0.0.1:${RELAY_PORT}`,
        secure: false,
      },
    ],
    static: { directory: path.resolve(root, 'static'), publicPath: '/' },
    historyApiFallback: true,
    ...devServer,
  },
})

// eslint-disable-next-line import/no-default-export
export default defineConfig(createConfig())
