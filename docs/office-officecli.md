# Office 预览与 OfficeCLI 集成

FastVibe 随安装包发布固定版本的 OfficeCLI，用同一份二进制支持智能体读写 Office 文件和 HTML 预览。docx / xlsx / pptx 的查看器、远程文件和手机使用静态快照；桌面侧栏打开本地文件时启动实时 watch，并先显示静态快照以缩短等待。Office 写命令已接入修改文件卡片和二进制检查点。

## 1. 上游依据

原始调研日期为 2026-10-18，对照 AionUi `c140550`（2026-10-14）、其 Rust 后端 AionCore `503a871`（2026-10-15），以及 OfficeCLI `fb98e59`（2026-10-13，发布版本 v1.0.157）。以下是这些版本的上游观察，用来解释集成边界；当前打包版本以 `scripts/officecli.json` 为准，不把历史调研视为对未来上游版本的承诺。

AionUi 的 `packages/desktop/src/renderer/pages/conversation/Preview/components/viewers/OfficeWatchViewer.tsx` 让 Word、Excel 和 PPT 共用 watch 预览；AionCore 的 `crates/aionui-office/src/watch_manager.rs` 按用户、规范化路径和类型复用进程，分配回环端口，每 100ms 探测就绪，最多等 15 秒，冲突最多重试三次。外部改动由 proxy 的 force_reload 向 `POST /api/switch` 发送同一路径，原因是 watch 只主动感知 OfficeCLI 自己的写入。

AionUi 在 Electron 中使用 webview，Web 版通过后端代理给 iframe。其 `officecli_runtime.rs` 负责查找与安装，`proxy.rs::force_reload` 负责外部修改后的刷新。找不到 CLI 时运行官方安装脚本，装入用户 PATH，并在打开 PPT 预览时最多每 24 小时检查更新。AionCore 的 Dockerfile 安装 libicu；给模型读取的转换另用 pandoc、calamine 和 OfficeCLI，不等同于预览渲染链路。

AionCore 还复制了专项技能并自动注入总技能。调研时这些副本已落后于上游的 batch 原子回滚和 open/save 生命周期语义。FastVibe 因此保留一个薄入口，由当前二进制的 `load_skill` 提供正文，避免技能与执行版本脱节。

OfficeCLI v1.0.157 的关键上游行为：

| 项目 | 上游证据与集成含义 |
| --- | --- |
| 许可与分发 | Apache-2.0，分发保留许可和 NOTICE；自包含单文件 .NET 二进制约 31–33 MB，Linux 仍需要 ICU。上游 macOS 资产有 Developer ID 签名和公证。 |
| 平台与版本 | 上游提供 mac、Windows、Linux、Alpine 的多架构资产；v1.0.148 到 v1.0.157 在五周内发布十版，每版附 SHA256SUMS，需固定版本而非跟随 latest。 |
| 渲染 | `view html` 输出独立页面，`view screenshot` 输出图片，`watch` 提供本地 HTTP 与 SSE。截图依赖系统 Chrome、Chromium、Edge 或 Firefox。 |
| watch 安全 | 只绑定 `127.0.0.1`，Host 非回环名时拒绝；写接口允许无 Origin 的 CLI 请求，拒绝非回环 Origin。沙箱把页面源变成 `null` 时，写入和选中上报会失败。 |
| watch 写入 | `/api/send`、`/api/batch` 会修改文件，`/api/switch` 切换文件；Excel 页面支持双击单元格编辑和图表拖动。实时预览具有写能力。 |
| 选中与定位 | `get <file> selected --json` 返回 docx / pptx 元素，包含稳定的 `@id=` 路径；watch 的 goto / mark 用于定位和标记。xlsx 不支持这套元素路径。 |
| 进程寿命 | watch 空闲退出默认五分钟，由 `OFFICECLI_WATCH_IDLE_SECONDS` 控制；这是宿主崩溃后的上游兜底，不替代宿主退出清理。 |
| 更新与安装 | 默认后台检查更新并替换自身；不带参数或执行 install 会复制二进制、写入其他 Agent 的技能和 MCP。官方脚本也会写用户技能目录。 |
| 状态与落盘 | 配置、缓存、插件路径固定在 `~/.officecli`；常驻标记可由 `OFFICECLI_STATE_DIR` 改位置。open 常驻文档可能延迟落盘，`OFFICECLI_RESIDENT_FLUSH=each` 令每次修改落盘。 |
| 外部资源 | HTML 中 KaTeX、three.js、Mermaid 可能从 jsDelivr 或上游镜像加载，部分字体使用 Google Fonts；离线时这些内容可能降级。 |

