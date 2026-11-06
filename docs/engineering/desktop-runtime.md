# 桌面运行环境与应用服务

涉及启动测量、locale、PTY、单实例、通知、唤醒与更新时阅读。

关联入口：[Agent runtime](../agent-runtime.md)、[引擎进程隔离评估](../engine-utility-process.md)。返回[工程合同索引](README.md) / [文档总索引](../README.md)。

本页承接根 `AGENTS.md` 拆出的详细合同、故障背景和验证资料。反引号中的源码与脚本路径相对仓库根；Markdown 链接相对本文件。历史实测只说明所述环境，不能当作当前性能保证；当前行为以源码、类型和所属功能文档核对。

## 启动时间线与主线程卡顿日志（`engine/startup-timeline.ts`）

「启动慢」「偶尔卡一下」以前没有数据：日志里只有 `app ready` 和 `window opened`。现在每个阶段自己打点，
窗口和引擎都起来时写**一行** `[startup] ms since process start: main-loaded …, app-ready …, proxy …,
ipc-ready …, window-created …, engine-runtime …, engine-session …, engine-ready …, window-shown …`
（按发生顺序排；一个阶段只记第一次，所以之后再开的窗口不会改写它）。`mcp-connected` 在行写出之后才到，
所以后台连接的耗时另有一行 `[mcp] …`。模块 Electron-free，引擎也在里面打点，无头 Agent 共用。

- **`main-loaded` 是整个静态 import 图求值完的时间**（开发态 ~870 ms，安装版 ~230 ms）。其中单独
  `import "@earendil-works/pi-coding-agent"` 就是 ~240–270 ms，是主进程冷启动里最大的一块，而且引擎需要它。
- **`watchEventLoop`**：每分钟至多一行 `[loop] event loop stalled up to N ms`，一分钟里最长停顿不到 200 ms 就
  不写。主进程一个线程承载引擎、流分发、git、远程服务器和窗口 IPC，这是判断「要不要把引擎搬进
  `utilityProcess`」的依据，见 `docs/engine-utility-process.md`。
- **没有做的启动优化，以及原因（都量过）：**
  - *V8 编译缓存*（`module.enableCompileCache`）：在 Electron 自带的 Node 24 里量了主进程的重依赖导入，
    有缓存 265 ms，没有 281–304 ms，省 10–30 ms；而要让它覆盖静态 import 图，必须多一个引导入口
    （`package.json` 的 `main` 改指向它再动态 import 真入口），不值。
  - *窗口提前创建*：`createNetworkProxy` 必须先于任何窗口，它保证没有会话在代理装好之前走直连；省下的
    ~100 ms 换不起这条不变量。
  - *切换会话「慢」*：`bench-session-open.mjs` 量出冷加载 18 个内置扩展第一次 ~260 ms（OS 文件缓存冷）/ ~55 ms（热），
    **之后同进程里任意 cwd 的重载只要 12–23 ms**（SDK 的扩展缓存在进程里共享）。日志里那些 300 ms 以上的
    `[session] opening` 几乎都是**启动后第一次打开**，它发生在 `start()` 里、和渲染进程启动并行。
    典型转写的 `prepareTranscriptForOpen` 是 4 MB ~20 ms、9 MB ~35 ms、58 MB ~150–210 ms。所以切换本身
    不是这组测量中的主要瓶颈。早期等待 MCP 的启动路径已改为后台连接，当前连接与提示词宽限行为见 [MCP 工程合同](extensions.md)，不能把旧等待耗时当作当前启动结论。

## 系统通知（设置 → 通用）

设置里只剩一个总开关，**默认打开**。任务完成、任务出错、需要确认、应用更新不再各自可关：总开关
开着时四个都提醒。Main 在每个事件上读一次文件，所以改完立即生效。四个场景回答的仍是不同的问题：
跑完是「可以回来看结果」，出错是「这次没成功」，等待插件问题回答是「你不回答它就永远走不下去」——只有最后一条是真正的阻塞。文案仍按场景区分，只是不再各有开关。

- **`settings.notifyDone` / `notifyError` / `notifyApproval` / `notifyUpdate`**，平铺在
  `settings.json` 里，由总开关一起写成同一个值。**缺失即为打开**。只有四个键全部是 `false` 才算总开关关掉——单独一个
  `false` 是旧的场景开关留下的，加载时丢掉（`normalizeNotificationSettings`），不再单独静音那个场景，否则设置页上
  已经没有地方把它打开。旧的 `notifications: "done" | "approval" | "off"` 被丢掉而不迁移。
