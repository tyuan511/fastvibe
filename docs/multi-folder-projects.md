# 多文件夹项目

一个本地项目可以包含多个文件夹。第一个是主文件夹，也是项目的标识和新会话的默认工作目录；其他文件夹有序保存。文件树按多个根分组展示，Git 操作按实际仓库分别执行。

## 数据与项目管理

`src/shared/types.ts` 的 `Project.cwd` 仍是项目主键，`folders?: string[]` 只保存其余文件夹。`src/shared/project-folders.ts` 的 `projectFolderPaths()` 还原主文件夹在前的完整列表；缺少 `folders` 的旧记录就是单文件夹项目。对象保存在 SQLite 的 JSON 数据列中，无需为这个可选字段增加 schema 迁移。

`src/renderer/src/components/project-folders-dialog.tsx` 提供本地项目的创建与编辑，名称留空时使用第一个文件夹的名字。引擎在 `src/main/pi/process-manager.ts` 中校验新增目录确实存在、是目录，并用 `realpathSync` 规范化；主线程的 stat 也让 macOS 能记住受保护目录的系统授权。列表去重，但允许嵌套目录和不同项目引用同一目录。

主文件夹不能直接移除，需先把另一项设为主文件夹。SSH 远程项目不支持附加文件夹；本地项目弹窗与远程目录浏览入口是两套组件。

## 更换主文件夹与重键

`src/main/engine/conversation-catalog.ts` 的 `setProjectPrimary()` 负责以下变更：

1. 选中的已有文件夹成为新 `cwd`，旧主文件夹放到其余文件夹列表的头部。
2. 所有 `conversation.project === 旧 cwd` 的会话改为绑定新项目键。
3. 项目名称等于旧目录 basename 时跟随新 basename；手动改过的名称保留。
4. 已有会话的 `conversation.cwd` 和转写中的工作目录保持原值；新会话才使用新主文件夹。

项目绑定和会话工作目录因此可能不同，不能用项目的新 `cwd` 替换已有会话的实际工作目录。

桌面 `projects:set-primary` handler 在目录变更后通过设置写队列调用 `rekeyProjectSettings()`，移动 `projectDefaults`、`sidebarCollapsedProjects` 和 `sidebarExpandedProjects`。默认模型在目标键已有值时保留目标值，旧键删除。项目顺序随原项目对象保留；不需要把会话 id 类型的归档、置顶记录当作路径改键。远程项目被入口拒绝，不进入 SSH 绑定重键流程。

目录变更通过 catalog 的 flush 统一落盘并广播 `workspace:changed`，设置变更另行广播。后续新增以项目路径为键的设置时，应同步扩展重键规则，不能只改 catalog。

## Agent 上下文与资源发现

`src/main/pi/process-manager.ts` 为主会话注册隐藏的 `fastvibe-project-folders` 扩展。每次提示重新读取目录、分支和资源信息，通过上下文快照发布；内容不变时复用已有投影，压缩后按需补回。单文件夹项目不注入多文件夹快照，并过滤旧快照。

快照由 `buildProjectFoldersPrompt()` 生成，列出会话实际工作目录、项目各文件夹的绝对路径、主/附加身份和 Git 分支，要求在工作目录以外使用绝对路径，并在文件所属仓库提交。委派运行不加载这项扩展，由宿主把同样的文本追加到系统提示。

SDK 只从会话 cwd 发现项目资源。其他文件夹的规则和技能由 `src/main/engine/project-folder-resources.ts` 枚举路径与说明，**列出但不自动加载正文**，智能体在修改对应文件夹之前再读取。查找向上到各自仓库根；不属于仓库的目录只查自身；会话祖先链上已由 SDK 加载的规则不重复列出。下次提示会重新扫描，因此新增规则或技能无需重建会话。

工具原本就接受绝对路径，多文件夹不增加文件系统沙箱或工具审批。worktree 会话只隔离自己的工作目录，其余文件夹仍是真实目录，快照明确提示这一点，不为每个目录自动创建 worktree。

## 文件搜索、文件树与 Git

