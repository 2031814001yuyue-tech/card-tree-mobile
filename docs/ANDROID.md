# Android APK 说明（card-tree-mobile 0.3.12）

这份文档说明 `android/` 壳子是怎么工作的、怎么构建、以及验证到了哪一步。
产品层面的安装步骤看 [`../README.md`](../README.md) 的「Android APK」一节。

## 为什么不用 Capacitor / React Native

结论：**自己写 WebView 壳 + 纯 Java 的本地 HTTP 服务**。

- **Capacitor**：它的 `CapacitorHttp` 把响应整体 buffer 后再交给 JS，聊天就会变成「等全部生成完再一次性出现」，流式体验直接没了；用 WebView 的 `shouldInterceptRequest` 返回 `PipedInputStream` 去拦截流，在不同 WebView 版本上行为不一致，也不选。
- **React Native**：等于把整套卡片树 UI 重写一遍，不划算——网页版已经 390×844 验收过。
- **自写壳的好处**：网页原样塞进 APK，本地起一个同源的 `http://127.0.0.1:<端口>`，CORS、安全上下文、IndexedDB 全部自然成立；上游 SSE 可以逐块 `read → write → flush` 透传。

## 启动到出字，中间发生了什么

```
MainActivity.onCreate()
  ├─ KeyVault(this)                        opencode go 对话 Key（Android Keystore AES-256-GCM）
  ├─ KeyVault(this, "deepseek_api_key", "card_tree_deepseek_key_v1")   DeepSeek 官方对话 Key ＝搜索 Key
  ├─ KeyVault(this, "zai_api_key", "card_tree_zai_key_v1")              智谱 Coding Key
  ├─ KeyVault(this, "kimi_api_key", "card_tree_kimi_key_v1")            Kimi Coding Key
  ├─ WebUpdater(getFilesDir(), UPDATE_REPO, APP_VERSION)              热更新器（见下节）
  ├─ LocalServer(assets, chatKeys, searchVault::get, sessionId, "0.3.12", preferredPort)
  │    ├─ ServerSocket(固定端口, 50, 127.0.0.1)   只监听本机回环；端口固定后复用
  │    ├─ 后台线程 acceptLoop()             每连接一个线程（daemon 线程池）
  │    └─ setChatDoneListener(this::notifyAnswerDone)   流式自然读完 → 后台时发系统通知
  │                                             （0.3.12：客户端中途断开 = 点停止，不触发）
  └─ WebView.loadUrl("http://127.0.0.1:<port>/")
        │
        ├─ GET /                     → files/web/index.html（热更新版）→ 没有再回 assets/www
        ├─ GET /static/js/main.*.js  → 静态资源（Cache-Control: no-store）
        ├─ GET /api/health           → {"ok":true,"mode":"android",...,"providers":{...}}
        ├─ GET /api/models           → 按 x-card-tree-provider 路由四家上游，每家 5 分钟缓存
        ├─ POST /api/chat/completions→ 按头路由四家并逐块透传 SSE
        │                               （一律注入 Authorization；opencode 另补 x-opencode-session / UA）
        ├─ POST /api/deepseek/search → 反代 DeepSeek Search API（工具循环 / 前置模式共用；没有搜索 Key 时返回 409）
        └─ POST /api/deepseek/messages→ 反代 DeepSeek Anthropic 端点（0.3.9 原生联网搜索：
                                        x-api-key + anthropic-version，SSE 逐块透传；没有 Key 时 409）

（启动 4 秒后 web.postDelayed → checkWebUpdateSilently()：后台查一次 GitHub Releases，
  有新版 toast 提示去「设置 → 关于」手动更新）
```

要点：

