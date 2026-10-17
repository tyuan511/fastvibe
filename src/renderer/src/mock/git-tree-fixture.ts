import type { GitStatus } from "@shared/ipc";

// Snapshot of path metadata for large-tree layout checks. Staging only mutates this fixture.
const files: GitStatus["files"] = [
  {
    "path": ".agents/skills/release/SKILL.md",
    "index": "M",
    "worktree": " "
  },
  {
    "path": ".agents/skills/release/scripts/release-notes.mjs",
    "index": "M",
    "worktree": " "
  },
  {
    "path": ".github/workflows/release.yml",
    "index": "M",
    "worktree": " "
  },
  {
    "path": "AGENTS.md",
    "index": "M",
    "worktree": "M"
  },
  {
    "path": "README.md",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "README.zh-CN.md",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "apps/mobile_flutter/AGENTS.md",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "apps/mobile_flutter/lib/chat/composer.dart",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "apps/mobile_flutter/lib/chat/file_sheet.dart",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "apps/mobile_flutter/lib/chat/file_transfer.dart",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "apps/mobile_flutter/lib/chat/message.dart",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "apps/mobile_flutter/lib/i18n/en.dart",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "apps/mobile_flutter/lib/i18n/zh.dart",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "apps/mobile_flutter/lib/main.dart",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "apps/mobile_flutter/lib/protocol/client.dart",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "apps/mobile_flutter/lib/protocol/diagnostics.dart",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "apps/mobile_flutter/lib/screens/chat.dart",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "apps/mobile_flutter/lib/screens/settings.dart",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "apps/mobile_flutter/lib/screens/transcript.dart",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "apps/mobile_flutter/lib/session/connection.dart",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "apps/mobile_flutter/test/output_files_test.dart",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "apps/mobile_flutter/test/screens_test.dart",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "apps/mobile_flutter/tool/i18n/en.json",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "apps/mobile_flutter/tool/i18n/zh.json",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "docs/release/README.md",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "docs/release/app-v0.5.8.md",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "docs/release/v0.20.3.md",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "resources/extensions/dag.ts",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "resources/extensions/schedules.ts",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "resources/extensions/session-title.ts",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "resources/extensions/subagent/index.ts",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "scripts/check-release-note.mjs",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "src/agent/handlers.ts",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "src/main/app-server/app-server.ts",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "src/main/dag-tools.ts",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "src/main/engine/conversation-search.ts",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "src/main/engine/scheduled-tasks.ts",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "src/main/engine/subagents.ts",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "src/main/engine/transcript-window.ts",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "src/main/engine/usage-stats.ts",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "src/main/index.ts",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "src/main/ipc/desktop-handlers.ts",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "src/main/ipc/engine-handlers.ts",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "src/main/pi/cua-component.ts",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "src/main/pi/process-manager-transcript.ts",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "src/main/pi/process-manager.ts",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "src/main/pi/scheduled-task-manager.ts",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "src/main/remote/gateway.ts",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "src/renderer/src/App.tsx",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "src/renderer/src/components/chat/diff-view.tsx",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "src/renderer/src/components/chat/message-list.tsx",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "src/renderer/src/components/chat/message-row.tsx",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "src/renderer/src/components/chat/tool-card.tsx",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "src/renderer/src/components/layout/browser-guest.ts",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "src/renderer/src/components/layout/command-palette.tsx",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "src/renderer/src/components/layout/side-pane-browser.tsx",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "src/renderer/src/components/layout/side-pane-files.tsx",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "src/renderer/src/components/layout/side-pane-git.tsx",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "src/renderer/src/components/layout/side-pane.tsx",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "src/renderer/src/components/layout/sidebar.tsx",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "src/renderer/src/components/schedules/schedule-time.ts",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "src/renderer/src/components/schedules/task-form.tsx",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "src/renderer/src/components/schedules/tasks-page.tsx",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "src/renderer/src/components/settings/computer-settings.tsx",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "src/renderer/src/components/settings/provider-detail.tsx",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "src/renderer/src/components/settings/usage-settings.tsx",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "src/renderer/src/index.css",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "src/renderer/src/lib/diff.ts",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "src/renderer/src/lib/todos.ts",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "src/renderer/src/locales/en/app.json",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "src/renderer/src/locales/en/chat.json",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "src/renderer/src/locales/en/schedules.json",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "src/renderer/src/locales/en/settings.json",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "src/renderer/src/locales/en/sidepane.json",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "src/renderer/src/locales/zh/app.json",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "src/renderer/src/locales/zh/chat.json",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "src/renderer/src/locales/zh/schedules.json",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "src/renderer/src/locales/zh/settings.json",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "src/renderer/src/locales/zh/sidepane.json",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "src/renderer/src/mock/preview.ts",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "src/renderer/src/stores/side-pane.ts",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "src/shared/api.ts",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "src/shared/ipc.ts",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "src/shared/remote-policy.ts",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "src/shared/schedules.ts",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "src/shared/subagent-state.ts",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "src/shared/transcript-page.ts",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "src/shared/types.ts",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "test/agent-session-routing.test.ts",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "test/check-release-note.test.ts",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "test/dag-sdk-tools.test.ts",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "test/dag-tools.test.ts",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "test/diff.test.ts",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "test/gateway.test.ts",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "test/opening-prompt.test.ts",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "test/scheduled-tasks.test.ts",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "test/server-policy.test.ts",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "test/subagent-run.test.ts",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "test/transcript-paging.test.ts",
    "index": " ",
    "worktree": "M"
  },
  {
    "path": "apps/mobile_flutter/lib/chat/download_maintenance.dart",
    "index": "?",
    "worktree": "?"
  },
  {
    "path": "apps/mobile_flutter/lib/chat/transcript_cache.dart",
    "index": "?",
    "worktree": "?"
  },
  {
    "path": "apps/mobile_flutter/lib/screens/connection_diagnostics.dart",
    "index": "?",
    "worktree": "?"
  },
  {
    "path": "apps/mobile_flutter/test/chat_loading_test.dart",
    "index": "?",
    "worktree": "?"
  },
  {
    "path": "apps/mobile_flutter/test/diagnostics_test.dart",
    "index": "?",
    "worktree": "?"
  },
  {
    "path": "apps/mobile_flutter/test/transcript_cache_test.dart",
    "index": "?",
    "worktree": "?"
  },
  {
    "path": "docs/release/app-v0.5.8_zh-CN.md",
    "index": "?",
    "worktree": "?"
  },
  {
    "path": "docs/release/v0.20.3_zh-CN.md",
    "index": "?",
    "worktree": "?"
  },
  {
    "path": "src/main/engine/browser-library.ts",
    "index": "?",
    "worktree": "?"
  },
  {
    "path": "src/main/engine/provider-test.ts",
    "index": "?",
    "worktree": "?"
  },
  {
    "path": "src/main/engine/transcript-reader.ts",
    "index": "?",
    "worktree": "?"
  },
  {
    "path": "src/main/ipc/browser-workspace.ts",
    "index": "?",
    "worktree": "?"
  },
  {
    "path": "src/main/source-control.ts",
    "index": "?",
    "worktree": "?"
  },
  {
    "path": "src/renderer/src/components/layout/browser-downloads-popover.tsx",
    "index": "?",
    "worktree": "?"
  },
  {
    "path": "src/renderer/src/components/layout/browser-library-dialog.tsx",
    "index": "?",
    "worktree": "?"
  },
  {
    "path": "src/renderer/src/components/layout/conversation-outputs.tsx",
    "index": "?",
    "worktree": "?"
  },
  {
    "path": "src/renderer/src/components/layout/conversation-resources.tsx",
    "index": "?",
    "worktree": "?"
  },
  {
    "path": "src/renderer/src/components/layout/conversation-title-bar.tsx",
    "index": "?",
    "worktree": "?"
  },
  {
    "path": "src/renderer/src/components/layout/git-change-list.tsx",
    "index": "?",
    "worktree": "?"
  },
  {
    "path": "src/renderer/src/components/layout/git-history.tsx",
    "index": "?",
    "worktree": "?"
  },
  {
    "path": "src/renderer/src/components/settings/provider-test.tsx",
    "index": "?",
    "worktree": "?"
  },
  {
    "path": "src/renderer/src/components/settings/usage-breakdown.tsx",
    "index": "?",
    "worktree": "?"
  },
  {
    "path": "src/renderer/src/lib/conversation-resources.ts",
    "index": "?",
    "worktree": "?"
  },
  {
    "path": "src/renderer/src/lib/git-change-tree.ts",
    "index": "?",
    "worktree": "?"
  },
  {
    "path": "src/renderer/src/mock/resources-preview.ts",
    "index": "?",
    "worktree": "?"
  },
  {
    "path": "src/renderer/src/stores/transcript-navigation.ts",
    "index": "?",
    "worktree": "?"
  },
  {
    "path": "src/shared/browser-workspace.ts",
    "index": "?",
    "worktree": "?"
  },
  {
    "path": "src/shared/conversation-outputs.ts",
    "index": "?",
    "worktree": "?"
  },
  {
    "path": "src/shared/provider-test.ts",
    "index": "?",
    "worktree": "?"
  },
  {
    "path": "src/shared/transcript-preview.ts",
    "index": "?",
    "worktree": "?"
  },
  {
    "path": "test/browser-workspace.test.ts",
    "index": "?",
    "worktree": "?"
  },
  {
    "path": "test/conversation-outputs.test.ts",
    "index": "?",
    "worktree": "?"
  },
  {
    "path": "test/conversation-resources.test.ts",
    "index": "?",
    "worktree": "?"
  },
  {
    "path": "test/conversation-search.test.ts",
    "index": "?",
    "worktree": "?"
  },
  {
    "path": "test/provider-test.test.ts",
    "index": "?",
    "worktree": "?"
  },
  {
    "path": "test/session-title.test.ts",
    "index": "?",
    "worktree": "?"
  },
  {
    "path": "test/source-control.test.ts",
    "index": "?",
    "worktree": "?"
  },
  {
    "path": "test/subagent-config.test.ts",
    "index": "?",
    "worktree": "?"
  },
  {
    "path": "test/transcript-loading.test.ts",
    "index": "?",
    "worktree": "?"
  }
];

export function gitTreeFixture(cwd: string): GitStatus {
  return { cwd, isRepository: true, branch: "main", changed: files.length, staged: files.filter(file => file.index !== " " && file.index !== "?").length, additions: 428, deletions: 137, ahead: 2, behind: 0, files };
}
