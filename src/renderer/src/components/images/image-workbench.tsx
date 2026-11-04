import { useEffect, useRef, useState, type ChangeEvent, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { HugeiconsIcon } from "@hugeicons/react";
import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area";
import { Add01Icon, ArrowUp02Icon, Cancel01Icon, Delete02Icon, Image01Icon, MoreHorizontalIcon, PencilEdit02Icon, SidebarLeft01Icon, SparklesIcon } from "@hugeicons/core-free-icons";
import { toast } from "sonner";
import type { ImageOptions, ImageReferenceInput, ImageSession, ImagesApi, ImageTask } from "@shared/image-generation";
import { isUsableImageModel } from "@shared/image-model";
import { inlineSrc } from "@shared/inline-media";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { HAS_TRAFFIC_LIGHTS } from "@/lib/platform";
import { cleanError } from "@/lib/ipc-error";
import { cn } from "@/lib/utils";
import { ImageSelect } from "./image-select";
import { ImageTaskCard } from "./image-task-card";
import { ImageGallery } from "./image-gallery";
import { useImageWorkbench } from "./use-image-workbench";

type Draft = { prompt: string; modelId?: string; options: ImageOptions; references: ImageReferenceInput[] };
const EMPTY_DRAFT: Draft = { prompt: "", options: {}, references: [] };
const ASPECT_RATIOS = ["1:1", "3:2", "2:3", "16:9", "9:16"];
const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;

function referenceSrc(reference: ImageReferenceInput): string {
  return "path" in reference ? inlineSrc({ ref: reference.path }) : `data:${reference.mimeType};base64,${reference.data}`;
}
function localDay(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}
function readReference(file: File): Promise<ImageReferenceInput> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string" || !result.includes(",")) { reject(new Error("referenceReadFailed")); return; }
      resolve({ data: result.slice(result.indexOf(",") + 1), mimeType: file.type, name: file.name });
    };
    reader.onerror = () => reject(new Error("referenceReadFailed"));
    reader.onabort = () => reject(new Error("referenceReadFailed"));
    reader.readAsDataURL(file);
  });
}

