import { useCallback, useEffect, useRef, useState, type ChangeEvent, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, ArrowDown01Icon, ArrowUp02Icon, Cancel01Icon, SidebarLeft01Icon, SparklesIcon } from "@hugeicons/core-free-icons";
import { toast } from "sonner";
import type { ImageOptions, ImageReferenceInput, ImageSession, ImagesApi, ImageTask } from "@shared/image-generation";
import { imageOptionsForResolution, imageRatios, imageResolution, imageResolutions } from "@shared/image-options";
import { isUsableImageModel } from "@shared/image-model";
import { inlineSrc } from "@shared/inline-media";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/icon-button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CHAT_COLUMN_CLASS } from "@/lib/chat-layout";
import { HAS_TRAFFIC_LIGHTS } from "@/lib/platform";
import { cleanError } from "@/lib/ipc-error";
import { cn } from "@/lib/utils";
import { ImageOptionsPicker } from "./image-options-picker";
import { ImageSelect } from "./image-select";
import { ImageSessionList } from "./image-session-list";
import { ImageTaskCard } from "./image-task-card";
import { ImageGallery } from "./image-gallery";
import { useImageWorkbench } from "./use-image-workbench";

type Draft = { prompt: string; modelId?: string; options: ImageOptions; references: ImageReferenceInput[] };
const EMPTY_DRAFT: Draft = { prompt: "", options: {}, references: [] };
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
  const [sessionsOpen, setSessionsOpen] = useState(false);
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
  const creatingSession = useRef(false);
  const ensuringDefault = useRef(false);
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
  const chooseSession = useCallback((id?: string): void => {
    selectSession(id);
    setSessionsOpen(false);
  }, [selectSession]);
  // Popover 新建显式建一个新会话（用服务端默认标题）；只有首次自动创建的那个才叫默认会话。
  const startSession = (): void => {
    if (creatingSession.current) return;
    creatingSession.current = true;
    void api.createSession().then((session) => { chooseSession(session.id); }).catch((cause) => toast.error(cleanError(cause))).finally(() => { creatingSession.current = false; });
  };
  // 第一次打开（或会话被删空后）保证有一个默认会话可落。
  useEffect(() => {
    if (loading || selectedId || sessions.length || ensuringDefault.current) return;
    ensuringDefault.current = true;
    void api.createSession(t("sessionList.default")).then((session) => { chooseSession(session.id); }).catch(() => undefined).finally(() => { ensuringDefault.current = false; });
  }, [api, chooseSession, loading, selectedId, sessions.length, t]);

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
      const chosen = config.models.find((item) => item.id === chosenModel)!;
      const originalOptions = override ? override.options : options;
      const currentOptions = originalOptions.size
        ? { ...originalOptions }
        : imageOptionsForResolution(chosen, originalOptions, originalOptions.aspectRatio ?? "1:1", "1K");
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

  return <div className="flex size-full min-h-0 min-w-0 text-foreground" data-image-workbench>
    <main className="flex min-h-0 min-w-0 flex-1 flex-col @container/image-timeline">
      <h1 className="sr-only">{t("title")}</h1>
      <header className={cn("flex h-12 shrink-0 items-center gap-2 border-b border-border/50 px-4", sidebarCollapsed && HAS_TRAFFIC_LIGHTS && "pl-24 md:pl-4")}>
        {sidebarCollapsed ? <Button size="icon-sm" variant="ghost" aria-label={t("expandSidebar")} onClick={onExpandSidebar}><HugeiconsIcon icon={SidebarLeft01Icon} /></Button> : null}
        <Popover open={sessionsOpen} onOpenChange={setSessionsOpen}>
          <PopoverTrigger render={<Button type="button" variant="ghost" aria-label={t("sessions")} title={session?.title || t("untitled")} className="min-w-0 max-w-64 gap-1 px-2 text-sm font-medium"><span className="min-w-0 truncate">{session?.title || t("untitled")}</span><HugeiconsIcon icon={ArrowDown01Icon} className="size-3.5 shrink-0 text-muted-foreground" /></Button>} />
          <PopoverContent side="bottom" align="start" className="w-[22rem] gap-0 p-0"><div className="flex h-[min(28rem,calc(100dvh-6rem))] flex-col">
            <ImageSessionList sessions={sessions} selectedId={selectedId} generating={activeTasks.length > 0} onSelect={(id) => { setSessionsOpen(false); selectSession(id); }} onCreate={() => { setSessionsOpen(false); startSession(); }} onRename={(item) => { setRenaming(item); setRename(item.title); }} onDelete={setDeleting} />
          </div></PopoverContent>
        </Popover>
        <div className="min-w-0 flex-1" />
        {session?.sourceConversationId && onOpenConversation ? <Button variant="ghost" size="sm" onClick={() => onOpenConversation(session.sourceConversationId!)}>{t("backToChat")}</Button> : null}
      </header>
      <div ref={timelineRef} className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]" onScroll={(event) => { const element = event.currentTarget; shouldFollow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100; }}>
        {error ? <div role="alert" className={cn(CHAT_COLUMN_CLASS, "flex items-start gap-3 py-5")}><p className="flex-1 text-sm text-destructive wrap-anywhere">{error}</p><Button variant="outline" size="sm" onClick={() => { void refresh(); }}>{t("actions.retry")}</Button></div> : null}
        {loading ? <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{t("loading")}</div> : showTasks && tasks.length ? <div className={cn(CHAT_COLUMN_CLASS, "space-y-9 py-7 sm:py-10")}>{tasks.map((task, index) => <div key={task.id} className="space-y-5">
          {index === 0 || localDay(task.createdAt) !== localDay(tasks[index - 1].createdAt) ? <h2 className="text-sm font-medium">{dateLabel(task.createdAt)}</h2> : null}
          <ImageTaskCard task={task} onDelete={setDeletingTask} onEdit={editTask} onRegenerate={(item) => { void submit(item); }} onCancel={(item) => { void run(() => api.cancel(item.id)); }} onPreview={(item, imageIndex) => setGallery({ task: item, index: imageIndex })} onUseReference={(item, image) => {
            patchDraft(draftKey, { references: [{ path: image.path }] });
            textRef.current?.focus();
          }} />
        </div>)}</div> : !selectedId || showTasks ? <Empty className="min-h-full gap-4 py-16"><EmptyHeader className="max-w-md gap-3"><EmptyMedia><div className="relative flex size-16 items-center justify-center rounded-2xl border border-border bg-muted/30"><HugeiconsIcon icon={SparklesIcon} className="size-7 text-primary" /></div></EmptyMedia><EmptyTitle className="text-2xl font-medium tracking-tight">{t("emptyTitle")}</EmptyTitle><EmptyDescription>{t("emptyDescription")}</EmptyDescription></EmptyHeader></Empty> : null}
      </div>
      <div className="shrink-0 pb-4 pt-3 sm:pb-6">
        {configLoading ? <p role="status" className={cn(CHAT_COLUMN_CLASS, "mb-3 text-sm text-muted-foreground")}>{t("configuration.loading")}</p> : configError ? <div role="alert" className={cn(CHAT_COLUMN_CLASS, "mb-3 flex flex-wrap items-start gap-3 rounded-xl border border-destructive/25 bg-destructive/5 p-4")}>
          <div className="min-w-0 flex-1 space-y-1"><p className="text-sm font-medium">{t("configuration.loadFailed")}</p><p className="text-xs text-muted-foreground">{t("configuration.retryDescription")}</p><p className="text-xs text-destructive wrap-anywhere">{configError}</p></div>
          <Button variant="outline" size="sm" onClick={() => { void refreshConfig(); }}>{t("actions.retry")}</Button>
        </div> : !models.length || !model ? <Empty className={cn(CHAT_COLUMN_CLASS, "mb-3 flex-row flex-wrap justify-between gap-3 rounded-xl border border-border bg-muted/30 p-4 text-left")} role="status">
          <EmptyHeader className="max-w-lg items-start gap-1"><EmptyTitle className="text-sm">{t(!models.length ? "configuration.title" : modelId ? "composer.unavailableModel" : "composer.selectModel")}</EmptyTitle><EmptyDescription className="text-xs">{t(!models.length ? "configuration.description" : "configuration.selectDescription")}</EmptyDescription></EmptyHeader>
          <Button variant="outline" size="sm" onClick={() => navigate("/settings/providers")}>{t("manageModels")}</Button>
        </Empty> : null}
        <form className={cn(CHAT_COLUMN_CLASS, "rounded-2xl border border-border bg-card/70 p-3 shadow-xs focus-within:border-ring/50")} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          {draft.references.length ? <div className="flex flex-wrap gap-2 px-1 pb-2">{draft.references.map((reference, index) => <div key={`${"path" in reference ? reference.path : reference.name}-${index}`} className="group relative size-16">
            <img src={referenceSrc(reference)} alt={t("composer.referenceNumber", { number: index + 1 })} className="size-full rounded-lg border border-border object-cover" />
            <Button type="button" size="icon-xs" variant="secondary" className="absolute -right-1 -top-1 rounded-full" aria-label={t("composer.removeReference", { number: index + 1 })} onClick={() => patchDraft(draftKey, { references: draft.references.filter((_, i) => i !== index) })}><HugeiconsIcon icon={Cancel01Icon} /></Button>
          </div>)}</div> : null}
          <Textarea ref={textRef} aria-label={t("composer.label")} placeholder={t(configLoading ? "configuration.loading" : configError ? "configuration.loadFailed" : !models.length ? "configuration.description" : "composer.placeholder")} value={draft.prompt} onChange={(event) => patchDraft(draftKey, { prompt: event.target.value })}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey || event.altKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              event.preventDefault();
              void submit();
            }}
            className="field-sizing-content min-h-13 max-h-52 resize-none border-0 bg-transparent px-1 py-2 text-sm shadow-none ring-0 focus-visible:ring-0 dark:bg-transparent" />
          <input ref={uploadRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(event) => { void addReferences(event); }} />
          <div className="flex flex-wrap items-center gap-2 pt-2">
            <Button type="button" variant="ghost" size="icon-sm" aria-label={t("composer.addReference")} onClick={() => uploadRef.current?.click()}><HugeiconsIcon icon={Add01Icon} /></Button>
            <ImageSelect label={t("composer.model")} value={modelId} onChange={(id) => {
              const nextModel = models.find((item) => item.id === id);
              const aspectRatio = imageRatios(nextModel).includes(options.aspectRatio ?? "1:1") ? options.aspectRatio ?? "1:1" : "1:1";
              const resolution = imageResolutions(nextModel).includes(imageResolution(options)) ? imageResolution(options) : "1K";
              patchDraft(draftKey, { modelId: id, options: { ...imageOptionsForResolution(nextModel, options, aspectRatio, resolution), quality: undefined } });
            }}
              options={[...(!modelId ? [{ value: "", label: t("composer.selectModel"), disabled: true }] : []), ...(modelId && !model ? [{ value: modelId, label: t("models.unavailable"), disabled: true }] : []), ...models.map((item) => ({ value: item.id, label: item.name }))]} className="max-w-56 border-transparent bg-muted/40 text-xs" />
            <ImageOptionsPicker model={model} options={options} onChange={(next) => patchDraft(draftKey, { options: next })} />
            <div className="ml-auto"><IconButton type="submit" size="icon-sm" variant="default" className="rounded-full" label={t(sending ? "composer.submitting" : "composer.generate")} disabled={configLoading || !!configError || !draft.prompt.trim() || !model || sending || readingReferences.has(draftKey)}><HugeiconsIcon strokeWidth={2} icon={ArrowUp02Icon} /></IconButton></div>
          </div>
        </form>
      </div>
    </main>
    <Dialog open={renaming !== null} disablePointerDismissal onOpenChange={(open) => { if (!open && !mutating) setRenaming(null); }}><DialogContent><DialogHeader><DialogTitle>{t("renameTitle")}</DialogTitle></DialogHeader><form className="space-y-4" onSubmit={(event) => { event.preventDefault(); if (!renaming || !rename.trim()) return; setMutating(true); void run(() => api.renameSession(renaming.id, rename.trim())).then((ok) => { if (ok) setRenaming(null); }).finally(() => setMutating(false)); }}><Input aria-label={t("renameTitle")} autoFocus value={rename} onChange={(event) => setRename(event.target.value)} /><DialogFooter><Button type="button" variant="ghost" disabled={mutating} onClick={() => setRenaming(null)}>{t("actions.cancel")}</Button><Button type="submit" disabled={mutating || !rename.trim()}>{t("actions.save")}</Button></DialogFooter></form></DialogContent></Dialog>
    <Dialog open={deleting !== null} onOpenChange={(open) => { if (!open && !mutating) setDeleting(null); }}><DialogContent><DialogHeader><DialogTitle>{t("deleteTitle")}</DialogTitle><DialogDescription>{t("deleteDescription", { name: deleting?.title })}</DialogDescription></DialogHeader><DialogFooter><Button variant="ghost" disabled={mutating} onClick={() => setDeleting(null)}>{t("actions.cancel")}</Button><Button variant="destructive" disabled={mutating} onClick={() => { if (!deleting) return; const id = deleting.id; setMutating(true); void run(async () => { const snapshot = await api.snapshot(id); await api.deleteSession(id); clearDeletedReferences(snapshot.tasks, id); }).then((ok) => { if (ok) { setDrafts((previous) => { const next = { ...previous }; delete next[id]; return next; }); setDeleting(null); } }).finally(() => setMutating(false)); }}>{t("actions.delete")}</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={deletingTask !== null} onOpenChange={(open) => { if (!open && !mutating) setDeletingTask(null); }}><DialogContent><DialogHeader><DialogTitle>{t("deleteTaskTitle")}</DialogTitle><DialogDescription>{t("deleteTaskDescription")}</DialogDescription></DialogHeader><DialogFooter><Button variant="ghost" disabled={mutating} onClick={() => setDeletingTask(null)}>{t("actions.cancel")}</Button><Button variant="destructive" disabled={mutating} onClick={() => { if (!deletingTask) return; const task = deletingTask; setMutating(true); void run(() => api.deleteTask(task.id)).then((ok) => { if (ok) { clearDeletedReferences([task]); setDeletingTask(null); } }).finally(() => setMutating(false)); }}>{t("actions.delete")}</Button></DialogFooter></DialogContent></Dialog>
    {gallery ? <ImageGallery task={gallery.task} index={gallery.index} onIndex={(index) => setGallery((current) => current ? { ...current, index } : null)} onClose={() => setGallery(null)} onUseReference={(image) => {
      patchDraft(draftKey, { references: [{ path: image.path }] });
      setGallery(null);
      requestAnimationFrame(() => textRef.current?.focus());
    }} /> : null}
  </div>;
}
