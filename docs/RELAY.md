# 本机中继（server.mjs）

前端要直接调用模型 API，但 **opencode go 的浏览器 CORS 是坏的**：`GET /models` 的预检/响应头正常，`POST /chat/completions` 的预检直接 404 且不带 CORS 头，浏览器里一律 `TypeError: Failed to fetch`。所以模型请求必须由本机一个零依赖的中继进程转发：浏览器只跟中继（同源或带 CORS）说话，中继拿 Key 去请求 opencode go。

```
浏览器/手机 ──HTTP(S)──▶ server.mjs（本机 8787） ──Bearer Key──▶ https://opencode.ai/zen/go/v1
```

## 一条命令启动

```bash
cd app
node server.mjs
```

零第三方依赖，只用 Node 内置模块（Node 18+，实测 Node 24）。

可用环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 中继监听端口 |
| `HOST` | `0.0.0.0` | 监听地址；`0.0.0.0` 才能让同 Wi-Fi 的手机访问 |
| `OPENCODE_GO_BASE_URL` | `https://opencode.ai/zen/go/v1` | 上游地址（末尾带不带 `/` 都行） |
| `OPENCODE_GO_SESSION` | `card-tree-mobile` | `x-opencode-session` 头的前缀；不设也行，中继会按设备指纹派生 |
| `OPENCODE_GO_API_KEY` | 从 `~/.dsh/.credentials.yaml` 读 `OPENCODE_GO_API_KEY` | 没设 env 时自动读本机 DSH 凭据；两处都没有会直接启动失败并给中文提示 |
| `DIST_DIR` | `app/dist` | 静态文件目录（`pnpm build` 的产物） |
| `HTTPS` | 自动 | `1` 强制 HTTPS（缺证书直接报错退出）、`0` 强制 HTTP；不设时「`certs/` 里有证书就 HTTPS」 |
| `HTTPS_CERT` | `app/certs/cert.pem` | 自定义服务器证书路径 |
| `HTTPS_KEY` | `app/certs/key.pem` | 自定义服务器私钥路径 |

启动成功会打印监听地址、本机 URL 和所有局域网 IPv4，并提示手机该用哪个地址。例如：

```
  卡片树手机版 · 本地中继
  ────────────────────────────────────────────
  API Key   : 已加载（来自 C:\Users\Lenovo\.dsh\.credentials.yaml，长度 51）
  上游地址  : https://opencode.ai/zen/go/v1
  上游请求头: 自动注入 Authorization、x-opencode-session、User-Agent（浏览器不用管）
  静态目录  : D:\DSH\Talk_in_Tree\card-tree-mobile\app\dist
  监听      : 0.0.0.0:8787
  访问协议  : HTTPS（自签证书：D:\DSH\Talk_in_Tree\card-tree-mobile\app\certs\cert.pem）
             电脑浏览器第一次会警告「不安全」，信任后即可；手机同理
  装成 App  : 手机先打开 https://127.0.0.1:8787/ca.pem 下载并信任根证书
             然后浏览器菜单里「添加到主屏幕 / 安装应用」
  本机访问  : https://127.0.0.1:8787
  局域网访问: https://192.168.1.23:8787    ← 手机用这个（同一 Wi-Fi）
  健康检查  : https://127.0.0.1:8787/api/health
```

`/api/health` 可用来确认中继活着（**不会返回 Key 本身**，只有 `hasKey` / `keyLength`）：

```bash
curl -k https://127.0.0.1:8787/api/health
# {"ok":true,"upstream":"https://opencode.ai/zen/go/v1","hasKey":true,"keyLength":51,"node":"v24.16.0","scheme":"https","tls":true}
```

## 从 HTTP 切到 HTTPS（手机装成 App 才需要）

浏览器只在安全上下文（https / localhost）下允许安装 PWA，而手机用局域网 IP 访问时是 http。中继内置自签证书方案，不依赖外网：

```bash
cd app
node scripts/make-cert.mjs      # 生成 app/certs/：本地 CA + 服务器证书（SAN 含 localhost、127.0.0.1、本机所有局域网 IPv4）
node server.mjs                 # 检测到证书后自动切成 https
```

- 手机先访问 `https://<电脑局域网IP>:8787/ca.pem` 下载根证书并安装信任（`/ca.crt` 是同内容的 DER 版），之后就能「安装应用 / 添加到主屏幕」
- `certs/ca.pem`、`certs/ca.crt` 只是公钥证书，可以随便下载；`certs/key.pem`、`certs/ca.key` 是私钥，绝不能外传（`.gitignore` 已排除 `certs/`）
- 换网络导致局域网 IP 变化后，重跑 `node scripts/make-cert.mjs --force` 重新签发
- 服务器证书有效期 397 天；本地 CA 有效期 3650 天
- 开发服务器 `pnpm dev`（:8090）会自动识别 `certs/` 并改用 https 代理到中继，不需要手改配置