- `src/main/engine/project-files.ts` 合并 `@` 文件搜索的多个根；其他文件夹命中带文件夹名前缀，同一个文件不重复返回。桌面 handler 补充项目附加目录，SSH 项目仍只有一个根。
- `src/renderer/src/components/layout/side-pane-files.tsx` 按根显示文件树；多文件夹项目的空白区不提供新建，需在具体文件夹上操作，避免目标不明确。
- `src/main/engine/project-repos.ts` 对每个文件夹解析 `git rev-parse --show-toplevel`，按仓库根去重，并记录该仓库覆盖的文件夹。同一仓库的根目录和子目录不会成为两个仓库；非仓库目录仍能在文件树中使用。
- `src/renderer/src/components/layout/side-pane-git.tsx` 在仓库数至少为二时显示切换按钮，标明目录名与分支。默认使用会话 cwd 所属仓库，状态、差异、暂存、提交信息生成、提交、推拉和分支操作都使用所选仓库 cwd。没有跨仓库联合提交或联合分支操作。
- `src/renderer/src/components/chat/file-chips.tsx` 使用 `displayProjectPath()` 区分其他目录中的同名文件，点击进入共用变更视图。仓库选择仍由 Git 面板管理，不能把带文件夹前缀的展示标签当成 Git pathspec。

## 检查点与重试回退

`src/main/engine/checkpoint.ts` 的检查点保留会话 `cwd` 与旧的 `head`，并通过可选的 `repos` 保存本轮涉及的每个仓库的 `{ root, head, paths }`。捕获时按文件实际所属仓库分组；还原时每组使用自己的 HEAD，不能拿主仓库的基线恢复另一个仓库的路径。旧检查点没有 `repos` 时继续按单个 `cwd + head` 还原。

仓库基线与文件原始快照是两层信息。恢复先按仓库处理基线，再写回已捕获的原始文本或 Office 二进制字节，并删除本轮新建的文件。**仓库外或未跟踪的文件不等于一律不可恢复**：有原始内容快照仍可恢复；没有可回退内容、超过捕获限制或写回失败的文件进入 `skipped`，界面必须说明回退不完整。

捕获在工具写入之前、每个用户回合每个文件只取一次，并在捕获时落盘。自动续跑不建立新的用户回合基线。重试对话前仍需询问是否回退文件；选择保留文件改动也照常重试。这些规则同样适用于多个仓库，不会因更换主文件夹而迁移已有检查点。

## 调用表与边界

方法通过 `src/main/ipc/desktop-handlers.ts` 注册中立调用表，接口定义在 `src/shared/api.ts` 与 `src/shared/ipc.ts`，远程分类见 `src/shared/remote-policy.ts`。

| 方法 | 行为 | 远程策略 |
| --- | --- | --- |
| `projects:create` | 用有序目录创建本地项目 | 允许 |
| `projects:pick-folder` | 弹出宿主原生目录选择框 | 拒绝 |
| `projects:add-folder` / `projects:remove-folder` | 修改附加目录 | 允许 |
| `projects:set-primary` | 更换主文件夹并重键 | 允许 |
| `projects:repos` | 解析项目仓库列表 | 允许 |

允许远程调用这些方法不表示 SSH 项目支持多个根，也不表示手机客户端已有对应管理界面。已有会话 cwd 迁移、多个仓库自动创建 worktree、跨仓库原子提交均不属于当前能力。

## 回归入口

以下是现有测试与预览入口，不代表本次文档维护执行过它们：

- `test/project-folders.test.ts`：列表、路径显示、主文件夹重键、自动名称与设置迁移。
- `test/project-folder-resources.test.ts`：其他目录的规则与技能发现、仓库边界、已加载资源去重和提示。
- `test/project-files.test.ts`：多根文件搜索。
- `test/checkpoint.test.ts`、`test/checkpoint-store.test.ts`：多仓库基线、原始内容恢复、二进制与持久化。
- `test/server-policy.test.ts`：调用表的远程分类覆盖。
- `mock.html?pane=files&folders=2`：多根文件树预览。
