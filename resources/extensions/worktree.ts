import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type WorktreeInfo = {
  path: string;
  branch?: string;
  head?: string;
  bare?: boolean;
  detached?: boolean;
  current?: boolean;
};

type WorktreeResult = {
  path: string;
  branch: string;
  cwd: string;
  rebound: boolean;
};

type WorktreeHost = {
  createWorktree?(options?: { path?: string; branch?: string; label?: string }): Promise<WorktreeResult>;
  bindWorktree?(path: string): Promise<WorktreeResult>;
  unbindWorktree?(options?: { remove?: boolean }): Promise<{ cwd: string }>;
  listWorktrees?(): Promise<WorktreeInfo[]>;
};

function hostOf(ctx: ExtensionContext): WorktreeHost {
  return ctx.ui as unknown as WorktreeHost;
}

function formatList(items: WorktreeInfo[]): string {
  if (items.length === 0) return "No git worktrees found for this project.";
  return items
    .map((item) => {
      const mark = item.current ? "* " : "  ";
      const branch = item.detached ? "(detached)" : item.branch || "HEAD";
      const extra = item.bare ? " (bare)" : "";
      return `${mark}${branch}  ${item.path}${extra}`;
    })
    .join("\n");
}

function formatBound(result: WorktreeResult): string {
  const pending = result.rebound
    ? "The agent workspace is now this directory."
    : "The agent workspace will switch to this directory after the current turn finishes. Use absolute paths under it if you still need to edit files in this turn.";
  return [`Bound to worktree ${result.path}`, `branch: ${result.branch}`, pending].join("\n");
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

export default function worktreeExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "worktree_list",
    label: "Worktree 列表",
    description: "列出当前项目的 git worktree（路径、分支、是否为当前会话工作区）。",
    promptSnippet: "List git worktrees for this project",
    promptGuidelines: [
      "Use worktree_list before creating or binding a worktree, so you can reuse an existing checkout instead of adding another.",
    ],
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const host = hostOf(ctx);
      if (!host.listWorktrees) {
        return { content: [{ type: "text", text: "当前宿主不支持 worktree。" }], details: { worktrees: [] }, isError: true };
      }
      try {
        const items = await host.listWorktrees();
        return { content: [{ type: "text", text: formatList(items) }], details: { worktrees: items } };
      } catch (error) {
        return { content: [{ type: "text", text: errorText(error, "Failed to list worktrees.") }], details: { worktrees: [] }, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "worktree_create",
    label: "创建 Worktree",
    description: [
      "为当前会话创建一个 git worktree，并把整个 agent 工作区绑定到该目录。",
      "调用前必须先征得用户同意：在回复里说明为什么想开、建在哪个路径，然后停下来等用户确认，同意后再调用。",
      "默认创建在 ~/.fastvibe/worktree/<project-name>/ 下。",
      "可指定 branch（新分支名）或 path（自定义路径）。",
    ].join(""),
    promptSnippet: "Create a git worktree and bind this conversation to it",
    promptGuidelines: [
      "Ask first, then stop: explain why a worktree would help and where it would live, end your reply, and wait for the user to agree. Only call this tool after they do.",
      "Never create a worktree on your own initiative — a new checkout is a change to the user's machine they did not ask for.",
      "Suggest one (and say why) when the task would dirty the project's main checkout: parallel work, a risky edit, or an isolated branch. Then let the user decide.",
      "Default path is ~/.fastvibe/worktree/<project-name>/<slug>. Pass path only to override.",
      "The session cwd switches to the worktree; subsequent read/edit/bash calls run there.",
    ],
    parameters: Type.Object({
      branch: Type.Optional(Type.String({ description: "Branch to create or check out in the worktree" })),
      path: Type.Optional(Type.String({ description: "Absolute path for the worktree; default ~/.fastvibe/worktree/<project-name>/<slug>" })),
      label: Type.Optional(Type.String({ description: "Short label used in the default folder name" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const host = hostOf(ctx);
      if (!host.createWorktree) {
        return { content: [{ type: "text", text: "当前宿主不支持创建 worktree。" }], details: {}, isError: true };
      }
      try {
        const result = await host.createWorktree({
          branch: typeof params.branch === "string" ? params.branch : undefined,
          path: typeof params.path === "string" ? params.path : undefined,
          label: typeof params.label === "string" ? params.label : undefined,
        });
        return { content: [{ type: "text", text: formatBound(result) }], details: result };
      } catch (error) {
        return { content: [{ type: "text", text: errorText(error, "Failed to create worktree.") }], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "worktree_bind",
    label: "绑定 Worktree",
    description: "把当前会话的工作区绑定到一个已有的 git worktree 目录。绑定后 read/edit/bash 与顶部 Git 操作都针对该目录。",
    promptSnippet: "Bind this conversation's workspace to an existing git worktree",
    promptGuidelines: [
      "Ask the user before binding, the same way worktree_create does — switching the workspace is not something to do unasked.",
      "Bind when a worktree already exists (see worktree_list) and this conversation should work in it.",
      "The path must belong to the same git repository as the bound project.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Existing worktree directory" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const host = hostOf(ctx);
      if (!host.bindWorktree) {
        return { content: [{ type: "text", text: "当前宿主不支持绑定 worktree。" }], details: {}, isError: true };
      }
      const path = typeof params.path === "string" ? params.path.trim() : "";
      if (!path) {
        return { content: [{ type: "text", text: "path is required." }], details: {}, isError: true };
      }
      try {
        const result = await host.bindWorktree(path);
        return { content: [{ type: "text", text: formatBound(result) }], details: result };
      } catch (error) {
        return { content: [{ type: "text", text: errorText(error, "Failed to bind worktree.") }], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "worktree_unbind",
    label: "解除 Worktree",
    description: "解除当前会话与 worktree 的绑定，工作区回到项目目录。默认保留磁盘上的 worktree；remove: true 时删除 FastVibe 创建的 worktree。",
    promptSnippet: "Unbind this conversation from its git worktree",
    parameters: Type.Object({
      remove: Type.Optional(Type.Boolean({ description: "Also delete a FastVibe-created worktree from disk" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const host = hostOf(ctx);
      if (!host.unbindWorktree) {
        return { content: [{ type: "text", text: "当前宿主不支持解除 worktree。" }], details: {}, isError: true };
      }
      try {
        const result = await host.unbindWorktree({ remove: params.remove === true });
        return {
          content: [{ type: "text", text: `Workspace restored to ${result.cwd}` }],
          details: result,
        };
      } catch (error) {
        return { content: [{ type: "text", text: errorText(error, "Failed to unbind worktree.") }], details: {}, isError: true };
      }
    },
  });
}
