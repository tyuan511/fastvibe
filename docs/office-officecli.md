# Office 预览与 OfficeCLI 集成方案

> 2026-10-18。调研对象：AionUi `c140550`（2026-10-14）、AionCore `503a871`（2026-10-15，AionUi 的 Rust 后端）、
> OfficeCLI `fb98e59`（2026-10-13，最新发布 v1.0.157）。

## 结论

OfficeCLI 能同时解决两件事：**预览**（它自带高还原度的 HTML 渲染器），以及**智能体处理 Office 文件**（CLI，加上打包在二进制里的技能）。
整体思路沿用 AionUi，但有五处不照搬：

1. 二进制随安装包内置，每个平台一份，用户不需要下载或安装任何东西。版本固定，构建时校验写死在仓库里的 SHA256。不运行官方安装脚本，不改用户 shell 配置里的 PATH（只在 FastVibe 自己起的进程里加），关闭它的自更新。
2. 默认用静态快照（`view html`）；实时的 `watch` 只用于侧栏里打开的本地文件。
3. 技能只内置一个很薄的入口，专项技能在运行时用 `officecli load_skill` 取出，和二进制版本一致。不拷贝上游技能文本。
4. 实时预览用 iframe，不用 `<webview>`。
5. 预览里选中的元素可以引用到对话。OfficeCLI 已经提供了这个能力，AionUi 没有接入。

## 1. AionUi 的实现

### 1.1 预览

- **渲染端**：`packages/desktop/src/renderer/pages/conversation/Preview/components/viewers/OfficeWatchViewer.tsx`，
  Word / Excel / PPT 三个 viewer 都是它的薄包装。打开文件时通过 IPC 调 `start`，拿到 `http://127.0.0.1:<port>`：
  Electron 里用 `<webview>` 打开，Web 版用 iframe 走后端反代 `/api/office-watch-proxy/<port>`。组件卸载时调 `stop`。
- **后端**：AionCore `crates/aionui-office/src/watch_manager.rs`。
  - 按（用户, 规范化路径, 类型）建一个会话。
  - 先在 `127.0.0.1` 上找一个空闲端口，再起 `officecli watch <file> --port <p>`，stdin/stdout/stderr 全部丢弃。
  - 每 100ms 探测一次端口，最多等 15 秒；端口被占就换一个，最多试 3 次。
  - 同一文件已有存活进程时直接复用端口；退出时全部 kill。
- **外部修改**：`officecli watch` 只在 officecli 自己写文件时刷新。AionCore 的 `proxy.rs::force_reload`
  向 watch 发 `POST /api/switch {"file": 同一路径}`，让它重新渲染。
- **格式路由**（`renderer/utils/file/fileType.ts`）：
  - 只有 docx / xlsx / pptx 走 officecli；
  - csv 当文本显示，因为 officecli 不接受 csv；
  - doc / xls / ppt、odt / ods / odp、docm / xlsm / pptm 明确标为「不支持」，不再提示去装 officecli。
- **给模型读的转换**（`conversion.rs`）是另一条路径：docx → Markdown 用 pandoc，xlsx → JSON 用 calamine，只有 pptx → JSON 用 officecli。

### 1.2 安装与更新

- **查找顺序**：PATH → `~/.local/bin/officecli` → `%LOCALAPPDATA%\OfficeCli\officecli.exe`，
  并要求 `officecli watch --help` 能正常运行（`officecli_runtime.rs`）。
- **找不到就运行官方安装脚本**，装进用户自己的 PATH：
  - Unix：从 `d.officecli.ai/install.sh` 下载脚本（失败退回 GitHub raw），再用 `bash` 执行；
  - Windows：`irm … | iex`。
- **更新**：每次打开 PPT 预览时，最多每 24 小时和 GitHub latest 比一次版本，不一致就重跑安装脚本。
- **Docker 镜像**需要装 `libicu`，否则 .NET 二进制一启动就崩（`Dockerfile`）。