- **回答完成通知（0.3.12）**：`LocalServer` 在透传循环里区分「上游自然读完」（`finished`）与「客户端断开」（点停止），只有前者调 `notifyChatDone(provider)` → `MainActivity.notifyAnswerDone`（`resumed` 时直接返回，即前台用 App 不打扰；后台时走通知 channel "answers"、点通知回 App）。`handleAnthropic`（原生联网搜索）同样接了。Android 13+ 首次启动 `requestNotificationPermissionIfNeeded()` 请求 `POST_NOTIFICATIONS`。网页版的对应逻辑在 `store.ts` 的 `notifyAnswerDone`（`visibilityState==='hidden'` 且已授权才发浏览器通知，授权入口在「设置 → 关于」）。
- `127.0.0.1` 是安全上下文，`navigator.serviceWorker` / `localStorage` / `IndexedDB` 都能用；不过 **Service Worker 在 APK 里不注册**（`registerServiceWorker()` 检测到 `window.CardTreeNative` 就直接返回），因为资源本来就在本地，注册反而会在升级后读到旧缓存。
- **端口固定**：`LocalServer` 的 5 参构造多了一个 `preferredPort`，`MainActivity` 从 SharedPreferences（`card_tree_mobile / local_port`）读上次的端口，先试绑、失败才回退随机端口，成功后写回。这一点是必须的——WebView 的 IndexedDB 按「scheme + host + port」隔离，端口每次都变就等于每次都是新 App，项目会全部看不见。
- **自动备份**：`NativeBridge.saveAutoBackup(json)` 走原生侧写文件（Android 10+ 用 MediaStore 写「下载 / CardTree / backups」，旧系统写应用外部目录），按文件名时间戳滚动保留最近 30 份；网页侧在数据变化后由 `App.tsx` 的 effect 触发（退到后台 / `pagehide` / 每 5 分钟，且只在有改动时写）。
- `/api/*` 的响应头固定带 `Cache-Control: no-store`；静态资源也是 `no-store`，避免 WebView 升级后还用旧 JS。
- 未知的、不带扩展名的路径回退到 `index.html`（SPA 路由习惯），`..` 一律拒绝。
- 上游请求带 `Accept-Encoding: identity`，避免 Android 的 HttpURLConnection 自动 gzip 后流式边界错乱；聊天 `readTimeout = 600s`，连接 20s。

### 附件（图片 / 文件）在 APK 里怎么走

附件全部在**网页侧**处理完再发：图片被压成 dataURL（长边 1280、JPEG 0.82），和文本附件一起被组装成 OpenAI 兼容的 `content` 数组（`[{type:'text'},{type:'image_url',image_url:{url:'data:image/jpeg;base64,…'}}]`）。

所以 `LocalServer` 一行 Java 都不用改：`handleChat` 本来就是把请求体的字节原样转给上游，SSE 也是逐块透传；上行变大的是请求体（4 张图约 1–1.6 MB，服务端 8 MB 上限内）。

一个代价：图片提问必须选**支持视觉的模型**（如 `claude-haiku-5-5`、`glm-5.3`、`gpt-5.6-luna`），选 `deepseek-v4.1-flash` 这类纯文本模型时上游会回 400，错误会显示在卡片上。

### 联网搜索在 APK 里怎么走

搜索分**三种情况**（0.3.9 原生模式 / 0.3.14 工具循环 / 前置模式兜底），由当前订阅和模型能力决定：

**前置模式（opencode go / 智谱 / Kimi 订阅）**——DeepSeek 官方 Search API：

```
网页（services/search.ts）
  └─ POST /api/deepseek/search {query, count, ori_question}
        └─ LocalServer.handleSearch
              ├─ searchKeys.get() 为空 → 409 {"code":"search_unavailable", …}
              └─ 有 Key → POST https://api.deepseek.com/v1/tools/search
                          （Bearer = 搜索 Key，UA = card-tree-mobile/<version> (android)）
                          → 状态码与响应体原样透传
```

**原生模式（DeepSeek 官方订阅，0.3.9 新增）**——Anthropic 协议 + 服务端 web_search 工具，和 DeepSeek 手机端同一套机制：

```
网页（services/api/anthropic.ts streamNativeSearchChat）
  └─ POST /api/deepseek/messages {model:"deepseek-chat", stream:true, tools:[web_search max_uses:5], messages, system?}
        └─ LocalServer.handleAnthropic
              ├─ searchKeys.get() 为空 → 409（提示切到 DeepSeek 官方订阅并粘 Key）
              └─ 有 Key → POST https://api.deepseek.com/anthropic/v1/messages
                          （x-api-key + Bearer + anthropic-version: 2023-06-01，SSE 4096 字节逐块 flush）
                          → server_tool_use / web_search_tool_result / text_delta 原样透传
```

