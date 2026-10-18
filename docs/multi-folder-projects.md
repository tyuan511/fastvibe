# 多文件夹项目

状态：已按本方案实现。设主文件夹会换项目主键，只对新会话生效；文件树是多根分组，不是合并视图。

## 目标

一个项目可以挂多个文件夹（同一个产品分散在几个仓库里的常见情况），行为参照 Codex：

- 创建项目时选一个或多个文件夹，**第一个是主文件夹**；项目名留空时取第一个文件夹名。
- 之后可以增删文件夹、把任意一个设为主文件夹。
- agent 能感知项目的所有文件夹，也能读写它们。
- Git 面板按文件夹区分仓库，每个仓库独立看状态、分支、提交。

## 现状（已读代码）

- `Project`（`src/shared/types.ts`）以 `cwd` 为主键，另有 `name` 等字段；`Conversation.project === Project.cwd`。
- `ConversationCatalog.ensureProject(cwd)` 按 `cwd` 去重。`projects:add` 弹原生选择框，一次只选一个目录，直接建项目。
- 现有 `AddProjectDialog`（`components/add-project-dialog.tsx`）是浏览 SSH 远程主机目录的，不是本地创建项目的弹窗。
- 一个会话只有一个工作目录：`#createSession(conversation, cwd, …)` 把 `cwd` 同时交给 `SettingsManager`、`DefaultResourceLoader` 和 `createAgentSession`。
- Git 的 IPC（`workspace:git-status|branches|checkout|stage|commit|pull|push|diff…`）**每次调用都带 `cwd`**，后端本身不绑定项目。绑定发生在渲染层：`SidePaneGit` / `SidePaneFiles` 各自接收一个 `cwd`。
- `checkpoint.ts` 的检查点带单个 `cwd`，用 `git -C cwd rev-parse HEAD` 记基线、`git -C checkpoint.cwd checkout <head> -- <paths>` 还原。
- 内置扩展可在 `before_agent_start` 里追加系统提示（`output-language.ts`）。委派的子 agent 不加载扩展，靠 `appendSystemPrompt` 补（`process-manager-subagent.ts`）。
- `folder-consent.ts` 在 `tool_call` 前用主线程 stat 工具要碰的目录，以便 macOS 的受保护文件夹弹窗能被系统记住。

## 设计

### 1. 数据模型

```ts
type Project = {
  cwd: string;          // 主文件夹，仍是项目主键
  folders?: string[];   // 其余文件夹，有序，绝对路径；缺省 = 单文件夹项目
  name: string;
  …
};
```

- 「第一个是主文件夹」在存储里就是 `cwd`；界面上把 `[cwd, ...folders]` 画成一个列表，第一行带「主」标记。
- 旧的 `conversations.json` 没有 `folders`，读作单文件夹，不需要迁移。降级到旧版本时多出的字段被忽略。
- 校验：必须是已存在的目录；按规范化路径精确去重（嵌套目录允许，不拦）；同一个目录可以同时出现在不同项目里。
- **远程（SSH）项目本期不支持附加文件夹**，相关方法对 `kind: "remote"` 的项目直接拒绝。

### 2. 设为主文件夹

选择「主文件夹」等于换项目主键，选的是改动最小的做法，不新引入项目 id：

1. 旧 `cwd` 降级插到 `folders` 头部，选中的文件夹从 `folders` 取出作为新 `cwd`。
2. 所有 `conversation.project === 旧 cwd` 的会话改指新 `cwd`。
3. 项目名若等于旧主文件夹的 basename（即用户没手改过），跟随改成新主文件夹的 basename。
4. **已有会话的 `conversation.cwd` 与 session 文件里的 cwd 不动**，只有新建的会话用新主文件夹。

后果与风险：

