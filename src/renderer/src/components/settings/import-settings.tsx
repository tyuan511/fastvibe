import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import {
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
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
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
  const { t } = useTranslation("settings");
  const [sources, setSources] = useState<ImportSourceStatus[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [active, setActive] = useState<ImportSourceStatus | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setScanning(true);
    try {
      setSources(await window.fastvibe.engine.importSources());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("import.scanFailed"));
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
            {t("import.title")}
          </CardTitle>
          <CardDescription>
            {t("import.desc")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">
              {sources === null ? t("import.scanning") : t("import.found", { count: total })}
            </span>
            <IconButton
              label={t("import.rescan")}
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


          {/* 
            * The list is only drawn when it has rows: every source FastVibe knows about
            * is absent — or the scan is still running — and an empty bordered box would
            * read as a rendering bug. `sources === null` (still scanning) and `[]` (nothing
            * installed) therefore both fall through to a message of their own.
            */}
          {sources && sources.length > 0 ? (
            <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
              {sources.map((source) => (
                <SourceRow
                  key={source.id}
                  source={source}
                  onOpen={() => setActive(source)}
                />
              ))}
            </div>
          ) : null}

          {sources !== null && sources.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border px-3 py-8 text-center">
              <p className="text-sm">{t("import.emptyTitle")}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("import.emptyDesc")}
              </p>
            </div>
          ) : null}

          {sources === null ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Spinner className="size-3.5" />
              {t("import.reading")}
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
  const { t } = useTranslation("settings");
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
            : `${t("import.sessions", { count: source.sessionCount })}${source.latestAt ? ` · ${t("import.latest", { date: formatDay(source.latestAt) })}` : ""}${
                source.archivedCount ? ` · ${t("import.archived", { count: source.archivedCount })}` : ""
              }`}
        </div>
      </div>
      <Button size="sm" variant="outline" disabled={unavailable} onClick={onOpen}>
        {t("import.import")}
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
  const { t } = useTranslation("settings");
  const [candidates, setCandidates] = useState<ImportCandidate[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [running, setRunning] = useState(false);
  const [outcomes, setOutcomes] = useState<ImportOutcome[] | null>(null);

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
        toast.error(err instanceof Error ? err.message : t("import.listFailed"));
      });
    return () => {
      cancelled = true;
    };
  }, [source.id]);

  const needle = query.trim().toLowerCase();
  const archivedCount = (candidates ?? []).filter((candidate) => candidate.archived).length;
  const archivedIds = useMemo(
    () => new Set((candidates ?? []).filter((candidate) => candidate.archived).map((candidate) => candidate.id)),
    [candidates],
  );
  // Archived sessions are the source agent's own leftovers — Codex hides 62 of 88 in the
  // author's corpus — so they are folded away rather than listed beside live work. The
  // switch is the only way they reappear, and a search looks in what is shown.
  const visible = useMemo(() => {
    if (!candidates) return [];
    return candidates.filter((candidate) => {
      if (candidate.archived && !showArchived) return false;
      if (!needle) return true;
      return `${candidate.title} ${candidate.cwd ?? ""}`.toLowerCase().includes(needle);
    });
  }, [candidates, needle, showArchived]);

  // Within `visible`, not the whole candidate list: the label reads 全选（x/y）beside a
  // list of y rows, and a selection hidden by the search box or by 显示已归档 must not make
  // x exceed y.
  const selectedCount = visible.filter((candidate) => selected.has(candidate.id)).length;
  const allVisibleSelected = visible.length > 0 && visible.every((candidate) => selected.has(candidate.id));

  function toggle(id: string, next: boolean): void {
    setSelected((current) => {
      const copy = new Set(current);
      if (next) copy.add(id);
      else copy.delete(id);
      return copy;
    });
  }

  /**
   * 「Select what is on screen」, not 「select everything」: with the archived folded away
   * or a search narrowing the list, a select-all that ticked hidden rows would import
   * sessions the user never saw, and the count beside it would disagree with the list.
   *
   * Only the visible rows are touched in either direction — a selection made under one
   * search survives the next one, and clearing visible rows never drops the rest.
   */
  function selectAllVisible(next: boolean): void {
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
      toast.error(err instanceof Error ? err.message : t("import.runFailed"));
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
            {t("import.dialogTitle", { name: source.name })}
          </DialogTitle>
          <DialogDescription>
            {outcomes
              ? `${t("import.doneSummary", { ok: succeeded.length })}${failed.length > 0 ? t("import.doneFailed", { failed: failed.length }) : ""}。`
              : t("import.pickHint")}
          </DialogDescription>
        </DialogHeader>

        {outcomes ? (
          <ImportReport outcomes={outcomes} candidates={candidates} />
        ) : (
          // Same shape as the model picker: a searched, multi-select list with a fixed
          // height, so the dialog never jumps around as a source's list loads.
          <div className="flex min-h-0 min-w-0 flex-col gap-3">
            {/* The control row is only the two controls that act on the list, sitting at
                opposite ends of it. The count rides in the checkbox's own label — an
                unticked box already means "nothing selected", so 清空 needs no button of
                its own. The search box is a fixed, modest width rather than `flex-1`: the
                dialog is wide and a full-width field for a one-line filter reads as the
                page's main input. */}
            <div className="flex min-w-0 items-center justify-between gap-3">
              <Label className="shrink-0 gap-2 text-xs font-normal text-muted-foreground tabular-nums">
                <Checkbox
                  checked={allVisibleSelected}
                  disabled={visible.length === 0}
                  onCheckedChange={(checked) => selectAllVisible(checked === true)}
                />
                {t("import.selectAll", { selected: selectedCount, total: visible.length })}
              </Label>
              <div className="relative w-56 max-w-full min-w-0 shrink">
                <HugeiconsIcon
                  strokeWidth={2}
                  icon={Search01Icon}
                  className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  value={query}
                  placeholder={t("import.search")}
                  className="h-8 pl-8 text-xs"
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
            </div>

            <ScrollArea className="h-80 rounded-lg border border-border">
              {candidates === null ? (
                <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
                  <Spinner className="size-3.5" />
                  {t("import.loadingList")}
                </div>
              ) : visible.length === 0 ? (
                <p className="py-10 text-center text-xs text-muted-foreground">
                  {needle
                    ? t("import.noMatch")
                    : archivedCount > 0
                      ? t("import.onlyArchived")
                      : t("import.none")}
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

            {/* A display option for the list, not an action on the selection, so it sits
                under the list rather than in the row above it (where it crowded 全选 and
                the search box). Always rendered: a disabled switch is how a source with
                no notion of archiving (pi, Claude Code) says so. The switch is not wrapped
                in a `<label>` — Base UI renders it as a `button`, which a label may not
                contain. */}
            <span className="flex shrink-0 items-center justify-end gap-2 text-xs text-muted-foreground">
              {archivedCount > 0 ? t("import.showArchivedCount", { count: archivedCount }) : t("import.showArchived")}
              <Switch
                checked={showArchived}
                disabled={archivedCount === 0}
                onCheckedChange={(next) => {
                  setShowArchived(next);
                  // What is hidden is not what gets imported: folding the archived rows
                  // away drops them from the selection too, so the count beside 全选
                  // never claims rows the user can no longer see.
                  if (!next) {
                    setSelected((current) => new Set([...current].filter((id) => !archivedIds.has(id))));
                  }
                }}
              />
            </span>
          </div>
        )}


        {/* 取消 and 导入 split the row evenly — both carry `flex-1`, so they always take
            an equal share of the footer whatever else is in it. `sm:flex-1` rather than
            `flex-1`: below `sm` the footer stacks into a column, where a flex share of an
            auto-height container would collapse both buttons. */}
        <DialogFooter>
          {outcomes ? (
            <Button size="sm" onClick={onClose}>
              {t("import.done")}
            </Button>
          ) : (
            <>
              <Button size="sm" variant="ghost" className="sm:flex-1" disabled={running} onClick={onClose}>
                {t("import.cancel")}
              </Button>
              <Button
                size="sm"
                className="sm:flex-1"
                disabled={running || selected.size === 0}
                onClick={() => void run()}
              >
                {running ? <Spinner className="size-3.5" /> : null}
                {running ? t("import.importing") : t("import.importCount", { count: selected.size })}
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
  const { t } = useTranslation("settings");
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
              {t("import.alreadyImported")}
            </Badge>
          ) : null}
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <span>{formatDay(candidate.updatedAt)}</span>
          {candidate.archived ? <Badge variant="outline">{t("import.archivedBadge")}</Badge> : null}
          {candidate.messageCount !== undefined ? <span>· {t("import.messages", { count: candidate.messageCount })}</span> : null}
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
  const { t } = useTranslation("settings");
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
              {t("import.importedCount", { count: succeeded.length })}
            </div>
            <ul className="space-y-1">
              {succeeded.map((outcome) => (
                <li key={outcome.id} className="truncate text-xs text-muted-foreground">
                  {outcome.title} · {t("import.messages", { count: outcome.messages })}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {notes.length > 0 ? (
          <div className="space-y-1">
            <div className="text-xs font-medium">{t("import.notes")}</div>
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
            <div className="text-xs font-medium">{t("import.missingDir")}</div>
            <ul className="space-y-0.5">
              {relocated.map((outcome) => (
                <li key={outcome.id} className="truncate text-xs text-muted-foreground">
                  {outcome.title} · {t("import.movedToWorkspace")}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {failed.length > 0 ? (
          <div className="space-y-1">
            <div className="text-xs font-medium text-destructive">{t("import.failedCount", { count: failed.length })}</div>
            <ul className="space-y-0.5">
              {failed.map((outcome) => (
                <li key={outcome.id} className="text-xs text-muted-foreground">
                  {outcome.title} · {outcome.error ?? t("import.unknownError")}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {succeeded.length === 0 && failed.length === 0 ? (
          <p className="py-10 text-center text-xs text-muted-foreground">{t("import.noneImported")}</p>
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