- 原生模式下**模型自主**决定搜不搜、搜什么、搜几轮（上限 `max_uses:5`）；网页侧 `onSearching` 显示「正在搜索…」、`onSources` 收集 `web_search_result`（title/url）写进 `followUp.search` / `card.search`；回答天然带 `[1][2]` 引用
- **工具循环（0.3.14 起，其它订阅的默认方式）**：网页侧请求带上 `tools:[web_search]`（OpenAI 兼容的 function calling），模型先返回 `tool_calls`（里面是它自己写的搜索词）→ 网页侧调 `/api/deepseek/search` 搜 → 把结果作为 `role:'tool'` 消息塞回去让它继续写，**最多两轮、每轮最多 2 次搜索**。APK 侧不需要新路由：`/api/deepseek/search` 本来就是原样转发，拿到的 `{results}`/`{sources}` 前端都认。搜索中卡片显示「正在搜索「模型给的词」…」（`live.searchingQuery`）
- 有些订阅/模型不认工具调用：第一次被上游 400/422 且错误里提到 tool/function 时，前端把这个订阅记进 localStorage `card-tree:tool-less`，之后该订阅自动退回**前置模式**（多花一次被拒的请求，不影响使用）
- `store.ts` 的 `run()`：`provider==='deepseek'` 且开了联网 → 走 `streamNativeSearchChat`（跳过前置搜索、不拼 searchBlock）；其它订阅先试工具循环、不支持再退回前置搜索。重答 / 换角度沿用卡片旧来源（原生模式重答走普通流式 + 旧来源，不再花钱搜索）
- 搜索 Key 是**独立一把**：`KeyVault(this, "deepseek_api_key", "card_tree_deepseek_key_v1")`——它同时是「DeepSeek 官方」订阅的对话 Key（同 field / alias，「设置 → 联网搜索」与「设置 → 连接（DeepSeek 官方时）」看到的就是同一把）；其它订阅的对话 Key 各用各的 field，互不影响
- 前置模式下网页侧**两种返回结构都认**：中继版返回 `{sources:[…]}`，APK 直连 DeepSeek 返回 `{results:[…]}`（`services/search.ts` 里优先读 `sources`，没有就读 `results`，`publishedAt` 兼容 `date`）
- 搜到的摘要（前置模式）会被 `context.ts` 的 `searchBlock()` 拼成编号清单放进这一问的用户消息；工具循环则把每条结果作为 `tool` 消息（`search.ts` 的 `formatToolResult()` 带编号 + 截断摘要）；两种模式与原生模式的来源都随卡片存 IndexedDB，离线回看时来源列表还在
- 搜索失败 / 没配 Key 都不会阻塞提问：工具循环把失败告诉模型让它换词或直接答，前置模式 toast 一句后照常发；APK 里没配 Key 时输入框上方的开关显示「联网（未开通）」

### 多订阅（四家上游）在 APK 里怎么走

`LocalServer` 里有一张静态 `PROVIDERS` 表（id / label / base / sessionNeeded），按请求头 `x-card-tree-provider` 路由（缺省 `opencode`，trim + 小写后匹配，未知 id → 400 `provider_unknown`）：

| id | 上游 | sessionNeeded | Key（SharedPreferences 字段 / Keystore alias） |
| --- | --- | --- | --- |
| opencode | `https://opencode.ai/zen/go/v1` | 是（补 `x-opencode-session` + UA） | `api_key` / `card_tree_api_key_v1` |
| zai | `https://open.bigmodel.cn/api/coding/paas/v4` | 否 | `zai_api_key` / `card_tree_zai_key_v1` |
| kimi | `https://api.kimi.com/coding/v1` | 否 | `kimi_api_key` / `card_tree_kimi_key_v1` |
| deepseek | `https://api.deepseek.com` | 否 | `deepseek_api_key` / `card_tree_deepseek_key_v1`（与搜索共用） |

- 构造函数签名：`LocalServer(AssetSource, Map<String,KeyProvider> chatKeys, KeyProvider searchKeys, String sessionId, String version, int preferredPort)`；`MainActivity.chatKeys(map)` 把 `Map<String,KeyVault>` 转成 `Map<String,KeyProvider>`（跳过没初始化的项）
- `handleModels` / `handleChat` 都先 `providerId(headers)` → `findProvider`；没配那家的 Key → 409 `provider_unavailable`（中文提示带 label）
- models 缓存按 provider 分桶（`ConcurrentHashMap<String, ModelsCache>`，TTL 仍是 5 分钟）；`health()` 返回 `"providers":{opencode:true,…}` 供网页显示「服务端已配置 Key 的订阅」
- `NativeBridge` 构造 `(MainActivity, KeyVault, Map<String,KeyVault> providerVaults, WebUpdater)`；新桥方法 `hasProviderKey(id)` / `saveProviderKey(id,key)`（成功后 `reloadModelsLater()`）/ `clearProviderKey(id)`；旧的 `hasKey/saveKey/clearKey` 保留、作用于 opencode 那把——**WebView 桥方法不能重载，所以按名字分发**
- 网页侧兼容旧壳：`nativeSupportsProviders()` 检测桥上有没有 `hasProviderKey`；0.3.4 及更早的壳没有 → 多订阅 UI 整体隐藏（防止热更新把新网页层推给旧壳、用户填了 Key 却存不上）

