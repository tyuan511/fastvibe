# 无用代码检查（2026-10-19）

本轮聚焦桌面端及无头 Agent 的 TypeScript / React 代码。工作区已有的功能开发保留；没有删除功能入口、IPC 接口、数据库迁移或测试。Flutter 手机端尚未逐项审计。

## 方法

- 从 Electron main、无头 Agent、preload、renderer、mock 预览、内置 extensions、脚本及测试入口追踪引用。
- 同时识别静态导入、字面量动态导入和 `new URL` 引用，并人工搜索候选名称，核对动态加载与配置入口。
- 临时启用 TypeScript `noUnusedLocals` / `noUnusedParameters`，筛出无用导入及私有声明；不把未使用参数或导出自动视为可删除的接口。
- 验证只使用命令行、自动测试、类型检查及构建，没有使用 Computer Use。

## 已清理

约 1,200 行无用代码与样式，涉及 37 个源文件；这是源代码减少量，不等于安装包或运行时内存减少量。

| 内容 | 清理原因 |
| --- | --- |
| `git-status-dialog.tsx`、`status-pill.tsx` | 没有调用方的旧组件 |
| `markdown-document.tsx` 及 191 行 `.chat-document*` 样式 | 文档组件及整套样式无引用 |
| `components/ui/alert.tsx`、`components/ui/sheet.tsx` | 没有调用方的完整 UI 原语文件；保留仍使用的 alert-dialog |
| `SessionMenu`、`SubagentBrowser` | 无入口的旧会话菜单；保留仍在使用的 `usagePercent` |
| `PreviewPanel`、`AddressActions`、`DagMobileSummary` | 无调用方的旧外壳；保留共享预览、复制、二维码和任务列表组件 |
| `SEND_ONLY`、`contextFor`、`dispatchForWindow` | Electron 入口里的旧转发代码；当前实现位于 transport 模块 |
| `#branchExists`、`execFileAsync`、`safeModel` 等 | 无调用方的私有辅助代码 |
| `CatalogFile`、`ScheduleFile`、`checkpoints`、`DAY_MS` | 存储重构后留下的类型、空 Map 和常量；迁移实现保留 |
| 无用 imports | 只删 TypeScript 已确认未使用的导入，保留其余代码和格式 |

## 后续优先检查

1. **仅由测试覆盖的遗留文档逻辑**：删除文档组件后，`file-document.ts` 中的 frontmatter / outline 解析主要由测试引用；`numericColumns` 仍供 CSV 预览使用。需要连同可选 heading-id 渲染路径一起确认，再按函数清理，不能整文件删除。
2. **依赖声明**：项目源码已通过 `cn` 合并类名，未找到对 `clsx`、`tailwind-merge` 的直接引用。可进一步核对 shadcn 生成工具及锁文件后移除直接声明；本轮未改动正在开发中的依赖文件。
3. **大模块**：`process-manager.ts` 约 5,800 行、`App.tsx` 约 2,100 行、session store / composer 各约 1,200 行。它们有真实调用方，不能作为死代码整块删除；应另做重复逻辑与功能边界审查。拆文件本身不会减少总代码量。
4. **手机端**：Flutter 代码约 2.5 万行，尚未用 Dart analyzer 和引用分析审计，本轮不对其作无用代码结论。

## 保留边界

- 内置 extensions、Worker、mock 预览和维护脚本是独立入口，不能仅凭主入口没引用而删除。
- IPC / App Protocol 供桌面、手机和无头 Agent 共用；桌面没有调用不代表接口无用。
- 旧数据迁移和协议兼容路径仍服务已有安装。
- `undici`、`typebox` 等 SDK 对齐依赖影响 pnpm peer 变体及安装包完整性，不能因源码未直接引用而删。
- 未引用的导出、仅用于类型断言的声明及当前开发中的新文件不做批量删除。

## 验证

- `pnpm typecheck`：通过，包括 pnpm 变体和 7 段注入脚本检查。
- `pnpm exec electron-vite build`：通过；仍有大 chunk 提示。
- 清理前 `pnpm test`：1,930 项中 1,927 通过、3 失败。原有失败为 Office watch 测试未启动、remote shell 超时、transcript paging 时间戳相差 1 ms。
- 单独复跑上述三个测试文件：29 项中 27 通过；Office watch 与 transcript paging 仍失败，remote shell 通过。
- 清理后 `node --test --test-concurrency=4 'test/**/*.test.ts'`：1,939 项中 1,938 通过，仅同一项 Office watch 测试失败（`the fake watch never started`）。期间工作区新增了其他开发的测试，因此总数与基线不同。
- `git diff --check`：通过。
- 未验证桌面视觉或交互；本轮删除的是没有入口的组件。如需发布前人工复核，可检查会话菜单、文件预览、Git 面板和远程地址的复制/二维码入口是否仍正常展示。

### Office watch 测试后续修复

测试曾把 `process.execPath` 直接写进 shebang；Node 位于带空格的 `Application Support` 路径时，假 watch 无法启动。现改为 `/bin/sh` 启动脚本，正确引用路径并 `exec` 独立的 `.cjs` fixture；同时补上提前退出诊断、临时目录与子进程清理、超时计时器清理。生产 watch 实现未改动。

修复后 Office watch 8/8 通过；全量 `node --test --test-concurrency=4 'test/**/*.test.ts'` 为 1,939/1,939 通过。
