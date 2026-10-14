import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  Clock01Icon,
  Delete02Icon,
  PanelLeftOpenIcon,
  PauseIcon,
  PencilEdit02Icon,
  PlayIcon,
  StopIcon,
} from "@hugeicons/core-free-icons";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { IconButton } from "@/components/icon-button";
import { RunningMark } from "@/components/running-mark";
import { TaskForm } from "@/components/schedules/task-form";
import {
  WEEKDAY_ORDER,
  draftFromForm,
  emptyScheduleForm,
  formFromTask,
  sortTasks,
  validateScheduleForm,
  type ScheduleFormError,
  type ScheduleFormState,
} from "@/components/schedules/schedule-time";
import { SchedulesUnavailableError, schedulesApi } from "@/components/schedules/schedules-client";
import { activeLanguage, i18n } from "@/lib/i18n";
import { localeTag } from "@/lib/language";
import { cn } from "@/lib/utils";
import type { ScheduleRule, ScheduledRunStatus, ScheduledTask, ScheduledTaskPatch, ScheduledTaskRun, ScheduledTaskSnapshot } from "@shared/schedules";
import type { Project } from "@shared/types";

type Panel =
  | { kind: "list" }
  | { kind: "create" }
  | { kind: "view"; id: string }
  | { kind: "edit"; id: string };

/**
 * 定时任务 — a page of the main column, same shell as 智能体 and 插件: a card grid,
 * and a dialog for the task you opened (details, history, and the create/edit form).
 */