export function ImageWorkbench({
  api = window.fastvibe.images,
  onOpenConversation,
  sidebarCollapsed = false,
  onExpandSidebar,
}: {
  api?: ImagesApi;
  onOpenConversation?: (id: string) => void;
  sidebarCollapsed?: boolean;
  onExpandSidebar?: () => void;
}): JSX.Element {
  const { t, i18n } = useTranslation("images");
  const navigate = useNavigate();
  const { sessions, tasks, config, configLoading, configError, selectedId, loadedSessionId, selectSession, loading, error, refresh, refreshConfig } = useImageWorkbench(api);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [submitting, setSubmitting] = useState<ReadonlySet<string>>(() => new Set());
  const [readingReferences, setReadingReferences] = useState<ReadonlySet<string>>(() => new Set());
  const [showSessions, setShowSessions] = useState(false);
  const [renaming, setRenaming] = useState<ImageSession | null>(null);
  const [rename, setRename] = useState("");
  const [deleting, setDeleting] = useState<ImageSession | null>(null);
  const [deletingTask, setDeletingTask] = useState<ImageTask | null>(null);
  const [mutating, setMutating] = useState(false);
  const [gallery, setGallery] = useState<{ task: ImageTask; index: number } | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const shouldFollow = useRef(true);
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const requestIds = useRef(new Map<string, { draft: Draft; modelId: string; id: string }>());
  const session = sessions.find((item) => item.id === selectedId);
  const draftKey = selectedId ?? "new";
  const draft = drafts[draftKey] ?? EMPTY_DRAFT;
  const modelId = draft.modelId ?? session?.modelId ?? config.defaultModelId ?? "";
  const models = config.models.filter(isUsableImageModel);
  const model = models.find((item) => item.id === modelId);
  const options = { aspectRatio: "1:1", count: 1, ...session?.options, ...draft.options };
  const sending = submitting.has(draftKey);
  const activeTasks = tasks.filter((task) => task.status === "generating");
  const showTasks = loadedSessionId === selectedId;

  useEffect(() => {
    shouldFollow.current = true;
    setGallery(null);
  }, [selectedId]);
  useEffect(() => {
    if (showTasks && shouldFollow.current && timelineRef.current) timelineRef.current.scrollTop = timelineRef.current.scrollHeight;
  }, [tasks, showTasks]);

  const patchDraft = (key: string, patch: Partial<Draft>): void => {
    setDrafts((previous) => ({ ...previous, [key]: { ...(previous[key] ?? EMPTY_DRAFT), ...patch } }));
  };
  const patchOptions = (patch: ImageOptions): void => patchDraft(draftKey, { options: { ...options, ...patch } });
  const run = async (action: () => Promise<unknown>): Promise<boolean> => {
    try { await action(); void refresh(); return true; }
    catch (cause) { toast.error(cleanError(cause)); return false; }
  };
  const clearDeletedReferences = (removedTasks: ImageTask[], sessionId?: string): void => {
    const paths = new Set(removedTasks.flatMap((task) => [...task.references, ...task.images].map((image) => image.path)));
    setDrafts((previous) => Object.fromEntries(Object.entries(previous)
      .filter(([key]) => key !== sessionId)
      .map(([key, value]) => [key, { ...value, references: value.references.filter((reference) => !("path" in reference) || !paths.has(reference.path)) }])));
    setGallery((current) => current && (current.task.sessionId === sessionId || removedTasks.some((task) => task.id === current.task.id)) ? null : current);
  };
  const chooseSession = (id?: string): void => {
    selectSession(id);
    setShowSessions(false);
  };

  const submit = async (override?: ImageTask): Promise<void> => {
    const key = draftKey;
    const material: Draft = override ? { prompt: override.prompt, modelId: override.model.id, options: override.options, references: override.references } : draft;
    const chosenModel = override ? override.model.id : modelId;
    if (configLoading) { toast.info(t("configuration.loading")); return; }
    if (configError) { toast.error(t("configuration.loadFailed")); return; }
    if (!models.some((item) => item.id === chosenModel)) {
      toast.error(t(models.length ? "composer.unavailableModel" : "configuration.description"));
      return;
    }
    if (!material.prompt.trim() || submitting.has(key) || (!override && readingReferences.has(key))) return;
    const previous = requestIds.current.get(key);
    const requestId = previous?.draft === material && previous.modelId === chosenModel ? previous.id : crypto.randomUUID();
    requestIds.current.set(key, { draft: material, modelId: chosenModel, id: requestId });
    setSubmitting((current) => new Set(current).add(key));
    const submittedSession = selectedId;
    try {
      const currentOptions = { ...(override ? override.options : options) };
      // Grok currently has no shared size control; never forward a stale GPT size on model switches.
      const protocol = config.models.find((item) => item.id === chosenModel)?.protocol;
      if (protocol === "grok") delete currentOptions.size;
      if (protocol === "openai") {
        const sizes: Record<string, string> = { "1:1": "1024x1024", "3:2": "1536x1024", "2:3": "1024x1536" };
        if (!sizes[currentOptions.aspectRatio ?? "1:1"]) {
          toast.error(t("composer.unsupportedRatio"));
          return;
        }
        currentOptions.size = sizes[currentOptions.aspectRatio ?? "1:1"];
      }
      delete currentOptions.quality;
      const task = await api.generate({ requestId, sessionId: submittedSession, prompt: material.prompt.trim(), modelId: chosenModel, options: currentOptions, references: material.references.slice(0, 1) });
      requestIds.current.delete(key);
      if (!override) {
        setDrafts((previousDrafts) => {
          const current = previousDrafts[key] ?? EMPTY_DRAFT;
          // Typing or adding a reference while acceptance is in flight must not be erased.
          if (current !== material) return previousDrafts;
          return { ...previousDrafts, [key]: { ...current, prompt: "", references: [] } };
        });
      }
      if (!submittedSession && selectedRef.current === undefined) {
        setDrafts((previousDrafts) => {
          const latest = previousDrafts[key] ?? EMPTY_DRAFT;
          const next = { ...previousDrafts, [task.sessionId]: previousDrafts[task.sessionId] ?? { ...latest, modelId: chosenModel, options: currentOptions } };
          delete next[key];
          return next;
        });
        chooseSession(task.sessionId);
      }
      shouldFollow.current = true;
      void refresh();
    } catch (cause) { toast.error(cleanError(cause)); }
    finally { setSubmitting((current) => { const next = new Set(current); next.delete(key); return next; }); }
  };

  const addReferences = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const key = draftKey;
    const files = Array.from(event.target.files ?? []).slice(0, 1);
    event.target.value = "";
    if (files.some((file) => !["image/png", "image/jpeg", "image/webp"].includes(file.type))) { toast.error(t("composer.invalidReference")); return; }
    if (files.some((file) => file.size > MAX_REFERENCE_BYTES)) { toast.error(t("composer.referenceTooLarge")); return; }
    setReadingReferences((current) => new Set(current).add(key));
    try {
      const references = await Promise.all(files.map(readReference));
      setDrafts((previous) => {
        const current = previous[key] ?? EMPTY_DRAFT;
        return { ...previous, [key]: { ...current, references } };
      });
    } catch { toast.error(t("composer.referenceReadFailed")); }
    finally { setReadingReferences((current) => { const next = new Set(current); next.delete(key); return next; }); }
  };

  const editTask = (task: ImageTask): void => {
    patchDraft(draftKey, { prompt: task.prompt, references: task.references.slice(0, 1), modelId: task.model.id, options: task.options });
    textRef.current?.focus();
  };
  const dateLabel = (timestamp: number): string => {
    if (localDay(timestamp) === localDay(Date.now())) return t("today");
    const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
    if (localDay(timestamp) === localDay(yesterday.getTime())) return t("yesterday");
    return new Intl.DateTimeFormat(i18n.language, { year: "numeric", month: "long", day: "numeric" }).format(timestamp);
  };

  const sessionList = <div className="flex min-h-0 flex-1 flex-col text-sidebar-foreground">
    <div className="shrink-0 px-2 pt-2"><Button variant="ghost" className="h-8 w-full justify-start gap-2.5 px-2 text-sm font-normal hover:bg-sidebar-accent/50 pointer-coarse:h-10" onClick={() => chooseSession()}><HugeiconsIcon icon={Add01Icon} strokeWidth={2} className="size-3.5 text-muted-foreground" />{t("newSession")}</Button></div>
    <ScrollArea className="sidebar-scroll min-h-0 flex-1" aria-label={t("sessions")}>
      <ScrollAreaPrimitive.Content className="px-2 pb-3 pt-3" style={{ minWidth: 0 }}>
      {sessions.length ? <div className="space-y-0.5">{sessions.map((item) => <ContextMenu key={item.id}>
        <ContextMenuTrigger render={<div className={cn("group flex h-8 min-w-0 items-center gap-2.5 rounded-md pr-1 text-sm transition-colors pointer-coarse:h-10", selectedId === item.id ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-sidebar-accent/50")} />}>
          <button type="button" onClick={() => chooseSession(item.id)} aria-current={selectedId === item.id ? "page" : undefined} className="flex h-full min-w-0 flex-1 items-center px-2 text-left text-sm">
            <span className="min-w-0 flex-1 truncate">{item.title || t("untitled")}</span>
          </button>
          <span className="relative flex size-6 shrink-0 items-center justify-center">
            {item.id === selectedId && activeTasks.length ? <span className="pointer-events-none size-1.5 rounded-full bg-primary group-hover:opacity-0 group-focus-within:opacity-0 group-has-[[data-slot=dropdown-menu-trigger][aria-expanded=true]]:opacity-0 pointer-coarse:hidden" aria-label={t("status.generating")} /> : null}
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label={t("more")} className="absolute inset-0 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 aria-expanded:opacity-100 pointer-coarse:opacity-100" />}><HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} className="size-3.5" /></DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => { setRenaming(item); setRename(item.title); }}><HugeiconsIcon icon={PencilEdit02Icon} />{t("rename")}</DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onClick={() => setDeleting(item)}><HugeiconsIcon icon={Delete02Icon} />{t("actions.delete")}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={() => { setRenaming(item); setRename(item.title); }}><HugeiconsIcon icon={PencilEdit02Icon} />{t("rename")}</ContextMenuItem>
          <ContextMenuItem variant="destructive" onClick={() => setDeleting(item)}><HugeiconsIcon icon={Delete02Icon} />{t("actions.delete")}</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>)}</div> : <p className="px-3 py-5 text-xs leading-5 text-muted-foreground">{t("emptySessions")}</p>}
      </ScrollAreaPrimitive.Content>
    </ScrollArea>
  </div>;

  return <div className="flex size-full min-h-0 min-w-0 text-foreground" data-image-workbench>
    <aside className={cn("floating-pane hidden w-52 shrink-0 flex-col bg-sidebar text-sidebar-foreground md:flex", sidebarCollapsed && HAS_TRAFFIC_LIGHTS && "pt-12")}>{sessionList}</aside>
    <main className="flex min-h-0 min-w-0 flex-1 flex-col @container/image-timeline">
      <header className={cn("flex h-12 shrink-0 items-center gap-2 border-b border-border/50 px-4", sidebarCollapsed && HAS_TRAFFIC_LIGHTS && "pl-24 md:pl-4")}>
        {sidebarCollapsed ? <Button size="icon-sm" variant="ghost" aria-label={t("expandSidebar")} onClick={onExpandSidebar}><HugeiconsIcon icon={SidebarLeft01Icon} /></Button> : null}
        <Button size="icon-sm" variant="ghost" className="md:hidden" aria-label={t("sessions")} onClick={() => setShowSessions(true)}><HugeiconsIcon icon={Image01Icon} /></Button>
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium">{session?.title || t("title")}</h1>
        {session?.sourceConversationId && onOpenConversation ? <Button variant="ghost" size="sm" onClick={() => onOpenConversation(session.sourceConversationId!)}>{t("backToChat")}</Button> : null}
      </header>
      <div ref={timelineRef} className="min-h-0 flex-1 overflow-y-auto px-4 [scrollbar-gutter:stable] sm:px-8" onScroll={(event) => { const element = event.currentTarget; shouldFollow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100; }}>
        {error ? <div role="alert" className="mx-auto flex max-w-5xl items-start gap-3 py-5"><p className="flex-1 text-sm text-destructive wrap-anywhere">{error}</p><Button variant="outline" size="sm" onClick={() => { void refresh(); }}>{t("actions.retry")}</Button></div> : null}
        {loading ? <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{t("loading")}</div> : showTasks && tasks.length ? <div className="mx-auto max-w-6xl space-y-9 py-7 sm:py-10">{tasks.map((task, index) => <div key={task.id} className="space-y-5">
          {index === 0 || localDay(task.createdAt) !== localDay(tasks[index - 1].createdAt) ? <h2 className="text-sm font-medium">{dateLabel(task.createdAt)}</h2> : null}
          <ImageTaskCard task={task} onDelete={setDeletingTask} onEdit={editTask} onRegenerate={(item) => { void submit(item); }} onCancel={(item) => { void run(() => api.cancel(item.id)); }} onPreview={(item, imageIndex) => setGallery({ task: item, index: imageIndex })} />
        </div>)}</div> : !selectedId || showTasks ? <Empty className="min-h-full gap-4 py-16"><EmptyHeader className="max-w-md gap-3"><EmptyMedia><div className="relative flex size-16 items-center justify-center rounded-2xl border border-border bg-muted/30"><HugeiconsIcon icon={SparklesIcon} className="size-7 text-primary" /></div></EmptyMedia><EmptyTitle className="text-2xl font-medium tracking-tight">{t("emptyTitle")}</EmptyTitle><EmptyDescription>{t("emptyDescription")}</EmptyDescription></EmptyHeader></Empty> : null}
      </div>
      <div className="shrink-0 px-4 pb-4 pt-3 sm:px-8 sm:pb-6">
        {configLoading ? <p role="status" className="mx-auto mb-3 max-w-6xl px-1 text-sm text-muted-foreground">{t("configuration.loading")}</p> : configError ? <div role="alert" className="mx-auto mb-3 flex max-w-6xl flex-wrap items-start gap-3 rounded-xl border border-destructive/25 bg-destructive/5 p-4">
          <div className="min-w-0 flex-1 space-y-1"><p className="text-sm font-medium">{t("configuration.loadFailed")}</p><p className="text-xs text-muted-foreground">{t("configuration.retryDescription")}</p><p className="text-xs text-destructive wrap-anywhere">{configError}</p></div>
          <Button variant="outline" size="sm" onClick={() => { void refreshConfig(); }}>{t("actions.retry")}</Button>
        </div> : !models.length || !model ? <Empty className="mx-auto mb-3 max-w-6xl flex-row flex-wrap justify-between gap-3 rounded-xl border border-border bg-muted/30 p-4 text-left" role="status">
          <EmptyHeader className="max-w-lg items-start gap-1"><EmptyTitle className="text-sm">{t(!models.length ? "configuration.title" : modelId ? "composer.unavailableModel" : "composer.selectModel")}</EmptyTitle><EmptyDescription className="text-xs">{t(!models.length ? "configuration.description" : "configuration.selectDescription")}</EmptyDescription></EmptyHeader>
          <Button variant="outline" size="sm" onClick={() => navigate("/settings/providers")}>{t("manageModels")}</Button>
        </Empty> : null}
        <form className="mx-auto max-w-6xl rounded-2xl border border-border bg-card/70 p-3 shadow-xs focus-within:border-ring/50" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          {draft.references.length ? <div className="flex flex-wrap gap-2 px-1 pb-2">{draft.references.map((reference, index) => <div key={`${"path" in reference ? reference.path : reference.name}-${index}`} className="group relative size-16">
            <img src={referenceSrc(reference)} alt={t("composer.referenceNumber", { number: index + 1 })} className="size-full rounded-lg border border-border object-cover" />
            <Button type="button" size="icon-xs" variant="secondary" className="absolute -right-1 -top-1 rounded-full" aria-label={t("composer.removeReference", { number: index + 1 })} onClick={() => patchDraft(draftKey, { references: draft.references.filter((_, i) => i !== index) })}><HugeiconsIcon icon={Cancel01Icon} /></Button>
          </div>)}</div> : null}
          <Textarea ref={textRef} aria-label={t("composer.label")} placeholder={t(configLoading ? "configuration.loading" : configError ? "configuration.loadFailed" : !models.length ? "configuration.description" : "composer.placeholder")} value={draft.prompt} onChange={(event) => patchDraft(draftKey, { prompt: event.target.value })}
            onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }}
            className="min-h-24 max-h-52 resize-none border-0 bg-transparent px-1 py-2 text-sm shadow-none ring-0 focus-visible:ring-0 dark:bg-transparent" />
          <input ref={uploadRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(event) => { void addReferences(event); }} />
          <div className="flex flex-wrap items-center gap-2 pt-2">
            <Button type="button" variant="ghost" size="icon-sm" aria-label={t("composer.addReference")} onClick={() => uploadRef.current?.click()}><HugeiconsIcon icon={Add01Icon} /></Button>
            <ImageSelect label={t("composer.model")} value={modelId} onChange={(id) => {
              const nextModel = models.find((item) => item.id === id);
              const aspectRatio = nextModel?.protocol === "openai" && !["1:1", "3:2", "2:3"].includes(options.aspectRatio ?? "1:1") ? "1:1" : options.aspectRatio;
              patchDraft(draftKey, { modelId: id, options: { ...options, aspectRatio, size: undefined, quality: undefined } });
            }}
              options={[...(!modelId ? [{ value: "", label: t("composer.selectModel"), disabled: true }] : []), ...(modelId && !model ? [{ value: modelId, label: t("models.unavailable"), disabled: true }] : []), ...models.map((item) => ({ value: item.id, label: item.name }))]} className="max-w-56 border-transparent bg-muted/40 text-xs" />
            <ImageSelect label={t("composer.aspectRatio")} value={options.aspectRatio ?? "1:1"} onChange={(aspectRatio) => patchOptions({ aspectRatio, ...(model?.protocol === "openai" ? { size: undefined } : {}) })} options={(model?.protocol === "openai" ? ASPECT_RATIOS.slice(0, 3) : ASPECT_RATIOS).map((value) => ({ value, label: value }))} className="border-transparent text-xs" />
            {model?.protocol === "gemini" ? <ImageSelect label={t("composer.size")} value={options.size ?? "1K"} onChange={(size) => patchOptions({ size })} options={["1K", "2K", "4K"].map((value) => ({ value, label: value }))} className="border-transparent text-xs" /> : null}
            <ImageSelect label={t("composer.count")} value={String(options.count ?? 1)} onChange={(count) => patchOptions({ count: Number(count) })} options={[1, 2, 3, 4].map((count) => ({ value: String(count), label: t("composer.countLabel", { count }) }))} className="border-transparent text-xs" />
            <div className="ml-auto"><Button type="submit" size="sm" className="rounded-xl" disabled={configLoading || !!configError || !draft.prompt.trim() || !model || sending || readingReferences.has(draftKey)}><HugeiconsIcon icon={ArrowUp02Icon} />{t(sending ? "composer.submitting" : "composer.generate")}</Button></div>
          </div>
        </form>
        <p className="mx-auto mt-2 max-w-6xl px-1 text-center text-xs text-muted-foreground">{t("composer.parallelHint")}</p>
      </div>
    </main>
    <Dialog open={showSessions} onOpenChange={setShowSessions}><DialogContent className="h-[70vh] p-0"><DialogTitle className="px-4 pt-4">{t("sessions")}</DialogTitle>{sessionList}</DialogContent></Dialog>
    <Dialog open={renaming !== null} disablePointerDismissal onOpenChange={(open) => { if (!open && !mutating) setRenaming(null); }}><DialogContent><DialogHeader><DialogTitle>{t("renameTitle")}</DialogTitle></DialogHeader><form className="space-y-4" onSubmit={(event) => { event.preventDefault(); if (!renaming || !rename.trim()) return; setMutating(true); void run(() => api.renameSession(renaming.id, rename.trim())).then((ok) => { if (ok) setRenaming(null); }).finally(() => setMutating(false)); }}><Input aria-label={t("renameTitle")} autoFocus value={rename} onChange={(event) => setRename(event.target.value)} /><DialogFooter><Button type="button" variant="ghost" disabled={mutating} onClick={() => setRenaming(null)}>{t("actions.cancel")}</Button><Button type="submit" disabled={mutating || !rename.trim()}>{t("actions.save")}</Button></DialogFooter></form></DialogContent></Dialog>
    <Dialog open={deleting !== null} onOpenChange={(open) => { if (!open && !mutating) setDeleting(null); }}><DialogContent><DialogHeader><DialogTitle>{t("deleteTitle")}</DialogTitle><DialogDescription>{t("deleteDescription", { name: deleting?.title })}</DialogDescription></DialogHeader><DialogFooter><Button variant="ghost" disabled={mutating} onClick={() => setDeleting(null)}>{t("actions.cancel")}</Button><Button variant="destructive" disabled={mutating} onClick={() => { if (!deleting) return; const id = deleting.id; setMutating(true); void run(async () => { const snapshot = await api.snapshot(id); await api.deleteSession(id); clearDeletedReferences(snapshot.tasks, id); }).then((ok) => { if (ok) { if (selectedRef.current === id) chooseSession(); setDrafts((previous) => { const next = { ...previous }; delete next[id]; return next; }); setDeleting(null); } }).finally(() => setMutating(false)); }}>{t("actions.delete")}</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={deletingTask !== null} onOpenChange={(open) => { if (!open && !mutating) setDeletingTask(null); }}><DialogContent><DialogHeader><DialogTitle>{t("deleteTaskTitle")}</DialogTitle><DialogDescription>{t("deleteTaskDescription")}</DialogDescription></DialogHeader><DialogFooter><Button variant="ghost" disabled={mutating} onClick={() => setDeletingTask(null)}>{t("actions.cancel")}</Button><Button variant="destructive" disabled={mutating} onClick={() => { if (!deletingTask) return; const task = deletingTask; setMutating(true); void run(() => api.deleteTask(task.id)).then((ok) => { if (ok) { clearDeletedReferences([task]); setDeletingTask(null); } }).finally(() => setMutating(false)); }}>{t("actions.delete")}</Button></DialogFooter></DialogContent></Dialog>
    {gallery ? <ImageGallery task={gallery.task} index={gallery.index} onIndex={(index) => setGallery((current) => current ? { ...current, index } : null)} onClose={() => setGallery(null)} onUseReference={(image) => {
      patchDraft(draftKey, { references: [{ path: image.path }] });
      setGallery(null);
      requestAnimationFrame(() => textRef.current?.focus());
    }} /> : null}
  </div>;
}
