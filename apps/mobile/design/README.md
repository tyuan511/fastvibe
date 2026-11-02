# FastVibe Native Mobile Design

This directory contains the high-fidelity visual prototype for FastVibe's native mobile clients (iOS + Android).

## Files

- `prototype-standalone.html` - The editable prototype with icons inlined; open this file directly in a browser

## Prototype Screens

### 1. **登录 (Login)**
- FastVibe account sign-in
- Browser PKCE flow explanation
- Account auto-discovery

### 2. **电脑列表 (Computers)**
- Account device list
- Online/offline status
- Connection type badges (直连 / 中转)
- An offline computer stays tappable; tapping it opens a sheet with the steps to bring it back online (wake it, open 设置 → 远程访问, check the signed-in account). The hint is not shown inline in the list.

### 3. **连接 (Connection)**
- Connection progress steps
- Direct/relay fallback indication
- Failure states with actionable error messages
- Retry mechanism

### 4. **会话列表 (Conversations)**
- A flat conversation list ordered by most recent activity, across all projects.
- Each row shows its project name (or “未归属项目”), preview, time and live status.
- Search conversations by title, preview or project name.
- The filter button beside the large “会话” title opens status and project filters.
- The connection header is a compact glass capsule containing the computer icon, name and a labelled connection indicator.
- FAB for new conversation opens an inset glass bottom drawer.
- Choose `fastvibe`, `fastvibe-services`, or “未归属项目”; a selection closes the drawer and opens an empty new conversation showing the chosen project.
- Close, outside tap, or Escape dismisses the drawer without creating a conversation.

### 5. **会话详情 (Conversation Thread)**
- Message thread with user/assistant bubbles
- Thinking blocks (collapsible)
- Tool call cards (collapsible, with status icons)
- Diff viewer for file changes
- Context compaction indicators
- Timestamp and processing time

### 6. **流式回复 (Streaming Reply)**
- Real-time thinking updates with caret
- Tool execution in progress
- Stop button for active reply
- Message queue preview

### 7. **历史分页 (History Pagination)**
- "Load earlier messages" interaction
- Loading banner during fetch
- Older messages with reduced opacity
- Smooth scroll to loaded content

### 8. **等你操作 (Pending UI)**
- Confirmation prompts (sheet overlay)
- Selection prompts (radio group)
- Input prompts (textarea)
- Context from conversation

### 9. **设置 (Settings)**
- Account info
- Appearance (system/light/dark)
- Connection diagnostics
- Relay usage meter
- Device identifier
- Version info

### Message queue
Shown above the composer on the streaming screen: queued prompts are sent after the reply completes and can be cancelled.

## Design System

The style is Apple's glass look (iOS 26 "Liquid Glass"). Content scrolls under floating glass chrome instead of sitting between opaque bars.

### Materials
- **Background**: a soft three-colour wash (blue top-left, pink right, teal bottom-left) over `#eef0f7` / `#050508`. Glass needs something behind it to blur.
- **Glass panel** (cards, groups, tool cards, queue): white 56% (light) or `rgb(44 44 52 / 44%)` (dark), `blur(22px) saturate(180%)`, a 1px inner top highlight, a 0.5px outer edge and a soft shadow.
- **Glass control** (nav buttons, search, composer field, secondary buttons): the same recipe slightly more opaque (74% / 58%) with an extra bottom highlight.
- **Sheet**: 84% / 80% with `blur(30px)`, inset 8px from the screen edges, 40px corner radius.
- **Accent fill** (primary buttons, user bubbles, FAB, avatar): `#4aa3ff → #007aff` gradient with a white top sheen and a tinted drop shadow.
- iOS maps these to `.glassEffect()` / `.ultraThinMaterial`; Android to a blurred `RenderEffect` surface with the same alpha and highlight.

### Chrome
- **Navigation**: 44px circular glass back / more buttons, centred title + subtitle. The header area fades and blurs the content scrolling under it. No hairline separator.
- **Navigation hierarchy**: the home page shows the computer list, with Settings in the upper-right corner. Selecting a computer opens its conversation list as a second-level page; Back returns to the computer list. Selecting a conversation opens its thread; Back returns to that computer's conversations. Settings also returns to the computer list. There is no bottom tab bar on any page. The conversation list keeps its floating New Conversation button.
- **Composer**: a floating glass field and a 48px round send button. The send button is grey glass when empty, accent when there is text, and a solid black/white stop button while a reply runs. Queued prompts float in a glass card above it.
- **History loading**: a glass capsule pinned under the header, not a full-width banner.

### Logo
The login screen uses the real app icon, the same tile the desktop's `AppLogo` draws (`src/renderer/src/assets/app-icon-light.png`; the 1024px master is `resources/icon.png`). It is shown at 96pt with a soft blue drop shadow, on both themes. Native apps should ship it from `resources/icon.png`, not redraw it.

### Typography
- System font stack (SF Pro, PingFang SC, Roboto, Noto Sans SC); 17px body.
- Large titles 34px / 700; nav titles 16px / 600; list titles 15.5px / 600; meta 13px.
- Mono for paths, commands and diffs; tabular numerals for metrics.

### Radii and sizes
- Cards and groups 24px, tool cards 22px, controls fully rounded.
- Touch targets ≥ 44px; primary buttons 52px.

## Implementation Checklist

Based on the agent audit findings (`sess_db0e27ca` task.output), the Rust core needs:

- [ ] Wire-compatible models (WorkspaceSnapshot, ConversationSnapshot, QueueState)
- [ ] RPC surface (listConversations, openConversation, getSnapshot, getMessagesPage, getPendingUi, permissionRespond)
- [ ] Request/result routing (pending request tracking, correlation by requestId)
- [ ] Handshake negotiation (welcome features, server capabilities, session ID)
- [ ] Snapshot/event ordering (buffer events during snapshot fetch, apply after seq check)
- [ ] Pending UI recovery (hydrate from snapshot.pendingUi, respond API)
- [ ] History paging (historyLimit on snapshot, beforeEntryId cursor, prepend + reset)
- [ ] Prompt method selection (engine:submit-prompt when advertised, else engine:prompt)

## Viewing the Prototype

Open `prototype-standalone.html` in a browser (append `?screen=thread&theme=dark` to jump to one screen). Use the toolbar to:
- Switch between screens
- Toggle theme (auto/light/dark)
- View all screens simultaneously or focus on one

The prototype is fully interactive:
- Click collapsible sections to expand/collapse
- Type in the composer to see send button state
- Toggle between connection states (progress/failed)
- Switch between pending UI types (confirm/select/input)

## Next Steps

1. **Rust Core** - Implement missing conversation lifecycle APIs
2. **iOS SwiftUI** - Build views matching this prototype exactly
3. **Android Compose** - Build views matching this prototype exactly
4. **E2E Testing** - Test on real devices against real desktop connections
