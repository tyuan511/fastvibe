import { useEffect, useMemo, useState, type JSX } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  ArrowDown01Icon,
  GitBranchIcon,
  Search01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { GitBranch, GitStatus } from "@shared/ipc";

/**
 * The composer's git chip: the checked-out branch, and a picker to switch it.
 * It reads no diff state — the 审查 pane owns change review — so the popover is
 * just 搜索分支 / 分支列表 / 创建并检出新分支…, matching the workspace row's flat
 * style (no chrome until hovered).
 *
 * Rendering nothing outside a repository keeps non-git workspaces unchanged.
 */
export function GitBranchChip({
  status,
  onBranchChange,
}: {
  status: GitStatus;
  /** Called after a successful switch/create so the caller can re-read status. */
  onBranchChange?: (status: GitStatus) => void;
}): JSX.Element | null {
  const cwd = status.cwd;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [branches, setBranches] = useState<GitBranch[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A fresh list every time the popover opens: branches move under us (the
  // agent itself may create them), so a cached list would go stale.
  useEffect(() => {
    if (!open) {
      setQuery("");
      setCreating(false);
      setNewName("");
      setError(null);
      return;
    }
    let cancelled = false;
    setBranches(null);
    window.fastvibe.workspace
      .gitBranches(cwd)
      .then((list) => {
        if (!cancelled) setBranches(list);
      })
      .catch(() => {
        if (!cancelled) setBranches([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, cwd]);

  const filtered = useMemo(() => {
    const list = branches ?? [];
    const term = query.trim().toLowerCase();
    if (!term) return list;
    return list.filter((item) => item.name.toLowerCase().includes(term));
  }, [branches, query]);

  async function switchTo(branch: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await window.fastvibe.workspace.gitCheckout(cwd, branch);
      onBranchChange?.(next);
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "切换分支失败");
    } finally {
      setBusy(false);
    }
  }

  async function createAndCheckout(): Promise<void> {
    const name = newName.trim();
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await window.fastvibe.workspace.gitCreateBranch(cwd, name);
      onBranchChange?.(next);
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "创建分支失败");
    } finally {
      setBusy(false);
    }
  }

  if (!status.isRepository || !status.branch) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`当前分支 ${status.branch}`}
            className="h-7 max-w-56 gap-1 rounded-full px-2 text-sm font-normal text-muted-foreground transition-colors hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground"
          />
        }
      >
        <HugeiconsIcon strokeWidth={1.8} icon={GitBranchIcon} className="size-3.5 shrink-0" />
        <span className="truncate">{status.branch}</span>
        <HugeiconsIcon strokeWidth={1.8} icon={ArrowDown01Icon} className="size-3 shrink-0" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        sideOffset={12}
        className="w-70 gap-0 rounded-xl p-1 shadow-lg"
      >
        {creating ? (
          <div className="p-1">
            <div className="px-2 pb-1 pt-0.5 text-xs font-medium text-muted-foreground">新分支名称</div>
            <Input
              autoFocus
              value={newName}
              placeholder="例如 feature/login"
              disabled={busy}
              className="h-7 rounded-md text-sm"
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void createAndCheckout();
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setCreating(false);
                }
              }}
            />
            <div className="mt-1.5 flex items-center justify-end gap-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 rounded-full px-2 text-xs font-normal text-muted-foreground"
                onClick={() => setCreating(false)}
              >
                取消
              </Button>
              <Button
                type="button"
                size="sm"
                className="h-6 rounded-full px-2 text-xs"
                disabled={busy || !newName.trim()}
                onClick={() => void createAndCheckout()}
              >
                创建并检出
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="relative mb-0.5 px-0.5 pt-0.5">
              <HugeiconsIcon
                strokeWidth={2}
                icon={Search01Icon}
                className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                autoFocus
                value={query}
                placeholder="搜索分支"
                className="h-7 rounded-md border-0 bg-transparent pl-6.5 text-sm shadow-none focus-visible:ring-0"
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <div className="px-2 py-0.5 text-xs font-medium text-muted-foreground">分支</div>
            <div className="max-h-52 overflow-y-auto">
              {branches === null ? (
                <div className="px-2 py-1.5 text-sm text-muted-foreground">读取分支…</div>
              ) : filtered.length > 0 ? (
                filtered.map((item) => (
                  <button
                    key={item.name}
                    type="button"
                    disabled={busy}
                    className={cn(
                      "flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm transition-colors hover:bg-muted disabled:opacity-60",
                      item.current && "bg-muted font-medium",
                    )}
                    onClick={() => {
                      if (item.current) {
                        setOpen(false);
                        return;
                      }
                      void switchTo(item.name);
                    }}
                  >
                    <HugeiconsIcon
                      strokeWidth={2}
                      icon={GitBranchIcon}
                      className="size-3.5 shrink-0 text-muted-foreground"
                    />
                    <span className="truncate">{item.name}</span>
                    {item.current ? (
                      <HugeiconsIcon strokeWidth={2} icon={Tick02Icon} className="ml-auto size-3.5 shrink-0" />
                    ) : null}
                  </button>
                ))
              ) : (
                <div className="px-2 py-1.5 text-sm text-muted-foreground">没有匹配的分支</div>
              )}
            </div>
            {error ? <div className="px-2 pb-1 text-xs text-destructive">{error}</div> : null}
            <div className="my-0.5 border-t border-border" />
            <button
              type="button"
              className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              onClick={() => {
                setNewName(query.trim());
                setQuery("");
                setCreating(true);
              }}
            >
              <HugeiconsIcon strokeWidth={2} icon={Add01Icon} className="size-3.5 shrink-0" />
              <span>创建并检出新分支...</span>
            </button>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
