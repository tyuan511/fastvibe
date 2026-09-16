import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Alert01Icon,
  CheckmarkCircle02Icon,
  ImportIcon,
  RefreshIcon,
  Search01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { AgentBrandIcon } from "@/components/agent-brand-icon";
import { IconButton } from "@/components/icon-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import type {
  ImportCandidate,
  ImportOutcome,
  ImportRunResult,
  ImportSourceStatus,
  WorkspaceSnapshot,
} from "@shared/types";

/**
 * 设置 → 导入.
 *
 * Four sibling coding agents can be read from disk, and this pane is a list of them:
 * mark, name, and a 导入 button. Nothing is imported until the user picks sessions in
 * the dialog and confirms, because these are somebody else's transcripts — every scan
 * is read-only, and an import *copies* the converted session into FastVibe's own
 * runtime rather than linking to the original (deleting a chat would otherwise unlink
 * the user's real data).
 *
 * See `docs/import-from-other-agents.md` for the formats and the conversion contract.
 */
export function ImportSettings({
  onImported,
}: {
  /** Hands the refreshed catalog to the shell so new chats appear in the sidebar. */
  onImported?: (snapshot: WorkspaceSnapshot, result: ImportRunResult) => void;
}): JSX.Element {
  const [sources, setSources] = useState<ImportSourceStatus[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<ImportSourceStatus | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setScanning(true);
    try {
      setSources(await window.fastvibe.engine.importSources());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "无法读取其他 agent 的数据目录");
      setSources([]);
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const total = (sources ?? []).reduce((sum, source) => sum + source.sessionCount, 0);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <HugeiconsIcon strokeWidth={2} icon={ImportIcon} className="size-4" />
            从其他 Agent 导入
          </CardTitle>
          <CardDescription>
            读取本机其他编程 agent 的会话记录，转换后复制到 FastVibe。
            原始数据只读，不会被修改或删除。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">
              {sources === null ? "正在扫描…" : `共发现 ${total} 个会话`}
            </span>
            <IconButton
              label="重新扫描"
              size="icon-sm"
              variant="outline"
              disabled={scanning}
              onClick={() => void refresh()}
            >
              <HugeiconsIcon
                strokeWidth={2}
                icon={RefreshIcon}
                className={scanning ? "size-3.5 animate-spin" : "size-3.5"}
              />
            </IconButton>
          </div>

          {error ? (
            <p className="flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              <HugeiconsIcon strokeWidth={2} icon={Alert01Icon} className="mt-0.5 size-3.5 shrink-0" />
              {error}
            </p>
          ) : null}

          <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
            {(sources ?? []).map((source) => (
              <SourceRow
                key={source.id}
                source={source}
                onOpen={() => setActive(source)}
              />
            ))}
            {sources !== null && sources.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">没有可用的来源</p>
            ) : null}
          </div>

          {sources === null ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner className="size-3.5" />
              正在读取 ~/.pi、~/.claude、~/.codex 与 opencode 的数据…
            </p>
          ) : null}
        </CardContent>
      </Card>

      {active ? (
        <ImportPickerDialog
          source={active}
          onClose={() => setActive(null)}
          onImported={(snapshot, result) => {
            onImported?.(snapshot, result);
            // Re-scan so the row's counts and the 已导入 marks reflect what just landed.
            void refresh();
          }}
        />
      ) : null}
    </div>
  );
}

/** One agent: brand mark and name on the left, an 导入 button on the right. */
function SourceRow({
  source,
  onOpen,
}: {
  source: ImportSourceStatus;
  onOpen: () => void;
}): JSX.Element {
  const unavailable = Boolean(source.reason) || source.sessionCount === 0;
  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted/40">
        <AgentBrandIcon agent={source.id} className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{source.name}</div>
        <div className="truncate text-xs text-muted-foreground">
          {source.reason
            ? source.reason
            : `${source.sessionCount} 个会话${source.latestAt ? ` · 最近 ${formatDay(source.latestAt)}` : ""}`}
        </div>
      </div>
      <Button size="sm" variant="outline" disabled={unavailable} onClick={onOpen}>
        导入
      </Button>
    </div>
  );
}

