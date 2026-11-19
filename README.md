# 卡片树 · 手机版（card-tree-mobile）

把「对话」拆成一张张卡片，长成一棵**可以回看的树**。

这是桌面版 DSH 插件 [`dsh-card-tree`](../card-tree) 的手机版：单页 Web App，模型支持**四家订阅随时切换**（opencode go / 智谱 Coding / Kimi Coding / DeepSeek 官方）。有两种装法——**Android APK**（内置本地服务，装到手机上就不需要电脑），或者**网页 / PWA**（浏览器打开，聊天请求走电脑上的零依赖中继）。APK 从 0.3.4 起**支持网页层热更新**：界面和功能的改动发到 GitHub Releases 就能推给已安装的 App，不用重装（见下文「热更新」）。

界面重做了一套自己的视觉语言——**索引卡 + 生长线**：带纸纹的纸面画布、白色索引卡、一条从父卡拐进子卡的实线把树的层级画出来，卡片左上角探出 mono 字体的「签」（带穿绳孔）标明它在树里的位置。完整规范见 [`docs/DESIGN.md`](docs/DESIGN.md)。

| 树视图（浅色） | 卡片详情（浅色） | 全览图 |
| --- | --- | --- | --- |
| ![树视图](docs/preview/02-tree-light.png) | ![卡片](docs/preview/12-card-light.png) | ![全览](docs/preview/06-overview.png) |

| 全览图拖卡片改上级 | 从右侧把手拉引用线 | 不能挂的时候会说原因 |
| --- | --- | --- | --- |
| ![拖动改父级](docs/preview/09-overview-drag.png) | ![拉引用线](docs/preview/10-overview-ref.png) | ![不能挂](docs/preview/11-overview-invalid.png) |

| 欢迎页 | 追问与子卡片 | 项目抽屉 | 设置 |
| --- | --- | --- | --- | --- |
| ![欢迎页](docs/preview/01-empty.png) | ![追问](docs/preview/05-card-follow.png) | ![项目](docs/preview/07-projects.png) | ![设置](docs/preview/08-settings.png) |

| 模型选择器（等宽字浮层） | 卡片详情（深色，正文吃满屏宽） | 树视图（深色） |
| --- | --- | --- | --- |
| ![模型选择器](docs/preview/13-model-picker.png) | ![卡片深色](docs/preview/04-card-dark.png) | ![树深色](docs/preview/03-tree-dark.png) |

| 树视图搜索（保留树的形状） | 长按卡片的快捷菜单 | 中断后接着生成 |
| --- | --- | --- | --- |
| ![搜索](docs/preview/16-search.png) | ![快捷菜单](docs/preview/17-quick-menu.png) | ![继续生成](docs/preview/18-continue.png) |

| 编辑卡片文字（不重跑模型） | 项目背景与规则 | 自动备份 |
| --- | --- | --- | --- |
| ![编辑卡片](docs/preview/19-card-edit.png) | ![项目设置](docs/preview/20-project-settings.png) | ![自动备份](docs/preview/21-backup.png) |

| 把根卡片重新挂到别的卡片下面 | APK 首次启动：填一次 Key | APK 的「设置 → 连接」 |
| --- | --- | --- |
| ![根卡片拖动](docs/preview/22-overview-root-drag.png) | ![首次启动](docs/preview/14-onboarding.png) | ![连接设置](docs/preview/15-settings-connect.png) |

| 提问时带上图片与文件 | 卡片里看到附件和回答 |
| --- | --- |
| ![待发送的附件](docs/preview/23-attach.png) | ![图片 + 文本附件](docs/preview/24-image-answer.png) |

| 联网搜索开关（提问前点亮） | 卡片里的来源列表与 [1] 引用 | APK 里单独配搜索 Key |
| --- | --- | --- |
| ![联网搜索开关](docs/preview/25-search-toggle.png) | ![来源列表](docs/preview/26-search-sources.png) | ![搜索设置](docs/preview/27-search-settings.png) |

| 热更新：设置 → 关于（检查到新版 0.3.5） |
| --- |
| ![检查更新](docs/preview/28-update-available.png) |

| 四家订阅随时切换（连接节跟随显示） | 树分支折叠 | 界面风格：羊皮纸 / 石墨 / 素笺 |
| --- | --- | --- | --- |
| ![订阅与模型](docs/preview/29-providers.png) | ![收起分支](docs/preview/30-fold.png) | ![羊皮纸](docs/preview/31-style-parchment.png) | ![石墨](docs/preview/32-style-graphite.png) ![素笺](docs/preview/33-style-plain.png) |

| 卡片操作行多了「分享」；追问右下可编辑 | 分享长图保存的 toast | 模型列表标注「能看图 / 上下文」 | 数据节「导出全部项目」 |
| --- | --- | --- | --- |
| ![卡片操作](docs/preview/34-card-actions.png) | ![分享](docs/preview/35-share-toast.png) | ![模型标注](docs/preview/36-model-hints.png) | ![导出全部](docs/preview/37-export-all.png) |

| 卡片合并：把一张卡并入另一张卡（0.3.7） |
| --- |
| ![合并选择器](docs/preview/38-merge.png) |

## 功能

**卡片树核心（对齐桌面版主体功能）**