### 网页层热更新在 APK 里怎么走

更新源是 GitHub Releases（仓库 `2031814001yuyue-tech/card-tree-mobile`，tag 形如 `web-v0.3.5`，资产 `web.zip` + `web.zip.sha256`）：

```
WebUpdater.check()
  └─ GET https://api.github.com/repos/<repo>/releases?per_page=10   （匿名，60 req/h 够用）
        └─ pickRelease：跳过 draft/prerelease；tag 必须是 web-v 前缀；
           版本要比 currentWebVersion() 新；资产必须同时有 web.zip 和 sha256

WebUpdater.install(info, progress)
  ├─ 下载 web.zip（≤64MB）→ 按资产里的 sha256 校验，不一致直接取消
  │   （0.3.6 起优先走「下载镜像」前缀；镜像失败自动回直连重试一次，progress 会报
  │    「镜像下载失败，改用直连」；镜像存 SharedPreferences，网页侧可改）
  ├─ 解压到 files/web-staging/（canonical path 防 zip-slip，单文件 32MB / 总量 96MB 上限，
  │   必须能找到 index.html，否则整个取消）
  ├─ deleteRecursive(files/web/) → staging.renameTo(files/web)   ← 原子切换
  └─ 写 files/web-version.txt = 新版本号（currentWebVersion() 以后读它）

MainActivity 的 AssetSource：
  updater.openUpdated(path) 有就先给 files/web/ 的；没有（或从没更新过）回 assets/www/
  → 下载/校验/解压任何一步失败，App 都继续用内置版，不会变砖
  → 清 App 数据 = 删掉 files/web → 回到 APK 内置版
```

- 触发点两个：启动 4 秒后静默查（只 toast 提示）；「设置 → 关于 → 检查更新」手动查 + 一键更新
- 网页侧 `NativeBridge.checkWebUpdate()` 同步返回 JSON（available/version/size/notes/error），`installWebUpdate()` 抢到锁后开守护线程装，进度经 `window.__cardTreeUpdateProgress` 回传，装完 `window.__cardTreeUpdateDone(ok, message)` → 网页自动 `location.reload()`
- 测试缝：`WebUpdater` 有一个包私有构造 `(baseDir, repo, shellVersion, apiBase)`，把 GitHub API 指到本地服务器用；Android 侧永远走公开构造（`apiBase = https://api.github.com`）
- 发布命令：`cd app && pnpm build && node scripts/publish-web.mjs --notes "…"`（zip 是纯 Node 写的——PS 5.1 的 `Compress-Archive` 会写出反斜杠条目名，Android 的 ZipFile 解不开）
- 仓库必须 **public**：App 匿名读 Releases，private 仓库 API 会 404
- 只有 Java 壳要改（新增 `@JavascriptInterface` 方法、改路由等）才需要重新发 APK；纯网页层改动只发 Release

## 文件一览（`android/app/src/main/java/com/cardtree/mobile/`）

| 文件 | 作用 |
| --- | --- |
| `MainActivity.java` | 唯一 Activity：起服务、配 WebView、处理返回键 / 文件选择 / 状态栏配色 / 导出备份、挂 WebUpdater、启动静默检查 |
| `LocalServer.java` | 本地 HTTP/1.1 服务（纯 JDK，不依赖 Android）：静态资源 + `/api/models` `/api/chat/completions`（SSE 逐块透传）+ `/api/deepseek/search`（前置搜索转发）+ `/api/deepseek/messages`（0.3.9 原生联网搜索，Anthropic 端点 SSE 透传） |
| `KeyVault.java` | API Key 的加解密：Android Keystore 里生成不可导出的 AES-256-GCM 密钥，密文（iv + ciphertext）Base64 存 SharedPreferences；构造器带 `field` / `alias`，对话 Key 与搜索 Key 各存一把 |
| `WebUpdater.java` | 热更新器（纯 JDK）：查 GitHub Releases → 下载（可走镜像前缀，失败回直连）→ sha256 校验 → 解压 staging → 原子切换 `files/web` → 写版本号；内嵌一个小型 JSON 解析器只读 Releases 响应 |
| `NativeBridge.java` | `@JavascriptInterface`，注入 `window.CardTreeNative`：`hasKey / saveKey / clearKey / hasSearchKey / saveSearchKey / clearSearchKey / hasProviderKey / saveProviderKey / clearProviderKey / version / setChrome / saveBackup / saveAutoBackup / saveImage / toast / getWebVersion / checkWebUpdate / installWebUpdate / setUpdateMirror / getUpdateMirror` |
| `AssetSource.java` | 一行接口，把 `assets/www/<path>` 抽象成 `InputStream`（方便在桌面 JVM 上测 `LocalServer`） |
| `Mime.java` | 扩展名 → Content-Type |

