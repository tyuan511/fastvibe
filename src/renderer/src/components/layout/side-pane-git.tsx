import { useEffect, useMemo, useState, type JSX } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  ArrowDown02Icon,
  ArrowUp02Icon,
  Delete02Icon,
  Refresh01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { DiffView } from "@/components/chat/diff-view";
import { cn } from "@/lib/utils";
import type { ChatMessage } from "@shared/types";
import type { GitDiffSource, GitStatus } from "@shared/ipc";

const SOURCES: Array<{ id: GitDiffSource; label: string }> = [
  { id: "unstaged", label: "未暂存" },
  { id: "staged", label: "已暂存" },
  { id: "branch", label: "全部分支更改" },
  { id: "last-turn", label: "上一轮更改" },
];

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

function lastTurnPaths(messages: ChatMessage[]): string[] {
  const paths = new Set<string>();
  for (const message of messages) {
    for (const tool of message.tools) {
      if (!/write|edit|apply|create/i.test(tool.name)) continue;
      const args = tool.args && typeof tool.args === "object" ? (tool.args as Record<string, unknown>) : {};
      const path = String(args.path ?? args.file_path ?? args.filename ?? "");
      if (path) paths.add(path);
    }
  }
  return [...paths];
}

export function SidePaneGit({
  cwd,
  messages,
  onError,
}: {
  cwd?: string;
  messages: ChatMessage[];
  onError: (message: string) => void;
}): JSX.Element {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [source, setSource] = useState<GitDiffSource>("unstaged");
  const [selected, setSelected] = useState<string>();
  const [diff, setDiff] = useState("");
  const [message, setMessage] = useState("");
  const [query, setQuery] = useState("");
  const lastTurn = useMemo(() => lastTurnPaths(messages), [messages]);

  async function reload(): Promise<void> {
    if (!cwd) {
      setStatus(null);
      return;
    }
    try {
      setStatus(await window.fastvibe.workspace.gitStatus(cwd));
    } catch (error) {
      onError(error instanceof Error ? error.message : "无法读取 Git 状态");
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
    if (!files.some((file) => file.path === selected)) setSelected(files[0]?.path);
  }, [files, selected]);

  useEffect(() => {
    if (!cwd || !selected) {
      setDiff("");
      return;
    }
    let cancelled = false;
    void window.fastvibe.workspace
      .gitDiff(cwd, selected, source)
      .then((text) => {
        if (!cancelled) setDiff(text || "没有可显示的 diff");
      })
      .catch(() => {
        if (!cancelled) setDiff("无法读取 diff");
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, selected, source]);

  if (!cwd) {
    return <p className="px-4 py-10 text-center text-sm text-muted-foreground">绑定项目后才能审查改动。</p>;
  }
  if (status && !status.isRepository) {
    return (
      <div className="px-4 py-10 text-center text-sm text-muted-foreground">
        <p className="font-medium text-foreground">当前 workspace 不在 Git 仓库中</p>
        <p className="mt-1">打开一个 Git 仓库目录后，这里会展示改动。</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap gap-1 border-b border-border px-2 py-2">
        {SOURCES.map((item) => (
          <Button
            key={item.id}
            size="xs"
            variant={source === item.id ? "secondary" : "ghost"}
            onClick={() => setSource(item.id)}
          >
            {item.label}
          </Button>
        ))}
        <Button size="icon-xs" variant="ghost" className="ml-auto" onClick={() => void reload()}>
          <HugeiconsIcon strokeWidth={2} icon={Refresh01Icon} />
        </Button>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(9rem,38%)_1fr]">
        <div className="flex min-h-0 flex-col border-r border-border">
          <div className="p-2">
            <Input value={query} placeholder="筛选文件..." className="h-7 text-xs" onChange={(event) => setQuery(event.target.value)} />
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="px-1 pb-2">
              {files.length ? (
                files.map((file) => (
                  <button
                    type="button"
                    key={file.path}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent/60",
                      selected === file.path && "bg-accent",
                    )}
                    onClick={() => setSelected(file.path)}
                  >
                    <span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
                    <span className="text-[10px] text-muted-foreground">
                      {file.index}
                      {file.worktree}
                    </span>
                  </button>
                ))
              ) : (
                <p className="px-2 py-8 text-center text-xs text-muted-foreground">当前来源下没有可展示的改动</p>
              )}
            </div>
          </ScrollArea>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="p-3">
            {selected ? <DiffView text={diff} /> : <p className="text-xs text-muted-foreground">选择一个文件以查看 Diff</p>}
          </div>
        </ScrollArea>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2">
        <Button
          size="xs"
          variant="outline"
          disabled={!selected || source !== "unstaged"}
          onClick={() => {
            if (!cwd || !selected) return;
            void window.fastvibe.workspace.gitStage(cwd, [selected]).then(setStatus).catch((error) => onError(error instanceof Error ? error.message : "暂存失败"));
          }}
        >
          <HugeiconsIcon strokeWidth={2} icon={Add01Icon} />
          暂存
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={!selected || source !== "staged"}
          onClick={() => {
            if (!cwd || !selected) return;
            void window.fastvibe.workspace.gitUnstage(cwd, [selected]).then(setStatus).catch((error) => onError(error instanceof Error ? error.message : "取消暂存失败"));
          }}
        >
          取消暂存
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={!selected || source !== "unstaged"}
          onClick={() => {
            if (!cwd || !selected) return;
            void window.fastvibe.workspace.gitDiscard(cwd, [selected]).then(setStatus).catch((error) => onError(error instanceof Error ? error.message : "丢弃失败"));
          }}
        >
          <HugeiconsIcon strokeWidth={2} icon={Delete02Icon} />
          丢弃
        </Button>
        <Input
          value={message}
          placeholder="提交信息"
          className="h-7 min-w-28 flex-1 text-xs"
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && message.trim() && cwd) {
              void window.fastvibe.workspace.gitCommit(cwd, message.trim()).then((next) => {
                setStatus(next);
                setMessage("");
              }).catch((error) => onError(error instanceof Error ? error.message : "提交失败"));
            }
          }}
        />
        <Button
          size="xs"
          disabled={!message.trim()}
          onClick={() => {
            if (!cwd || !message.trim()) return;
            void window.fastvibe.workspace.gitCommit(cwd, message.trim()).then((next) => {
              setStatus(next);
              setMessage("");
            }).catch((error) => onError(error instanceof Error ? error.message : "提交失败"));
          }}
        >
          <HugeiconsIcon strokeWidth={2} icon={Tick02Icon} />
          提交
        </Button>
        <Button size="xs" variant="outline" onClick={() => cwd && void window.fastvibe.workspace.gitPull(cwd).then(setStatus).catch((error) => onError(error instanceof Error ? error.message : "拉取失败"))}>
          <HugeiconsIcon strokeWidth={2} icon={ArrowDown02Icon} />
          拉取
        </Button>
        <Button size="xs" variant="outline" onClick={() => cwd && void window.fastvibe.workspace.gitPush(cwd).then(setStatus).catch((error) => onError(error instanceof Error ? error.message : "推送失败"))}>
          <HugeiconsIcon strokeWidth={2} icon={ArrowUp02Icon} />
          推送
        </Button>
      </div>
    </div>
  );
}