- 树视图：缩进 + 分支竖线、模式徽章、提问单行省略、回答两行预览；顶部**搜索框**按关键词过滤卡片（命中的卡片和它的祖先链保留，树的形状不变）
- **长按卡片**弹出快捷菜单：打开 / 编辑文字 / 引用一张卡片 / 换角度重答 / 继续生成 / 分享成长图 / 删除
- 四种生长方式：**追问**（同一张卡继续问）/ **深入**（长出子卡片）/ **发散**（同层开新支线）/ **独立**（不与树相连）
- **分支重答**：回到同一张卡的问题，换一个角度重新作答
- 卡片详情：Markdown + KaTeX 公式 + 代码高亮、可折叠的思考过程、流式打字；**可以直接编辑问题或回答的文字**（不重新调用模型），追问也能编辑（右下角「编辑」）
- **中断后继续生成**：回答流到一半被中断（比如切走网络断了），已经写出的内容留在卡片上，点「继续生成」从中断处接着写，不用重问一遍
- **项目背景与规则**：给每个项目写一段 system（比如「用高中生能懂的语言解释」），拼进这个项目里每次提问的最前面
- **上下文预算**：按「根 → 父级」链 + 被引用卡片自动装配，超预算时先折叠再丢弃，卡片底部显示 `上下文 ≈x / y tokens · 折叠 n / 丢弃 n / 引用 n`
- **图片与文件附件**：提问时可以带上最多 4 个附件 —— 图片自动压到长边 1280 的 JPEG 直接给模型看；txt / md / csv / json / 代码等文本文件读成内容拼进问题（超过 2 万字会截断）。附件随卡片一起存在本地，导入导出也会带上
- **联网搜索**：提问前点亮输入框上方的「联网搜索」，会先搜 5 条实时结果，把标题 / 摘要 / 链接拼进这一问的上下文；回答里带 `[1][2]` 引用，卡片底部列出可点的来源（详见下方「联网搜索」）
- 引用卡片（最多 8 张）；**全览图可以编辑树**：拖动卡片到另一张卡片上改上级、拖到空白处摘成根卡片、从卡片右侧的「⊕」把手拉到另一张卡片上建立引用（拖动时有落点高亮、能力提示和松手 toast，详见下方「全览图能改什么」）
- 多项目：新建 / 切换 / 重命名 / 删除；导入桌面版导出的 `state.json`；导出 / 导入本应用备份
- **自动备份（APK）**：数据一有改动就记一笔，退到后台或每 5 分钟往「下载 / CardTree / backups」写一份，滚动保留最近 30 份；也可以随时点「立即备份」
- **四家订阅随时切换（0.3.5 起）**：设置 → 订阅与模型，在 opencode go / 智谱 Coding / Kimi Coding / DeepSeek 官方之间一键切换；每家记忆自己的模型和推理强度，切回来还是原来那个（详见下方「多订阅」）
- **模型能力标注（0.3.6 起）**：模型列表里每个模型下方标注「能看图 / 上下文 1M」这类小字（读自各家 `/models` 的 `modalities` 和 `limit` 字段），选模型不再盲选
- **追问文字也能编辑（0.3.6 起）**：追问右下角有「编辑」按钮，和卡片编辑一样只改文字不重跑模型
- **单卡分享长图（0.3.6 起）**：卡片操作行「分享」把问题 + 回答 + 参考来源渲染成一张 720px 宽的长图（纯 canvas，跟随当前深浅色），APK 里存到「下载/CardTree」，可直接发微信
- **导出全部项目（0.3.6 起）**：设置 → 数据 →「导出全部项目」，一次导出所有项目的 JSON；格式与桌面版 `state.json` 同构，桌面版也能读回
- **卡片合并（0.3.7 起）**：两张答了同一件事的卡可以并成一张 —— 卡片操作行「合并」或长按菜单「并入另一张卡…」，选目标卡确认即可；源卡被删，它的追问、子卡片、附件和引用都转到目标卡上，两个回答用「---」隔开（问法不同会加一行「另一个问法」），引用会去重、别人对源卡的引用自动改成指向目标卡。自己、祖先、子孙和正在生成的卡不能并
- **热更新下载镜像（0.3.6 起）**：设置 → 关于 →「下载镜像（可选）」，填一个加速前缀（如 `https://ghproxy.net/`），更新包先走它；留空直连，镜像失败自动回直连重试一次
- **四种界面风格（0.3.5 起）**：索引卡（默认）/ 素笺 / 羊皮纸 / 石墨，风格与深浅主题可任意组合（详见下方「界面风格」）
- **流式自动跟随**：回答流式生成时页面自动往下滚；往回翻就停（不打扰你重读），再滚回底部自动恢复跟随
- **树分支可折叠**：有子卡片的地方出现「收起分支」，折叠后显示「N 张子卡片」，点击展开；折叠状态记在本地
- 深浅色 / 跟随系统、推理强度（低/中/高）、模型随时切换（模型选择器是自绘的等宽字浮层，不再是系统下拉框）
- 401（Key 失效）不再只是报错：APK 里直接弹出重新粘贴**当前订阅** Key 的面板，网页版会提示去看电脑上中继里这家的 Key

**视觉细节**

- 纸面有极细的噪点纹理（SVG 噪点叠在页面底色上，深浅色各一个 opacity），索引卡的「签」带穿绳孔、从纸面边缘探出来
- 卡片与树节点有很轻的入场位移（300ms / 320ms，树节点按顺序错开 24ms），Sheet 上滑；`prefers-reduced-motion` 下全部关闭
- 全应用只有两种字体角色：内容用系统无衬线，层级 / 计数 / token / 日期一律等宽 mono