网页侧对应新增 `app/src/services/native.ts`：

- `isNativeApp()` / `nativeBridge()` / `nativeHasKey()` / `saveNativeKey()` / `clearNativeKey()` / `nativeHasSearchKey()` / `saveNativeSearchKey()` / `clearNativeSearchKey()` / `nativeHasProviderKey()` / `saveNativeProviderKey()` / `clearNativeProviderKey()` / `nativeSupportsProviders()` / `nativeVersion()` / `saveNativeBackup()` / `saveNativeAutoBackup()` / `saveNativeImage()` / `nativeUpdateMirror()` / `setNativeUpdateMirror()`（后三个是可选桥方法，旧壳 0.3.4 没有会安全降级）
- 0.3.6 网页侧新增：`services/share.ts` 纯 canvas 把单卡渲染成 720px 长图（`renderCardImage`，跟随深浅色），APK 里经 `saveImage` 存「下载/CardTree」，网页版直接触发下载；「导出全部项目」走 `io.ts` 的 `exportAllProjectsJson`（与桌面版 `state.json` 同构）
- `App.tsx` 在 `window.__cardTreeBack` 上挂返回键处理（先关浮层 → 再回树 → 都没有才退出），在 `window.__cardTreeKeyChanged` 上挂模型重拉
- 没有 Key 时弹一次「先连上 <当前订阅>」的 Sheet；「设置 → 连接」跟随当前订阅显示 / 替换 / 清除那家的 Key
- `theme.ts` 把纸面背景色同步给原生状态栏 / 导航栏（四种界面风格切换时也会跟着换）
- `store.ts` 的「导出当前项目」在 APK 里改走原生保存到「下载/CardTree」

## 构建

环境（实测）：JDK 17（Temurin 17.0.20）、Gradle 8.7、AGP 8.5.2、Android SDK platform 34 + build-tools 34.0.0、Windows 10/11 + PowerShell 5.1。

```powershell
# 1) 先出网页产物
cd app
pnpm install
pnpm build

# 2) 再打 APK（app/build.gradle 的 preBuild 会自动把 ../app/dist 复制进 assets/www，并先清空）
cd ../android
C:\Users\Lenovo\Android\gradle-8.7\bin\gradle.bat assembleDebug
# 产物：android/app/build/outputs/apk/debug/app-debug.apk
```

`android/local.properties` 里写 `sdk.dir=<SDK 路径>`（git 忽略）。没有写 SDK 的机器上会直接报错提示。

首次构建需要联网下载 AGP / 依赖；之后离线也能构建（本机就是这样，缓存来自 2026-11-03 的旧项目）。

### 版本号

改四处（**一条命令改一个文件**，别批量替换；批量替换曾把整份文件里的字符替换错）：
`android/app/build.gradle` 的 `versionCode` / `versionName`、`MainActivity.java` 的 `APP_VERSION`（网页「关于」里显示的那个）、`app/src/components/settings/SettingsSheet.tsx` 里 `nativeVersion() ?? '0.3.6'` 的兜底值（有两处，含 WebUpdate 组件里那处）、`app/package.json` 的 `version`。改完 `node -e "require('./package.json')"` + `pnpm type` 过一遍。**一次只改一条**（PowerShell 批量替换曾把整份文件改坏过）。

**纯网页层的改动不需要动 APK**：壳没变时只改 `app/package.json` 的 `version` 和 SettingsSheet 两处兜底（如 0.3.7 的卡片合并、0.3.10 的滑动动画、0.3.11 的流式快照、0.3.13 的字号/手势/搜索词、0.3.14 的工具循环搜索），发一个 `web-v<x.y.z>` 的 Release 即可，装了旧 APK 的用户「检查更新」就能拿到；`versionCode` / `APP_VERSION` 保持不变，`aapt2` 验证结果也不变。

## 已做的验证