### 1.3 技能

- AionCore 的 `assets/builtin-skills/` 里放了 OfficeCLI 的专项技能：
  - 三个格式技能：`officecli-docx` / `officecli-xlsx` / `officecli-pptx`；
  - 场景技能：学术论文、数据看板、财务模型、融资路演、Word 表单、morph-ppt、morph-ppt-3d；
  - 总技能 `officecli` 放在 `auto-inject/` 下，注入到每个助手。
- 这些文件都是从 OfficeCLI 仓库拷来的，开头加了一段「Windows 上把 bash 写法翻译成 PowerShell」的说明。
- **拷贝已经落后于上游。** 例如上游的 `batch` 已改成默认原子回滚，`open` / `save` 的生命周期说明也变了，AionCore 的副本还是旧说法。
  技能文本和二进制版本对不上，模型就会按过时的语义操作。

## 2. OfficeCLI 需要知道的行为

| 项 | 事实 | 对我们的影响 |
| --- | --- | --- |
| 许可 | Apache-2.0，NOTICE 要求随分发保留 | 可以分发二进制，需要附 NOTICE |
| 形态 | 自包含的单文件 .NET 二进制，每平台约 31–33 MB；macOS 版有 Developer ID 签名并已公证 | 无运行时依赖；Linux 需要 ICU |
| 发布频率 | v1.0.148 → v1.0.157：五周十个版本（2026-09-07 至 10-12），每版附 `SHA256SUMS` | 必须固定版本 |
| 平台 | mac arm64/x64、win x64/arm64、linux x64/arm64、alpine x64/arm64 | 桌面和 SSH Agent 都能覆盖 |
| 渲染方式 | `view html`（独立 HTML 文件）、`view screenshot`（PNG）、`watch`（本地 HTTP + SSE 自动刷新） | 预览直接用这些 |
| watch 的安全 | 只绑 `127.0.0.1`；Host 不是回环名一律 403（防 DNS 重绑定）；写接口检查 Origin：没带放行，非回环来源拒绝 | iframe 必须保留自己的源，否则 Origin 是 `null`，写接口会拒 |
| watch 的写接口 | `POST /api/send`、`/api/batch` 会改文件，`/api/switch` 换文件；Excel 预览里双击单元格可以直接编辑，图表可以拖动 | 预览不再是只读的 |
| 选中与标记 | 预览里点选、框选的元素可以用 `officecli get <file> selected --json` 读出；`mark` 在预览上挂待审的修改建议；`goto` 滚动预览。覆盖 pptx 的形状、图片、表格、图表，docx 的顶层段落和表格；**xlsx 不支持** | 「圈选反馈」几乎不用写代码 |
| 外部修改 | watch 只感知 officecli 自己的写入 | 我们要自己监听文件，用 `/api/switch` 刷新 |
| 空闲退出 | watch 空闲超时默认 5 分钟（`OFFICECLI_WATCH_IDLE_SECONDS`） | 我们崩溃时子进程不会永久残留 |
| 技能 | 全部技能编译在二进制里，用 `officecli load_skill <name>` 输出 | 不需要拷贝技能文本 |
| 自更新 | 每次调用都在后台检查更新，把新版下载到二进制旁边，下次调用时替换自己 | 必须设 `OFFICECLI_SKIP_UPDATE=1` |
| 自安装 | 不带参数运行 `officecli`，或运行 `officecli install`，会把自己复制到 `~/.local/bin`，并向检测到的 Claude Code、Cursor、Codex、pi 等写入技能和 MCP 配置；官方 `install.sh` 也会写技能——**包括 `~/.agents/skills/officecli`，FastVibe 会读这个目录** | 必须设 `OFFICECLI_NO_AUTO_INSTALL=1`，技能里禁止运行 `install`；见 §3.5 同名问题 |
| 用户目录 | 配置、缓存、插件的路径固定在 `~/.officecli`；只有常驻模式的标记能用 `OFFICECLI_STATE_DIR` 改位置 | 见 §6 |
| 常驻模式 | `open` 把文档留在内存里，空闲约 10 秒才落盘；`OFFICECLI_RESIDENT_FLUSH=each` 让每次修改立即落盘 | 预览和文件快照读的是磁盘 |
| 截图 | `view screenshot` 依赖系统里的 Chrome / Chromium / Edge / Firefox | 没装浏览器的机器截不了图 |
| 外部资源 | 生成的 HTML 里，公式（KaTeX）、3D（three.js）、Mermaid 从 jsDelivr 或它自己的镜像加载，部分字体走 Google Fonts | 离线时这些元素会降级；内联 HTML 的 CSP 已放行 https |

