# app —— 卡片树手机版前端 + 中继

根目录的 [`../README.md`](../README.md) 有完整说明；这里只写开发者需要的最小信息。

```powershell
pnpm install
pnpm dev      # rspack serve :8090（/api 代理到 127.0.0.1:8787，中继切 HTTPS 时自动走 https）
pnpm type     # tsc --noEmit
pnpm lint     # oxlint
pnpm build    # 生产构建 → dist/
pnpm start    # node server.mjs（静态托管 dist + /api 中继，默认 :8787）
pnpm smoke    # 真实调用一次 opencode go，验证中继与 SSE
node scripts/make-cert.mjs   # 生成 app/certs/ 自签证书；有证书时 server.mjs 自动走 HTTPS
```

关键约定：

- 前端默认 `apiBase = '/api'`（同源中继），不要在前端存 API Key
- `server.mjs` 只从环境变量或 `~/.dsh/.credentials.yaml` 读 `OPENCODE_GO_API_KEY`
- 主题只用 `src/app/theme.css` 里的 token（`--dsw-alias-*` / `--dsw-static-*` / `--dsw-specific-*`），不要写字面色
- 上下文装配逻辑在 `src/services/tree/context.ts`，移植自桌面插件 `../../card-tree/index.js`，改动请同步对照
- PWA 资源在 `static/`（manifest / sw.js / icon-*.png），构建时由 CopyRspackPlugin 原样拷进 `dist/` 根目录；改 `sw.js` 的缓存内容记得同时改 `CACHE_NAME`
- `certs/` 里是 TLS 私钥，已在 `.gitignore` 排除，别提交