## 手机怎么打开

### 1. 同一个 Wi-Fi（最简单）

1. 电脑上 `cd app && node server.mjs`（或者 `pnpm build` 之后再启动，这样还能顺带托管前端 dist）。
2. 手机浏览器打开启动日志里打印的局域网地址，例如 `https://192.168.1.23:8787`（没生成证书时是 `http://…`）。
3. 如果打不开：Windows 防火墙对 8787 端口的入站连接默认可能是拦的，需要放行；另外确认路由器没开「AP 隔离」。
4. 自签证书第一次打开会有「不安全」警告，按「继续访问」即可；想让手机完全没有警告并把网页装成 App，见上面「从 HTTP 切到 HTTPS」。

### 2. Tailscale（不在同一网络，也安全）

电脑装 Tailscale 并登录后，中继会监听在 `0.0.0.0`，手机也装 Tailscale 登同一账号，直接访问电脑的 Tailscale IP：`http://100.x.y.z:8787`。流量走加密隧道，不用改路由器、不用暴露公网。

### 3. 公网反向代理（谨慎）

把 8787 反代到公网域名时必须自己加一层认证（HTTP Basic / 网关鉴权），并套 HTTPS。中继本身**没有任何鉴权**，见下面的安全提醒。

## 开发模式（rspack serve 8090）

前端 dev server 是 `cd app && pnpm dev`（rspack serve，端口 **8090**），它跨源请求中继，所以中继对 `/api/*` 已带 CORS（`Access-Control-Allow-Origin: *`，允许 `authorization, content-type, x-opencode-session`，`OPTIONS` 直接 204）。

开发时两个进程都开着：

```bash
# 终端 1：中继
cd app && node server.mjs

# 终端 2：前端
cd app && pnpm dev
```

然后在应用「设置 → API 地址」里填：

```
http://127.0.0.1:8787/api
```

（相对路径 `/api` 是给生产模式用的：那时 `node server.mjs` 同时托管 dist 和 API，同源，设置里留空即可。）

手机想连开发服务器调试的话，`pnpm dev` 默认只听 localhost，需要让 rspack 对外监听（`--host 0.0.0.0`，改 `rspack.config.ts` 的 devServer.host —— 这部分不在中继范围内）。

## 中继提供的 API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查：`{ok, upstream, hasKey, keyLength, node, scheme, tls}` |
| GET | `/api/models` | 代理上游 `GET /models`，注入 Key，内存缓存 5 分钟 |
| POST | `/api/chat/completions`（`/api/chat` 等价） | 原样转发 chat 请求体，SSE 流式字节透传 |
| GET | `/ca.pem`、`/ca.crt` | 下载自签根证书（仅公钥，供手机安装信任；没生成证书时 404） |

请求体和上游协议一致（OpenAI 兼容）：

```json
{
  "model": "deepseek-v4.1-flash",
  "messages": [{ "role": "user", "content": "你好" }],
  "stream": true
}
```

## 中继替你补的请求头

opencode go 对 chat 请求有两条硬要求，缺了直接返回 400（`MissingSessionID`）：

- `x-opencode-session`：每个请求都要带一个稳定的会话 id。**浏览器只发普通请求会被拒**，中继会自动补：客户端显式带了就透传（CORS 已放行这个头，可按对话区分），没带就按「设备指纹」派生一个，同一台手机共享一个会话。
- `User-Agent`：要求客户端用自己的 UA 标识自己，而不是 SDK/HTTP 库的默认 UA；中继固定发 `card-tree-mobile/0.1 (local relay)`。

`Authorization: Bearer <key>` 也由中继注入，浏览器侧永远不需要、也不应该持有 Key。

## 安全提醒（重要）

- **中继等同持有 API Key**：任何能访问 8787 的人都能用它花你的额度、读你的模型列表。所以默认只建议内网/Tailscale 使用。
- 不要把它直接暴露到公网；确需公网访问，务必在反向代理层加认证（并只开 HTTPS）。
- Key 只存在于中继进程内存和 `~/.dsh/.credentials.yaml`，不会写日志、不会出现在 `/api/health`、也不会传给浏览器。
- `certs/` 下的 `key.pem`、`ca.key` 是 TLS 私钥：不要提交、不要发给别人。中继只对外提供 `ca.pem` / `ca.crt`（公钥证书），私钥永远不出网。
- 中继目前**不转发** `/models` 以外的上游路径，也不代理任意 URL，避免被当成开放代理。

## 自检

```bash
cd app
node scripts/smoke-relay.mjs   # 端到端冒烟：health → models → SSE 流式对话
```

冒烟脚本会以 `PORT=8799` 临时拉起一个中继（不占用 8787），全程走真实上游，最后输出 `SMOKE OK`。
