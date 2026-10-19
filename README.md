<p align="center">
  <img src="resources/icon.png" width="96" height="96" alt="FastVibe logo" />
</p>

# FastVibe

**English** | [简体中文](README.zh-CN.md)

[![Latest desktop release](https://img.shields.io/github/v/release/tyuan511/fastvibe?display_name=tag&sort=semver)](https://github.com/tyuan511/fastvibe/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

An AI agent workspace for code, documents, and everyday tasks. Work with your own models, follow what the agent does, and keep conversations, files, terminals, and Git changes together on your desktop.

[Download](#download) · [Get started](#get-started) · [Features](#features) · [Use your phone](#use-your-phone) · [Development](#development) · [Release notes / 更新说明](docs/release/README.md)

![FastVibe workspace with conversations and tools](docs/images/workspace-en.webp)

## Download

Get the desktop app from [GitHub Releases](https://github.com/tyuan511/fastvibe/releases/latest). Downloaded builds do not require Node.js or pnpm.

| Platform | Architecture | Installer |
| --- | --- | --- |
| macOS | Apple Silicon / Intel | `.dmg` or `.zip` |
| Windows | x64 | `.exe` installer |
| Linux | x64 / arm64 | `.AppImage` or `.deb` |

On macOS, open the DMG and drag FastVibe into Applications. On Windows, run the installer. On Linux, install the DEB or make the AppImage executable before launching it. The desktop app checks for updates; you choose when to download and restart.

The [Android releases](https://github.com/tyuan511/fastvibe/releases?q=app-v&expanded=true) provide an arm64 APK for the companion app. iOS can be built from the [Flutter project](apps/mobile_flutter/README.md).

## Get started

1. Open **Settings → Providers**, add a provider, and connect it with your API key or a supported provider login. Select the models you want to use; custom compatible endpoints are supported too.
2. Create a project by choosing a folder, or start a conversation without a project to use a separate scratch workspace. Local projects can include several folders and repositories.
3. Choose a model and describe the task. Follow tool calls and file changes in the conversation, then open files, the terminal, or Git review alongside it.

> [!NOTE]
> Bring a model provider to run tasks. FastVibe account sign-in is separate from provider setup and is used for account-based remote connections. Model usage is billed by your provider.

## Features

- **A workspace around the task.** Organize projects and conversations, search history, attach images and files, branch a conversation, and archive finished work.
- **Visible agent activity.** Read streaming replies, reasoning, tool calls, and edit diffs. Preview changed files from the conversation and inspect Markdown, code, CSV, images, and other outputs beside the chat.
- **Files, terminals, and Git together.** Browse multiple project folders, find changed files in the tree, search terminal output, and review, stage, and commit changes without leaving the workspace.
- **Longer and parallel work.** Use goal mode, todos, subagents, task dependencies, and isolated Git worktrees. Schedule recurring tasks and receive results in the conversation that requested them.
- **Your models and tools.** Configure providers and per-model protocols, connect MCP servers, and add skills or pi extensions. Track token usage and estimated cost across conversations.
- **Browser and computer use.** Let the agent work in the embedded browser, or enable desktop control on macOS and Windows — one click, keystroke or scroll at a time, decided by your model.
- **Optional long-term memory.** Let finished conversations inform future work through local Markdown notes. Memory is off by default and can be inspected or cleared in Settings.
- **Work across devices.** Continue from the Flutter phone app, or connect the desktop to a headless Linux Agent over SSH. Chinese and English interfaces, themes, interface scaling, and configurable shortcuts are included.

## Use your phone

Turn on **Settings → Remote access** on the desktop, then connect from the phone app:

| Connection | Setup |
| --- | --- |
| FastVibe account | Sign in to the same account on both devices. The phone discovers your computer and connects directly when possible, using the relay when needed. |
| Local network | Set a remote-access password on the desktop. On the same network, scan its QR code or choose it from nearby computers, then enter the password. |
| SSH host | In the desktop's SSH host settings, enable phone access and set a password for the resident Linux Agent. |

The phone works with the host's conversations, models, and tasks. Keep the desktop or remote Agent running and reachable while connected.

## Data and privacy

FastVibe keeps conversations, settings, credentials, and runtime files in its own application data directory:

| Platform | Directory |
| --- | --- |
| macOS | `~/Library/Application Support/FastVibe/` |
| Windows | `%APPDATA%\FastVibe\` |
| Linux | `~/.config/FastVibe/` |

Requests go to the model provider you configure. Provider credentials are held in FastVibe's isolated runtime and are not exported to your login shell or the integrated terminal. Embedded-browser cookies use a separate browser session.

Long-term memory is optional. When enabled, eligible conversations are sent to the configured model for summarization, and the resulting Markdown files stay in `runtime/engine/memories/`. Turning memory off stops extraction and use; existing files remain until you clear them. See [how memory works](docs/memory.md).

## Development

Use **Node.js 24** and **pnpm 11** on macOS, Windows, or Linux.

```bash
git clone https://github.com/tyuan511/fastvibe.git
cd fastvibe
pnpm install
pnpm dev
```

| Command | Purpose |
| --- | --- |
| `pnpm typecheck` | Check injected scripts, dependency variants, and TypeScript |
| `pnpm test` | Run the Node.js test suite |
| `pnpm build` | Build the desktop app into `out/` |
| `pnpm dist:mac` / `pnpm dist:win` / `pnpm dist:linux` | Package desktop installers |
| `pnpm sync:models` | Refresh the models.dev snapshot |
| `pnpm flutter:analyze` / `pnpm flutter:test` | Check the Flutter companion app |

To preview the renderer in a browser:

```bash
pnpm exec vite src/renderer --config vite.config.ts
# Open /mock.html?desktop=1&theme=dark on the URL printed by Vite.
```

FastVibe embeds the `@earendil-works/pi-coding-agent` SDK in Electron's main process. It supplies its own runtime paths and does not use `~/.pi` as its data root. pi extensions are installed into that isolated runtime, with their semantic UI requests mapped to desktop controls.

```text
src/main/             Electron main process, embedded agent, IPC, and remote connections
src/renderer/         React desktop interface
src/preload/          Electron bridge
src/shared/           Shared APIs, types, and App Protocol
src/agent/            Headless Linux Agent
resources/            Bundled extensions, skills, icons, and model metadata
apps/mobile_flutter/  iOS and Android companion app
```

For deeper work, see the [architecture and repository conventions](AGENTS.md), [multi-folder projects](docs/multi-folder-projects.md), [Agent runtime releases](docs/agent-runtime.md), and [Flutter development guide](apps/mobile_flutter/README.md). Report problems through [GitHub Issues](https://github.com/tyuan511/fastvibe/issues), including your app version, operating system, and steps to reproduce.
