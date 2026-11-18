# Android APK 说明（card-tree-mobile 0.3.3）

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
  ├─ KeyVault(this)                        对话 Key（Android Keystore AES-256-GCM）
  ├─ KeyVault(this, "deepseek_api_key", "card_tree_deepseek_key_v1")   搜索 Key（另一把，同样加密）
  ├─ LocalServer(assets, vault::get, searchVault::get, sessionId, "0.3.3", preferredPort)
  │    ├─ ServerSocket(随机端口, 50, 127.0.0.1)   只监听本机回环；端口固定后复用
  │    └─ 后台线程 acceptLoop()             每连接一个线程（daemon 线程池）
  └─ WebView.loadUrl("http://127.0.0.1:<port>/")
        │
        ├─ GET /                     → assets/www/index.html
        ├─ GET /static/js/main.*.js  → 静态资源（Cache-Control: no-store）
        ├─ GET /api/health           → {"ok":true,"mode":"android",...}
        ├─ GET /api/models           → 反代 opencode go，5 分钟缓存
        ├─ POST /api/chat/completions→ 反代并逐块透传 SSE
        │                               （注入 Authorization / x-opencode-session / User-Agent）
        └─ POST /api/deepseek/search → 反代 DeepSeek Search API（没有搜索 Key 时返回 409）
```

要点：

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

搜索结果不是靠对话模型「猜」出来的，走的是 DeepSeek 官方 Search API：

```
网页（services/search.ts）
  └─ POST /api/deepseek/search {query, count, ori_question}
        └─ LocalServer.handleSearch
              ├─ searchKeys.get() 为空 → 409 {"code":"search_unavailable", …}
              └─ 有 Key → POST https://api.deepseek.com/v1/tools/search
                          （Bearer = 搜索 Key，UA = card-tree-mobile/<version> (android)）
                          → 状态码与响应体原样透传