| 项目 | 结果 |
| --- | --- |
| `aapt2 dump badging` | `package: name='com.cardtree.mobile' versionCode='11' versionName='0.3.12'`，minSdk 26 / targetSdk 34，`INTERNET` + `POST_NOTIFICATIONS` 权限，label「卡片树」，5 个密度图标齐全 |
| `apksigner verify` | release APK 由 `android/app/card-tree-release.jks` 签名（v2 方案），证书 DN `CN=CardTree Mobile` —— 不是 debug 证书 |
| APK 内容 | 167 个条目，其中 156 个是 `assets/www/**`：`index.html`、`manifest.webmanifest`、`icon-180/192/512.png`、单个 hash 化的 `static/js/main.*.js` + `static/css/main.*.css` + KaTeX 字体 |
| `LocalServer` 桌面 JVM 冒烟 | 用 JDK 17 把 `LocalServer` + `AssetSource` + `Mime` 编译成纯 JVM 程序，读真实 `app/dist` 与真实 Key：静态首页 1330 B、manifest、SPA 回退、未知静态 404、`/api/health` JSON（含 `"search":true`）、`/api/models` 42151 B（32 个模型）、`/api/chat/completions` 真实 SSE —— **29 个 chunk、首块 1ms、27 条 `data:` 事件、200 text/event-stream**、`/api/deepseek/search` 真实搜索 —— **200、771ms，返回 中国天气网 / 钱江晚报 两条结果** |
| 网页侧 | `pnpm type` 0 error、`pnpm lint` 0 warning 0 error、`pnpm build` 通过 |
| 联网搜索端到端 | 390×844 视口点亮「联网搜索」提问「杭州今天天气怎么样？」：真实搜到 5 条来源、回答带 `[1]–[5]`、卡片底部来源列表可点；思考过程里能看到 5 条资料摘要（见 `docs/preview/25-search-toggle.png`、`26-search-sources.png`） |
| 工具循环搜索（0.3.14） | CDP 390×844 + opencode go / deepseek-v4.1-flash：开联网追问「今天杭州天气怎么样？顺便说说 2026 年 11 月最新的 AI 新闻」→ 请求体带 	ools:1（5 条消息）→ 模型返回 2 个 tool_call → App 真实搜了 2 次（杭州今天天气 实时天气预报、2026年11月 AI 最新新闻）→ 第二轮带 8 条消息（assistant + 2 条 tool 结果）→ 924 字回答 → 落库 ollowUp.search.query 与 10 条去重来源（见 docs/preview/44-tool-search.png） |
| 原生 UI 路径 | 用 CDP 注入一个假的 `window.CardTreeNative`，在 390×844 视口截了「首次启动填 Key」和「设置 → 连接」两张图（见 `docs/preview/14-onboarding.png`、`15-settings-connect.png`） |
| **WebUpdater 全链路** | **真实 GitHub API**：同版本（0.3.4）check → `null`（无更新）；低版本（0.0.1）check → 正确拿到 `web-v0.3.4`（tag/size/notes 齐全）。**本地服务器扮演 GitHub 完整安装**：check → 下载 → sha256 校验 → 解压 156 个文件（`index.html` 1450 B、`static/css/main.*.css` 73530 B 都能从 `files/web/` 读出）→ 原子切换 → `currentWebVersion()` 读回 `9.9.9`；`../` 目录穿越被拒绝；**sha256 不一致**时抛「更新包校验失败（sha256 不一致），已取消」且 `files/web` 不被创建、版本仍是壳版本 |
| 发布脚本 | `node scripts/publish-web.mjs` 发布 `web-v0.3.5`（web.zip 1.78 MB、156 个条目、正斜杠路径），`jar tf` 验证 zip 结构正确；gh 前置检查（auth / tag 不存在）都过 |
| 四家订阅路由 | `GET /api/models` 带 `x-card-tree-provider` 四家全 200；kimi / deepseek / opencode 流式对话真跑通（31 / 17 / 8 chunks）；智谱返回 429「套餐已到期」原样透传；未知头 400 `provider_unknown`；「设置 → 连接」随当前订阅显示（CDP 假桥注入验证，见 `docs/preview/29-providers.png`） |
| **镜像回退（0.3.6）** | 本地双 HttpServer 扮演直连源与镜像源：配好镜像时 `install` 全程走镜像装包成功（LOG 无回退）；镜像指向无人监听端口时自动报「镜像下载失败，改用直连」并回退直连成功；空镜像直连回归正常。手写 STORED zip 验证了解压路径（教训：单文件 zip 的 CRC 必须真算） |
| 0.3.6 新交互 | CDP 文本 dump 验证：卡片操作行六 chip（含「分享」）、追问右下「编辑」、分享 toast、模型菜单「能看图 · 上下文 1M」（读自真实 `/models` 的 `limit.context` 字段——注意不是 `context_window`）、「导出全部项目」按钮、「下载镜像」输入框（见 `docs/preview/34–37`） |
| **卡片合并（0.3.7，纯网页层）** | CDP 端到端三链路全验：卡片操作行「合并」chip 与长按菜单「并入另一张卡…」两个入口都真跑——IndexedDB 逐项核对源卡删除、追问转移、子卡改挂目标卡、引用去重合并、其它卡对源卡的引用改指目标卡；合并后正看源卡自动回树。**顺带修真 bug**：长按抬手的合成 click 会落在刚打开浮层的遮罩上把菜单立刻关掉（Sheet 加 350ms 打开宽容期，`Input.dispatchTouchEvent` hold 700ms 复现验证） |
| **流式跟随 / 浮动按钮 / 左右滑（0.3.8，纯网页层）** | CDP 全验：滚动后跳底钮出现、两态切换（跳底 atBottomGap:0 / 跳顶 top:0）、树右滑开抽屉、抽屉右滑关、卡右滑回树、树左滑回最近卡、卡左滑开全览、按住期间流式不拉走滚动位置；追问区的「正在搜索…」350ms 可见、搜索结束消失。**顺带修真 bug**：0.3.5 起的跟随拉回底部（scroll/resize 监听挂在 `ready=false` 时刻从未生效——`mainRef.current=null` 时挂了个空；0.3.8 改为 `ready` 后挂并加 `userTouchRef` 按住即停）。**测试坑**：CDP touch 起点 x<80 会触发 Chrome 历史导航手势把页面导走，起点要 ≥100 |
| **原生联网搜索（0.3.9，壳改动）** | 三层验证：①中继真实冒烟（`POST /api/deepseek/messages` → 200 SSE，`server_tool_use` 1 次、`web_search_tool_result` 10 条来源、`text_delta` 55 段、首字 1635ms、总 2062ms）；②APK JVM harness（`handleAnthropic` 直连上游：200、2 轮搜索、10 条来源、48 段正文流式、`System.exit(0)` 干净退出）；③CDP e2e（localStorage 切 provider=deepseek → 开联网 pill → 发追问 → 900ms 显示「正在搜索…」→ 16s 完成，`followUp.search` 落库 5 条来源、回答带 `[1][2][3][4]` 引用、UI「联网搜索 · 5 条来源」）。**顺带改进**：上下文预算改按 `/models` 真实窗口算（deepseek-flash 1M → 预算约 55 万 token，此前写死 32K） |
| **回答完成通知（0.3.12，壳改动）** | 桌面 JVM harness 三断言（慢速分块假上游经 `providerBase` 测试缝注入）：①正常读完 → 回调触发一次、带 provider id（`NORMAL_DONE=true EVENTS=[opencode]`）；②流式中途 `disconnect()`（= 点停止语义）→ **不触发**（`STOP_NO_NOTIFY=true TOTAL=1`，假上游须分块慢发——一次性发完时断开前转发已完成，属合理竞态）；③`setChatDoneListener(null)` → 不炸（`NULL_LISTENER_OK=true`）。MainActivity 通知构造 / `POST_NOTIFICATIONS` 权限请求（SDK>=33，requestCode 1002）/ `resumed` 守卫过了 gradle 编译与 `aapt2` 权限校验；通知实际弹出效果待真机走查 |
| **字号可调 / 左滑误触 / 搜索词带上下文（0.3.13，纯网页层）** | CDP 验过三件事：①把根变量 `--ct-font-scale` 从 1 调到 1.25，输入框字号 15.5px → 19.375px、树卡片提示 16.5px → 20.625px；把 `fontScale: 1.25` 写进 localStorage 后刷新，变量仍是 1.25（设置 → 外观 → 字号真的落到渲染）。②卡片视图左滑之后没有浮现全览（`[role=dialog]` 不存在、「拖卡片改上级」提示不在），全览仍可从顶栏「全览」进。③点亮联网搜索后发追问「举个例子」，拦到的请求体是 `query = 原卡片问题 + 举个例子`、`ori_question = 举个例子`，卡片底部来源列表照常渲染（1 条假来源） |

