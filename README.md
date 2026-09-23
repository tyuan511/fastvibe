# FastVibe

[中文 README](README.zh-CN.md) · English README

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Electron](https://img.shields.io/badge/Electron-44.4.0-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![pi coding agent](https://img.shields.io/badge/pi%20coding%20agent-0.85.1-6E56CF)](https://github.com/badlogic/pi-mono)
[![Latest release](https://img.shields.io/github/v/release/tyuan511/fastvibe?display_name=tag&sort=semver)](https://github.com/tyuan511/fastvibe/releases/latest)

> A desktop AI agent workspace built on **pi coding agent**.

FastVibe embeds pi coding agent in an Electron desktop app, bringing conversations, tool calls, extensions, and project workspaces into one interface.

![FastVibe](apps/website/public/screenshots/en/workspace.webp)

## Download

Download the latest installer from [GitHub Releases](https://github.com/tyuan511/fastvibe/releases/latest):

- macOS: `.dmg` or `.zip`
- Windows: `.exe`
- Linux: `.AppImage` or `.deb`

## Features

- Native pi SDK support for conversations, tool calls, and pi extensions.
- Multi-project workspaces with archived chats, branches, attachments, and isolated scratch workspaces.
- Visual tool calls, edit diffs, terminal output, reasoning, and permission requests.
- Three permission modes: ask, smart approval, and full access; plus plan and goal modes.
- FastVibe and OpenAI-compatible providers, model protocol settings, and OAuth login.
- MCP, skills, todos, subagents, Git worktrees, and usage statistics.
- Optional Jev decision engine for browser control, computer control, batch decisions, smart approval, and enhanced memory.
- Long-term memory in three modes — default, semantic, and JEV-enhanced — stored locally, captured automatically, and injected as context.
- File preview, terminal, browser use, computer use, and Git review side panes.
- Remote web / mobile clients and SSH connections to headless Linux Agents.
- Themes, UI scaling, customizable shortcuts, and automatic updates.

## Decision engine (Jev)

Settings → Decision engine can put **Jev (TypeSafe)** behind a set of “what happens next” judgements, applied per scenario (each with its own switch):

| Scenario | What it does |
| --- | --- |
| Browser control | The decision model drives clicking and typing in the browser (`browser_task`) |
| Computer control | The decision model drives operations in desktop windows (`computer_task`) |
| Batch decisions | The main agent gains the `batch_decide` tool |
| Smart approval | Permission-sandbox judgements go to the decision model |
| Enhanced memory | Memory typing, relations, consolidation, and retrieval go to the decision model |

When it is off every scenario takes its default path: the main model calls `browser_*` / `computer_*` directly, and the permission sandbox uses its built-in rules. Jev serves decision scenarios only — it is not a chat model and never appears in the model list. Its API key stays on this machine and is never handed back to the renderer.

## Long-term memory

Settings → Memory offers three modes over one local SQLite store:

- **Default memory** — always on, no embedding model, using SQLite full-text retrieval to store and recall conversations.
- **Semantic memory** — adds a local multilingual embedding model (about 118 MB, downloaded after confirmation).
- **JEV-enhanced memory** — adds Jev's decision layer on top of the local store for write typing, relations and consolidation, and retrieval routing. Requires Jev to be selected in the decision engine with the “Enhanced memory” scenario checked.

Memory is injected as an ephemeral system-prompt section before each turn and never appended to the transcript; capture happens after a user or final assistant message completes, and thinking blocks, tool results, and sensitive fields are not recorded.

## Relationship with pi

FastVibe uses the `@earendil-works/pi-coding-agent` SDK and stores runtime data in its own userData directory. It never reads or writes the user's native `~/.pi` directory.

Common pi UI APIs are mapped to the desktop UI:

| pi API | FastVibe UI |
| --- | --- |
| `ctx.ui.confirm` | Inline approval panel |
| `ctx.ui.select` / `input` / `questions` | Selection, input, and question forms |
| `ctx.ui.editor` | Multiline editor dialog |
| `ctx.ui.notify` | Notification |
| `ctx.ui.setStatus` / `setWidget` | Status row and composer widgets |
| `ctx.newSession` / `switchSession` | Create / switch conversations |

Extensions are installed through the SDK package manager into FastVibe's isolated directory. Terminal-only full-screen interaction such as `ctx.ui.custom()` is not supported; extensions should use `select`, `confirm`, `input`, `editor`, or `questions` instead.

## Development

Requirements: **Node.js 24** and **pnpm 11**. macOS, Windows, and Linux are supported.

```bash
pnpm install
pnpm dev          # start electron-vite
```

Useful commands:

```bash
pnpm typecheck    # type-check the project
pnpm test         # run tests
pnpm sync:models  # update the models.dev snapshot
pnpm build        # build to out/
pnpm dist:mac     # package macOS (also dist:win / dist:linux)
```

Browser preview:

```bash
pnpm exec vite src/renderer --config vite.config.ts
# open /mock.html?theme=dark
```

## Data and privacy

Runtime data is stored in FastVibe's own userData directory:

| Platform | Directory |
| --- | --- |
| macOS | `~/Library/Application Support/FastVibe/` |
| Windows | `%APPDATA%\\FastVibe\\` |
| Linux | `~/.config/FastVibe/` |

Provider credentials stay in the isolated runtime and are injected into the SDK's in-memory authentication storage. They are not exported to the user's login shell or the in-app terminal. Browser login cookies are stored only in FastVibe's isolated browser session, and Long-term memory lives in the local `runtime/engine/memory.sqlite`: default and semantic modes are entirely local, and only JEV-enhanced memory sends the relevant content to the configured decision model.

## Project structure

```text
src/main/       Electron main process, IPC, embedded Agent, and remote services
src/agent/      headless FastVibe Agent
src/preload/    contextBridge API
src/renderer/   React UI
src/shared/     IPC, App Protocol, and shared types
resources/      bundled extensions, skills, and model resources
```

## License

[MIT](LICENSE) © 2026 FastVibe