## 3. FastVibe 方案

### 3.1 二进制：随安装包内置

Office 是内置功能，不是可选开关，所以 officecli 和 `models-dev`、内置扩展一样随安装包发布，装好 FastVibe 就能用。
运行时没有下载、安装、移除这些步骤，也就没有相应的界面状态、IPC 方法和失败路径。

- **版本清单写在仓库里**：新增 `scripts/officecli.json`，记录版本号和每个平台资产的 SHA256。
  哈希从该版本的 `SHA256SUMS` 抄过来、提交进仓库，构建时不信任下载下来的 `SHA256SUMS`。
- **构建时取二进制**：新增 `scripts/fetch-officecli.mjs`。
  - 按清单下载目标平台的资产，放到 `resources/officecli/<os>-<arch>/officecli[.exe]`（这个目录加进 `.gitignore`），校验哈希，`chmod +x`。
  - 已存在且哈希一致就跳过，所以重复构建不会重复下载。
  - 下载源顺序：GitHub release → OfficeCLI 自己的镜像 `d.officecli.ai` → 已在用的 `gh-proxy.com`。哈希在清单里，用哪个镜像都不影响完整性。
  - 挂在 `predev`（取本机架构）和打包前的 `stage:app`（取要打包的架构）上。`dist:mac` 一次打 arm64 和 x64，两份都要取。
- **打包**：`electron-builder.yml` 的 `extraResources` 加一条 `from: resources/officecli/${os}-${arch}` → `to: officecli`。
  每个安装包只带自己架构的那一份，不需要再写 `files` 的排除规则。
- **打包后检查**：`scripts/check-packaged-deps.cjs`（`afterPack`）加一项：`resourcesPath/officecli/` 下有对应架构的二进制、可执行；
  架构和构建机一致时，再跑一次 `officecli --version`，版本必须和清单一致。不满足就让构建失败，和缺依赖一样拦在出安装包之前。
- **运行时路径**：打包后是 `process.resourcesPath/officecli/`，开发时是 `resources/officecli/<os>-<arch>/`，和 `resources/skills` 同一套解析方式。
- **macOS 签名**：electron-builder 会遍历 `.app` 里的每个 Mach-O 文件，用我们的 Developer ID 重新签名，开启 hardened runtime 并带上
  `entitlements.mac.inherit.plist`。这份文件已经有 .NET JIT 需要的 `allow-jit` 和 `allow-unsigned-executable-memory`。
  重签之后能否通过公证、能否正常启动，必须在一次真正公证过的构建上验证（§6）。
- **升级**：新增 `pnpm sync:officecli -- --version vX.Y.Z`，读取该版本的 `SHA256SUMS`，重写 `scripts/officecli.json`。
  提交前人工看一眼 diff，并跑一遍 §7 的手工检查。随 FastVibe 发版升级，不另做自动更新。

### 3.2 环境变量

新增 `applyOfficeCliEnv()`，放在 `applyShellPath()` / `applyShellLocale()` 旁边，在 `src/main/index.ts` 和 `src/agent/main.ts` 中、任何会话和终端 fork 之前调用：