## 2. 二进制、打包与升级

`scripts/officecli.json` 保存版本与各平台 SHA256。`scripts/fetch-officecli.mjs` 按清单获取资产，校验仓库里固定的哈希，放到 `resources/officecli/<os>-<arch>/officecli[.exe]`，已有内容匹配时跳过。下载支持 GitHub release、上游镜像和代理回退，完整性不依赖镜像提供的校验文件。

下载挂在开发准备与应用打包准备流程中。`electron-builder.yml` 的 extraResources 将目标平台目录复制为安装包的 `officecli/`，每个安装包只带自己的架构，并附许可、NOTICE 与版本清单。`scripts/check-packaged-deps.cjs` 的 afterPack 检查缺失、可执行性，并在可运行的本机构建目标上检查版本；不能把跨架构静态检查当作真实启动验证。

运行时由 `src/main/engine/office-cli.ts` 解析：安装版读取 `process.resourcesPath/officecli/`，开发版读取资源根下的平台目录。`scripts/build-agent-runtime.mjs` 把对应 Linux 架构及许可、NOTICE、清单打进 SSH Agent runtime，缺少资产时拒绝打包。runtime 体积和 hash 随二进制变化，发布规则见 `docs/agent-runtime.md`。

升级通过 `pnpm sync:officecli -- --version vX.Y.Z` 更新清单，人工审查差异后随 FastVibe 发版。运行中的应用不下载或自更新 OfficeCLI，也不运行上游安装脚本。

## 3. 运行环境与技能

`applyOfficeCliEnv()` 在 `src/main/index.ts` 和 `src/agent/main.ts` 的会话、终端及工具子进程创建之前运行：

- 将内置二进制目录放到进程 PATH 最前，桌面异步 shell PATH 合并后再次确保这个顺序。
- 设置 `OFFICECLI_SKIP_UPDATE=1`、`OFFICECLI_NO_AUTO_INSTALL=1`。
- 设置 `OFFICECLI_STATE_DIR` 为 runtime 下的 `officecli-state`，以及 `OFFICECLI_RESIDENT_FLUSH=each`。

找不到内置二进制时不写这些变量，避免无意改变用户自装版本的行为。这些设置只作用于 FastVibe 及其子进程，不修改用户登录 shell。

内置入口为 `resources/skills/office/SKILL.md`，按任务加载一个专项技能，再按格式 help 操作。调研版本没有名为 officecli 的 load_skill 条目，可用名包含 word、excel、pptx、word-form、academic-paper、pitch-deck、financial-model、data-dashboard、morph-ppt 和 morph-ppt-3d；通用规则用 `officecli help <format>`，与专项技能冲突时以 help 为准。

入口禁止 install、mcp、config 及自行启动 watch/unwatch，要求通过 present 交付，Windows 下转换 shell 语法，截图环境不可用时使用 HTML 与 issues 检查。文件没有在侧栏实时预览中打开时不使用 watch goto / mark。

技能命名为 office 是为了避开官方安装脚本可能生成的用户级 officecli 技能。FastVibe 原生发现用户技能且同名时用户目录优先；若用户另有同名 office 技能仍可能遮蔽入口，不能只凭列表名称判断加载来源。OfficeCLI 不处理 PDF。

