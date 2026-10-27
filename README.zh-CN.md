<p align="center">
  <img src="resources/icon.png" width="96" height="96" alt="FastVibe 图标" />
</p>

# FastVibe

[English](README.md) | **简体中文**

[![最新桌面版](https://img.shields.io/github/v/release/tyuan511/fastvibe?display_name=tag&sort=semver)](https://github.com/tyuan511/fastvibe/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

面向代码、文档和日常任务的 AI 智能体工作台。接入你自己的模型，查看智能体的执行过程，在桌面上集中处理对话、文件、终端和 Git 变更。

[下载](#下载) · [开始使用](#开始使用) · [功能](#功能) · [用手机继续工作](#用手机继续工作) · [开发](#开发) · [更新说明 / Release notes](docs/release/README.md)

![FastVibe 工作区，斜线分割：左半亮色主题，右半暗色主题](docs/images/workspace-zh.webp)

## 下载

前往 [GitHub Releases](https://github.com/tyuan511/fastvibe/releases/latest) 下载桌面端。安装包自带运行环境，无需另装 Node.js 或 pnpm。

| 平台 | 架构 | 安装包 |
| --- | --- | --- |
| macOS | Apple Silicon / Intel | `.dmg` 或 `.zip` |
| Windows | x64 | `.exe` 安装程序 |
| Linux | x64 / arm64 | `.AppImage` 或 `.deb` |

macOS 打开 DMG 后，将 FastVibe 拖入「应用程序」；Windows 运行安装程序；Linux 安装 DEB，或为 AppImage 添加可执行权限后启动。桌面端会检查更新，由你决定何时下载并重启安装。

手机端可从 [Android 发布页](https://github.com/tyuan511/fastvibe/releases?q=app-v&expanded=true) 下载 arm64 APK。iOS 可通过 [Flutter 项目](apps/mobile_flutter/README.md)自行构建。

## 开始使用

1. 打开 **设置 → 供应商**，添加自定义端点并填入 API Key，再选择需要的模型。兼容 OpenAI、Anthropic 或 Google 格式的自建/代理接口都可以接入。
2. 选择文件夹创建项目，或直接新建对话，使用独立的临时工作区。本地项目可以包含多个文件夹和仓库。
3. 选择模型，描述任务。在对话中查看工具调用和文件变更，按需在旁边打开文件、终端或 Git 审查。

> [!NOTE]
> 执行任务需要先配置自定义模型端点和 API Key。FastVibe 不提供模型订阅登录；模型用量由你配置的端点计费。

## 功能

- **围绕任务组织工作。** 管理项目与对话、搜索历史、附加图片和文件、创建对话分支，完成后归档。
- **看得见的执行过程。** 查看流式回答、思考过程、工具调用和编辑 diff；从对话中预览文件变更，在侧栏阅读 Markdown、代码、CSV、图片等成果。
- **文件、终端与 Git 集中处理。** 浏览项目的多个文件夹，在文件树中定位变更，搜索终端输出，审查、暂存并提交代码。
- **持续推进与并行协作。** 支持目标模式、待办、子 Agent、任务依赖和隔离的 Git worktree；可安排定时任务，让结果回到发起任务的对话。
- **接入自己的模型与工具。** 配置供应商及各模型的接口协议，连接 MCP 服务器，添加技能或 pi 扩展，查看跨对话的 Token 用量和费用估算。
- **浏览器与电脑操控。** 让智能体操作内嵌浏览器，或在 macOS、Windows 上启用电脑操控；可选用 Jev 决策引擎处理浏览器、电脑和批量决策。
- **可选长期记忆。** 将已结束对话的经验整理成本地 Markdown，供后续任务读取。默认关闭，可在设置中检查或清除。
- **跨设备继续工作。** 用 Flutter 手机客户端连接电脑，或从桌面端通过 SSH 连接无图形界面的 Linux Agent。支持中英文界面、多主题、界面缩放和自定义快捷键。

## 用手机继续工作

在桌面端打开 **设置 → 远程访问**，再从手机 App 连接：

| 连接方式 | 设置方法 |
| --- | --- |
| FastVibe 账号 | 两端登录同一个账号，手机自动发现电脑；优先直连，需要时通过中转连接。 |
| 局域网 | 在电脑上设置远程访问密码；手机连接同一网络，扫码或从「附近的电脑」选择，再输入密码。 |
| SSH 主机 | 在桌面端的 SSH 主机设置中开启「允许手机连接」，为驻留的 Linux Agent 设置密码。 |

手机使用主机上的同一批对话、模型和任务。连接期间，请保持电脑或远程 Agent 运行且网络可达。

## 数据与隐私

FastVibe 将对话、设置、凭据和运行文件保存在自己的应用数据目录中：

| 平台 | 目录 |
| --- | --- |
| macOS | `~/Library/Application Support/FastVibe/` |
| Windows | `%APPDATA%\FastVibe\` |
| Linux | `~/.config/FastVibe/` |

模型请求会发送到你配置的供应商。供应商凭据保存在 FastVibe 的隔离运行时中，不会导出到登录 shell 或应用内终端。内嵌浏览器的 Cookie 使用独立会话保存。

长期记忆按需开启。开启后，符合条件的对话会发送给配置的模型做整理，生成的 Markdown 保存在 `runtime/engine/memories/`。关闭后停止整理和使用，已有文件会保留，直到你主动清除。详见[长期记忆说明](docs/memory.md)。

## 开发

使用 **Node.js 24** 和 **pnpm 11**，支持 macOS、Windows、Linux。

```bash
git clone https://github.com/tyuan511/fastvibe.git
cd fastvibe
pnpm install
pnpm dev
```

| 命令 | 用途 |
| --- | --- |
| `pnpm typecheck` | 检查注入脚本、依赖变体和 TypeScript |
| `pnpm test` | 运行 Node.js 测试 |
| `pnpm build` | 将桌面端构建到 `out/` |
| `pnpm dist:mac` / `pnpm dist:win` / `pnpm dist:linux` | 打包桌面端安装程序 |
| `pnpm native:fmt` / `pnpm native:check` / `pnpm native:test` | 检查原生 Rust 工作区 |
| `pnpm native:build` / `pnpm native:bundle` | 构建并生成带技能、OfficeCLI 资源清单的原生 bundle |
| `pnpm native:verify -- --bundle DIR` | 校验原生 bundle 的资源和签名后二进制 |
| `cargo dev` | 构建原生 server 与 GUI，空闲时替换有变更的 server，然后启动应用（仓库根或 `native/` 下都可运行） |
| `pnpm sync:models` | 更新 models.dev 快照 |
| `pnpm flutter:analyze` / `pnpm flutter:test` | 检查 Flutter 手机客户端 |

在浏览器中预览界面：

```bash
pnpm exec vite src/renderer --config vite.config.ts
# 在 Vite 打印的地址下访问 /mock.html?desktop=1&theme=dark。
```

FastVibe 在 Electron 主进程中嵌入 `@earendil-works/pi-coding-agent` SDK，使用独立的运行路径，不以 `~/.pi` 为数据根目录。pi 扩展安装在隔离运行时中，其语义化 UI 请求映射为桌面控件。

```text
src/main/             Electron 主进程、内嵌智能体、IPC 和远程连接
src/renderer/         React 桌面界面
src/preload/          Electron 桥接
src/shared/           共享 API、类型和 App Protocol
src/agent/            无图形界面的 Linux Agent
resources/            内置扩展、技能、图标和模型元数据
apps/mobile_flutter/  iOS / Android 手机客户端
```

进一步了解[架构与仓库约定](AGENTS.md)、[多文件夹项目](docs/multi-folder-projects.md)、[Agent runtime 发布](docs/agent-runtime.md)和 [Flutter 开发指南](apps/mobile_flutter/README.md)。遇到问题可在 [GitHub Issues](https://github.com/tyuan511/fastvibe/issues) 中附上应用版本、操作系统和复现步骤。