- 凡是用项目 `cwd` 当键的持久化数据都要随之改键。**实现时确认**并逐一处理：项目的模型默认值（`ProjectModelDefault`）、侧栏项目的折叠/排序状态、归档与置顶里可能存在的项目键、`remote/gateway.ts` 的 `bindingProjectKey`。
- 如果核对后发现涉及面过大，退路是给 `Project` 加稳定的 `id`，`cwd` 只作展示与默认工作目录。这是更干净的做法，代价是一次目录迁移，因此不作为首选。

### 3. Agent 感知与读写

新增隐藏扩展 `fastvibe-project-folders`，注册在 `#createSession` 的 `extensionFactories` 里，闭包持有 `conversation.id`。

- 每轮 `before_agent_start` 读一次 catalog，往系统提示里追加一段（约 10 行），内容由一个纯函数 `buildProjectFoldersPrompt()` 生成：
  - 当前工作目录（会话的 `ctx.cwd`）。
  - 项目的其余文件夹，每个一行：绝对路径、是否是 git 仓库、当前分支。
  - 说明：这些目录都可以读写；访问非工作目录要用绝对路径；不同文件夹是不同的仓库，提交要分别在各自仓库里做。
- **以会话 `cwd` 为准，而不是项目的主文件夹**：设为主文件夹后，旧会话的 `cwd` 可能已经不是项目主文件夹。列表取 `[project.cwd, ...folders]` 去掉等于 `ctx.cwd` 的那一项。
- 只有一个文件夹的项目不追加任何内容，行为与现在完全一致。
- 每轮重新读取，所以在设置里增删文件夹，下一条消息就生效，不用重建会话。
- 不用环境变量传递：`process.env` 是全进程共享，会串会话。
- 子 agent 与 DAG 节点不加载扩展，需要在 `process-manager-subagent.ts` 里用同一个函数生成文本，走 `appendSystemPrompt`。
- 读写能力不需要改工具：`read` / `edit` / `write` / `bash` 本来就接受绝对路径，FastVibe 没有路径沙箱，也不做审批。
- macOS 受保护目录（桌面、文稿等）：**添加文件夹时**由主线程 stat 一次，让系统弹窗出现在用户刚选完的时刻，而不是 agent 第一次访问时。`folder-consent` 对工具入参里的路径照旧处理。
- worktree 隔离的会话只隔离主文件夹；其余文件夹仍是真实目录，提示里要如实写出。

### 4. Git 按文件夹区分仓库

Git 的 IPC 已经是「每次调用带 `cwd`」，后端不用改协议，要改的是渲染层怎么选 `cwd`，以及怎么把文件夹归并成仓库。

- 新增主进程函数 `resolveProjectRepos(folders)`：对每个文件夹跑 `git -C <dir> rev-parse --show-toplevel`，得到 `{ folder, root | null }`。
- **按仓库根去重**：两个文件夹落在同一个仓库里（比如 `repo/` 和 `repo/packages/a`），只出一个仓库条目，否则同一份改动会被数两遍。条目里记下它覆盖了哪些文件夹。
- 不是 git 仓库的文件夹不进仓库列表，但仍在文件树里出现；Git 面板对它显示「不是 Git 仓库」。
- Git 面板（`SidePaneGit`）顶部加仓库选择器，仅当仓库数 ≥ 2 时出现；只有一个仓库时界面与现在一致。选项显示文件夹名，并附带分支和未提交文件数的小标记，让用户不用逐个点开就知道哪个仓库有改动。
- 选择器的状态按会话保存在渲染层，默认选会话 `cwd` 所在的仓库；切换后面板里的 status / diff / stage / commit / push / pull / 切分支都用所选仓库的根作为 `cwd`，这些调用本身不需要改。
- 聊天里每轮的改动 chips（`chat/file-chips.tsx`）把文件路径相对 `cwd` 显示，点开进的是 `SidePaneGit`（不再有独立的「本轮改动」面板）。多文件夹时，落在其他文件夹里的文件要显示成「文件夹名/相对路径」，否则两个仓库里同名的 `README.md` 无法区分；点开时 `openGitDiff` 带的 `cwd` 仍是会话文件夹，所以落在其他仓库的文件会在当前仓库里找不到，需要用户自己切仓库。
- 提交信息生成（`commit-message`）和分支操作同样以所选仓库的根为单位，不跨仓库合并。
- **实现时确认**：`side-pane.tsx` 里 `cwd` 是怎么从会话或项目推出来的，以及 `SidePaneGit` 里 `readGitStatus(cwd, true)` 的缓存键是否只按 `cwd`；若是，选择器切换时缓存天然隔离，不需要改。