- **`PATH` 前面加上 §3.1 的运行时目录。**
  这样智能体的 bash 工具和应用内终端都能直接用 `officecli`，而且用的是随应用发布的那个版本。
- **`OFFICECLI_SKIP_UPDATE=1`、`OFFICECLI_NO_AUTO_INSTALL=1`**：不自更新，也不往用户的其他工具里写东西。
- **`OFFICECLI_STATE_DIR=runtime/engine/officecli-state`。**
- **`OFFICECLI_RESIDENT_FLUSH=each`**：智能体使用常驻模式时，每次修改都立即落盘，预览、文件快照和「已修改文件」看到的都是最新内容。

用户自己装的 officecli 不受影响；在 FastVibe 起的进程里，它排在我们这个版本后面。

### 3.3 预览：静态快照为主，实时 watch 只用于侧栏

新增预览类型 `{ kind: "office"; format: "docx" | "xlsx" | "pptx"; path; name; size }`。
`readFilePreview` 只按扩展名返回这个类型，不再在主进程里同步解压：现在用的 `execFileSync("unzip")` 在 Windows 上没有这个命令，而且会阻塞主进程。

两种渲染方式：

| | 静态快照 | 实时 watch |
| --- | --- | --- |
| 命令 | `officecli view <file> html -o <缓存路径>` | `officecli watch <file> --port <p>` |
| 用在哪里 | 对话里的查看器、远程主机上的文件、以后的手机端；watch 启动失败时也回退到这里 | 侧栏「文件」里打开的**本地**文件 |
| 能力 | 原样排版 | 原样排版 + 自动刷新 + 选中 / 标记 / goto + Excel 内联编辑 |
| 进程 | 一次性子进程 | 每个打开的文件一个常驻子进程 |

**静态快照**

- 新增方法 `office:render { path, conversationId? }`，返回 `{ url }`。
- 缓存键是（realpath、mtime、size、officecli 版本），缓存目录是 `runtime/engine/office-preview/`，按总大小做 LRU 清理。
- 用异步子进程渲染，超时 60 秒，可以取消；同一个文件同时只渲染一次。
- 页面经 `fastvibe-media://` 提供，和现有的 HTML 预览完全一样：iframe 用 `sandbox="allow-scripts"`，响应头加 `INLINE_HTML_CSP`。

**实时 watch**（`src/main/engine/office-watch.ts`，不依赖 Electron）

- **进程管理**参照 AionCore 的 `OfficecliWatchManager`：
  - 按 realpath 建一个会话，带引用计数：同一文件在两个窗口打开，只起一个进程；
  - 分配回环端口，等待就绪（最多 15 秒），端口冲突时最多重试 3 次；
  - 最后一个引用释放后延迟几秒再 kill，切换标签时不会反复起停；
  - 退出应用时全部 kill。
- **spawner 做成可替换的接口**，测试时换成假进程（AionCore 也是这样测的）。
- **外部修改**：对正在 watch 的文件做 `fs.watch` 加防抖，文件变化后发 `POST /api/switch`（AionCore 的做法）。
  这样智能体用 python 改的、用户在 Word 里保存的，预览都能刷新。
- **渲染端用 `<iframe src="http://127.0.0.1:<port>/" sandbox="allow-scripts allow-same-origin">`，不用 `<webview>`。**
  - 侧栏的 `<webview>` 只要在 DOM 里被移动就会被 Chromium 销毁（AGENTS.md「A guest is never re-parented」），而文件预览会随布局切换重新挂载，iframe 没有这个问题。
  - 代价是 CSP 的 `frame-src` 要加 `http://127.0.0.1:*`。
  - `allow-same-origin` 不能省：没有它，页面的 Origin 是 `null`，watch 的写接口和选中上报都会被拒。
- **每个阶段都要有界面状态**：启动中 / 启动失败（可重试）/ 已回退为静态快照。

**各格式的处理**