**手机端细节**

- 390×844 真机视口验收；卡片详情**左右不留白**（纸面铺到屏幕两边，只保留 18px 内边距），`viewport-fit=cover` + 四边安全区（刘海 / 圆角 / 横屏）、`visualViewport` 处理键盘顶起
- 安全区与键盘已用 Chrome CDP 模拟验证：竖屏 47/34 的刘海与 Home 指示条、横屏 47/47 左右刘海、键盘顶起时输入框仍贴在键盘上沿；真机建议再走一遍（见「已知限制」）
- 底部 Sheet 式设置面板、左侧抽屉式项目列表、能在全览图上直接改树的单指手势（拖卡片改上级、拉把手建引用）
- PWA：manifest + 192/512 图标 + Service Worker，https 下可「安装应用 / 添加到主屏幕」（见下方「装成 App」）

**刻意没做**

- 没有本地工具（读文件 / 搜索 / 抓网页）——按需求「先不要工具」，先把树本身做好
- 没有语音；联网搜索要单独配一把 DeepSeek API Key（见下方「联网搜索」）；**图片需要选支持视觉的模型**（claude-haiku-5-5 / glm-5.3 / gpt-5.6-luna 这类，deepseek-v4.1-flash 按模型元数据也支持图片），纯文本模型收到图片会报 400

## 多订阅

「设置 → 订阅与模型」里可以在这四家之间切换，选中的那家就是当前对话用的订阅：

| 订阅 | 上游 | 默认模型 | 推理强度 | Key 环境变量（网页版中继） |
| --- | --- | --- | --- | --- |
| opencode go | `https://opencode.ai/zen/go/v1` | deepseek-v4.1-flash | 低 / 中 / 高 | `OPENCODE_GO_API_KEY` |
| 智谱 Coding | `https://open.bigmodel.cn/api/coding/paas/v4` | glm-5.3 | 不支持（隐藏） | `ZAI_CODING_CN_API_KEY` |
| Kimi Coding | `https://api.kimi.com/coding/v1` | kimi-for-coding | 低 / 高 / 最大 | `KIMI_CODING_API_KEY` |
| DeepSeek 官方 | `https://api.deepseek.com` | deepseek-flash | 低 / 高 / 最大 | `DEEPSEEK_API_KEY` |

- 四家全是 OpenAI 兼容协议，App 内部按 `x-card-tree-provider` 请求头路由（缺省按 opencode，老版本无缝兼容）
- **每家记忆自己的模型和推理强度**：切到别家再切回来，还是你上次选的那个
- Key 分开存：APK 里每家一个 Android Keystore 加密条目（「设置 → 连接」跟随当前订阅显示）；DeepSeek 官方的 Key 和联网搜索共用一把
- 网页版中继把四家的 Key 都配在同一台电脑上：环境变量优先，读不到会去 `~/.dsh/.credentials.yaml` 找同名条目；设置页会显示「服务端已配置 Key 的订阅」
- **注意**：智谱 Coding 的套餐是会过期的（本机这把 Key 实测返回 429「您的 GLM Coding Plan 套餐已到期」）；上游错误会原样透传，续订后即恢复
- 401 / 没配 Key 时：APK 弹当前订阅的填 Key 面板；网页版提示去电脑上配这家的环境变量

## 界面风格

「设置 → 外观 → 风格」四种，只换纸面和墨色，深浅主题另算，可任意组合：

- **索引卡**（默认）：纸面 `#f4f5f9` 带细噪点，白卡 + 生长线
- **素笺**：纯白纸面，去掉噪点和阴影，最简
- **羊皮纸**：暖黄纸 `#f5efe2`、墨色带一点棕、强调色换暖深靛，适合长时间阅读
- **石墨**：冷灰纸、冷蓝强调色，对比更硬朗

风格选择记在 `localStorage`，刷新即恢复。

## 图片与文件

输入框左边的回形针可以一次选多个文件（手机相册、相机、文件管理器都行），最多 4 个：

- **图片**：自动压缩到长边 1280、JPEG 质量 0.82（大概 100–300 KB/张），按 OpenAI 兼容的 `image_url` 内容块发给模型。**要选视觉模型**，否则上游会返回 400。
- **文本文件**：`txt / md / csv / tsv / json / log / xml / yml / html / css / js / ts / py / java / go / rs / sql / sh` 等常见文本格式直接读成字符串，放进用户消息里（`【附件：文件名】` + 内容），所有模型都能用；单个文件最多读 2 万字符，超出会截断并标注。
- 附件只跟着**当前这一问**发出去：新卡片只带自己的附件，追问带追问的附件，不会把整棵树的图片反复重发。
- 附件连同卡片一起存在 IndexedDB 里，所以「导出当前项目 / 自动备份」的 JSON 会变大（带图片时尤其明显），这是有意的取舍。
- 卡片详情里：图片直接显示（点开看大图可以长按保存），文本文件是一个可以展开的折叠块。
- 上下文预算会把图片按每张约 900 token 扣掉，再给祖先链分配预算。

## 联网搜索

提问前点亮输入框上方的「联网搜索」，这个问题就会**先搜一遍再回答**：

