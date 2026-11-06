# 工作区、Git、Office 与媒体交付

涉及文件树、预览、Git 变更、OfficeCLI、图片引用、内联产物与 HTML 隔离时阅读。

关联入口：[OfficeCLI 集成与升级验收](../office-officecli.md)、[多文件夹项目](../multi-folder-projects.md)。返回[工程合同索引](README.md) / [文档总索引](../README.md)。

本页承接根 `AGENTS.md` 拆出的详细合同、故障背景和验证资料。反引号中的源码与脚本路径相对仓库根；Markdown 链接相对本文件。历史实测只说明所述环境，不能当作当前性能保证；当前行为以源码、类型和所属功能文档核对。

## File icons

File/folder glyphs come from **vscode-icons** (24.7M installs on the Marketplace, MIT),
**vendored** into `resources/file-icons` and shared by the project file tree, the chat's
per-turn change chips and the inline preview strip.

- The directory is committed, not fetched: `scripts/vendor-file-icons.mjs` is run **by hand**
  and nothing in `predev`/`prebuild`/`stage:app` calls it. A build therefore needs no network
  and two machines cannot quietly draw different glyphs. There is nothing stable to pin on the
  download anyway — the Marketplace re-zips each VSIX per request (three fetches of v13.0.0 came
  back with three hashes), so the script prints a digest over the *icon contents* instead.
  Refresh deliberately: `node scripts/vendor-file-icons.mjs --vsix=<path>`.