export function TasksPage({
  projects,
  sidebarCollapsed,
  onExpandSidebar,
  onOpenConversation,
}: {
  projects: Project[];
  sidebarCollapsed: boolean;
  onExpandSidebar: () => void;
  /** The shell's own open-chat path, so a run's conversation is a normal navigation. */
  onOpenConversation: (conversationId: string) => void;
}): JSX.Element {
  const { t } = useTranslation("schedules");
  const { t: tApp } = useTranslation("app");
  const [snapshot, setSnapshot] = useState<ScheduledTaskSnapshot | null>(null);
  const [ready, setReady] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [panel, setPanel] = useState<Panel>({ kind: "list" });
  const [form, setForm] = useState<ScheduleFormState>(() => emptyScheduleForm());
  const [formError, setFormError] = useState<ScheduleFormError | null>(null);
  const [history, setHistory] = useState<ScheduledTaskRun[]>([]);
  const [historyReady, setHistoryReady] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ScheduledTask | null>(null);
  const historyFor = useRef<string | null>(null);

  const tasks = useMemo(() => sortTasks(snapshot?.tasks ?? []), [snapshot]);
  const viewedId = panel.kind === "view" || panel.kind === "edit" ? panel.id : null;
  const viewed = viewedId ? tasks.find((task) => task.id === viewedId) : undefined;

  useEffect(() => {
    let unsubscribe = () => {};
    let cancelled = false;
    const fail = (err: unknown): void => {
      if (cancelled) return;
      if (err instanceof SchedulesUnavailableError) setUnavailable(true);
      else toast.error(messageOf(err, t("loadFailed")));
      setReady(true);
    };
    try {
      const api = schedulesApi();
      unsubscribe = api.onChanged((next) => {
        if (!cancelled) setSnapshot((current) => current && current.revision > next.revision ? current : next);
      });
      void api
        .list()
        .then((next) => {
          if (cancelled) return;
          setSnapshot((current) => current && current.revision > next.revision ? current : next);
          setReady(true);
        })
        .catch(fail);
    } catch (err) {
      fail(err);
    }
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [t]);

  useEffect(() => {
    if (!viewedId) return;
    if (tasks.some((task) => task.id === viewedId)) return;
    setPanel({ kind: "list" });
  }, [tasks, viewedId]);

  const reloadHistory = useCallback(
    async (id: string): Promise<ScheduledTaskRun[]> => {
      const runs = await schedulesApi().history(id);
      setHistory(runs);
      setHistoryReady(true);
      return runs;
    },
    [],
  );

  useEffect(() => {
    if (!viewedId) {
      historyFor.current = null;
      setHistory([]);
      setHistoryReady(false);
      return;
    }
    let cancelled = false;
    if (historyFor.current !== viewedId) {
      historyFor.current = viewedId;
      setHistory([]);
      setHistoryReady(false);
    }
    try {
      void schedulesApi()
        .history(viewedId)
        .then((runs) => {
          if (!cancelled) setHistory(runs);
        })
        .catch((err: unknown) => {
          if (!cancelled) toast.error(messageOf(err, t("loadFailed")));
        })
        .finally(() => {
          if (!cancelled) setHistoryReady(true);
        });
    } catch (err) {
      if (!cancelled) {
        if (err instanceof SchedulesUnavailableError) setUnavailable(true);
        else toast.error(messageOf(err, t("loadFailed")));
        setHistoryReady(true);
      }
    }
    return () => {
      cancelled = true;
    };
  }, [viewedId, snapshot?.revision, t]);

  const detailRunning = Boolean(viewedId && history.some((run) => run.taskId === viewedId && run.status === "running"));
  const showList = ready && !unavailable && tasks.length > 0;

  function runningOf(task: ScheduledTask): boolean {
    if (task.id === viewedId && historyReady) return detailRunning;
    return task.lastStatus === "running";
  }

  function backToList(): void {
    setFormError(null);
    setPanel({ kind: "list" });
  }

  function startCreate(): void {
    setForm(emptyScheduleForm());
    setFormError(null);
    setPanel({ kind: "create" });
  }

  function startEdit(task: ScheduledTask): void {
    setForm(formFromTask(task));
    setFormError(null);
    setPanel({ kind: "edit", id: task.id });
  }

  async function act(key: string, run: () => Promise<void>, fallback = t("actionFailed")): Promise<void> {
    if (busy) return;
    setBusy(key);
    try {
      await run();
    } catch (err) {
      if (err instanceof SchedulesUnavailableError) setUnavailable(true);
      toast.error(messageOf(err, fallback));
    } finally {
      setBusy(null);
    }
  }

  function save(): void {
    const error = validateScheduleForm(form);
    setFormError(error);
    if (error) return;
    const draft = draftFromForm(form);
    if (!draft) return;
    const editingId = panel.kind === "edit" ? panel.id : null;
    void act(editingId ? `save:${editingId}` : "create", async () => {
      const api = schedulesApi();
      if (editingId) {
        // Empty string clears a previously bound project. JSON would drop `undefined`.
        const patch: ScheduledTaskPatch = {
          name: draft.name,
          prompt: draft.prompt,
          schedule: draft.schedule,
          project: draft.project ?? "",
        };
        const saved = await api.update(editingId, patch);
        adopt(saved);
        setPanel({ kind: "view", id: saved.id });
        toast.success(t("saved"));
        return;
      }
      const created = await api.create(draft);
      adopt(created);
      setPanel({ kind: "view", id: created.id });
      toast.success(t("created"));
    });
  }

  function adopt(task: ScheduledTask): void {
    setSnapshot((current) => ({
      revision: current?.revision ?? 0,
      tasks: [...(current?.tasks ?? []).filter((item) => item.id !== task.id), task],
    }));
  }

  function setEnabled(task: ScheduledTask, enabled: boolean): void {
    void act(`enabled:${task.id}`, async () => {
      const saved = await schedulesApi().update(task.id, { enabled });
      adopt(saved);
      toast.success(enabled ? t("resumed") : t("paused"));
    });
  }

  function runNow(task: ScheduledTask): void {
    void act(`run:${task.id}`, async () => {
      const api = schedulesApi();
      const run = await api.runNow(task.id);
      const runs = await api.history(task.id).catch(() => [run]);
      setHistory(runs.some((item) => item.id === run.id) ? runs : [run, ...runs]);
      setHistoryReady(true);
      toast.success(t("ran"));
    });
  }

  function stopRun(task: ScheduledTask): void {
    void act(`stop:${task.id}`, async () => {
      const stopped = await schedulesApi().stopRun(task.id);
      await reloadHistory(task.id).catch(() => undefined);
      toast.success(stopped ? t("stopped") : t("stopMissed"));
    });
  }

  function remove(task: ScheduledTask): void {
    void act(`delete:${task.id}`, async () => {
      const removed = await schedulesApi().remove(task.id);
      if (!removed) {
        toast.error(t("deleteMissing"));
      } else {
        setSnapshot((current) =>
          current
            ? { revision: current.revision, tasks: current.tasks.filter((item) => item.id !== task.id) }
            : current,
        );
        toast.success(t("deleted"));
      }
      setPendingDelete(null);
      if (viewedId === task.id) setPanel({ kind: "list" });
    });
  }

  const showingForm = panel.kind === "create" || panel.kind === "edit";
  const dialogOpen = panel.kind !== "list" && (showingForm || Boolean(viewed));

  function closeDialog(): void {
    if (busy) return;
    backToList();
  }

  return (
    <div className="@container/tasks flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="drag-region shrink-0 pt-4">
        <div className="mx-auto flex w-full max-w-5xl items-start gap-1 px-6 pb-3">
          {sidebarCollapsed ? (
            <IconButton size="icon-sm" variant="ghost" label={tApp("workspace.expandSidebar")} onClick={onExpandSidebar} className="no-drag mt-0.5">
              <HugeiconsIcon strokeWidth={2} icon={PanelLeftOpenIcon} />
            </IconButton>
          ) : null}
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="min-w-0 flex-1 truncate text-xl font-medium tracking-tight">{t("title")}</h1>
              <Button size="sm" className="no-drag" disabled={unavailable || Boolean(busy)} onClick={startCreate}>
                <HugeiconsIcon strokeWidth={2} icon={Add01Icon} data-icon="inline-start" />
                {t("new")}
              </Button>
            </div>
            <p className="text-sm leading-5 text-muted-foreground">{t("lifetime")}</p>
          </div>
        </div>
      </header>
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-6 pb-10 pt-1">
          {!ready ? (
            <div className="flex justify-center py-16">
              <Spinner />
            </div>
          ) : unavailable ? (
            <p className="py-16 text-center text-sm text-muted-foreground">{t("unavailable")}</p>
          ) : tasks.length === 0 ? (
            <EmptyState onCreate={startCreate} />
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3">
              {tasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  running={runningOf(task)}
                  onOpen={() => {
                    setFormError(null);
                    setPanel({ kind: "view", id: task.id });
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </ScrollArea>
      <Dialog open={dialogOpen} onOpenChange={(open) => { if (!open) closeDialog(); }}>
        <DialogContent className="@container/tasks flex max-h-[88vh] min-h-0 flex-col gap-4 overflow-hidden sm:max-w-3xl">
          <DialogHeader>
            {showingForm || !viewed ? (
              <DialogTitle>{panel.kind === "edit" ? t("editTitle") : t("createTitle")}</DialogTitle>
            ) : (
              <div className="flex flex-wrap items-center gap-2 pr-8">
                <DialogTitle className="min-w-0 truncate">{viewed.name}</DialogTitle>
                <TaskBadge task={viewed} running={historyReady ? detailRunning : viewed.lastStatus === "running"} />
              </div>
            )}
          </DialogHeader>
          <div className="-mx-1 min-h-0 overflow-y-auto px-1">
            {showingForm ? (
              <TaskForm
                form={form}
                projects={projects}
                error={formError}
                saving={Boolean(busy)}
                onChange={(patch) => {
                  setForm((current) => ({ ...current, ...patch }));
                  setFormError(null);
                }}
                onSubmit={save}
                onCancel={() => {
                  if (panel.kind === "edit") setPanel({ kind: "view", id: panel.id });
                  else backToList();
                }}
              />
            ) : viewed ? (
              <TaskDetail
                task={viewed}
                projects={projects}
                running={historyReady ? detailRunning : viewed.lastStatus === "running"}
                history={history}
                historyReady={historyReady}
                busy={busy}
                onEdit={() => startEdit(viewed)}
                onPause={() => setEnabled(viewed, false)}
                onResume={() => setEnabled(viewed, true)}
                onRun={() => runNow(viewed)}
                onStop={() => stopRun(viewed)}
                onDelete={() => setPendingDelete(viewed)}
                onOpenConversation={onOpenConversation}
              />
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
      <AlertDialog open={pendingDelete !== null} onOpenChange={(open) => { if (!open && !busy) setPendingDelete(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("deleteDesc", { name: pendingDelete?.name ?? "" })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={Boolean(busy)}>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={Boolean(busy) || !pendingDelete}
              onClick={() => {
                if (pendingDelete) remove(pendingDelete);
              }}
            >
              {t("deleteAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** One task on the page. The card opens its dialog; nothing on it acts on its own. */
function TaskCard({ task, running, onOpen }: { task: ScheduledTask; running: boolean; onOpen: () => void }): JSX.Element {
  const { t } = useTranslation("schedules");
  return (
    <div
      role="button"
      tabIndex={0}
      className={cn(
        "group flex min-w-0 cursor-pointer flex-col gap-2.5 rounded-xl border border-border bg-card/80 p-3 text-left transition-colors",
        "hover:border-primary/30 hover:bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
      )}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-info/10 text-info ring-1 ring-info/15">
          {running ? <RunningMark /> : <HugeiconsIcon strokeWidth={1.8} icon={Clock01Icon} className="size-5" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" title={task.name}>{task.name}</p>
          <p className="truncate text-xs text-muted-foreground" title={scheduleSummary(task.schedule, t)}>{scheduleSummary(task.schedule, t)}</p>
        </div>
      </div>
      <p className="line-clamp-2 min-h-8 text-xs leading-4 text-muted-foreground">{task.prompt}</p>
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {t("next")} {formatWhen(task.enabled ? task.nextRunAt : undefined)}
        </span>
        <TaskBadge task={task} running={running} />
      </div>
    </div>
  );
}

function TaskDetail({
  task,
  projects,
  running,
  history,
  historyReady,
  busy,
  onEdit,
  onPause,
  onResume,
  onRun,
  onStop,
  onDelete,
  onOpenConversation,
}: {
  task: ScheduledTask;
  projects: Project[];
  running: boolean;
  history: ScheduledTaskRun[];
  historyReady: boolean;
  busy: string | null;
  onEdit: () => void;
  onPause: () => void;
  onResume: () => void;
  onRun: () => void;
  onStop: () => void;
  onDelete: () => void;
  onOpenConversation: (conversationId: string) => void;
}): JSX.Element {
  const { t } = useTranslation("schedules");
  const locked = Boolean(busy);
  const projectName = task.project
    ? projects.find((project) => project.cwd === task.project)?.name ?? task.project
    : t("projectScratch");
  const runs = [...history].sort((a, b) => b.scheduledAt - a.scheduledAt || b.id.localeCompare(a.id));

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">{scheduleSummary(task.schedule, t)}</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={locked} onClick={onEdit}>
          <HugeiconsIcon strokeWidth={2} icon={PencilEdit02Icon} data-icon="inline-start" />
          {t("edit")}
        </Button>
        {task.enabled ? (
          <Button size="sm" variant="outline" disabled={locked} onClick={onPause}>
            <HugeiconsIcon strokeWidth={2} icon={PauseIcon} data-icon="inline-start" />
            {t("pause")}
          </Button>
        ) : task.schedule.kind !== "once" || Date.parse(task.schedule.at) > Date.now() ? (
          <Button size="sm" variant="outline" disabled={locked} onClick={onResume}>
            <HugeiconsIcon strokeWidth={2} icon={PlayIcon} data-icon="inline-start" />
            {t("resume")}
          </Button>
        ) : null}
        {running ? (
          <Button size="sm" variant="outline" disabled={locked} onClick={onStop}>
            <HugeiconsIcon strokeWidth={2} icon={StopIcon} data-icon="inline-start" />
            {t("stop")}
          </Button>
        ) : (
          <Button size="sm" disabled={locked} onClick={onRun}>
            <HugeiconsIcon strokeWidth={2} icon={PlayIcon} data-icon="inline-start" />
            {t("runNow")}
          </Button>
        )}
        <Button size="sm" variant="destructive" disabled={locked} onClick={onDelete}>
          <HugeiconsIcon strokeWidth={2} icon={Delete02Icon} data-icon="inline-start" />
          {t("delete")}
        </Button>
      </div>
      <dl className="grid gap-3 text-sm @min-[28rem]/tasks:grid-cols-2">
        <Fact label={t("project")} value={projectName} />
        <Fact label={t("next")} value={formatWhen(task.enabled ? task.nextRunAt : undefined)} />
        <Fact label={t("last")} value={formatWhen(task.lastRunAt)} />
        {task.notifyConversationId ? (
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs text-muted-foreground">{t("notify")}</dt>
            <dd className="text-sm">
              <Button
                variant="link"
                size="sm"
                className="h-auto px-0"
                onClick={() => onOpenConversation(task.notifyConversationId!)}
              >
                {t("notifyOpen")}
              </Button>
            </dd>
          </div>
        ) : null}
      </dl>
      <section className="flex flex-col gap-1.5">
        <h3 className="text-sm font-medium">{t("prompt")}</h3>
        <p className="whitespace-pre-wrap rounded-xl border border-border bg-muted/40 px-3 py-2 text-sm">{task.prompt}</p>
      </section>
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">{t("history")}</h3>
        {!historyReady ? (
          <p className="text-sm text-muted-foreground">{t("historyLoading")}</p>
        ) : runs.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border px-3 py-8 text-center text-sm text-muted-foreground">{t("historyEmpty")}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {runs.map((run) => (
              <li key={run.id} className="flex flex-col gap-1.5 rounded-xl border border-border px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={run.status} />
                  {run.manual ? <Badge variant="outline">{t("manual")}</Badge> : null}
                  <span className="min-w-0 flex-1 text-xs text-muted-foreground">{t("scheduledAt", { time: formatWhen(run.scheduledAt) })}</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {[
                    run.startedAt ? t("startedAt", { time: formatWhen(run.startedAt) }) : null,
                    run.endedAt ? t("endedAt", { time: formatWhen(run.endedAt) }) : null,
                  ].filter(Boolean).join(" · ")}
                </p>
                {run.error ? <p className="text-xs text-destructive">{run.error}</p> : null}
                {run.conversationId ? (
                  <Button
                    variant="link"
                    size="sm"
                    className="h-auto justify-start px-0"
                    onClick={() => onOpenConversation(run.conversationId!)}
                  >
                    {t("openConversation")}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }): JSX.Element {
  const { t } = useTranslation("schedules");
  return (
    <Empty className="border-0 py-16">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <HugeiconsIcon strokeWidth={2} icon={Clock01Icon} />
        </EmptyMedia>
        <EmptyTitle>{t("emptyTitle")}</EmptyTitle>
        <EmptyDescription>{t("emptyDesc")}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button onClick={onCreate}>
          <HugeiconsIcon strokeWidth={2} icon={Add01Icon} data-icon="inline-start" />
          {t("new")}
        </Button>
      </EmptyContent>
    </Empty>
  );
}

function Fact({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate text-sm" title={value}>{value}</dd>
    </div>
  );
}

function TaskBadge({ task, running }: { task: ScheduledTask; running: boolean }): JSX.Element {
  if (running) return <StatusBadge status="running" />;
  if (!task.enabled) {
    if (task.schedule.kind === "once" && task.lastStatus && task.lastStatus !== "running") return <StatusBadge status={task.lastStatus} />;
    return <StatusBadge status="paused" />;
  }
  // A recurring task stays scheduled after a finished run; the last outcome lives in history.
  return <StatusBadge status="scheduled" />;
}

function StatusBadge({ status }: { status: ScheduledRunStatus | "paused" | "scheduled" }): JSX.Element {
  const { t } = useTranslation("schedules");
  const variant = status === "failed" || status === "interrupted" ? "destructive" : status === "running" ? "default" : "secondary";
  return <Badge variant={variant}>{t(`status.${status}`)}</Badge>;
}

function scheduleSummary(rule: ScheduleRule, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (rule.kind === "once") return t("summary.once", { time: formatIso(rule.at) });
  if (rule.kind === "daily") return t("summary.daily", { time: rule.time, zone: rule.timeZone });
  const days = WEEKDAY_ORDER.filter((day) => rule.days.includes(day)).map((day) => t(`days.${day}`)).join(t("summary.daySep"));
  return t("summary.weekly", { days, time: rule.time, zone: rule.timeZone });
}

function formatWhen(ms: number | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return i18n.t("schedules:none");
  return new Date(ms).toLocaleString(localeTag(activeLanguage()), { dateStyle: "medium", timeStyle: "short" });
}

function formatIso(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? formatWhen(ms) : iso;
}

function messageOf(err: unknown, fallback: string): string {
  if (err instanceof SchedulesUnavailableError) return fallback;
  return err instanceof Error && err.message ? err.message : fallback;
}