- 搜索走 **DeepSeek 官方 Search API**（`https://api.deepseek.com/v1/tools/search`）：一次 HTTP、不跑模型，通常 1 秒内返回 5 条结果，按搜索次数计费（不占对话模型的 token 上下文太多，只占结果摘要那一小段）
- 搜到的标题 / 摘要 / 链接会拼成一段「【联网搜索结果 · 搜索词：…】」放在问题前面，并要求模型在用到的地方标 `[1]` 这类编号、末尾列出参考来源；卡片底部显示「联网搜索 · N 条来源」，每条都能点开原文
- 只搜**当前这一问**：追问是新的一句，深入 / 发散 / 独立是新建卡片，都会重新搜；「重答 / 换角度 / 继续生成」会自动沿用那张卡上一次的来源，不会重复花钱
- 搜索结果跟着卡片一起存进 IndexedDB（`card.search`），导出 / 自动备份也会带上；关掉开关就完全恢复原样（不搜、不带来源、卡片底部也没有来源列表）
- **要单独配一把 DeepSeek API Key**（和对话用的 opencode go Key 是两把，也分开存）：
  - APK：「设置 → 联网搜索」里粘贴，用 Android Keystore 单独加密；没配时开关显示「联网（未开通）」，点了会引导你去设置
  - 网页版：中继启动前设环境变量 `DEEPSEEK_API_KEY`，或写进 `~/.dsh/.credentials.yaml`；没配时开关同样提示未开通
- 搜索失败不会卡住这一问：toast 一句「联网搜索失败，这次先按不联网回答」，然后照常提问；搜到 0 条也会给同样的提示

## 全览图能改什么

点顶部「全览」进入全览图（SVG，节点位置自动排布）：

- **拖动卡片改上级**：按住一张卡片拖到另一张卡片上松手，它就挂到那张卡片下面；拖到空白处松手，就从树里摘出来变成根卡片
- **拉引用线**：按住卡片右侧的「⊕」把手拖到另一张卡片上松手，就把它加进这张卡片的引用（最多 8 张）
- 拖动过程中实时反馈：源卡片虚线化、落点卡片描边加粗（能挂）或变红虚线（不能挂）、手指上方浮一张「挂到 / 引用到」的预览卡、底部一行说明（如「松手，挂到这张卡片下面」）
- 不能挂时会直接说原因：正在生成的卡片不能移动、不能挂到自己或自己的子孙下面、两张卡片已经有引用了、引用已满
- 手势互不冲突：单指按卡片 = 拖卡片，单指按空白 = 平移画面，双指 = 缩放，点一下卡片 = 打开它；手指按偏一点点也会抓住最近的卡片（30px 内算命中），不用精确点在框里

## 装到手机（两种方式）

|  | **Android APK** | **网页 / PWA** |
| --- | --- | --- | --- |
| 需要电脑吗 | 装好之后**不需要**（只有 API Key 要在首次启动时粘一次） | 每次用都要开着电脑上的中继 `node server.mjs` |
| 怎么装 | 把 `dist/card-tree-mobile-0.3.6.apk` 传到手机，点开安装 | 手机浏览器打开 `https://<电脑IP>:8787`，可「添加到主屏幕」 |
| Key 存在哪 | 手机上（Android Keystore 加密） | 电脑上（`~/.dsh/.credentials.yaml`，手机不留 Key） |
| 数据存在哪 | App 自己的本地存储 | 浏览器 IndexedDB |
| 适合 | 随身当独立 App 用 | 想用浏览器 / iPhone / 不想装 APK |

两种方式的数据**不互通**，换方式时用设置里的「导出当前项目 / 导入备份」迁移。

## Android APK（不依赖电脑）

产物：[`dist/card-tree-mobile-0.3.6.apk`](dist/card-tree-mobile-0.3.6.apk)（约 1.9 MB，**release 签名**，可以直接侧载）。签名用的 keystore 在 `android/app/card-tree-release.jks`，密码写在 `android/keystore.properties`（两者都已 git 忽略）——**请把这两份文件留好**，以后发新版本要用同一把钥匙签名，否则手机上会变成两个不同的 App（升级装不上、数据也不接续）。

> 之前装过 0.3.2–0.3.5 的：0.3.6 的 Java 壳变了（新增保存长图、下载镜像两个原生桥方法），**需要重新安装一次 APK**；装完之后界面 / 功能的更新又都走热更新，不用再重装。

**安装**

1. 把 APK 传到手机（微信文件传输助手 / USB / 网盘都行），在文件管理器里点开
2. 系统提示「未知来源」时允许「安装未知应用」（设置 → 应用 → 特殊权限）
3. 打开「卡片树」，首次启动会要求粘贴一次当前订阅的 API Key（默认 opencode go；也可以之后在「设置 → 订阅与模型」里换成智谱 / Kimi / DeepSeek 官方）
4. Key 用 Android Keystore 加密保存在本机，之后打开就能直接提问，全程不需要电脑

**它在手机上怎么跑起来的**

APK 里打包了一个只监听 `127.0.0.1` 的本地 HTTP 服务（纯 Java，手写 HTTP/1.1）：