- docx / xlsx / pptx：走 officecli。
- csv / tsv：继续用现有的表格预览（officecli 不接受 csv），顺手修掉现在按逗号硬切的解析。
- doc / xls / ppt、odt / ods / odp、带宏的格式：显示「不支持预览」，不再把 zip 当文本读、显示一屏乱码。
- officecli 渲染失败时（文件损坏、加密、超时）：显示失败原因，提供重试和「用系统应用打开」。
  现在 `file-preview.ts` 里的纯文本提取会给出错误内容（公式单元格为空、列错位），二进制又总是在，所以把它删掉，不留作兜底。

### 3.4 把选中内容引用到对话

OfficeCLI 已经能让 CLI 读到预览里的选中元素，FastVibe 只需要把它接到输入框：

- 侧栏的 Office 预览处于 watch 模式、文件是 docx 或 pptx 时，标题栏显示「引用选中内容」。
  点击后，Main 运行 `officecli get <file> selected --json`，把结果作为引用插入输入框，内容包括：文件名、元素路径、文本的前几十个字。
  OfficeCLI 用的是稳定的 `@id=` 路径，文件改动后仍然有效。
- 智能体拿到的是精确路径，可以直接 `officecli set <file> '<path>' …`，不用再按描述去找是哪一段。
- 反过来，智能体可以用 `officecli goto` 把用户的预览滚动到某个元素，用 `mark` 在预览上挂修改建议给用户审。
  这两个命令依赖侧栏里正在运行的 watch，技能里要写明：文件没在预览里打开时不要用。
- xlsx 目前没有元素路径（OfficeCLI 的已知限制），所以 Excel 预览不显示这个按钮。

### 3.5 技能：一个入口，专项技能运行时加载

- **新增内置技能 `resources/skills/office/SKILL.md`**，中文，FastVibe 自己写，加进 `BUILTIN_SKILLS`。
  description 覆盖 docx / xlsx / pptx 的读取、生成和修改。
- **正文写三件事：**
  1. **加载规则**：按任务运行 `officecli load_skill <name>`，一件产物只加载一个。
     v1.0.157 没有名为 `officecli` 的技能（`load_skill` 是隐藏命令，可用名是 `word` / `excel` / `pptx` /
     `word-form` / `academic-paper` / `pitch-deck` / `financial-model` / `data-dashboard` / `morph-ppt` /
     `morph-ppt-3d`）。通用规则用 `officecli help <format>`，专项技能和 help 不一致时以 help 为准。
  2. **「你运行在 FastVibe 里」**，照 `skill-creator` / `find-skills` 的做法纠正上游技能里不成立的部分：
     - 二进制随 FastVibe 发布，已经在 PATH 上；`officecli --version` 不通就如实告诉用户，不要尝试安装；
     - **不要**执行上游技能里的 `curl | bash`、`officecli install`、`officecli mcp`、`officecli config`；
     - **不要**自己起 `watch` / `unwatch`：它会阻塞 bash 工具，而且一个文件只能有一个 watch，会和侧栏抢；
     - 交付时用 `present` 把文件展示给用户；
     - Windows 上 shell 语法不同，上游的 bash 写法要翻译（AionCore 是在每个技能开头加说明，我们只在入口里写一次）。
  3. **检查产物**：`view screenshot` 需要系统里有 Chrome 或 Edge；没有时用 `view html` 加 `view issues`。
- **为什么不拷贝上游技能**：技能编译在二进制里，`load_skill` 输出的内容永远和当前二进制同一版本。AionCore 的拷贝已经和上游不一致，就是反例。
- **同名问题**：用户在别处跑过 `officecli install`，或运行过官方 `install.sh`，只要 `~/.agents` 存在，就会有 `~/.agents/skills/officecli`。
  AionUi 自动安装时运行的正是这个脚本。
  FastVibe 原生读取这个目录，而且同名时用户目录胜出、界面上看不出来（AGENTS.md「同名技能会静默遮蔽」）。
  所以入口技能**不能**叫 `officecli`，叫 `office`，并在正文写明「如果还看到名为 officecli 的技能，以本技能为准」。