- **判定与投递分两层。** `src/shared/notifications.ts` 不引 Electron（`node --test` 加载不了），
  只回答两件事：总开关开没开、这个事件属于哪个场景。`src/main/engine/notifications.ts`
  是 Electron 那一半：`new Notification` 和它的 click。这里多出的一个理由是 test 要能跑。
- **`notifyError` 与 `notifyDone` 分开，`stopped` 两者都不发。** `agent_settled` 上的
  `#interruptedRuns` 判定既是「队列能不能继续排空」的依据，也是「这次算完成还是失败」的依据；
  「任务已完成」压在一次用户自己按的停止上，是一条没人要过的通知。
- **点通知要落到那条会话。** click 里先 `app.focus({ steal: true })`（macOS：只
  `window.focus()` 拉不回 ⌘H 隐藏或在别的 Space 的窗口）、再 restore/show/focus，然后调
  `engine.openConversation(id)`。跳转本身不重新实现：把会话设成 active 就是侧栏点一下做的事，
  每个客户端都已经在跟（`workspace:changed` → `handleOpen`），所以窗口当时**关着**也对——
  活过来的窗口在启动时 adopt 的正是 catalog 的 activeId。
- 只有会阻塞的 dialog 方法算数（`isBlockingPrompt`）；`notify` / `setStatus` / `setWidget`
  是单向的，不能触发通知。
- **前台不等于看见。** 其余场景只在没有窗口聚焦时发；`notifyApproval` 多两条路：窗口在前但
  请求的会话不是屏幕上的那一个（`focusedApprovalNeedsNotice`，纯函数，有单测），以及窗口失焦时
  补发还停着的请求。提问面板只画在活动会话的 composer 里，这是「在前却没看见」唯一会发生的场景。
- **Vivi 注意力通知一条事实只播报一次。** `main/vivi/bot-notifications.ts` 把已播报的问题/失败
  事实 id 存进 `bot-attention-state.json`，重启不再为同一条旧事实重复打扰；快照里消失的事实
  会从状态里清掉。首次初始化（无状态文件）时把当时已存在的事实静默计为已播报，而不是升级后
  翻旧账。回归在 `test/bot-notifications.test.ts`。

## 单窗口

FastVibe 是一个窗口、一个进程：`app.requestSingleInstanceLock()` 在模块作用域取（输的那个进程
要在开窗之前就没了），`second-instance` 把已有的窗口恢复并聚焦——再点 Dock 图标不是再开一个
窗口，而是回到原来那个。`window:new` 同样折进已有窗口而不是 `createWindow()`：每个 push、
每个不说「谁的」就操作「当前会话」的方法都是按一个客户端设计的。

开发态是例外：`ELECTRON_RENDERER_URL` 有值时跳过锁。`electron-vite dev` 每次改主进程都会异步
杀掉旧子进程再起新的，新进程可能在旧进程还没释放锁的时候来抢——那会让 `pnpm dev` 变成一个
没有窗口也没有报错的应用（旧进程以为是自己被替换了，新进程以为旧的那个还在）。在主进程里，
`false` 恰好是错的那个答案。

## 终端与子进程的 locale（`engine/shell-locale.ts`）

侧栏终端「有时候乱码」的根因不在 xterm，也不在编码转换：**从 Finder/Dock 启动的 Electron 拿不到 locale**。
launchd 只给 HOME、SHELL、PATH，`LANG` 是登录 shell 或 Terminal.app 的「启动时设置区域环境变量」才会写的，
两者都不在这里发生。于是本进程 fork 出来的每个子进程——首先是终端里那个 shell——都跑在 POSIX/C locale，
而 C locale 里 0x7f 以上的字节不是字符的一部分。

用真实 pty 量过的现象（macOS，`LC_CTYPE=C`）：zsh 的行编辑器不是多字节感知的，**画出来的是字节不是字**——

```
敲下 echo 中文测试   →   echo <00ad><0096><0087><008b><0095>
通配失败              →   zsh: no matches found: /tmp/\M--\M-^V\M-^G*
locale charmap        →   US-ASCII
```