- `resources/file-icons/` holds `manifest.json` (FastVibe's own lookup shape), `icons/*.svg`
  (only the 1303 icons the manifest references, 3.4 MB) and `LICENSE.txt`. Main reads it from
  `fileIconsResourceDir()` — packaged `process.resourcesPath/file-icons`, dev
  `FASTVIBE_RESOURCES_PATH`/`<cwd>/resources` — and serves the SVGs under the private
  `fastvibe-icon://icons/<name>.svg` scheme (registered privileged before app ready,
  `protocol.handle` after). A name with no file behind it falls back to `default_file.svg`, and
  `electron-builder.yml` ships the directory through `extraResources`.
- **The manifest must fold `languageIds`, and that is the non-obvious part.** vscode-icons maps
  most file types by VS Code *language id* (599 extensions, 1923 file names, but 558 language ids —
  `.ts`, `.py` and `.md` are all language-only), and FastVibe resolves icons from a file name with
  no language service in sight. `scripts/lib/file-icons-normalize.mjs` folds those ids back onto
  their extensions via `LANGUAGE_EXTENSIONS`; an explicit theme mapping always wins, and the id
  that *is* the extension name owns it (`.yaml` is YAML, not Ansible). A forgotten entry degrades
  to a blank page icon silently, so the fold rules, the resolution rules and the shipped manifest
  are all pinned in `test/file-icons.test.ts`. **The long tail is deliberately unmapped** — only
  the languages a code project actually contains are in the table; the rest take the generic glyph.
- **`light` is a second artwork set, not a colour tweak.** vscode-icons ships a `light` block (the
  same maps, different glyphs for light colour themes — a dark-on-white logo has nothing to bite
  into a white row). The vendor script keeps **only the entries that differ** (~480 of 3000, plus
  ~150 extra SVGs), so `manifest.light` is a sparse override. `resolveFileIcon(mapping, name, { light })`
  merges it and falls back per key; `FileIcon` reads `useIsDarkTheme()` (`lib/use-theme.ts`, which
  watches the `data-theme-kind` / `dark` attributes `applyTheme` already writes, one observer for
  the whole tree) and passes `light: !dark`. vscode-icons' *default* file/folder glyphs have an
  empty `iconPath` in the light block, so there is no light default — the base one is used for both.
- `workspace:file-icons` hands the renderer the lookup table once
  (`src/renderer/src/lib/file-icons.ts`, cached module-wide). The name→icon rules live in
  `@shared/file-icons` (`resolveFileIcon`, `fileIconUrl`) — pure, no React, so the tests can reach
  them; `components/file-icon.tsx` composes the hook with them. Add `fastvibe-icon:` to the desktop
  CSP `img-src` when a new surface loads these icons.
- The mock harness imports the committed manifest with `?raw` and derives the icon directory from
  one `?url&no-inline` asset, so `fastvibe-icon://` URLs are rewritten to what the dev server can
  actually answer (`src/renderer/src/mock/preview.ts`).
- The right pane's **文件** tab (`components/layout/side-pane-files.tsx`) is the
  consumer: a lazily-loaded project tree (`workspace:read-dir`, hiding `.git` and
  `node_modules`). Narrow panes swap between the tree and the open file; when
  the pane is wide enough (`@min-[32rem]/files`) the tree stays on the left and
  the file on the right. The project directory is not a row — the tree starts at
  its children — and the tree is always there: its column keeps the width the
  splitter was dragged to (224px by default, 120px minimum, at most 75% of the
  pane), and there is no way to collapse it away. The 展开文件树 / 收起文件树
  strings still exist for the 变更视图's own list column.
  A narrow pane swaps the two instead. Text that is the file itself (code, Markdown, HTML,
  diff) can be edited there and saved with `workspace:write-file`; a rendered
  office document, image, or other binary stays view-only, because writing it
  back would replace the original. Clicking a file anywhere in a conversation
  routes through `openPreview` → `openFilePreview`, so it opens in this same
  view rather than a separate tab.

## 文件树的增删改

树的右键菜单除了预览与复制路径，还能新建文件 / 新建文件夹、重命名、删除
（`components/layout/file-tree-dialogs.tsx` 一个名称输入框 + 一个删除确认）。三个方法
（`workspace:create-entry` / `rename-entry` / `delete-entry`）的实现全在
`src/main/engine/workspace-fs.ts`，桌面端与 SSH Agent 注册同一份，所以远程项目的树也能改自己那台机器上的文件。

- **每个调用都带 `cwd`，而它不是装饰：它就是边界。** 引擎要求目标在该项目根之内，**并且把
  中间目录过一遍 `realpath`**：词法检查不解析符号链接，一个项目内的链接目录就是通往项目外的门
  （树不列链接，所以只有构造调用会走到这一步）。项目目录本身永远不是重命名或删除的对象（否则
  面板会剩下一棵它已经没有的项目树）；名字必须是一段（含分隔符直接拒绝，不去拆成路径）；
  `.git` 按**每一段**、大小写无关地拒绝（`<cwd>/.git/objects` 与 `<cwd>/.GIT` 都是仓库）。
  规则在 `test/workspace-fs.test.ts` 里逐条钉住。
- **重命名不会顶掉目标。** `renameSync` 是覆盖式的，所以文件走 `linkSync` + `unlink`、
  符号链接走 `symlinkSync`（两者在内核里对已存在的目标报 `EEXIST`），把“检查”和“动手”合为一件事；
  目录与不允许硬链接的卷只能退回先查后改，那个窗口写在注释里而不是被藏起来。
  大小写不敏感的 APFS/NTFS 上 `README.md` → `readme.md` 与自身“碰撞”，但改大小写止是为了改它，
  所以同一路径（忽略大小写）直接当普通重命名放行。
- **桌面端删除走废纸篓，无头的 Agent 没有废纸篓。** 桌面 handler 传一个 `trash`
  （`shell.trashItem`），删除因此可恢复；`trash` 失败就报出来（确认框里用破坏色列出原因），
  **绝不**顺手改成永久删除——用户点的是「删除」，期待的是还能拿回来。因此确认框的文案按 `remote`
  分开：本机说「会移到废纸篓」，远程主机说「无法恢复」。残留风险：`trashItem` 不回答它到底做了什么，
  Electron 文档写明不支持废纸篓的卷会直接永久删除（`desktop-handlers.ts` 里记着）。
- **改完要把界面带到同一个现场。** 父目录重新读取（`parentOf` 只切最后一个分隔符，不把 `\` 归一成
  `/`——树的 `children` / `expanded` 用的就是宿主自己 `path.join` 出的键，归一了就会写到一个
  永远没人读的键上，界面上旧行还在）；新建的文件直接打开；重命名把**草稿按前缀重新键好**
  （不只是当前打开那一个——留在旧路径上的孤儿草稿会在新文件建到旧名后被打开并保存，覆盖掉真内容）；
  重命名后若当前正看着那个文件，把预览的路径与标题换过去；删除或重命名一个正被预览包含的目录时
  清掉预览。这些判断都读**存活的 tab**（`useSidePaneStore.getState()`）而不是点击那一刻的 `tab`：
  对话框开着的这几秒里，转写点击、资源面板或手机跟随活动会话都能把预览换掉。
- **多文件夹项目**下，列表空白处的右键菜单不提供新建（那块空白属于所有文件夹，而它只能选一个）；
  要新建就右键某个文件夹行，对话框的「位置：」一行始终告诉你会落在哪。
- **远程策略：允许。** 与 `workspace:write-file` 同一个理由（拿到密码的人本来就能让智能体跑命令），
  且每个调用被它自己声明的项目根限住；`server-policy.test.ts` 的覆盖检查仍会漏分类时报错。
  网关的 `scopePathField` 也认这两个返回 `{ path }` 的方法，所以远程新建/重命名回来的路径带着
  `remote:<server>:` 前缀，和列表里其他行一样可用。
- **第一层缩进要多走一步。** 多文件夹项目的根是一行带底色和展开箭头的卡片，它的图标被箭头顶右；
  子行没有箭头，于是整棵树会挂在父图标的左边（看起来像缩进坏了）。`.chat-tree-card` 因此把
  `--tree-root-indent` 设成 1.125rem（普通一步 0.75rem），只加在 `guides` 的**第一个** slot 上，
  更深各层照旧一步 0.75rem；单文件夹项目没有这张卡片，`var()` 回退到普通步长，缩进不变。
  两个数按**图标中心**对齐（卡片画 1rem，行画 0.875rem），不是按左边缘。
- 预览：`mock.html?pane=files`（`mock/preview.ts` 里那三个 stub 把改动记在内存的树覆盖层上，
  重命名会真的移动一行）；`&folders=2` 给预览项目加第二个文件夹，才会画出上面那张根卡片。

## 预览失败要说人话

文件打不开时，界面上曾经是 `statSync` 的原话：一行红色的 `ENOENT: no such file or directory, stat
'/Users/…/DESIGN.md'`。那是给调试路径的人看的，不是给刚点了一下文件名的人看的——它既没说发生了
什么，也没说能怎么办。

- **判断只在 `readFilePreview` 里做一次**（`engine/file-preview.ts` 的 `previewFailure`），桌面与
  SSH Agent 注册同一份，所以手机那类只显示文本的客户端拿到的 `message` 也已经是人话。错误种类是
  `FilePreview` 里 `kind: "error"` 的 `reason`（`missing | permission | not-a-file | unknown`），
  **必填**：新增产出方必须选一个，不能把 errno 直接丢给界面。
- **`detail` 是原话，`message` 是结论。** 渲染层按 `reason` 画空状态（图标 + 一句结论 + 一句解释 +
  路径 + 出路），只有 `unknown`——没有任何种类能描述它——才把宿主那句话当正文显示。
- **出路要按「还成立吗」给。** 文件没了，「在文件夹中显示」就不能指向那个文件，所以 `directory` 是
  它本该在的目录（`not-a-file` 时是它自己）；`workspace.reveal` 对不存在的路径返回
  `{ok:false,reason:"missing"}`，界面据此提示。`remote:` 路径不给这两个按钮：那台机器上没有访达。
- **`reason` 由 errno 推，不靠文案**（`ENOENT`/`ENOTDIR` → missing，`EACCES`/`EPERM` → permission，
  `EISDIR` → not-a-file）；`test/file-preview-failure.test.ts` 钉住这一点，并断言结论里**不含** errno。
- 预览：`mock.html?pane=files&preview=missing|permission|folder|unknown`。

## 变更视图

`side-pane-git.tsx` 同时展示冲突、已暂存和未暂存文件，选择项包含路径和 diff 来源；同一文件可同时在暂存区和工作区。聊天里每轮的「已修改 N 个文件」卡片（`chat/file-chips.tsx`）是该轮工具自己的 patch，点击它（卡片上的文件行或「查看变更」）打开的是这个变更视图，不再是独立的修改记录面板；路径以绝对形式交给 `openGitDiff`，由 `selectGitChange` 落到真正包含它的分组（未暂存/已暂存/冲突），文件已提交或已回退时退回工作区的第一个改动。
列表与目录树复用 `git-change-list.tsx`：`git-change-tree.ts` 只压缩单子目录链，分叉保留；行布局为文件名、固定操作槽、状态列，方向键和右键操作与点击一致。右上角仅保留列表/目录树切换（ListIcon / FolderTreeIcon），不显示文件筛选和全部折叠。历史列表在 `git-history.tsx`，与文件区之间可拖动调整高度。提交区由 `git-commit-form.tsx` 组成：输入框右侧 AI 生成、提交分体按钮，菜单仅保留「提交」和「提交并推送」。有改动且无冲突即可直接提交，Cmd/Ctrl+Enter 同样执行；多行草稿在切换仓库时保留。两个操作与聊天顶部提交入口共用 `performGitCommit`：先暂存仓库全部改动，输入为空时基于 index 自动生成提交信息，再提交，唯一区别是是否追加推送。手动 AI 生成读取所有改动；生成期间输入框显示「正在生成提交信息…」，生成按钮显示 Spinner，失败保留原草稿。**提交信息一律英文，与 AI 偏好语言无关**：AI 偏好语言决定的是对话里怎么对读者说话，而提交信息是仓库历史的一行，git log、CI 和同事都在读；它曾经跟随 `FASTVIBE_AI_LANGUAGE_PROMPT`，于是中文安装上的 `git log` 是中文。两段提示词（分组摘要、最终 subject）因此收在 `engine/commit-message.ts` 的 `buildCommitGroupSummaryPrompt` / `buildCommitSubjectPrompt` 里并写明英文，`generateCommitMessage` 不再拼语言指令——分组摘要也要英文，因为分片模式下它是最终请求唯一的证据。`test/commit-message.test.ts` 钉住这两段里既有 `in English`、又没有 `Language requirement`。提交成功即清空已提交草稿并刷新，后续推送失败单独报告。桌面与 SSH 共用 `commitGitChanges`（底层仍只提交 index）并都注册 AI 生成方法；保留独立的 `workspace:git-amend` 兼容已有调用。
`DiffView` 仍是唯一 diff 渲染器，默认统一（合并）视图，按用户操作切换并排，支持换行和 hunk 跳转；并排列只配对同一变更块内的增删行。变更视图加载后自动选中冲突/未暂存/已暂存文件，刷新和暂存尽量保留当前路径；目录与文件面板采用相同的宽度规则：默认 224px，最小 120px，最多占面板的 75%，复用标准 SplitHandle 拖动调宽，不因拖窄自动收起。有独立收起/展开按钮；所有宽度都在变更面板内与 diff 并排展示，不使用抽屉，也不按面板宽度自动收起。diff 始终保持挂载，不能以目录/差异两级视图互相替换；目录收起/展开不重置历史分支筛选。

- 每轮改动卡片的形状：头部只占一行（「已修改 N 个文件」+ 合计 + 展开箭头 + 右侧「查看变更」），**不再画 32px 图标底块或两行堆叠**——下面每一行都已经带文件图标，头部再放一个是重复，而且它把卡片顶得比内容还高。文件行是 `FileIcon` + 文件名 + 灰色目录 + 增删数，与 `git-change-list.tsx` 的列表行同一套切分（`splitLabel`）：名字认文件，目录只说明它在哪；没有目录的标签整段当名字，不截断。
- **列表默认五行高，超出在卡片内滚动**（`max-h-40`，rem 所以跟着「界面字号」走；一行是 `py-1.5` + `text-sm` 的 2rem）。原来的「再显示 N 个文件」连同 `files.more` / `files.collapse` 一起删了：头部已经能整卡收起，列表里再套一层折叠就是两个上限干同一件事，而且四十个文件的回合会把这条回复顶出屏幕。
- **滚动条贴卡片右边，不飘在行尾。** 滚动条画在滚动元素的 border box 上，所以内边距必须落在滚动盒**里面**：`pb-1.5` 在外、`max-h-40 overflow-y-auto` 再包一层 `px-1.5`，行和数字的位置一个像素都没动（滚动条仍然从内容盒里拿那 11px），但条子贴到了卡片的框上。以前 `px-1.5` 在外，条子离右边还有 6px，看起来像行尾中间浮着一根。底边距留在外面是另一件事：放进去它就成了可滚动内容，五行文件会被裁掉第五行。
- 预览：`mock.html?chips=many`（十三个文件，才会出现那根条——其它 fixture 一个回合最多写两个文件）。
- `main/source-control.ts` 是桌面和 SSH Agent 共用的 Git 实现。新方法通过中立调用表和远程策略注册：`workspace:git-comparison`、`workspace:git-history`；`git-diff` 的可选 `revision` 只接受完整 commit hash。
- 分支文件列表和 patch 使用同一个 upstream merge base；历史支持当前分支与全部分支，以拓扑顺序读取完整 parents，`git-graph.ts` 按真实父哈希分配和合并色道；根提交不得画向无关历史的线。HEAD、本地/远端分支和标签按 `for-each-ref` 的结构化元数据展示；分页固定初次读取的 tip hashes，避免新提交造成跳页。点击提交自动打开首个文件，显示作者、时间、提交正文及标签；合并提交默认对比第一父提交，根提交对比空树。
- Git 路径按 literal pathspec 传递，不 trim 文件名。未跟踪文件用 `diff --no-index` 读取，只有退出码 1 表示成功生成差异，其它失败必须显示。
- 丢弃工作区修改恢复到 **index**，保留部分暂存的内容；删除未跟踪文件先由界面确认，只 unlink 状态中列出的文件，不能递归删除目录。取消暂存重命名要同时处理源路径和目标路径；未首次提交的仓库用 `rm --cached` 保留工作文件。
- 切仓库和卸载后丢弃迟到的读取结果；刷新也重读已选文件的 diff。历史 commit 是不可变的，工作区轮询不应重置历史分页。
- 验证：`test/source-control.test.ts` 使用临时真实仓库覆盖新文件、部分暂存、重命名、根提交、分支和子目录；`test/diff.test.ts` 覆盖并排对齐和 hunk 内伪装成文件头的代码行；`test/git-change-selection.test.ts` 覆盖每轮改动 chips 给的绝对路径能落到真正包含它的分组。`test/git-change-tree.test.ts` 和 `test/git-graph.test.ts` 覆盖紧凑目录和真实拓扑；`mock.html?pane=git&git=large&maximize=1&lang=zh` 提供百文件与分叉/合并预览。

## Office 预览（OfficeCLI）

Word / Excel / PowerPoint 的预览和智能体编辑都走随安装包发布的 OfficeCLI，不下载、不装进用户的 PATH。
版本和每个平台的 SHA256 写在 `scripts/officecli.json`；`scripts/fetch-officecli.mjs` 在 `predev` 和打包前按清单取二进制，校验的是仓库里的哈希，不信任下载旁边的 `SHA256SUMS`。打包只带当前架构那一份（`extraResources` 的 `${os}-${arch}`），`afterPack` 缺二进制或版本不符就让构建失败。

- **环境。** `applyOfficeCliEnv()` 在两个入口、任何会话和终端 fork 之前调用：把二进制目录加到 PATH 最前，并设 `OFFICECLI_SKIP_UPDATE=1`、`OFFICECLI_NO_AUTO_INSTALL=1`、`OFFICECLI_RESIDENT_FLUSH=each`、`OFFICECLI_STATE_DIR=runtime/engine/officecli-state`。没有二进制就不写这些变量，以免改到用户自己装的那份。
- **预览。** `readFilePreview` 对 docx / xlsx / pptx 只返回 `{ kind: "office" }`，不再 `unzip`、不再抽纯文本。渲染是 `office:render`：`officecli view <file> html -o <缓存>`，缓存键是 realpath、mtime、size 和 OfficeCLI 版本，目录 `runtime/engine/office-preview/`，按总大小 LRU。页面走 `fastvibe-media://`，iframe `sandbox="allow-scripts"`，和 HTML 预览同一条 CSP。doc / xls / ppt、odt / ods / odp、docm / xlsm / pptm 是 `unsupported`，提供「用系统应用打开」（`workspace:open-external`，远程拒绝：它开的是这台电脑上的应用）。csv / tsv 仍是表格，按 RFC 4180 解析。
- **技能。** 内置技能叫 `office`，不叫 `officecli`：用户目录里的同名技能会静默遮蔽，而 `officecli install` 写的就是 `~/.agents/skills/officecli`。正文只规定加载哪一个 `load_skill`（v1.0.157 没有名为 `officecli` 的技能；通用规则用 `officecli help <format>`），并禁止 install / mcp / 自己起 watch。交付用 `present`，它接受这三种扩展名。
- **`~/.officecli`。** 配置、缓存、插件的路径写死在用户目录，只能靠改 HOME 规避。关掉自更新后它基本不写 `config.json`；Mermaid 缓存仍可能出现。接受这个例外。
- **实时预览。** 侧栏里打开的本地 Office 文件走 `office:watch-start`（`officecli watch --port`），两个窗口共用一个进程，最后一个引用释放后延迟几秒再停，退出应用时全部杀掉。外部改动经防抖后 `POST /api/switch` 刷新。页面用 iframe，`sandbox="allow-scripts allow-same-origin"`：没有 `allow-same-origin` 时 Origin 是 `null`，选中上报会被拒；页面源是 `127.0.0.1`，和窗口不是同一个源，进不了应用。CSP 的 `frame-src` 因此放行 `http://127.0.0.1:*`。远程客户端拿不到这个地址，`office:watch-start` / `office:watch-stop` 拒绝远程调用。启动失败可以重试，或退回静态快照。
- **引用选中。** docx / pptx 的实时预览标题栏有「引用选中内容」，走 `office:selection`（`officecli get <file> selected --json`），把文件名、稳定的 `@id=` 路径和一小段文字放进输入框。xlsx 没有元素路径，不显示这个按钮。技能里写明：文件没在侧栏实时预览里打开时不要用 `watch goto` / `watch mark`。
- **写命令。** `tool_execution_start` 认出 bash 里的 `officecli set/add/remove/batch/merge…`，在命令跑之前对目标文件做二进制快照（zip 含 NUL，文本快照会把它当成不可回退）。重试按这份字节写回。转写里的「已修改 N 个文件」也列出这些文件，没有逐行 diff。
- **远程。** `scripts/build-agent-runtime.mjs` 把对应 linux 架构的二进制打进 `resources/officecli/`（缺了就拒绝打包）。`office:render` 已按路径路由到那台主机，HTML 经媒体代理回来。实时 watch 仍只在本机侧栏。
- **实时预览不让人干等。** `officecli watch` 起来要 1–3 s，期间窗格是空的。`OfficeFrame` 同时要静态渲染（有缓存，
  约 0.5 s 或更快），先显示它，live 页面就绪后替换；watch 一直起不来时静态页就留着，只有两者都没有才报错。
  iframe 的 sandbox 跟着**实际加载的页面**走（`liveReady`），不是跟着「要求了 live」——静态页不该拿到 `allow-same-origin`。
- **手机。** 打开 docx / xlsx / pptx 时调用 `office:render`，把主机渲染的 HTML 放进 WebView。见 `docs/office-officecli.md`。

## 会话内联预览（图片 / 视频 / HTML / Office，`shared/inline-media.ts`）

回复里产生的可看的东西直接画在转写里，而不是只给一个路径。预览来自 `present` 工具（模型明说“展示这个”）、
能识别为生成/编辑操作的工具返回的图片块（MCP 生图直接返回图，没有文件），以及 `write` 写出的图片/HTML。
**不从普通文本输出猜产物路径**：`bash` / MCP / `codemode` 输出中的路径、链接甚至“saved to”都可能来自读取旧日志；
仅返回路径的工具、脚本和用途不明的工具要用独立的 `present` 调用明确展示交付物。

- **纯函数、只靠转写重算。** `collectInlinePreviews(tools, resolve)` 只看 `ToolCallBlock`（参数、结果、`details`、
  `images`），不读磁盘，所以刷新、切会话、手机重连画出来的和流式时一样。只处理 `status === "done"` 的非嵌套调用，
  半写的 HTML 不会闪。同一个引用只出现一次，每个调用最多 4 个、每条回复最多 12 个。
- **读取素材不是产物。** 图片块按工具操作筛选，识别 MCP 前缀、分隔符和 camelCase；读取、查看、搜索、截图及
  用途不明的工具不自动展示。MCP bridge 在 `details.mcp` 保存原始 `toolName` 和 `readOnlyHint`，避免服务器名干扰
  判断；明确只读优先排除，旧转写回退到完整工具名。`codemode` 只有整批调用均成功且均可识别为产物操作才自动
  展示图片；混合读取和生成时图片缺少逐张来源，必须用独立 `present` 选择产物。明确要求展示的文件允许是已有素材。
- **转写里存的是图片的引用，不是字节**（`shared/tool-image-ref.ts`）。一个截了 271 张图的会话，转写 82 MB、
  96% 是 base64，每次打开都要解析、会话常驻 84 MB 内存、每次请求还要整份 `structuredClone`——而模型每次最多只看
  最新的 4 MB。所以 `tool_result` 钩子在缩小之后把**发给模型的那份**写到 `tool-images/<会话>/model/<调用>-<n>.<ext>`，
  内容块换成 `{ type: "text", text: "[image/jpeg tool result, saved at …]", fastvibeImage: { folder, file, mimeType,
  chars, index } }`：`type` 仍是 text，SDK 的压缩、摘要、pi CLI 这些不认识它的读者看到的是一句指向文件的话；
  `context` 钩子请求前把预算内最新的引用读回成图片（`prepareRequestToolImages`，`ToolImageReader` 按路径缓存），
  其余换成带路径的说明，文件没了就说「已不可用」。投影（`externalizeToolImages`）把引用画成同序号的原图，退而求其次是
  模型那份，都没有就整块不画；`map-messages` / 两种搜索 / 记忆转写都跳过引用那句话（`isToolImageRef`）。
  - **旧转写在打开时于内存里换成引用**（`referenceStoredToolImages`，在会话由这些条目构建之前），文件不动——SDK
    只追加。第一次打开要把模型那份写出来（82 MB 的会话：271 张、78 ms），之后只是存在性检查；常驻内存 84 → 6 MB。
  - **超过 6M 字符（`MAX_REFERENCED_IMAGE_CHARS`）的图保持内联**：SDK 的规范化跑在钩子之后，只有内联的图它还看得到，
    缩不动的大图得留给它。
  - **分叉时把复制过去的结果的图硬链接进新会话的目录**（`linkToolImages`，不行就复制）。引用先找本会话目录、再找写它的
    目录，所以删掉源会话（连同它的图片目录）不影响分叉。
  - 引用的 `folder` / `file` 在解析时校验（只允许 `model/<名字>.<扩展名>`），手改或导入的转写指不到图片目录之外。
  - 代价：SDK 估算「最后一次回复之后」那几条消息的 token 时，引用按文字算，比图片少——刚返回大量截图、下一次请求之前，
    上下文环和自动压缩的估算会偏低，下一次回复的真实用量会纠正它。
  - 测试：`test/tool-image-refs.test.ts`（引用、预算、分叉、校验），`test/tool-images-session.test.ts`（真实 SDK：
    文件里没有 base64、提供方仍收到图、重开后再发一次、旧转写打开时变轻）。
- **图片落盘，转写只带路径。** MCP 生图直接返回 base64，没有文件。Main 在两处把它存成
  `runtime/engine/tool-images/<会话>/<toolCallId>-<n>.<ext>`（`engine/tool-images.ts`，文件名由调用决定，重复写只是
  一次存在性检查）：转写映射前（`projectSessionMessages`）和实时的 `tool_execution_end` 事件，都把 image 块换成
  `{ type: "image", mimeType, path }`。`toolImagesOf`（`shared/tool-result.ts`）见 `path` 就只带路径，渲染层按路径走
  `fastvibe-media://`；写不了盘的才退回 data URL（单张 12M 字符、一次 4 张封顶）。**不要把图片字节放回转写**：
  每次读转写、每条 IPC、渲染层 store 都会背着几十 MB。删会话时一并删这个目录；手机用的摘要形态仍丢掉它
  （`omitted.images`）。
- **发给模型的图：进入历史时缩一次，请求前只留字节兜底。** SDK 每次请求都把全部历史工具结果（含图）重发，而它自己的
  规范化（`normalizeToolResultImages`：长边 ≤2000px、单张 <4.5MB）只是单张的上限，3.8MB 的图照样放行——一个生了
  26 张图的会话请求体 58MB，网关回 413 / 502 / 超时，换哪个上游都一样。隐藏扩展 `fastvibe-tool-images`：
  - **`tool_result` 钩子**：图一到就把**原图存盘**（`tool-images/`，界面显示用），历史里换成缩小的副本
    （`shrinkToolResultImages`；SDK 导出的 `resizeImage`，Photon 跑在 worker 线程，不卡主线程；长边 1568、512KB
    以内，生成图基本变成 JPEG，实测 3.8MB → 233KB）。缩不动或失败就保持原样。此后每次请求、重载、分叉带的都是小图。
    转写里图是 JPEG、原图是 PNG，所以按调用 id + 序号找文件时**不看扩展名**（`findSaved`）。
  - **`context` 钩子**：每次请求前按字节兜底（`prepareRequestToolImages`，`engine/context-images.ts`，内联图和引用共用一个预算），总量超过 4MB
    （base64 字符）就从最旧的开始丢，最新一张总是保留。没有按张数的裁剪：缩小后单张只有几百 KB。
    它保护的是缩小机制出现之前的旧会话（图还是原尺寸）和特别长的会话。被丢的图换成一行说明，**带着落盘路径**
    （没存过就当场存），模型要看就用 `read` 再读；存不了才写「重新生成」。
  - 只改请求与历史里的副本，用户自己附的图不动。**不要把 `ToolCallBlock.images` 换回 data URL**，也不要引
    Electron 的 `nativeImage` 来缩图：引擎层要能在无头 Agent 里跑。
- **HTML 走独立文档，不走 `srcdoc`。** `srcdoc` 框架会继承应用的 CSP（`script-src 'self'`），脚本永远跑不起来。
  所以 `fastvibe-media://` 也能服务本地 `.html`（`authorizeMediaMime`：请求名和真实路径必须同属“页面”或同属
  “媒体”，不能用 `.png` 符号链接去读页面）；`media-protocol.ts` 对 `text/html` 响应**自己**加
  `INLINE_HTML_CSP`（只允许内联代码和 https 资源，不能读本地文件、不能提交表单），远程主机来的页面也一样，
  不信上游的头。框架是 `sandbox="allow-scripts"`，**没有** `allow-same-origin`：无存储、无 cookie、碰不到应用。
  想收紧就改 `INLINE_HTML_CSP` 这一个常量。https 链接只展示图片和视频，不当页面开。
- **`present`（`resources/extensions/present.ts`）只校验、不搬运。** 路径相对工作目录解析，要求文件存在且类型
  可展示；https 链接必须以图片/视频扩展名结尾；不收 data URL（让模型把 base64 写进参数是浪费 token）。结果
  `details.items` 记下 `{ref, title, ok, error}`，渲染层只画 `ok` 的。扩展不能 import `@shared`，所以扩展名
  清单在两处各一份，`test/inline-media.test.ts` 把它们对齐。
- **工具产物预览只画名字。** 工具预览是行内文件名（图标 + 名字，和路径链接同一个观感；一次调用的多项同一行换行排列）。工具产生的预览随工具一起进入「用时 …」，并通过 `InlineThumbStrip` 在折叠标题右侧汇总入口（最多三个，超出显示更多）；入口是折叠触发器的兄弟，点击预览不切换折叠。最终回复区保留正文及正文里的 Markdown 图片。点击标题右侧入口或展开过程后的文件名都打开**查看器**（`Viewer`）：全窗口深色遮罩，一次一项，图片 / 视频 / HTML 都支持，底部「‹ 第 i 项，共 n 项 ›」，← / → 在**同一批**里切换，左下是名字，右上是「在侧栏中打开」和 ⋮（在文件夹中显示 / 复制路径或链接 / 在浏览器中打开）与关闭。点遮罩空白处也关。猜出来的本地路径用 `filesExist` 核对，不存在就不画名字（`useMissingGuesses`）；明确要求展示的不核对，打不开时查看器里写「无法加载」。
- **位置。** 预览紧跟产生它的工具卡，随运行过程一起折叠；最终回复区保留最后输出的正文，不额外提取智能体操作或工具产物。文件变更卡片在本轮结束后统一放在最终回复正文末尾、操作栏之前，独立于运行过程折叠。
  `shared/media-preview.ts` 不能用 `node:path`：渲染层也 import 它，浏览器构建里 `extname`
  是 `undefined`，第一次展示文件就会抛。
- **Markdown 图片直接内嵌显示。** `MarkdownView` 的 `![]()` 与清洗后的 HTML `<img>` 共用图片组件：保持比例、不超过容器宽度，最大高度 `20rem`，小图不放大，并保留 `alt` / `title` / `width` / `height`。不强加边框或圆角，徽章可以同行、`align="center"` 可继续居中。绝对路径、`file://`、相对路径仍按会话目录解析并经 `inlineSrc` 转成媒体 URL；HTTPS/data 图片直接加载。视频、HTML 和 Office 引用继续显示文件名入口，点击后在查看器中打开。`react-markdown` 默认会丢掉 `file:` / `data:`，所以 `urlTransform` 放行 `file://`、`data:image|video` 和路径链接插件的 `fvpath:`；清洗白名单和 CSP 不变。
- **预览**：`mock.html?pane=files&preview=markdown` 可检查徽章、HTML 指定宽度和大图的尺寸；`mock.html?inline=1` 同时展示正文图片与工具产物入口（浏览器里没有 `fastvibe-media://`，HTML 框架是空的，只能看版式）；`mock.html?inline=office` 可展开「用时」查看文档产物。

## Git 状态轮询（`lib/use-git-status.ts`）

输入框的分支标签、资源面板、文件树和 Git 面板读的是同一份状态。它们以前各有一个定时器，而且每个定时器都
`force` 绕过缓存——同一个工作区上 N 个界面就是每拍 N 轮 `git status` + `git diff --numstat`，慢调用日志里
`workspace:git-status` 成对出现（78 次、平均 714 ms，同样的命令在本仓库 50 ms、在 1.6 万文件的仓库 150–230 ms，
多出来的是并发）。现在**每个工作区一个轮询**（`subscribeGitStatus`）：第一个订阅者起拍，后来者加入，
最后一个离开就停；退避（相同结果翻倍到 60 s）、隐藏窗口暂停、窗口聚焦/可见时立即读一次，都只有一份。
`useGitStatus` 的 `refreshKey` 翻转（一轮结束）走 `refreshGitStatus` 强制读；Git 面板只在**签名变了**
才 `setEpoch`（那会重读选中的 diff 和历史），其余时候收到同样的状态什么也不做。
