# FastVibe Website

FastVibe 产品介绍与下载页，使用 Next.js App Router 和 next-intl。

## 本地开发

在仓库根目录运行 `pnpm website:dev`，或在本目录运行 `pnpm dev`。

- `/zh`、`/en`：中文、英文页面，文案位于 `messages/`。
- `/`：next-intl 根据语言偏好 cookie、浏览器语言选择页面；默认英文。
- 页面按语言加载 `public/screenshots/{zh,en}/` 的应用截图。官网只呈现 `workspace` / `review` / `models` 三张；`files` / `tools` / `market` 供 README 使用，同一套截图脚本一并生成。
- DM Sans 通过 Fontsource 本地托管，不依赖 Google Fonts 请求。
- 视觉使用 FastVibe 标志的紫色与青色、桌面式圆角和真实工作区首屏，不使用蓝灰雾面或仿终端下载窗。

## 明暗主题

仅通过 CSS `prefers-color-scheme` 跟随系统，不提供切换按钮，也不读取或存储手动主题偏好。系统外观变化时页面实时切换，首屏和无 JavaScript 的情况也保持一致；旧版存储的主题选择不会覆盖系统设置。

全站颜色位于 `app/globals.css` 的语义变量中；导航、下载控件、源码链路、截图弹窗等共用同一组 token。应用截图保留拍摄时的深色应用主题，独立于官网配色。浏览器 `theme-color` 使用分别带明暗媒体条件的 metadata 标签，无需客户端脚本。

## 产品文案

「基于 Pi」介绍参考 [Pi 官网](https://pi.dev) 的精简核心、适应工作流、多模型与扩展理念，采用 FastVibe 自己的双语表述，不展示 benchmark 或性能排名。

源码入口沿真实依赖链排列：FastVibe → pi-coding-agent → pi-agent-core → pi-ai。Pi 包分别位于上游仓库的 `packages/coding-agent`、`packages/agent`、`packages/ai`。计划、子 Agent、审批和 MCP 桥接归于 FastVibe 的集成能力，不宣称 Pi 默认提供这些功能，也不承诺所有 TUI 插件都能在 GUI 中运行。开源范围为应用和 Agent 软件层，不代表第三方模型或服务开源。

## 检查

在仓库根目录运行：

```bash
pnpm website:typecheck
pnpm website:lint
pnpm website:build
```

浏览器回归（先启动网站）：

```bash
WEBSITE_URL=http://localhost:3000 pnpm --filter @fastvibe/website test:browser
```

覆盖中英文 × 明暗主题 × 五种视口宽度、实时系统主题变化、忽略旧版手动偏好，以及对应语言截图、源码入口、下载控件、截图弹窗、语言记忆与无 JavaScript 的服务端页面。可用 `CHECK_SCREENSHOTS_DIR` 保存 375px / 1440px 的完整页面截图。

## 重新拍摄产品截图

```bash
pnpm --filter @fastvibe/website screenshots
```

脚本使用真实 renderer 的 `mock.html?website=1&lang=zh|en&scene=workspace|files|review|tools|models|market&platform=darwin`，生成十二张 2880×1800 WebP（两种语言 × 六个场景），同时供官网与两份 README 使用。演示数据来自 `src/renderer/src/mock/website-fixtures.ts`。macOS 交通灯只注入此专用 mock，不改变正式应用窗口。

每个场景都必须让 mock 设置 `document.body.dataset.websiteSceneReady`（展开某个折叠、切到某个标签页、打开侧栏），脚本等到它才截图，所以场景跑不到那个状态时会超时失败，而不是拿到一张空白图。`apps/website/lib/screenshots.ts` 与 `scripts/capture-website.mjs` 各持一份场景清单，新增场景要同时改两处。

截图脚本复用 `CAPTURE_PORT`（默认 5175）上的 Vite，否则自行启动并在结束后关闭。浏览器脚本在 macOS 默认使用 Google Chrome；其他平台先运行 `pnpm --filter @fastvibe/website exec playwright install chromium`，或通过 `CHROME_PATH` 指定浏览器。

## 下载与部署

页面从 GitHub Releases API 读取最新版本，缓存 10 分钟，按平台匹配安装包。API 不可用或缺失资产时，保留 GitHub Release 页面作为兜底链接。

Vercel 的 Root Directory 设置为 `apps/website`，安装命令使用 `pnpm install --frozen-lockfile`，构建命令使用 `pnpm build`。需要支持 Next.js 服务端/ISR，不能部署为纯静态导出。

`WEBSITE_BUILD_DIR` 可指定独立构建目录，避免与正在运行的开发服务器混用产物。