真正交给命令的字节是对的（那条 `echo` 的输出仍是「中文测试」），所以它表现为「有时候」：
只要没有非 ASCII 参与就一切正常。补上任意一个 UTF-8 的 `LC_CTYPE`，同一个会话就画 `echo 中文测试`。

- **只写 `LC_CTYPE`，不写 `LANG`。** 决定「什么是一个字符」的就是这个类别，也是所有工具在 `LC_ALL`
  之后第一个查的（vim、less、man、git 的 `is_utf8_locale()`、JDK 的 `sun.jnu.encoding`、Ruby 的
  `default_external`、Python 的 PEP 538/540 都认它）。留着 `LANG` 不动，`LC_MESSAGES` / `LC_TIME` /
  `LC_COLLATE` 就还是 C：`sort` 保持字节序，也不会有什么东西突然改用另一种语言回话。
- **已经设了就绝不覆盖**（`localeIsSet` 看 `LC_ALL` / `LC_CTYPE` / `LANG`），包括用户故意写的 `LANG=C`。
  Linux 桌面会话本来就设 `LANG`，所以这条路主要是给 macOS 的 GUI 启动兜底。
- **不编造 locale 名。** `pickUtf8Locale` 只在 `locale -a`（有界 500ms）列出的里面挑，顺序是
  `C.UTF-8` → `en_US.UTF-8`；名字按折叠和去掉分隔符比较（macOS 印 `C.UTF-8`，glibc 印 `C.utf8`）。
  一个不存在的名字比 C locale 更糟：之后每条命令都要先印一行
  `setlocale: LC_CTYPE: cannot change locale (…)`。探测失败时只有 macOS 还给答案（`en_US.UTF-8`
  是系统自带的），其它平台宁可不设。Windows 直接跳过——它的控制台是代码页不是 locale，ConPTY 两头都是 UTF-8。
- **调用点在两个入口**（`src/main/index.ts` 和 `src/agent/main.ts`），紧挨着 shell PATH 的探测，
  在任何 agent 会话、MCP stdio 服务器和终端被 fork 之前。它改的是 `process.env`，所以智能体自己的
  bash 工具、`source-control.ts` 的 git 调用一起受益——`TerminalSessions` 因此不需要自己的 locale 代码
  （它本来就把 `process.env` 展开进 pty）。这也是有意的：不要只在终端里补，让同一次运行的其余部分继续在 C locale。
- **桌面端的登录 shell PATH 是异步问的**（`applyShellPathAsync`）。`$SHELL -ilc` 跑用户的启动文件：普通配置
  100–250 ms，装了 nvm / conda 的常常顶到 1.5 s 超时，以前在 `app.whenReady` 之前同步卡着。现在模块加载时发出、
  和 Electron 初始化并行，`whenReady` 的第一件事就是等它——之后才有会话、终端、MCP 或窗口发来的 git 调用。shell 的
  条目合并在原有 PATH 前面，所以随后再调一次 `applyOfficeCliEnv()` 把内置 OfficeCLI 挪回最前（它会去重）。超时时
  连同 stdout 一起丢掉：被杀的 shell 留下的子进程可能还握着管道。无头 Agent 仍是同步的，它没有窗口在等。

## 安装版里 node-pty 必须带补丁（`patches/node-pty.patch`）

打包后 electron-builder 把整个 `node-pty` 包（含 `lib/*.js`）放进 `app.asar.unpacked`，Electron 解析 `require` 时
`__dirname` 已经是 `…/app.asar.unpacked/…`。node-pty 的 `helperPath.replace('app.asar', 'app.asar.unpacked')`
于是得到 `app.asar.unpacked.unpacked`，`spawn-helper` 找不到，`pty.fork` 报 `posix_spawnp failed.`——
**dev 没有 asar，所以一切正常，只有安装包起不了终端**。补丁把三处 `replace` 改成
`/app\.asar(?!\.unpacked)/`（`unixTerminal.js` 两处、`windowsConoutConnection.js` 一处）。
升级 node-pty 时用 `pnpm patch node-pty` 重做；去掉补丁前先在打包产物里实测开终端。

## 回退路径（node-pty 不可用时）

`TerminalSessions` 优先用 node-pty；不可用时 Linux/Windows 退化成 `script` / 裸子进程，macOS 直接报「无法启动终端」。