- 把打包进 `assets/www` 的网页当站点根目录发出去 → WebView 加载 `http://127.0.0.1:<port>/`，同源所以**没有 CORS 问题**
- **端口是固定的**：第一次启动绑一个空闲端口后写进 SharedPreferences，以后每次启动都用同一个端口（WebView 的 IndexedDB 按「源」隔离，端口一变数据就全丢了——这是 0.3.0 修掉的一个真问题）
- `/api/models`、`/api/chat/completions` 按 `x-card-tree-provider` 请求头路由到四家上游之一（缺省 opencode go），自动注入 `Authorization`；opencode go 额外补它要求的 `x-opencode-session`
- 聊天响应是**逐块 read→write→flush 透传**的，所以流式还是一行一行出（不是等全部生成完才一次性出现）
- `127.0.0.1` 属于安全上下文，IndexedDB / localStorage 都正常；APK 里不注册 Service Worker（资源本来就在本地，避免升级后读到旧缓存）
- 返回键：先关弹层 → 再回树 → 都没有才退出 App；状态栏 / 导航栏颜色跟随深浅色
- **自动备份**：数据有改动后，退到后台或每 5 分钟由原生侧往「下载 / CardTree / backups」写一份 JSON，滚动保留 30 份（卸载 App 后这些文件仍在）

### 热更新（0.3.4 起）：改界面不用重装 APK