### 5. 检查点与「重试这一轮」回退

这是多文件夹里最容易静默出错的地方，单独写出来。

- 现状：检查点只带一个 `cwd`，基线是 `git -C cwd rev-parse HEAD`，还原是 `git -C checkpoint.cwd checkout <head> -- <paths>`。agent 一旦写了别的文件夹里的文件，这套逻辑会拿主文件夹的 HEAD 去还原另一个仓库的路径，要么失败、要么还原错。
- 方案：捕获时把本轮写过的文件**按所属仓库根分组**，每组各记一份 `{ root, head, files }`；还原时按组各自执行。基线 HEAD 的缓存键本来就是 `cwd`，改成仓库根即可。
- 写在任何仓库之外的文件（没有 `.git`）沿用现有「没有可回退内容」的处理，进 `skipped`，并在回退提示里说出来，保持「回退不全必须说出来」这条已有原则。
- **实现时确认**：`captureCheckpoint` 目前如何把绝对路径转成相对路径、以及 `saveCheckpoints` 的落盘格式；格式变化要兼容旧的持久化文件（旧记录读作只有一组）。

### 6. 创建项目弹窗与管理入口

**创建项目弹窗**（新组件，不复用 `AddProjectDialog`，那个是 SSH 远程目录浏览器）：

- 字段：项目名称（可空）、源文件夹列表、「添加文件夹」行。
- 项目名留空时，占位符和最终取值都是第一个文件夹的 basename，随第一个文件夹变化。用户手输过名称后不再跟随。
- 文件夹列表每行：文件夹图标、basename（悬停显示完整路径）、移除按钮。第一行带「主」标记。
- 「添加文件夹」调用原生选择框，选完追加到列表末尾，已存在的忽略。
- 至少需要一个文件夹才能点「创建项目」。列表允许拖动换序，换序即改主文件夹。
- 弹窗里输入过内容时不因点击外部而关闭，必须点取消或 ✕（沿用 `PermissionDialog` 对输入框的同一约定）。
- 入口：侧栏「添加项目」改为打开此弹窗；原来「选一个目录就直接建」的快捷路径保留给拖入文件夹，避免多一步。

**管理入口**：侧栏项目的 ⋯ 菜单第一项是「编辑」，打开同一个弹窗。新建会话只留在项目行右侧，菜单里不再重复。编辑时可以改项目名和文件夹：

- 列表项增加「设为主文件夹」和「移除」，底部「添加文件夹」。
- 移除主文件夹时必须先指定新的主文件夹；只剩一个文件夹时不能移除。
- 目录已被删除或移走的文件夹照常列出，标红并提示「目录不存在」，不静默丢弃，由用户决定移除。

文案同时进 `locales/zh/app.json` 和 `locales/en/app.json`。设置里的描述只写「做什么」。

### 7. IPC 与远程策略

新方法进中立调用表（`handle()`），同时在桌面 `desktop-handlers.ts` 和无头 Agent `agent/handlers.ts` 注册，并补进 `shared/ipc.ts`、`shared/api.ts`：