```

- 网页侧**两种返回结构都认**：中继版返回 `{sources:[…]}`，APK 直连 DeepSeek 返回 `{results:[…]}`（`services/search.ts` 里优先读 `sources`，没有就读 `results`，`publishedAt` 兼容 `date`）
- 搜索 Key 是**第二把**：`KeyVault(this, "deepseek_api_key", "card_tree_deepseek_key_v1")`，和对话 Key 用不同的 SharedPreferences 字段与不同的 Keystore alias，互不影响；「设置 → 联网搜索」里单独保存 / 清除
- 搜到的摘要会被 `context.ts` 的 `searchBlock()` 拼成编号清单放进这一问的用户消息，并要求模型标 `[1][2]`；来源随卡片存 IndexedDB（`card.search`），所以离线回看时来源列表还在
- 搜索失败 / 没配 Key 都不会阻塞提问：前端 toast 一句后照常发；APK 里没配 Key 时输入框上方的开关显示「联网（未开通）」

## 文件一览（`android/app/src/main/java/com/cardtree/mobile/`）

| 文件 | 作用 |
| --- | --- |
| `MainActivity.java` | 唯一 Activity：起服务、配 WebView、处理返回键 / 文件选择 / 状态栏配色 / 导出备份 |
| `LocalServer.java` | 本地 HTTP/1.1 服务（纯 JDK，不依赖 Android）：静态资源 + `/api/models` `/api/chat/completions`（SSE 逐块透传）+ `/api/deepseek/search`（搜索转发） |
| `KeyVault.java` | API Key 的加解密：Android Keystore 里生成不可导出的 AES-256-GCM 密钥，密文（iv + ciphertext）Base64 存 SharedPreferences；构造器带 `field` / `alias`，对话 Key 与搜索 Key 各存一把 |
| `NativeBridge.java` | `@JavascriptInterface`，注入 `window.CardTreeNative`：`hasKey / saveKey / clearKey / hasSearchKey / saveSearchKey / clearSearchKey / version / setChrome / saveBackup / saveAutoBackup / toast` |
| `AssetSource.java` | 一行接口，把 `assets/www/<path>` 抽象成 `InputStream`（方便在桌面 JVM 上测 `LocalServer`） |
| `Mime.java` | 扩展名 → Content-Type |

网页侧对应新增 `app/src/services/native.ts`：

- `isNativeApp()` / `nativeBridge()` / `nativeHasKey()` / `saveNativeKey()` / `clearNativeKey()` / `nativeHasSearchKey()` / `saveNativeSearchKey()` / `clearNativeSearchKey()` / `nativeVersion()` / `saveNativeBackup()` / `saveNativeAutoBackup()`
- `App.tsx` 在 `window.__cardTreeBack` 上挂返回键处理（先关浮层 → 再回树 → 都没有才退出），在 `window.__cardTreeKeyChanged` 上挂模型重拉
- 没有 Key 时弹一次「先连上 opencode go」的 Sheet；「设置 → 连接」里可以替换 / 清除 Key
- `theme.ts` 把纸面背景色同步给原生状态栏 / 导航栏
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
`android/app/build.gradle` 的 `versionCode` / `versionName`、`MainActivity.java` 的 `APP_VERSION`（网页「关于」里显示的那个）、`app/src/components/settings/SettingsSheet.tsx` 里 `nativeVersion() ?? '0.3.3'` 的兜底值、`app/package.json` 的 `version`。改完 `node -e "require('./package.json')"` + `pnpm type` 过一遍。

## 已做的验证

| 项目 | 结果 |
| --- | --- |
| `aapt2 dump badging` | `package: name='com.cardtree.mobile' versionCode='6' versionName='0.3.3'`，minSdk 26 / targetSdk 34，`INTERNET` 权限，label「卡片树」，5 个密度图标齐全 |
| `apksigner verify` | release APK 由 `android/app/card-tree-release.jks` 签名（v2 方案），证书 DN `CN=CardTree Mobile` —— 不是 debug 证书 |
| APK 内容 | 167 个条目，其中 156 个是 `assets/www/**`：`index.html`、`manifest.webmanifest`、`icon-180/192/512.png`、单个 hash 化的 `static/js/main.*.js` + `static/css/main.*.css` + KaTeX 字体 |
| `LocalServer` 桌面 JVM 冒烟 | 用 JDK 17 把 `LocalServer` + `AssetSource` + `Mime` 编译成纯 JVM 程序，读真实 `app/dist` 与真实 Key：静态首页 1330 B、manifest、SPA 回退、未知静态 404、`/api/health` JSON（含 `"search":true`）、`/api/models` 42151 B（32 个模型）、`/api/chat/completions` 真实 SSE —— **29 个 chunk、首块 1ms、27 条 `data:` 事件、200 text/event-stream**、`/api/deepseek/search` 真实搜索 —— **200、771ms，返回 中国天气网 / 钱江晚报 两条结果** |
| 网页侧 | `pnpm type` 0 error、`pnpm lint` 0 warning 0 error、`pnpm build` 通过 |
| 联网搜索端到端 | 390×844 视口点亮「联网搜索」提问「杭州今天天气怎么样？」：真实搜到 5 条来源、回答带 `[1]–[5]`、卡片底部来源列表可点；思考过程里能看到 5 条资料摘要（见 `docs/preview/25-search-toggle.png`、`26-search-sources.png`） |
| 原生 UI 路径 | 用 CDP 注入一个假的 `window.CardTreeNative`，在 390×844 视口截了「首次启动填 Key」和「设置 → 连接」两张图（见 `docs/preview/14-onboarding.png`、`15-settings-connect.png`） |

**没做到的**：真机 / 模拟器安装运行。这台开发机没有硬件虚拟化（`VirtualizationFirmwareEnabled: False`），开不了 Android 模拟器；`adb` 已随 platform-tools 装好，有真机插上可以直接 `adb install`。

## 安全说明

- Key 只在本机：Android Keystore 生成不可导出密钥 → AES-256-GCM 加密 → Base64 存 SharedPreferences。**两把 Key 两个 alias**：对话 Key 存 `card_tree_mobile/api_key`（alias `card_tree_api_key_v1`），搜索 Key 存 `card_tree_mobile/deepseek_api_key`（alias `card_tree_deepseek_key_v1`）。Keystore 密钥不进备份，`android:allowBackup="false"`。
- 本地服务只绑 `127.0.0.1`：同一 Wi-Fi 的其它设备连不上；不需要网络权限以外的任何权限。
- 明文 HTTP 只对 `127.0.0.1` / `localhost` 放开（`res/xml/network_security_config.xml`），其它域名一律禁明文；上游是 https。
- `x-opencode-session` 用 `ANDROID_ID` 派生并存在 SharedPreferences（`session_id`），opencode go 要求每个客户端带一个稳定值，缺了会 400 `MissingSessionID`。

## 常见问题

- **装不上 / 提示未知来源**：APK 用的是自己生成的 release 证书（不是 Play 商店签名），系统仍会提示未知来源，允许「安装未知应用」即可。**`android/app/card-tree-release.jks` 与 `android/keystore.properties` 必须保留**：以后发新版本要用同一把钥匙签名，否则手机会当成另一个 App，装不上去也接不上数据。
- **提示「本地服务启动失败」**：端口被占用或 assets 里没有网页（构建时 `pnpm build` 没跑）。重装即可。
- **一直转圈 / 模型列表空**：先确认设置里的 Key 状态是「已配置」；`/api/models` 返回 401 就是没 Key，返回 502 一般是上游网络问题。
- **导出备份找不到文件**：Android 10+ 在「下载/CardTree」下；更老的系统在 `Android/data/com.cardtree.mobile/files/Documents/`。
- **联网搜索点了没反应 / 显示「联网（未开通）」**：说明还没配第二把 Key。到「设置 → 联网搜索」粘贴一把 DeepSeek API Key（可以在 `platform.deepseek.com` 创建），保存后按钮就可以点亮了；搜索接口返回 409 也是同一个原因。
- **联网搜索报错**：卡片上不会显示搜索错误（不阻塞回答），只会 toast 一句「联网搜索失败，这次先按不联网回答」；`/api/deepseek/search` 返回 502 多半是 Key 没有 Search API 权限或网络不通。
- **升级后界面没变**：`gradle assembleDebug` 会重新复制 `app/dist` 并清空旧资源；确认先跑了 `pnpm build`。