- **回退的输出必须过一个 `StringDecoder`**（`createChunkDecoder`）。逐块 `chunk.toString("utf8")` 会把跨两次读的
  多字节字符变成两个 U+FFFD——pty 一次读多少由内核缓冲区决定，负载下 3 字节的 CJK 字符被切开是常态。
  stdout 和 stderr 共用一个解码器：在 `script` 回退里它们是同一个 pty 的两端，字节本来就一个顺序。
- **回退不等价，而且它以前是静默的。** 它设不了 pty 尺寸（`resize` 是空操作），于是输出按 shell 启动时的
  行列数折行——这本身就长得像乱码。`loadPty()` 现在是惰性的，失败原因在 `start()` 里 `console.warn` 一次
  （Main 把 console 钩进 `logs/main.log`；这个模块不能 import logger，那会带进 Electron，而无头 Agent 跑同一个文件）。
  惰性加载也顺带让这个模块能被 `node --test` 直接 import。
- 已知未修：渲染层在 `terminalStart` 的 invoke 回来之前收到的输出会被丢掉（监听器按 `sessionId` 过滤，
  而 id 那时还不知道）。Main 的 16ms 合帧通常让回复先到，所以实践中罕见；真发生时表现是「终端空白/少了前几行」，
  不是乱码。彻底修需要客户端自带 id（要过 SSH Agent 的版本偏差），暂不做。

## 运行时保持唤醒

Settings → 通用 → 运行时保持唤醒 (`settings.keepAwake`, on by default) holds the machine
awake while an agent run is in flight **or the remote-access server is listening**.

- `src/main/engine/keep-awake.ts` owns a single `powerSaveBlocker` and is the only place
  that starts or stops it. Two inputs decide the state: the preference, and whether
  anything is streaming — so turning the switch off mid-run releases it at once, and the
  last run to finish releases it while the switch stays on.
- It blocks `prevent-app-suspension`, not `prevent-display-sleep`: the run survives, the
  screen may still dim. A late-night run should not light the room.
- Runs are tracked per conversation id from the engine's `conversation_running` event,
  which is broadcast for background chats too, so a session the user switched away from
  still counts. `before-quit` clears the set. A compaction counts too: it is minutes of
  model work on the user's own machine, and it is the last thing to finish.
- **A listening remote server counts too** (`setRemoteServing`, driven from `announce` /
  `announceFromServer` in `remote.ts`). Counting runs alone let an idle Mac sleep under a
  phone that was reading a transcript between prompts, which dropped the connection. Listening
  (or the official connection being online — `setRemoteServing` takes a source for each) is the condition, not a connected client: a phone reconnects
  whenever it likes, and sleeping between its visits is the same failure.
- **A closed lid is out of reach, and the row says so.** `prevent-app-suspension` is IOKit's
  `PreventUserIdleSystemSleep`, which the header documents as still sleeping «for lid close»;
  only `sudo pmset -a disablesleep 1` or clamshell mode (power + external display) keeps a
  closed MacBook up. Changing a machine-wide power setting is the user's call, not the app's.

## 自动更新（updater）

`src/main/updater.ts` owns electron-updater. Background checks run once shortly after
launch and then every hour (`CHECK_INTERVAL_MS`), and they only ever *announce* a version:
downloads are user-initiated (`autoDownload` is off), from the manual-check dialog or the
small button to the right of the sidebar's 设置 row. The sidebar button and the dialog both
read the same `update:state` stream (`AppUpdateState`), so 「download → progress → restart」
cannot disagree between them.

The hour is affordable because a stale *notice* is not a stale *install*: 立即更新 re-reads
the feed whenever the version on screen was resolved more than `UPDATE_RECHECK_AFTER_MS`
ago (`update-refresh.ts`), since `downloadUpdate()` otherwise downloads whatever the last
check cached. Shortening the interval only bounded how long the badge could name a
superseded release; it was never what kept the download correct.

**`releaseNotes` is HTML, not markdown.** electron-updater's GitHub provider builds it
from the releases **Atom feed** (`<content type="html">`), i.e. GitHub's already-rendered
HTML — so rendering it with `react-markdown` showed the raw tags. `release-notes.tsx`
parses it and rebuilds a whitelist subset as React elements (never `dangerouslySetInnerHTML`;
unknown tags unwrap, `javascript:` hrefs and `<script>` are dropped), and falls back to the
markdown renderer when a feed does hand us markdown.