**没做到的**：真机 / 模拟器安装运行。这台开发机没有硬件虚拟化（`VirtualizationFirmwareEnabled: False`），开不了 Android 模拟器；`adb` 已随 platform-tools 装好，有真机插上可以直接 `adb install`。

## 安全说明

- Key 只在本机：Android Keystore 生成不可导出密钥 → AES-256-GCM 加密 → Base64 存 SharedPreferences。**每家订阅一个字段一个 alias**：opencode 存 `card_tree_mobile/api_key`（alias `card_tree_api_key_v1`）、智谱 `zai_api_key`（`card_tree_zai_key_v1`）、Kimi `kimi_api_key`（`card_tree_kimi_key_v1`）、DeepSeek `deepseek_api_key`（`card_tree_deepseek_key_v1`，同时是搜索 Key）。Keystore 密钥不进备份，`android:allowBackup="false"`。
- 本地服务只绑 `127.0.0.1`：同一 Wi-Fi 的其它设备连不上；不需要网络权限以外的任何权限。
- 明文 HTTP 只对 `127.0.0.1` / `localhost` 放开（`res/xml/network_security_config.xml`），其它域名一律禁明文；上游是 https。
- `x-opencode-session` 用 `ANDROID_ID` 派生并存在 SharedPreferences（`session_id`），opencode go 要求每个客户端带一个稳定值，缺了会 400 `MissingSessionID`。