## 4. 预览

### 静态预览

`src/main/engine/file-preview.ts` 对 docx / xlsx / pptx 返回 `kind: "office"`，不在主线程解压或抽取文本。csv / tsv 使用表格预览并按 RFC 4180 解析；doc / xls / ppt、odt / ods / odp、docm / xlsm / pptm 返回不支持预览，可在本机用系统应用打开。

`office:render` 调用 `src/main/engine/office-render.ts`，异步执行 `officecli view <file> html -o <缓存路径>`，返回产物 `path`。缓存身份包含 realpath、mtime、size 和 OfficeCLI 版本，保存在 `runtime/engine/office-preview/`，按总大小进行 LRU 清理；相同渲染去重，子进程有超时与取消处理。

页面经 `fastvibe-media://` 提供，使用共用 HTML 安全策略 `INLINE_HTML_CSP`，iframe 为 `sandbox="allow-scripts"`。静态页不取得同源权限；损坏、加密、缺少二进制或超时都有可见错误和重试入口，不退回失真的纯文本提取。

### 本地实时预览与选中引用

`src/main/engine/office-watch.ts` 不依赖 Electron，按 realpath 管理 watch。相同文件共享一个进程并引用计数，端口冲突有界重试，就绪最多等 15 秒；最后一个引用释放后延迟停止，应用退出清理全部进程。文件监听对外部修改防抖并调用 `/api/switch`，也处理替换文件的保存方式。

`src/renderer/src/components/chat/office-frame.tsx` 的 live 模式只用于侧栏本地文件。静态渲染和 watch 并行启动，静态页先到就先显示，watch 就绪后替换；watch 失败时已有静态页继续可用，两者都不可用才显示错误。失败界面支持重试和静态回退。

live 页使用 `http://127.0.0.1:<port>/` iframe，沙箱为 `allow-scripts allow-same-origin`，应用 CSP 的 frame-src 放行回环端口。保留页面源是上游选中上报和写接口所需；回环页面与应用窗口仍是不同源。**沙箱随实际加载的页面切换**：等待中的静态快照仍只有 allow-scripts，不能因请求了 live 就提前放宽。

docx / pptx 在实时页就绪后提供「引用选中内容」，由 `office:selection` 执行 get selected，将文件名、稳定元素路径和短文本插入输入框。xlsx 不显示这个入口。预览中的 Excel 编辑直接修改文件，是用户操作，不经过智能体工具检查点。

## 5. 交付、修改记录与回退

`resources/extensions/present.ts` 接受三种 Office 格式，与 `src/shared/inline-media.ts` 的清单保持一致。转写显示文件名，点击后由查看器展示静态页面。

`src/shared/office-command.ts` 识别 bash 中可识别的 officecli 写命令与目标。`src/main/pi/process-manager.ts` 在 tool_execution_start、命令执行之前捕获文件；Office 文件用 `readBeforeBinary()` 保存完整字节，避免 ZIP 中的 NUL 令普通文本检查点把它标为不可恢复。`src/main/engine/checkpoint.ts` 持久化并还原二进制快照；修改文件卡片列出文件，但不生成逐行 diff。

还原前尝试释放 OfficeCLI 常驻文档，避免旧内存副本稍后落盘覆盖已恢复文件。命令识别只覆盖可识别的调用，不能承诺任意脚本、间接调用或 watch 页内编辑都有检查点；二进制快照也受捕获大小限制。

## 6. 远程边界与运行风险

### SSH、手机与远程边界

桌面和 SSH Agent 在中立调用表注册同一套 Office 方法，分别见 `src/main/ipc/desktop-handlers.ts` 与 `src/agent/handlers.ts`。网关在 `src/main/remote/gateway.ts` 按路径或会话路由渲染请求，并为远程产物路径加主机作用域，HTML 通过媒体代理返回。

