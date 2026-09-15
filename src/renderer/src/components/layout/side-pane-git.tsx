import { useEffect, useMemo, useState, type JSX } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  ArrowDown02Icon,
  ArrowLeft01Icon,
  ArrowUp02Icon,
  Delete02Icon,
  Folder01Icon,
  GitBranchIcon,
  GitCompareIcon,
  MinusSignIcon,
  RefreshIcon,
  Search01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { DiffView } from "@/components/chat/diff-view";
import { FileIcon } from "@/components/file-icon";
import { IconButton } from "@/components/icon-button";
import { readGitStatus } from "@/lib/use-git-status";
import { cn } from "@/lib/utils";
import { displayPath } from "@/lib/workspace-path";
import { useSessionStore } from "@/stores/session";
import type { ChatMessage } from "@shared/types";
import type { GitDiffSource, GitStatus } from "@shared/ipc";

const SOURCES: Array<{ id: GitDiffSource; label: string }> = [
  { id: "unstaged", label: "未暂存" },
  { id: "staged", label: "已暂存" },
  { id: "branch", label: "分支" },
  { id: "last-turn", label: "上一轮" },
];

const EMPTY_COPY: Record<GitDiffSource, string> = {
  unstaged: "没有未暂存的改动",
  staged: "没有已暂存的改动",
  branch: "没有分支改动",
  "last-turn": "上一轮没有改动文件",
};

const STATUS_TONE: Record<string, string> = {
  M: "text-warning",
  T: "text-warning",
  A: "text-success",
  "?": "text-success",
  D: "text-destructive",
  U: "text-destructive",
  R: "text-info",
  C: "text-info",
};

const STATUS_LABEL: Record<string, string> = {
  M: "已修改",
  T: "类型变更",
  A: "新增",
  "?": "未跟踪",
  D: "已删除",
  U: "冲突",
  R: "重命名",
  C: "复制",
};

function filesForSource(status: GitStatus | null, source: GitDiffSource, lastTurn: string[]): GitStatus["files"] {
  if (!status) return [];
  if (source === "last-turn") {
    return lastTurn.map((path) => ({ path, index: " ", worktree: "M" }));
  }
  return status.files.filter((file) => {
    if (source === "staged") return file.index !== " " && file.index !== "?";
    if (source === "unstaged") return file.worktree !== " " || file.index === "?";
    return true;
  });
}

function sourceCounts(status: GitStatus | null, lastTurn: string[]): Record<GitDiffSource, number> {
  const files = status?.files ?? [];
  return {
    unstaged: files.filter((file) => file.worktree !== " " || file.index === "?").length,
    staged: status?.staged ?? 0,
    branch: files.length,
    "last-turn": lastTurn.length,
  };
}

function fileLetter(file: GitStatus["files"][number], source: GitDiffSource): string {
  if (source === "staged") return file.index.trim() || "M";
  if (source === "unstaged") return file.index === "?" ? "?" : file.worktree.trim() || file.index.trim() || "M";
  if (file.index === "?") return "?";
  if (file.worktree.trim() && file.worktree !== "?") return file.worktree;
  if (file.index.trim()) return file.index;
  return "M";
}

function splitRelPath(path: string, cwd?: string): { name: string; dir: string } {
  const rel = displayPath(path, cwd).replace(/\\/g, "/");
  const slash = rel.lastIndexOf("/");
  if (slash < 0) return { name: rel, dir: "" };
  return { name: rel.slice(slash + 1), dir: rel.slice(0, slash) };
}