## 常见问题

- **装不上 / 提示未知来源**：APK 用的是自己生成的 release 证书（不是 Play 商店签名），系统仍会提示未知来源，允许「安装未知应用」即可。**`android/app/card-tree-release.jks` 与 `android/keystore.properties` 必须保留**：以后发新版本要用同一把钥匙签名，否则手机会当成另一个 App，装不上去也接不上数据。
- **提示「本地服务启动失败」**：端口被占用或 assets 里没有网页（构建时 `pnpm build` 没跑）。重装即可。
- **一直转圈 / 模型列表空**：先确认设置里当前订阅的 Key 状态是「已配置」；`/api/models` 返回 401 就是没 Key / Key 失效，返回 409 是中继或 APK 没配那家 Key，返回 502 一般是上游网络问题。智谱返回 429「套餐已到期」是订阅过期，续订即恢复。
- **切换订阅后模型列表没变**：模型按订阅分开缓存（5 分钟），点一下「刷新模型」即可；每家记忆的模型 / 推理强度切回来会自动恢复。
- **导出备份找不到文件**：Android 10+ 在「下载/CardTree」下；更老的系统在 `Android/data/com.cardtree.mobile/files/Documents/`。
- **联网搜索点了没反应 / 显示「联网（未开通）」**：说明还没配第二把 Key。到「设置 → 联网搜索」粘贴一把 DeepSeek API Key（可以在 `platform.deepseek.com` 创建），保存后按钮就可以点亮了；搜索接口返回 409 也是同一个原因。
- **联网搜索报错**：卡片上不会显示搜索错误（不阻塞回答），只会 toast 一句「联网搜索失败，这次先按不联网回答」；`/api/deepseek/search` 返回 502 多半是 Key 没有 Search API 权限或网络不通。
- **升级后界面没变**：`gradle assembleDebug` 会重新复制 `app/dist` 并清空旧资源；确认先跑了 `pnpm build`。
- **「检查更新」一直失败 / 下载不动**：检查更新走 `api.github.com`（匿名限流 60 次/小时/IP，一般够用，被限流会提示「访问太频繁」）；下载走 GitHub 的文件 CDN（`objects.githubusercontent.com`），国内网络偶尔拉不动——0.3.6 起可以在「设置 → 关于 → 下载镜像」填一个加速前缀（如 `https://ghproxy.net/`），镜像失败会自动改回直连重试一次；拉不动就留在当前版本下次再试，不影响使用。仓库必须是 public，private 会让检查一直 404。
- **分享长图找不到**：和导出备份同目录——Android 10+ 在「下载/CardTree」，更老系统在应用外部 Documents 目录；文件名 `card-<时间>-<标题>.png`。网页版点「分享」是直接触发浏览器下载。
- **没弹通知（0.3.12）**：先看系统设置里「卡片树」的通知权限是否开启（Android 13+ 第一次启动会弹请求，拒绝了就这里开）；国产 ROM 还要看省电策略有没有限制后台——App 被杀死时自然不会有通知，但流式快照 + 「继续生成」仍兜底。前台用 App 时不弹是设计内（`resumed` 守卫），只有退到后台才提醒。