function ImportPickerDialog({
  source,
  onClose,
  onImported,
}: {
  source: ImportSourceStatus;
  onClose: () => void;
  onImported: (snapshot: WorkspaceSnapshot, result: ImportRunResult) => void;
}): JSX.Element {
  const [candidates, setCandidates] = useState<ImportCandidate[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [running, setRunning] = useState(false);
  const [outcomes, setOutcomes] = useState<ImportOutcome[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.fastvibe.engine
      .importCandidates(source.id)
      .then((list) => {
        if (!cancelled) setCandidates(list);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setCandidates([]);
        setError(err instanceof Error ? err.message : "无法读取会话列表");
      });
    return () => {
      cancelled = true;
    };
  }, [source.id]);

  const needle = query.trim().toLowerCase();
  const visible = useMemo(() => {
    if (!candidates) return [];
    if (!needle) return candidates;
    return candidates.filter((candidate) =>
      `${candidate.title} ${candidate.cwd ?? ""}`.toLowerCase().includes(needle),
    );
  }, [candidates, needle]);

  const selectedVisible = visible.filter((candidate) => selected.has(candidate.id)).length;

  function toggle(id: string, next: boolean): void {
    setSelected((current) => {
      const copy = new Set(current);
      if (next) copy.add(id);
      else copy.delete(id);
      return copy;
    });
  }

  function toggleAll(next: boolean): void {
    setSelected((current) => {
      const copy = new Set(current);
      for (const candidate of visible) {
        if (next) copy.add(candidate.id);
        else copy.delete(candidate.id);
      }
      return copy;
    });
  }

  async function run(): Promise<void> {
    if (selected.size === 0) return;
    setRunning(true);
    setError(null);
    try {
      const result = await window.fastvibe.engine.importSessions(source.id, [...selected]);
      setOutcomes(result.outcomes);
      setSelected(new Set());
      setCandidates((current) =>
        current
          ? current.map((candidate) =>
              selected.has(candidate.id) ? { ...candidate, imported: true } : candidate,
            )
          : current,
      );
      onImported(result.snapshot, result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "导入失败，请重试");
    } finally {
      setRunning(false);
    }
  }

  const succeeded = outcomes?.filter((outcome) => outcome.ok) ?? [];
  const failed = outcomes?.filter((outcome) => !outcome.ok) ?? [];

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AgentBrandIcon agent={source.id} className="size-4" />
            导入 {source.name} 会话
          </DialogTitle>
          <DialogDescription>
            {outcomes
              ? `本次导入完成：成功 ${succeeded.length} 个${failed.length > 0 ? `，失败 ${failed.length} 个` : ""}。`
              : "选择要导入的会话。导入后会在左侧对话列表中出现，原会话不受影响。"}
          </DialogDescription>
        </DialogHeader>

        {outcomes ? (
          <ImportReport outcomes={outcomes} candidates={candidates} />
        ) : (
          // Same shape as the model picker: a searched, multi-select list with a fixed
          // height, so the dialog never jumps around as a source's list loads.
          <div className="flex min-h-0 min-w-0 flex-col gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <div className="relative min-w-0 flex-1">
                <HugeiconsIcon
                  strokeWidth={2}
                  icon={Search01Icon}
                  className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  value={query}
                  placeholder="搜索标题或目录"
                  className="h-8 pl-8 text-xs"
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
              <Button size="xs" variant="outline" onClick={() => toggleAll(true)}>
                全选
              </Button>
              <Button size="xs" variant="outline" onClick={() => setSelected(new Set())}>
                清空
              </Button>
              <span className="shrink-0 text-xs text-muted-foreground">
                已选 {selected.size}/{visible.length}
              </span>
            </div>

            <ScrollArea className="h-80 rounded-lg border border-border">
              {candidates === null ? (
                <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
                  <Spinner className="size-3.5" />
                  正在读取会话列表…
                </div>
              ) : visible.length === 0 ? (
                <p className="py-10 text-center text-xs text-muted-foreground">
                  {needle ? "没有匹配的会话" : "没有可导入的会话"}
                </p>
              ) : (
                <div className="divide-y divide-border">
                  {visible.map((candidate) => (
                    <CandidateRow
                      key={candidate.id}
                      candidate={candidate}
                      checked={selected.has(candidate.id)}
                      onToggle={() => toggle(candidate.id, !selected.has(candidate.id))}
                    />
                  ))}
                </div>
              )}
            </ScrollArea>
          </div>
        )}

        {error ? (
          <p className="flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            <HugeiconsIcon strokeWidth={2} icon={Alert01Icon} className="mt-0.5 size-3.5 shrink-0" />
            {error}
          </p>
        ) : null}

        <DialogFooter>
          {outcomes ? (
            <Button size="sm" onClick={onClose}>
              完成
            </Button>
          ) : (
            <>
              <Button size="sm" variant="ghost" disabled={running} onClick={onClose}>
                取消
              </Button>
              <Button size="sm" disabled={running || selected.size === 0} onClick={() => void run()}>
                {running ? <Spinner className="size-3.5" /> : null}
                {running ? "正在导入…" : `导入 ${selected.size} 个会话`}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CandidateRow({
  candidate,
  checked,
  onToggle,
}: {
  candidate: ImportCandidate;
  checked: boolean;
  onToggle: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className="flex w-full items-start gap-2.5 px-3 py-2 text-left hover:bg-muted/50"
      onClick={onToggle}
    >
      <span
        className={cn(
          "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-[4px] border",
          checked ? "border-primary bg-primary text-primary-foreground" : "border-input",
        )}
      >
        {checked ? <HugeiconsIcon strokeWidth={2} icon={Tick02Icon} className="size-3" /> : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-xs font-medium">{candidate.title}</span>
          {candidate.imported ? (
            <Badge variant="secondary" className="shrink-0">
              已导入
            </Badge>
          ) : null}
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <span>{formatDay(candidate.updatedAt)}</span>
          {candidate.messageCount !== undefined ? <span>· {candidate.messageCount} 条消息</span> : null}
          {candidate.bytes !== undefined ? <span>· {formatBytes(candidate.bytes)}</span> : null}
          {candidate.cwd ? <span className="truncate">· {shortenPath(candidate.cwd)}</span> : null}
        </span>
        {candidate.note ? (
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">{candidate.note}</span>
        ) : null}
      </span>
    </button>
  );
}

/** What happened, per session — imports are per-session, so failures are listed, not hidden. */
function ImportReport({
  outcomes,
  candidates,
}: {
  outcomes: ImportOutcome[];
  candidates: ImportCandidate[] | null;
}): JSX.Element {
  const succeeded = outcomes.filter((outcome) => outcome.ok);
  const failed = outcomes.filter((outcome) => !outcome.ok);
  const originalCwd = new Map((candidates ?? []).map((candidate) => [candidate.id, candidate.cwd]));
  // A session whose project no longer exists is imported into the shared workspace
  // instead. Saying so is the difference between "my chat moved" and "the import broke".
  const relocated = succeeded.filter(
    (outcome) => originalCwd.get(outcome.id) && originalCwd.get(outcome.id) !== outcome.cwd,
  );
  const notes = [...new Set(succeeded.flatMap((outcome) => outcome.skipped ?? []))];
  return (
    <ScrollArea className="h-80 rounded-lg border border-border">
      <div className="space-y-3 p-3">
        {succeeded.length > 0 ? (
          <div className="space-y-1.5">
            <div className="flex items-center gap-2 text-xs font-medium text-success">
              <HugeiconsIcon strokeWidth={2} icon={CheckmarkCircle02Icon} className="size-4" />
              已导入 {succeeded.length} 个会话
            </div>
            <ul className="space-y-1">
              {succeeded.map((outcome) => (
                <li key={outcome.id} className="truncate text-xs text-muted-foreground">
                  {outcome.title} · {outcome.messages} 条消息
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {notes.length > 0 ? (
          <div className="space-y-1">
            <div className="text-xs font-medium">转换说明</div>
            <ul className="space-y-0.5">
              {notes.map((note) => (
                <li key={note} className="text-xs text-muted-foreground">
                  {note}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {relocated.length > 0 ? (
          <div className="space-y-1">
            <div className="text-xs font-medium">原目录不存在</div>
            <ul className="space-y-0.5">
              {relocated.map((outcome) => (
                <li key={outcome.id} className="truncate text-xs text-muted-foreground">
                  {outcome.title} · 已放入工作区
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {failed.length > 0 ? (
          <div className="space-y-1">
            <div className="text-xs font-medium text-destructive">失败 {failed.length} 个</div>
            <ul className="space-y-0.5">
              {failed.map((outcome) => (
                <li key={outcome.id} className="text-xs text-muted-foreground">
                  {outcome.title} · {outcome.error ?? "未知错误"}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {succeeded.length === 0 && failed.length === 0 ? (
          <p className="py-10 text-center text-xs text-muted-foreground">没有会话被导入</p>
        ) : null}
      </div>
    </ScrollArea>
  );
}

function formatDay(at: number): string {
  const date = new Date(at);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, {
    month: "2-digit",
    day: "2-digit",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** Last two segments: enough to tell two repos apart without a full path in a row. */
function shortenPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join("/")}`;
}