function resolvePath(cwd: string, path: string): string {
  if (/^([a-zA-Z]:)?\//.test(path)) return path;
  return `${cwd.replace(/\/+$/, "")}/${path}`;
}

function countPatch(text: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

function stripDiffHeaders(text: string): string {
  return text
    .split("\n")
    .filter((line) => {
      if (line.startsWith("diff --git ")) return false;
      if (line.startsWith("index ")) return false;
      if (line.startsWith("--- ") || line.startsWith("+++ ")) return false;
      if (line.startsWith("new file mode ") || line.startsWith("deleted file mode ")) return false;
      if (line.startsWith("similarity index ")) return false;
      if (line.startsWith("rename from ") || line.startsWith("rename to ")) return false;
      return true;
    })
    .join("\n")
    .replace(/^\n+/, "");
}

function computeLastTurnPaths(messages: ChatMessage[]): string[] {
  const paths = new Set<string>();
  for (const message of messages) {
    for (const tool of message.tools) {
      if (tool.status === "error") continue;
      if (!/write|edit|apply|create/i.test(tool.name)) continue;
      const args = tool.args && typeof tool.args === "object" ? (tool.args as Record<string, unknown>) : {};
      const path = String(args.path ?? args.file_path ?? args.filename ?? "");
      if (path) paths.add(path);
    }
  }
  return [...paths];
}

const lastTurnCache = new WeakMap<ChatMessage, string[]>();

/** Cached on the trailing message's identity so streaming doesn't rescan the transcript. */
function lastTurnPaths(messages: ChatMessage[]): string[] {
  const key = messages[messages.length - 1];
  if (!key) return [];
  const cached = lastTurnCache.get(key);
  if (cached) return cached;
  const paths = computeLastTurnPaths(messages);
  lastTurnCache.set(key, paths);
  return paths;
}

function GitEmpty({
  icon,
  title,
  description,
}: {
  icon: typeof GitCompareIcon;
  title: string;
  description: string;
}): JSX.Element {
  return (
    <Empty className="min-h-0 flex-1 border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <HugeiconsIcon strokeWidth={2} icon={icon} />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function DiffPane({
  cwd,
  file,
  diff,
  diffError,
  diffLoading,
  patch,
  busy,
  canStage,
  canUnstage,
  canDiscard,
  onBack,
  onStage,
  onUnstage,
  onDiscard,
}: {
  cwd: string;
  file: GitStatus["files"][number];
  diff: string;
  diffError: string | null;
  diffLoading: boolean;
  patch: { added: number; removed: number };
  busy: boolean;
  canStage: boolean;
  canUnstage: boolean;
  canDiscard: boolean;
  onBack: () => void;
  onStage: () => void;
  onUnstage: () => void;
  onDiscard: () => void;
}): JSX.Element {
  const { name } = splitRelPath(file.path, cwd);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border px-2">
        <IconButton
          size="icon-xs"
          variant="ghost"
          label="返回文件列表"
          className="@min-[32rem]/git:hidden"
          onClick={onBack}
        >
          <HugeiconsIcon strokeWidth={2} icon={ArrowLeft01Icon} />
        </IconButton>
        <FileIcon name={name} />
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={file.path}>
          {name}
        </span>
        {patch.added > 0 ? <span className="shrink-0 text-xs tabular-nums text-success">+{patch.added}</span> : null}
        {patch.removed > 0 ? (
          <span className="shrink-0 text-xs tabular-nums text-destructive">−{patch.removed}</span>
        ) : null}
        {canStage ? (
          <IconButton size="icon-xs" variant="ghost" label="暂存" disabled={busy} onClick={onStage}>
            <HugeiconsIcon strokeWidth={2} icon={Add01Icon} />
          </IconButton>
        ) : null}
        {canUnstage ? (
          <IconButton size="icon-xs" variant="ghost" label="取消暂存" disabled={busy} onClick={onUnstage}>
            <HugeiconsIcon strokeWidth={2} icon={MinusSignIcon} />
          </IconButton>
        ) : null}
        {canDiscard ? (
          <IconButton
            size="icon-xs"
            variant="ghost"
            label="丢弃"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            disabled={busy}
            onClick={onDiscard}
          >
            <HugeiconsIcon strokeWidth={2} icon={Delete02Icon} />
          </IconButton>
        ) : null}
        <IconButton
          size="icon-xs"
          variant="ghost"
          label="在访达中显示"
          onClick={() => void window.fastvibe.workspace.reveal(resolvePath(cwd, file.path))}
        >
          <HugeiconsIcon strokeWidth={2} icon={Folder01Icon} />
        </IconButton>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {diffLoading ? (
          <div className="flex items-center justify-center py-10">
            <Spinner className="size-4 text-muted-foreground" />
          </div>
        ) : diffError ? (
          <p className="px-4 py-10 text-center text-xs leading-5 text-muted-foreground">{diffError}</p>
        ) : diff ? (
          <DiffView text={diff} className="mt-0 max-h-none overflow-visible rounded-none border-0" />
        ) : (
          <p className="px-4 py-10 text-center text-xs leading-5 text-muted-foreground">没有可显示的 diff</p>
        )}
      </ScrollArea>
    </div>
  );
}

export function SidePaneGit({
  cwd,
  onError,
}: {
  cwd?: string;
  onError: (message: string) => void;
}): JSX.Element {
  const messages = useSessionStore((state) => state.messages);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [source, setSource] = useState<GitDiffSource>("unstaged");
  const [selected, setSelected] = useState<string>();
  const [diff, setDiff] = useState("");
  const [diffError, setDiffError] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [reloading, setReloading] = useState(false);
  const lastTurn = useMemo(() => lastTurnPaths(messages), [messages]);
  const counts = useMemo(() => sourceCounts(status, lastTurn), [status, lastTurn]);

  async function reload(): Promise<void> {
    if (!cwd) {
      setStatus(null);
      return;
    }
    setReloading(true);
    try {
      setStatus(await readGitStatus(cwd, true));
    } catch (error) {
      onError(error instanceof Error ? error.message : "无法读取 Git 状态");
    } finally {
      setReloading(false);
    }
  }

  async function run(action: () => Promise<GitStatus>, fail: string): Promise<void> {
    if (!cwd || busy) return;
    setBusy(true);
    try {
      setStatus(await action());
    } catch (error) {
      onError(error instanceof Error ? error.message : fail);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void reload();
  }, [cwd]);

  const files = useMemo(() => {
    const list = filesForSource(status, source, lastTurn);
    const needle = query.trim().toLowerCase();
    return needle ? list.filter((file) => file.path.toLowerCase().includes(needle)) : list;
  }, [status, source, lastTurn, query]);

  useEffect(() => {
    if (selected && !files.some((file) => file.path === selected)) setSelected(undefined);
  }, [files, selected]);

  useEffect(() => {
    if (!cwd || !selected) {
      setDiff("");
      setDiffError(null);
      setDiffLoading(false);
      return;
    }
    let cancelled = false;
    setDiff("");
    setDiffError(null);
    setDiffLoading(true);
    void window.fastvibe.workspace
      .gitDiff(cwd, selected, source)
      .then((text) => {
        if (cancelled) return;
        setDiff(stripDiffHeaders(text ?? ""));
        setDiffError(null);
      })
      .catch(() => {
        if (!cancelled) setDiffError("无法读取 diff");
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, selected, source]);

  if (!cwd) {
    return <GitEmpty icon={GitCompareIcon} title="未绑定项目" description="绑定项目后即可审查工作区改动。" />;
  }
  if (status && !status.isRepository) {
    return <GitEmpty icon={GitBranchIcon} title="不是 Git 仓库" description="打开一个 Git 仓库目录后，这里会展示改动。" />;
  }

  const selectedFile = files.find((file) => file.path === selected);
  const patch = diffError || !diff ? { added: 0, removed: 0 } : countPatch(diff);
  const canStage = Boolean(selected) && source === "unstaged";
  const canUnstage = Boolean(selected) && source === "staged";
  const canDiscard = Boolean(selected) && source === "unstaged";

  return (
    <div className="@container/git flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border px-2">
        <HugeiconsIcon strokeWidth={2} icon={GitBranchIcon} className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={status?.branch}>
          {status?.branch ?? "HEAD"}
        </span>
        {status?.behind ? (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">↓{status.behind}</span>
        ) : null}
        {status?.ahead ? (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">↑{status.ahead}</span>
        ) : null}
        {status && status.changed > 0 ? (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{status.changed} 个改动</span>
        ) : null}
        <IconButton
          size="icon-xs"
          variant="ghost"
          label="拉取"
          disabled={busy}
          onClick={() => void run(() => window.fastvibe.workspace.gitPull(cwd), "拉取失败")}
        >
          <HugeiconsIcon strokeWidth={2} icon={ArrowDown02Icon} />
        </IconButton>
        <IconButton
          size="icon-xs"
          variant="ghost"
          label="推送"
          disabled={busy}
          onClick={() => void run(() => window.fastvibe.workspace.gitPush(cwd), "推送失败")}
        >
          <HugeiconsIcon strokeWidth={2} icon={ArrowUp02Icon} />
        </IconButton>
        <IconButton size="icon-xs" variant="ghost" label="刷新" disabled={reloading} onClick={() => void reload()}>
          <HugeiconsIcon strokeWidth={2} icon={RefreshIcon} className={cn(reloading && "animate-spin")} />
        </IconButton>
      </div>

      <div className="border-b border-border px-2 py-1.5">
        <div className="flex h-8 w-full items-center rounded-lg bg-muted p-[3px]">
          {SOURCES.map((item) => {
            const count = counts[item.id];
            const active = source === item.id;
            return (
              <button
                key={item.id}
                type="button"
                className={cn(
                  "inline-flex h-full min-w-0 flex-1 items-center justify-center gap-1 rounded-md px-1.5 text-xs font-medium whitespace-nowrap transition-colors",
                  active
                    ? "bg-background text-foreground shadow-sm dark:bg-input/30"
                    : "text-muted-foreground hover:text-foreground",
                )}
                onClick={() => setSource(item.id)}
              >
                <span className="truncate">{item.label}</span>
                {count > 0 ? <span className="tabular-nums text-muted-foreground">{count}</span> : null}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col @min-[32rem]/git:flex-row">
        <div
          className={cn(
            "min-h-0 flex-col @min-[32rem]/git:w-[min(16rem,40%)] @min-[32rem]/git:min-w-40 @min-[32rem]/git:flex-none @min-[32rem]/git:border-r @min-[32rem]/git:border-border",
            selected ? "hidden @min-[32rem]/git:flex" : "flex flex-1",
          )}
        >
          <div className="p-2">
            <div className="relative">
              <HugeiconsIcon
                strokeWidth={2}
                icon={Search01Icon}
                className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                value={query}
                placeholder="筛选文件"
                className="h-7 pl-8 text-xs"
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="px-1 pb-2">
              {!status ? (
                <div className="flex items-center justify-center py-10">
                  <Spinner className="size-4 text-muted-foreground" />
                </div>
              ) : files.length ? (
                files.map((file) => {
                  const { name, dir } = splitRelPath(file.path, cwd);
                  const letter = fileLetter(file, source);
                  const active = selected === file.path;
                  return (
                    <button
                      type="button"
                      key={file.path}
                      aria-current={active ? "true" : undefined}
                      title={file.path}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted",
                        active && "bg-muted",
                      )}
                      onClick={() => setSelected(file.path)}
                    >
                      <FileIcon name={name} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs text-foreground">{name}</span>
                        {dir ? <span className="block truncate text-xs text-muted-foreground">{dir}</span> : null}
                      </span>
                      <span
                        className={cn(
                          "w-4 shrink-0 text-center text-xs font-medium tabular-nums",
                          STATUS_TONE[letter] ?? "text-muted-foreground",
                        )}
                        title={STATUS_LABEL[letter] ?? letter}
                      >
                        {letter}
                      </span>
                    </button>
                  );
                })
              ) : (
                <p className="px-2 py-10 text-center text-xs leading-5 text-muted-foreground">
                  {query.trim() ? "没有匹配的文件" : EMPTY_COPY[source]}
                </p>
              )}
            </div>
          </ScrollArea>
        </div>

        {selected && selectedFile ? (
          <DiffPane
            cwd={cwd}
            file={selectedFile}
            diff={diff}
            diffError={diffError}
            diffLoading={diffLoading}
            patch={patch}
            busy={busy}
            canStage={canStage}
            canUnstage={canUnstage}
            canDiscard={canDiscard}
            onBack={() => setSelected(undefined)}
            onStage={() => void run(() => window.fastvibe.workspace.gitStage(cwd, [selected]), "暂存失败")}
            onUnstage={() => void run(() => window.fastvibe.workspace.gitUnstage(cwd, [selected]), "取消暂存失败")}
            onDiscard={() => void run(() => window.fastvibe.workspace.gitDiscard(cwd, [selected]), "丢弃失败")}
          />
        ) : (
          <div className="hidden min-h-0 min-w-0 flex-1 items-center justify-center px-8 text-center text-xs leading-5 text-muted-foreground @min-[32rem]/git:flex">
            选择文件以查看 Diff
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-border px-3 py-2">
        <Input
          value={message}
          placeholder={status?.staged ? "提交信息" : "暂存后即可提交"}
          className="h-8 min-w-0 flex-1 text-sm"
          disabled={busy}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || !message.trim() || !status?.staged) return;
            void run(async () => {
              const next = await window.fastvibe.workspace.gitCommit(cwd, message.trim());
              setMessage("");
              return next;
            }, "提交失败");
          }}
        />
        <Button
          size="sm"
          disabled={busy || !message.trim() || !status?.staged}
          onClick={() => {
            if (!message.trim() || !status?.staged) return;
            void run(async () => {
              const next = await window.fastvibe.workspace.gitCommit(cwd, message.trim());
              setMessage("");
              return next;
            }, "提交失败");
          }}
        >
          <HugeiconsIcon strokeWidth={2} icon={Tick02Icon} />
          提交
        </Button>
      </div>
    </div>
  );
}