| 方法 | 作用 | 远程策略 |
| --- | --- | --- |
| `projects:create` | 带 `{ name?, folders[] }` 创建项目 | 允许 |
| `projects:pick-folder` | 弹原生选择框，只返回路径 | **拒绝**（弹原生对话框会挂起） |
| `projects:add-folder` | 给项目追加一个路径 | 允许 |
| `projects:remove-folder` | 移除一个路径 | 允许 |
| `projects:set-primary` | 把某个路径设为主文件夹 | 允许 |
| `projects:repos` | 返回项目的 git 仓库列表 | 允许 |

- 选择框和「改项目」拆成两个方法，手机端因此仍然能管理文件夹（路径由用户输入或从电脑上已有的列表里选），只是不能触发电脑上的原生对话框。
- `policy.ts` 的覆盖检查要求每个方法都归类，漏分类会让服务器拒绝启动，这是预期的保险。
- 目录变更照旧走 `ConversationCatalog.#flush()` 的 `workspace:changed` 广播，不在各个方法里单独推送。
- `setActive` 无关；项目换主键后，持有旧 `cwd` 的客户端会收到新的快照，需要确认渲染层不会把它当成「项目被删除」。

### 8. 暂不做

- SSH 远程项目的附加文件夹。
- 手机端的管理界面（IPC 已可用，界面后续跟进；手机端看到的是 agent 的行为和 Git 状态）。
- 跨仓库的联合提交、联合分支。每个仓库独立操作，这是有意的。
- 把已有会话的 `cwd` 搬到新主文件夹。
- 为每个文件夹自动建 worktree。
- 文件树里同时展示多个根的合并视图以外的功能。文件树本期画成多个根目录，每个根一个可折叠分组，行为与现在的单根一致。

## 实施步骤

每一步单独可编译、可测试，按顺序提交：

1. 数据与目录：`Project.folders`、catalog 的增删改和设主文件夹（含会话改键），加 `test/` 里的纯逻辑测试。
2. 提示词：`buildProjectFoldersPrompt()`、`fastvibe-project-folders` 扩展、子 agent 的 `appendSystemPrompt`。
3. 仓库解析：`resolveProjectRepos()`，按仓库根去重，补测试（嵌套目录、非仓库目录、符号链接）。
4. 检查点按仓库分组，兼容旧落盘格式，补测试。
5. IPC、策略分类、`api.ts`，跑 `server-policy` 覆盖测试。
6. 渲染层：创建项目弹窗、管理入口、Git 面板的仓库选择器、文件树多根。
7. 文案、`AGENTS.md` 里补一节「多文件夹项目」，`mock.html` 里加预览参数。

## 测试

- 纯模块：`buildProjectFoldersPrompt`（单文件夹不输出、会话 cwd 去重、非仓库标注）；catalog 设主文件夹时会话改键与改名跟随；`resolveProjectRepos` 去重。
- 检查点：两个仓库各写一个文件后回退，各自还原；写在仓库外的文件进 `skipped`。
- 策略：`projects:pick-folder` 在远程被拒绝，其余被允许；覆盖检查通过。
- 手动：创建项目 → 让 agent 同时改两个仓库 → Git 面板切换仓库分别提交 → 设主文件夹 → 新开会话确认工作目录已变。

## 风险

- 设主文件夹换键的涉及面（第 2 节）是最大的不确定项，开工前先枚举所有用项目 `cwd` 当键的地方，再决定是否改用稳定 id。
- 提示词变长会略增每轮 token，所以单文件夹项目完全不追加，多文件夹也只写路径和一行说明，不列目录内容。
- agent 同时改多个仓库时，每轮的改动 chips、变更视图和检查点是否按仓库给出一致的视图，需要在步骤 4、6 里用真实多仓库项目验证，而不是只靠单元测试。

## 待你确认

1. 设主文件夹是否接受「只对新会话生效、旧会话保持原工作目录」。
2. 换键涉及面过大时，是否同意改用稳定项目 id（一次性迁移）。
3. 文件树本期是否可以只做多根分组，不做合并视图。