- 现有的 `pdf` 技能保持不变，OfficeCLI 不处理 PDF。

### 3.6 让产物看得见

- **`present` 接受 `.docx` / `.xlsx` / `.pptx`**：`resources/extensions/present.ts` 和 `shared/inline-media.ts` 里的扩展名清单各加一份，`test/inline-media.test.ts` 会检查两份是否一致。
  对话里显示文件名，点击后用静态快照在查看器里打开。
- **「已修改 N 个文件」和重试回退**目前只覆盖 write / edit 工具。智能体用 bash 跑 `officecli set/add/remove/batch/merge…` 改的文件，不会出现在卡片里，重试时也不会回退；而且 checkpoint 会跳过二进制文件。
  这部分放到第三期：在 `tool_execution_start` 识别 officecli 的写命令和目标文件，对整个文件做二进制快照。

### 3.7 远程主机与手机

- **SSH Agent**：同样内置。`scripts/build-agent-runtime.mjs` 按 `--arch` 把对应的 linux 二进制打进 runtime 包，
  `src/agent/main.ts` 调同一个 `applyOfficeCliEnv()`，远程项目里的智能体也能直接用 officecli。
  runtime 包每个架构因此大约增加 33 MB；升级 officecli 会改变 runtime 的 hash，从而发布一个新的 `agent-runtime-vN`（`docs/agent-runtime.md` 的去重规则）。
- **远程文件的预览**：`office:render` 经网关按 `conversationId` 路由到那台主机渲染，HTML 走现有的媒体代理传回来。实时 watch 第一期不支持远程，因为要通过 SSH 转发端口。
- **手机**：第一期不做。以后由主机渲染静态 HTML，手机用 WebView 显示。

### 3.8 调用表与远程策略

| 方法 | 说明 | 远程客户端 |
| --- | --- | --- |
| `office:render` | 静态快照 | 允许（有密码的人本来就能让智能体执行命令） |
| `office:watch-start` / `office:watch-stop` | 返回 `127.0.0.1` 地址 | 拒绝：这个地址对手机没有意义 |
| `office:selection` | 读取预览里的选中元素 | 允许 |

推送：`office:watch-state`，在 `remote-events.ts` 里分类。
所有方法都用 `handle()` 注册到中立调用表；漏了分类时，`server-policy.test.ts` 的覆盖检查会失败。
officecli 的版本号在构建时从 `scripts/officecli.json` 读进应用，显示在 设置 → 关于，不需要单独的方法。

## 4. 和 AionUi 不同的地方

| AionUi | FastVibe | 原因 |
| --- | --- | --- |
| 预览时发现没装，就运行官方安装脚本，装进用户的 PATH | 随安装包内置，固定版本 | 开箱即用；不改动用户的机器；版本和技能对得上；哈希在构建时校验 |
| 每 24 小时检查一次，有新版就重装 | 随发版升级，关闭自更新 | 上游五周发了十个版本，行为会变；用户的产物不能因为一次后台更新就变样 |
| 所有 Office 预览都起 watch 进程 | 默认静态快照，watch 只用于侧栏本地文件 | 查看器、远程、手机都不需要常驻进程 |
| `<webview>` | iframe | 侧栏的 webview 不能重新挂载 |
| 拷贝上游技能文本 | 一个入口 + `load_skill` | 拷贝会和二进制版本脱节 |
| 没接入选中内容 | 选中内容可以引用到对话 | OfficeCLI 已经支持，成本很低 |

## 5. 分期

**第一期：内置二进制 + 静态预览**