手机客户端已通过 `apps/mobile/lib/chat/file_transfer.dart` 调用 office:render，由 `apps/mobile/lib/chat/file_sheet.dart` 将主机生成的 HTML 放进 WebView；不在手机打包 OfficeCLI，也没有远程 live 端口转发。

| 方法/事件 | 远程边界 |
| --- | --- |
| `office:render` | 允许，主机生成静态页面 |
| `office:selection` | 允许，读取主机现有预览选中内容 |
| `office:watch-start` / `office:watch-stop` | 拒绝，回环 URL 只属于宿主 |
| `workspace:open-external` | 拒绝，系统应用属于宿主桌面 |
| `office:watch-state` | 宿主预览状态推送，远程事件表分类处理 |

方法分类见 `src/shared/remote-policy.ts`，事件分类见 `src/shared/remote-events.ts`。静态页面使用 `src/shared/media-preview.ts` 的 CSP 与媒体协议，不能信任远程主机返回的头来放宽页面权限。

### 仍需保留的运行风险

以下是原调研留下的实机验证项或能力限制，源码接入不等于这些场景已经验证通过：

- **用户目录例外**：配置、缓存和插件路径固定在 `~/.officecli`，STATE_DIR 不能全部迁走。关闭更新后通常不写 config，但 Mermaid 缓存仍可能出现；不通过改 HOME 规避。
- **PATH 顺序**：用户非登录 shell 启动文件仍可能重新排列 PATH。实机可用 `command -v officecli` 核对实际执行版本。
- **跨进程通信**：bash 中的 selected / mark / goto 需以同一用户、同一 STATE_DIR 找到 Main 的 watch；假进程测试不能代替命名管道实测。
- **网络与离线**：Google Fonts 等请求在部分网络可能挂起、拖慢首屏；公式、3D、Mermaid 离线降级。当前 HTML CSP 允许 https 资源，并不保证这些资源可达。
- **macOS 重签与公证**：electron-builder 会用 FastVibe 的 Developer ID 重签 Mach-O；`resources/entitlements.mac.inherit.plist` 提供 JIT 相关权限。上游资产已公证不能证明重签后的 .NET 单文件程序能运行，仍需真正签名、公证后的安装包验证。
- **Linux ICU**：精简 SSH 镜像可能缺 libicu，导致程序启动失败；不把未经验证的 globalization invariant 重试当作已支持行为，数字与日期格式影响需先实测。
- **体积与升级**：二进制未压缩约 32 MB，每架构 Agent runtime 也增加相近体积。升级会同时改变渲染和技能，需重新检查三种格式、live 选中与修改回退。

## 7. 测试与升级验收

本节是 `scripts/sync-officecli.mjs` 注释与输出所引用的稳定入口（§7）。每次升级二进制后都应重新执行这里的回归与手工验收，核对渲染还原度及 `load_skill` 输出的操作语义；它是持续有效的升级验证要求，不是已完成的实施阶段。

以下是现有回归入口；本次文档维护未运行测试或构建：

- `test/officecli-manifest.test.ts`：目标平台资产、哈希与路径约定。
- `test/office-cli-env.test.ts`：环境变量与内置二进制选择。
- `test/office-render-cache.test.ts`：缓存身份、并发去重与 LRU。
- `test/office-watch.test.ts`：复用、引用计数、端口冲突、超时、文件替换、刷新、退出与选中引用。
- `test/office-command.test.ts`、`test/checkpoint.test.ts`：写命令识别和 Office 二进制回退。
- `test/inline-media.test.ts`：交付格式一致性；`test/server-policy.test.ts`：远程调用分类覆盖。
- `mock.html?pane=files&office=docx|xlsx|pptx|starting|error`：用固定 HTML 查看布局与状态，不验证真实 OfficeCLI。

真实发布验收仍需在目标平台安装包上打开三种文件、生成并展示产物，检查本地实时刷新与选中引用，以及签名、公证、字体网络和精简 Linux 环境。