这个 App 90% 的代码是网页层（React + CSS），附件、联网搜索、界面重做这些改动全都只动网页层。0.3.4 开始，网页层可以通过 [GitHub Releases](https://github.com/2031814001yuyue-tech/card-tree-mobile/releases) 热更新：

- **App 启动 4 秒后自动查一次**，有新版弹 toast；也可以「设置 → 关于 → 检查更新」手动查
- 下载 → sha256 校验 → 解压到 App 私有目录 → 原子切换，成功后页面自动刷新，**不用重装 APK、不加任何权限**
- **下载镜像（0.3.6 起）**：GitHub 的文件 CDN 国内偶尔拉不动，设置 → 关于 →「下载镜像（可选）」填加速前缀（如 `https://ghproxy.net/`），更新包先走镜像；留空直连；**镜像下载失败会自动改回直连重试一次**，不会卡死在半路
- **永远不会变砖**：内置在 APK `assets/www` 里的那一份永远保留，下载 / 校验失败就继续用内置版；想回到内置版，清一次 App 数据即可
- 想自己发新版：改完代码后 `cd app && pnpm build && node scripts/publish-web.mjs --notes "这次改了什么"`（需要 [gh](https://cli.github.com/) 登录），脚本会把 `dist/` 打成 `web.zip`、算好 sha256、发一个 `web-v<版本>` 的 Release
- 仓库必须是 **public**：App 是匿名读 Releases 的，private 仓库会 404

只有 Java 壳本身要改时（比如要加新的原生桥方法）才需要发新 APK——这种改动会越来越少。

**从源码构建**

需要 JDK 17 与 Android SDK（`platforms;android-34`、`build-tools;34.0.0`），`android/local.properties` 里写 `sdk.dir=<SDK 路径>`：

```powershell
cd app
pnpm install
pnpm build                                          # 先出 app/dist
cd ../android
<gradle>/bin/gradle.bat assembleDebug               # 产物：android/app/build/outputs/apk/debug/app-debug.apk
```

`preBuild` 会自动把 `app/dist` 复制进 `android/app/src/main/assets/www/`（每次先清空，不会残留旧 hash 包）。

**已经验到什么程度**

- `aapt2 dump badging`：包名 `com.cardtree.mobile`、versionCode 9 / versionName 0.3.6、minSdk 26、targetSdk 34、`INTERNET` 权限、图标 / 中文名正常
- `apksigner verify`：release APK 用 `card-tree-mobile` 自己的 keystore 签名（v2），证书 DN `CN=CardTree Mobile`，不是 debug 证书
- APK 里 156 个网页资源齐全（index.html、manifest、icon 180/192/512、单个 hash 化的 js/css），端口固定、自动备份与四家路由的 Java 代码都在包里
- **热更新器全链路验过**：真实 GitHub API 检查（同版本返回「无更新」、旧版本能查到 `web-v0.3.4`）；用本地服务器扮演 GitHub 完整跑了一遍「下载 → sha256 校验 → 解压 156 个文件 → 原子切换 → LocalServer 从新目录发页面」，坏 sha256 被正确拒绝且不污染现有目录（详见 `docs/ANDROID.md`）
- **镜像回退验过（0.3.6）**：本地双服务器扮演「直连源 + 镜像源」——配好镜像时全程走镜像装包成功；镜像不可达时自动报「镜像下载失败，改用直连」并回退成功；空镜像直连回归正常
- 把同一份 `LocalServer` 拿到桌面 JVM 上真跑了一遍：静态资源 / SPA 回退 / 404 / `/api/health`（含 `search:true`）/ `/api/models`（42 KB、32 个模型）/ `/api/chat/completions` 真实 SSE（29 个 chunk、首块 1ms、27 条 `data:` 事件）/ **`/api/deepseek/search` 真实搜索（200、771ms，返回 中国天气网 / 钱江晚报 两条真实结果）**
- **四家订阅路由冒烟（0.3.5）**：中继上 `GET /api/models` 带 `x-card-tree-provider` 四家全 200；kimi / deepseek / opencode 流式对话真跑通（31 / 17 / 8 chunks）；智谱返回 429「套餐已到期」原样透传；未知头 400 `provider_unknown`；设置页「连接」节随当前订阅显示（假桥注入 CDP 验证）
- 新增交互（搜索、长按菜单、编辑、继续生成、项目背景、自动备份入口、订阅 pills、风格 pills、折叠分支）用 Chrome CDP 在 390×844 视口逐屏截图验过，见上方截图
- **附件端到端验过**：在 390×844 视口里用真实文件选择框塞进一个 txt + 一张图，选 `claude-haiku-5-5` 提问，模型正确答出文本里的型号（X-200）和图片里的数字（42）；两个附件都落进了 IndexedDB
- **联网搜索端到端验过**：在 390×844 视口里点亮「联网搜索」问「杭州今天天气怎么样？」，真实搜到 5 条来源（中国天气网 / 墨迹 / 东方天气…），回答里带 `[1]–[5]` 引用，卡片底部来源列表可点；搜索摘要确实进了模型上下文（思考过程里能看到 5 条资料）
- **0.3.6 新交互 CDP 验过**：卡片操作行六个 chip（含「分享」）、追问右下「编辑」按钮、分享 toast、模型菜单「能看图 · 上下文 1M」标注（读自真实 `/models` 的 `limit.context` 字段）、「导出全部项目」按钮、「下载镜像」输入框，见上方截图
- **卡片合并 CDP 端到端验过（0.3.7）**：长按菜单和卡片操作行两个入口都真跑了一遍「并入另一张卡」——源卡删除、追问与附件转移、子卡改挂目标卡、双方引用去重合并、其它卡对源卡的引用自动改指目标卡（IndexedDB 逐项核对）；合并后正看源卡会自动回树。顺带修了一个真 bug：长按抬手的合成点击会立刻关掉刚打开的浮层（Sheet 打开后 350ms 内忽略遮罩点击，详见 `docs/DESIGN.md`）
- **没有在真机或模拟器上跑过**：这台机器没有硬件虚拟化，开不了 Android 模拟器。装到手机上照着 [`docs/DEVICE-CHECK.md`](docs/DEVICE-CHECK.md) 的 20 条清单走一遍（约 10 分钟），哪条不对发回来即可定位

要改代码 / 自己构建，看 [`docs/ANDROID.md`](docs/ANDROID.md)（架构、文件分工、构建、验证记录、常见问题）。

## 网页 / PWA：在电脑上起中继

前置：Node.js ≥ 22（实测 v24）、pnpm（或 npm）。

```powershell
cd app
pnpm install
pnpm build                    # 产物在 app/dist
node scripts/make-cert.mjs    # 生成自签证书（只在想「装成 App」时需要，推荐）
node server.mjs               # 默认监听 0.0.0.0:8787；certs/ 里有证书就自动走 HTTPS
```

- 电脑上打开 <https://127.0.0.1:8787>（自签证书首次会提示「不安全」，继续访问即可）
- 手机和电脑连同一个 Wi-Fi，打开 **`https://<电脑局域网IP>:8787`**（server 启动时会把地址打印出来）
- 只想用 HTTP（不装 App / 没证书）：`$env:HTTPS='0'; node server.mjs`，然后开 `http://…:8787`
- 改端口：`$env:PORT=8788; node server.mjs`
- 要用**联网搜索**：中继启动前设 `$env:DEEPSEEK_API_KEY='你的 key'`，或写进 `~/.dsh/.credentials.yaml`；重启后 `GET /api/health` 里会出现 `"search":true`，输入框上方的「联网搜索」就变成可点状态

### 装成 App（PWA）

浏览器只在**安全上下文**（https 或 localhost）下允许「安装应用」，局域网 HTTP 地址不行。中继自带一套自签证书方案：

```powershell
cd app
node scripts/make-cert.mjs   # 生成 app/certs/：本地 CA + 服务器证书，SAN 自动带上本机局域网 IP
node server.mjs              # 检测到证书，自动切成 https
```

1. **信任根证书**（每台手机一次）
   - 手机浏览器打开 `https://<电脑局域网IP>:8787/ca.pem` 下载（`/ca.crt` 是同内容的 DER 版）
   - Android：设置 → 安全 → 加密与凭据 → 安装证书 → **CA 证书** → 选刚下载的文件
   - iOS：Safari 下载后在 设置 → 通用 → VPN 与设备管理 安装；再到 设置 → 通用 → 关于本机 → 证书信任设置 打开完全信任
2. 回到 `https://<电脑局域网IP>:8787`，浏览器菜单选「安装应用 / 添加到主屏幕」
3. 之后从桌面图标启动，就是全屏无地址栏的独立 App

补充：

- 证书 SAN 已含 `localhost`、`127.0.0.1` 和本机所有局域网 IPv4；**换 Wi-Fi 导致 IP 变化后**，重跑 `node scripts/make-cert.mjs --force`
- 电脑上想消掉浏览器的「不安全」警告：把 `app/certs/ca.pem` 导入系统的「受信任的根证书颁发机构」（Windows：双击 ca.crt → 安装证书 → 受信任的根证书颁发机构；`certutil -addstore -user Root app\certs\ca.crt` 也可以）
- `app/certs/key.pem`、`ca.key` 是私钥，不要提交或发给别人（`.gitignore` 已排除 `certs/`）；`ca.pem`/`ca.crt` 只是公钥证书
- 服务器证书 397 天到期，重新生成即可
- 不想装证书也可以：用 Tailscale Serve / Cloudflare Tunnel 之类把 8787 映射成真正的 https 域名

### API Key 在哪

**APK**：首次启动时粘一次当前订阅的，之后由 Android Keystore（AES-256-GCM）加密存在手机里，可以在「设置 → 连接」里替换或清除；每家订阅一把、分开加密，DeepSeek 官方那把和联网搜索共用。Key 不会上传，也不随备份导出。

**网页版**：中继进程 `app/server.mjs` 会自动从 `~/.dsh/.credentials.yaml` 里读四家 Key（`OPENCODE_GO_API_KEY` / `ZAI_CODING_CN_API_KEY` / `KIMI_CODING_API_KEY` / `DEEPSEEK_API_KEY`，只读这些行，不碰其它凭据）。

也可以临时覆盖，不写文件：

```powershell
$env:OPENCODE_GO_API_KEY = "<你的 key>"     # 对话默认订阅
$env:KIMI_CODING_API_KEY = "<你的 key>"     # 想用哪家就配哪家
node server.mjs
```

**Key 只在电脑上的中继进程里，手机端不保存任何 Key**，前端默认接口地址就是同源 `/api`。

## 开发

```powershell
cd app
pnpm dev     # rspack serve :8090，/api 自动代理到 127.0.0.1:8787
pnpm type    # tsc 严格类型检查
pnpm lint    # oxlint（当前 0 warning 0 error）
pnpm smoke   # 真实打一次 opencode go，验证中继与流式

# 发一版网页层热更新（需要 gh 登录；先 pnpm build）
node scripts/publish-web.mjs --notes "这次改了什么"   # 加 --dry-run 先预览
```

目录：

```
card-tree-mobile/
├─ app/
│  ├─ server.mjs                零依赖中继：静态托管 dist + 按 x-card-tree-provider 路由四家的 /api/models、/api/chat/completions(SSE) + /api/deepseek/search + HTTP/HTTPS
│  ├─ scripts/make-cert.mjs     生成本地 CA 与服务器证书（装成 App 用）
│  ├─ scripts/publish-web.mjs   把 dist/ 打包发布成 GitHub Release（网页层热更新）
│  ├─ certs/                    自签证书（git 忽略；key.pem / ca.key 是私钥）
│  ├─ src/app/design.css        视觉系统 token（--ct-*，索引卡 + 生长线，见 docs/DESIGN.md）
│  ├─ src/services/tree/        卡片树领域层（context 上下文装配 / model 树变更 / db IndexedDB / io 导入导出 / store zustand）
│  ├─ src/services/attachments.ts  图片压缩与文本文件读取（附件）
│  ├─ src/services/api/chat.ts  浏览器端模型客户端（组合式 fetchModels / streamChat）
│  ├─ src/services/search.ts    联网搜索客户端（/api/deepseek/search，兼容中继 sources 与 DeepSeek results）
│  ├─ src/services/update.ts    热更新的 UI 状态（检查 / 下载进度 / 结果）
│  ├─ src/components/tree/      树视图（嵌套列表 + 生长线）
│  ├─ src/components/card/      卡片详情（单张纸面：思考、公式、追问、引用、统计）
│  ├─ src/components/overview/  SVG 全览图（可拖动改树）
│  ├─ src/components/composer/  底部输入框（追问/深入/发散/独立 pills）
│  └─ src/components/{projects,settings,common}/  抽屉、设置、Sheet
├─ android/                     Android 壳：WebView + 纯 Java 本地服务
│  ├─ app/src/main/java/com/cardtree/mobile/
│  │  ├─ MainActivity.java      WebView 壳、固定端口、返回键、文件选择、状态栏配色、导出备份
│  │  ├─ LocalServer.java       127.0.0.1 固定端口的本地 HTTP 服务（静态资源 + 四家 /api 路由 + SSE 透传 + 搜索转发；静态资源优先读热更新目录）
│  │  ├─ KeyVault.java          Android Keystore AES-256-GCM 加密保存 API Key（四家订阅分开存，DeepSeek 与搜索共用一把）
│  │  ├─ WebUpdater.java        热更新器：查 GitHub Releases → 下载 → sha256 校验 → 解压 → 原子切换
│  │  └─ NativeBridge.java      注入给网页的 window.CardTreeNative（含 saveAutoBackup 自动备份与热更新三个方法）
│  └─ app/src/main/assets/www/  构建时从 app/dist 复制进来（git 忽略）
├─ dist/                        打包好的安装包：card-tree-mobile-0.3.6.apk
└─ docs/                        FEASIBILITY.md（可行性 + M0–M5 计划）、DESIGN.md（视觉语言）、ANDROID.md（APK 架构与构建）、RELAY.md（中继细节）、DEVICE-CHECK.md（真机走查清单）、preview/（截图）
```

## 数据存在哪

- 所有项目存在**手机/浏览器本地** IndexedDB（库名 `card-tree-mobile`），不上传服务器
- 设置存 `localStorage`（键 `card-tree:settings`）
- 联网搜索的来源（标题 / 摘要 / 链接）随卡片一起存在 IndexedDB 的 `card.search` 里，导出 / 自动备份会带上
- **Key 分开存**：四家订阅每家一把（DeepSeek 官方与联网搜索共用一把）。APK 里都在手机上（Android Keystore 加密，设置 → 连接跟随当前订阅）；网页版都在电脑上（`~/.dsh/.credentials.yaml` 或环境变量），手机不留
- **APK 自动备份**：数据有改动后，退到后台或每 5 分钟写一份到手机的「下载 / CardTree / backups」，滚动保留最近 30 份；设置面板「数据 → 自动备份」里能看到上次时间、也能点「立即备份」
- 换设备 / 备份：设置面板 →「导出当前项目」（单个）或「导出全部项目」（0.3.6 起，桌面版 `state.json` 同构、可直接读回）、「导入备份」
- 从桌面版迁移：设置面板 →「导入备份」直接选 `~/.dsh/card-tree/state.json`，会把里面每个项目拆成独立项目导入（运行中的卡片会标为可重试的错误态）

## 已知限制

1. **网页版的中继必须开着**：浏览器无法直连 opencode go 的聊天接口（实测 CORS 预检 404），所以聊天请求走本机 `server.mjs` 转发。APK 版把这一层搬进了应用内，不需要电脑。
2. **APK 与网页版的数据不互通**（两套本地存储），换方式用导出 / 导入迁移。
3. **APK 用的是自己的 keystore 签名**（不是 debug 证书，也不再是 Play 商店的正规签名）：自己装完全没问题；转给别人时系统仍会提示「未知来源」，需要对方点「仍要安装」。要正式上架得换商店要求的签名方式。
4. **APK 没在真机 / 模拟器上跑过**（本机无硬件虚拟化）：逻辑层已验证到「桌面 JVM 跑通真实 SSE」，界面层沿用同一套已在 390×844 视口验收过的网页。
5. **换了签名钥匙就装不上旧版本**：`android/app/card-tree-release.jks` + `android/keystore.properties` 要留好，新版本必须用同一把钥匙签名，否则手机会当成另一个 App。
6. **PWA 安装需要安全上下文**：局域网 `http://192.168.x.x` 不能安装；用内置的 `node scripts/make-cert.mjs` 切到自签 HTTPS 并信任根证书即可（见「装成 App」），或改用 Tailscale / Cloudflare Tunnel 的真 https 域名。
7. **安全区/键盘只在桌面 Chrome 的 CDP 模拟里验过**（见「手机端细节」的数值），真机 iOS/Android 建议再走一遍：刘海遮挡、横屏、键盘顶起、下拉刷新。
8. 网页版局域网默认走自签 HTTPS（浏览器会警告一次，信任根证书后消失）；用 `HTTPS=0` 退回 HTTP 时才是明文传输，不要在不信任的网络里开 `HOST=0.0.0.0`。APK 只监听 `127.0.0.1`，不经局域网。
9. 数据默认只在当前设备：网页版清缓存就没了；APK 卸载会删掉应用内数据，但「下载 / CardTree / backups」里的自动备份文件还在，重装后可以导入恢复。重要内容仍建议手动导出。
10. 全览图能拖卡片改上级、拉引用线（包括把根卡片重新挂到别的卡片下面），但不能手动摆节点位置（位置自动排布）；在手机上节点可能缩得比较小，按偏一点也会抓住最近的卡片。
11. 无本地工具（读文件 / 抓网页）、无语音；附件与联网搜索都已支持——但联网搜索要**单独配一把 DeepSeek API Key**，而且按搜索次数计费（每次提问搜 5 条），不用时把开关关掉即可。
12. **热更新的下载走 GitHub 的文件 CDN**：国内网络偶尔拉不动 `objects.githubusercontent.com`（本机试过一次 1.8 MB 下了十几分钟）。0.3.6 起可以在「设置 → 关于 → 下载镜像」里填加速前缀（如 `https://ghproxy.net/`），镜像失败自动回直连；拉不动时 App 会留在当前版本、下次再试，不影响使用。检查更新本身走 `api.github.com`，在实测网络下一直正常。
13. **四家订阅是「包月编码套餐」的路子**：智谱 Coding 的套餐会过期（本机实测返回 429「您的 GLM Coding Plan 套餐已到期」），过期后上游错误原样透传，续订即恢复；Kimi / opencode go 的套餐同理。模型列表和默认模型以各家 `/models` 返回为准。
14. Java 壳在 0.3.3（多订阅）、0.3.5（多订阅桥）和 **0.3.6（保存长图 + 下载镜像桥）** 都改过，从更早版本升上来要**重新装一次 APK**；之后纯网页层的改动又都走热更新，不用再重装。

## 技术栈

React 18.3 + TypeScript 7 + zustand 4.4 + idb 8 + rspack 2（`builtin:swc-loader` / `lightningcss`），Markdown 侧是 `mdast-util-*` + KaTeX + Mermaid + Prism。视觉层是自己写的 `--ct-*` token 系统与组件样式（索引卡 + 生长线，见 [`docs/DESIGN.md`](docs/DESIGN.md)）；基础控件与 Markdown 渲染沿用了 DeepSeek 开源的 [`deepseek-ai/chat-demo`](https://github.com/deepseek-ai/chat-demo)（MIT）。

Android 侧没有用 Capacitor / React Native，而是**自写 WebView 壳 + 纯 Java（零 androidx 依赖）的本地 HTTP 服务**：Capacitor 的 HTTP 插件会把响应整体 buffer，流式回答会变成「等全部生成完再一次性出现」；自写服务可以把上游 SSE 逐块 flush 给 WebView。构建用 Gradle 8.7 + AGP 8.5.2，产物约 2 MB（网页资源占大头）。

联网搜索走 **DeepSeek 官方 Search API**（`POST https://api.deepseek.com/v1/tools/search`）：一次 HTTP 拿回标题 / 摘要 / 链接，不跑模型、不做重排；拿到后当成上下文喂给对话模型。和 DSH 的默认搜索提供方 `deepseek-search-api` 是同一套接口——所以「这个 App 的联网搜索」和「这个 agent 的联网搜索」本质是一回事。

## 许可

MIT。`app/LICENSE` 保留了 chat-demo 的 MIT 许可；本应用是派生作品，未使用 DeepSeek 商标或官方 Logo。模型能力由 opencode go 提供，与 DeepSeek 官方无关。