- `scripts/officecli.json`、`fetch-officecli.mjs`、`sync:officecli`、`extraResources` 和 `afterPack` 检查；`applyOfficeCliEnv`；`office:render`。
- 预览类型 `office`，侧栏和查看器都用静态快照；修正 csv 解析；不支持格式的提示；删掉主进程里的同步解压和纯文本提取。
- 入口技能 `office`；`present` 接受 Office 文件。
- 出口：三个平台的安装包装好后，不做任何额外操作，打开 docx / xlsx / pptx 都能看到原样排版，智能体能生成一份 pptx 并展示出来；
  macOS 的构建通过公证。

**第二期：实时预览与引用选中内容**

- `office-watch.ts`、iframe、外部修改刷新、`office:watch-*`、`office:selection`、引用到输入框。
- 出口：智能体修改 pptx 时侧栏实时刷新；用户选中一段，引用之后，智能体能按路径改到那一段。

**第三期：交付闭环**

- officecli 的写命令进入「已修改文件」卡片和重试回退（二进制快照）。
- 远程主机的预览，以及打进 Agent runtime 的二进制；手机端的静态预览。

## 6. 风险与待验证

- **`~/.officecli`**：配置、缓存和插件路径写死在用户目录下，只能靠改 HOME 规避，代价太大。
  关闭自更新后，它基本不会写 `config.json`（创建这个目录的主要是更新检查）；Mermaid 缓存目录仍可能出现。
  接受这个例外，并在 AGENTS.md 里记一笔。
- **PATH 顺序**：如果用户的 shell 配置在非登录 shell 里也修改 PATH，可能把用户自己装的 officecli 排到前面。
  验证方法：在会话里运行 `command -v officecli`。
- **跨进程管道**：智能体在 bash 里运行的 `officecli get … selected` / `mark` / `goto`，要能通过命名管道找到 Main 起的 watch 进程（同一用户、同一 `OFFICECLI_STATE_DIR`）。需要实测。
- **Google Fonts**：国内网络下，样式表请求可能挂起，拖慢首屏。需要实测；必要时在 `INLINE_HTML_CSP` 这一层处理。
- **Excel 内联编辑**会直接写文件，不经过 checkpoint。第一期接受，因为这是用户自己在改。
- **macOS 重签与公证**：OfficeCLI 发布的二进制带的是它自己的签名，打包时会被换成我们的 Developer ID，并开启 hardened runtime。
  .NET 单文件程序在 hardened runtime 下需要 JIT 相关的 entitlement，`entitlements.mac.inherit.plist` 里已经有了，
  但重签后能不能启动、能不能通过公证，只有在一次真正公证过的构建上才能确认。第一期的出口条件包含这一项。
- **Linux 缺 ICU**：.NET 二进制在没有 libicu 的系统上一启动就崩。桌面发行版基本都有；精简的服务器镜像（SSH 主机）可能没有。
  可以检测到这种失败后，用 `DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1` 重试，但要先验证它对数字和日期格式化的影响。
- **体积**：每个安装包增加约 32 MB（未压缩），Agent runtime 每个架构约 33 MB。这是选择内置的代价。
- **升级节奏**：上游几天发一版。我们只在需要修复或新功能时跟进，每次升级都要重跑 §7 的手工检查，因为渲染结果和技能都会跟着变。

## 7. 测试

- `test/officecli-manifest.test.ts`：`scripts/officecli.json` 覆盖所有要打包的平台和架构，每个资产都有哈希；资产名和运行时路径解析一致。
- 构建：`afterPack` 检查（§3.1）在每个打包 job 里运行，缺二进制或版本不符就让构建失败。
- `test/office-watch.test.ts`：用假 spawner 覆盖复用、引用计数、端口冲突重试、就绪超时、退出清理（可参照 AionCore 的 `watch_manager_integration.rs`）。
- `test/office-render-cache.test.ts`：缓存键、并发去重、LRU。
- `mock.html?pane=files&office=docx|xlsx|pptx|starting|error`：预览各个状态。浏览器里没有 officecli，用固定的 HTML 代替。
- 手工：用三个平台的安装包全新安装，不做任何额外操作，打开三种文件，并让智能体生成一份 pptx。
