import { useEffect, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  Copy01Icon,
  Folder01Icon,
  Globe02Icon,
  Image01Icon,
  MoreVerticalIcon,
  PlayIcon,
  SidebarRight01Icon,
} from "@hugeicons/core-free-icons";
import { inlineSrc, type InlinePreview } from "@shared/inline-media";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { isRemoteRef } from "@/lib/remote-project";
import { useIsNarrowViewport } from "@/lib/sidebar-visibility";
import { useSessionStore } from "@/stores/session";
import { cn } from "@/lib/utils";

/**
 * Images, videos and HTML pages a reply asked to show (`@shared/inline-media` decides *what*;
 * this decides how it looks and what a failure does).
 *
 * Nothing is drawn large in the transcript. A reply mentions them the way it mentions a file —
 * an inline name — and a finished run shows a few thumbnails at the end of its 「用时」 row.
 * Clicking either opens the **viewer**: the whole window, dimmed, one item at a time, with
 * ← / → through the same batch.
 */

function nameOf(ref: string): string {
  if (ref.startsWith("data:")) return "";
  const path = /^https:\/\//i.test(ref) ? new URL(ref).pathname : ref;
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? ref;
}

function isData(ref: string): boolean {
  return ref.startsWith("data:");
}

function isUrl(ref: string): boolean {
  return /^https:\/\//i.test(ref);
}

function isLocal(ref: string): boolean {
  return !isData(ref) && !isUrl(ref);
}

const KIND_ICON = { image: Image01Icon, video: PlayIcon, html: Globe02Icon } as const;

/**
 * Local files that a result's text only *suggested*: a path a script printed is not proof the
 * file is there. Those that are missing are dropped, so a guess never leaves a dead name behind.
 * Anything the model or a tool named outright is kept, and so is a lookup that fails.
 */
function useMissingGuesses(items: InlinePreview[]): ReadonlySet<string> {
  const cwd = useSessionStore((state) => state.conversations.find((item) => item.id === state.activeId)?.cwd);
  const [missing, setMissing] = useState<ReadonlySet<string>>(() => new Set());
  const guesses = items.filter((item) => !item.explicit && isLocal(item.ref)).map((item) => item.ref);
  const signature = guesses.join("\n");
  useEffect(() => {
    if (!signature) return;
    let live = true;
    void window.fastvibe.workspace
      .filesExist(signature.split("\n"), cwd)
      .then((existing) => {
        if (!live) return;
        const found = new Set(existing);
        setMissing(new Set(signature.split("\n").filter((ref) => !found.has(ref))));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [signature, cwd]);
  return missing;
}

/** Reveal / copy / open-in-browser for one item; nothing when the item has no address to act on. */
function ItemMenu({ preview, className }: { preview: InlinePreview; className?: string }): JSX.Element | null {
  const { t } = useTranslation("chat");
  const { ref } = preview;
  const local = isLocal(ref);
  const canReveal = local && !isRemoteRef(ref);
  const canCopy = !isData(ref);
  if (!canReveal && !canCopy && !isUrl(ref)) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button type="button" size="icon-sm" variant="ghost" aria-label={t("preview.more")} className={className} />}>
        <HugeiconsIcon strokeWidth={2} icon={MoreVerticalIcon} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        {isUrl(ref) ? (
          <DropdownMenuItem onClick={() => window.open(ref, "_blank", "noopener,noreferrer")}>
            <HugeiconsIcon strokeWidth={2} icon={Globe02Icon} />
            {t("preview.openExternal")}
          </DropdownMenuItem>
        ) : null}
        {canReveal ? (
          <DropdownMenuItem
            onClick={() =>
              void window.fastvibe.workspace.reveal(ref).then((result) => {
                if (result && result.ok === false) toast.error(t("preview.pathMissing"));
              })
            }
          >
            <HugeiconsIcon strokeWidth={2} icon={Folder01Icon} />
            {t("preview.pathReveal")}
          </DropdownMenuItem>
        ) : null}
        {canCopy ? (
          <DropdownMenuItem onClick={() => void navigator.clipboard?.writeText(ref)}>
            <HugeiconsIcon strokeWidth={2} icon={Copy01Icon} />
            {t(local ? "preview.pathCopy" : "preview.linkCopy")}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The viewer's picture, film or page, as large as the window allows. */
function ViewerMedia({ preview, failed, onFail }: { preview: InlinePreview; failed: boolean; onFail: () => void }): JSX.Element {
  const { t } = useTranslation("chat");
  const label = preview.title ?? nameOf(preview.ref);
  if (failed) {
    return <p className="text-sm text-white/70">{t("preview.inlineFailed", { name: label || t(`preview.kind.${preview.kind}`) })}</p>;
  }
  if (preview.kind === "image") {
    return <img src={inlineSrc(preview)} alt={label} decoding="async" className="max-h-full max-w-full rounded-lg object-contain" onError={onFail} />;
  }
  if (preview.kind === "video") {
    return (
      <video
        controls
        playsInline
        preload="metadata"
        src={inlineSrc(preview)}
        className="max-h-full max-w-full rounded-lg bg-black"
        onError={onFail}
      />
    );
  }
  // A page runs in a frame of its own document, sandboxed *without* `allow-same-origin`: it has
  // no storage and no reach into the app, and Main serves it under a policy that lets it load
  // only inline code and https resources (`INLINE_HTML_CSP`).
  return (
    <iframe
      title={label}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      src={inlineSrc(preview)}
      className="h-full w-full max-w-6xl rounded-lg border-0 bg-white"
    />
  );
}

const SCRIM_BUTTON = "text-white hover:bg-white/15 hover:text-white aria-expanded:bg-white/15";

/**
 * The window, dimmed, one item at a time. ← / → (or the arrows) walk the batch the item came
 * from; the caption is bottom-left, the position bottom-centre and what a row's buttons do is
 * top-right, because nothing else on screen is clickable while this is open.
 */
function Viewer({
  items,
  index,
  onIndex,
  onClose,
}: {
  items: InlinePreview[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
}): JSX.Element | null {
  const { t } = useTranslation("chat");
  const narrow = useIsNarrowViewport();
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const count = items.length;
  const current = items[index];

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (count < 2 || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
      event.preventDefault();
      onIndex((index + (event.key === "ArrowRight" ? 1 : count - 1)) % count);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [count, index, onIndex]);

  if (!current) return null;
  const caption = current.title ?? (nameOf(current.ref) || t(`preview.kind.${current.kind}`));
  const canPane = isLocal(current.ref) && !narrow;
  const step = (delta: number): void => onIndex((index + delta + count) % count);
  // A press on the empty scrim, not on the item or a control, puts the viewer away.
  const dismissOnScrim = (event: { target: unknown; currentTarget: unknown }): void => {
    if (event.target === event.currentTarget) onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        showCloseButton={false}
        overlayClassName="bg-black/90"
        // The dialog's own glass fill would tint the scrim and blur the page behind it.
        style={{ backgroundColor: "transparent", backdropFilter: "none", WebkitBackdropFilter: "none" }}
        className="top-0 left-0 flex size-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-0 p-0 shadow-none ring-0 sm:max-w-none"
      >
        <DialogTitle className="sr-only">{caption}</DialogTitle>
        <div className="flex shrink-0 items-center justify-end gap-1 p-3" onClick={dismissOnScrim}>
          {canPane ? (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={t("preview.open")}
              title={t("preview.open")}
              className={SCRIM_BUTTON}
              onClick={() => {
                onClose();
                void useSessionStore.getState().openPreview(current.ref);
              }}
            >
              <HugeiconsIcon strokeWidth={2} icon={SidebarRight01Icon} />
            </Button>
          ) : null}
          <ItemMenu preview={current} className={SCRIM_BUTTON} />
          <Button type="button" size="icon-sm" variant="ghost" aria-label={t("preview.close")} className={SCRIM_BUTTON} onClick={onClose}>
            <HugeiconsIcon strokeWidth={2} icon={Cancel01Icon} />
          </Button>
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center px-4" onClick={dismissOnScrim}>
          <ViewerMedia
            key={current.key}
            preview={current}
            failed={failed.has(current.key)}
            onFail={() => setFailed((previous) => new Set(previous).add(current.key))}
          />
        </div>
        <div className="grid shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-3 px-5 py-4 text-white" onClick={dismissOnScrim}>
          <span className="min-w-0 truncate text-sm">{caption}</span>
          {count > 1 ? (
            <span className="flex items-center gap-3">
              <Button type="button" size="icon-sm" variant="ghost" aria-label={t("preview.previous")} className={SCRIM_BUTTON} onClick={() => step(-1)}>
                <HugeiconsIcon strokeWidth={2} icon={ArrowLeft01Icon} />
              </Button>
              <span className="text-sm tabular-nums">{t("preview.itemOf", { index: index + 1, count })}</span>
              <Button type="button" size="icon-sm" variant="ghost" aria-label={t("preview.next")} className={SCRIM_BUTTON} onClick={() => step(1)}>
                <HugeiconsIcon strokeWidth={2} icon={ArrowRight01Icon} />
              </Button>
            </span>
          ) : (
            <span />
          )}
          <span />
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * One call's previews as names in the text: `[icon] chart.png`, the way a path in a reply
 * reads. Several share a line and wrap. A press opens the viewer on that one, with the rest of
 * the call's items a step away.
 */
export function InlinePreviews({ items, className }: { items: InlinePreview[]; className?: string }): JSX.Element | null {
  const { t } = useTranslation("chat");
  const missing = useMissingGuesses(items);
  const [viewing, setViewing] = useState<number | null>(null);
  const visible = items.filter((item) => !missing.has(item.ref));
  if (visible.length === 0) return null;
  return (
    <span className={cn("my-0.5 flex w-full max-w-2xl flex-wrap items-center gap-x-4 gap-y-1 text-sm", className)}>
      {visible.map((item, index) => {
        const label = item.title ?? (nameOf(item.ref) || `${t(`preview.kind.${item.kind}`)}${visible.length > 1 ? ` ${index + 1}` : ""}`);
        return (
          <button
            key={item.key}
            type="button"
            title={isLocal(item.ref) ? item.ref : label}
            onClick={() => setViewing(index)}
            className="inline-flex max-w-64 items-center gap-1.5 text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
          >
            <HugeiconsIcon strokeWidth={2} icon={KIND_ICON[item.kind]} className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate">{label}</span>
          </button>
        );
      })}
      {viewing !== null ? (
        <Viewer items={visible} index={Math.min(viewing, visible.length - 1)} onIndex={setViewing} onClose={() => setViewing(null)} />
      ) : null}
    </span>
  );
}

/** A single item (a markdown image) as the same inline name. */
export function InlineMediaItem({ preview }: { preview: InlinePreview }): JSX.Element | null {
  return <InlinePreviews items={[preview]} className="inline-flex w-auto" />;
}

const STRIP_MAX = 3;

/**
 * What a finished run made, as a few thumbnails at the end of its 「用时」 row: at most three, then
 * 更多. Nothing is large until one is clicked, and the viewer then walks the whole batch.
 */
export function InlineThumbStrip({ items }: { items: InlinePreview[] }): JSX.Element | null {
  const { t } = useTranslation("chat");
  const missing = useMissingGuesses(items);
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const [viewing, setViewing] = useState<number | null>(null);
  // A guess that did not load is not a thumbnail; an explicit one stays, as an icon.
  const visible = items.filter((item) => !missing.has(item.ref) && (item.explicit || !failed.has(item.key)));
  if (visible.length === 0) return null;
  const extra = visible.length - STRIP_MAX;
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-3">
      {visible.slice(0, STRIP_MAX).map((item, index) => (
        <button
          key={item.key}
          type="button"
          title={item.title ?? nameOf(item.ref)}
          aria-label={item.title ?? (nameOf(item.ref) || t(`preview.kind.${item.kind}`))}
          onClick={() => setViewing(index)}
          className="flex h-8 w-11 items-center justify-center overflow-hidden rounded-md border border-border bg-muted/40 text-muted-foreground shadow-xs transition-colors hover:border-ring"
        >
          {item.kind === "image" && !failed.has(item.key) ? (
            <img
              src={inlineSrc(item)}
              alt=""
              loading="lazy"
              decoding="async"
              className="size-full object-cover"
              onError={() => setFailed((previous) => new Set(previous).add(item.key))}
            />
          ) : (
            <HugeiconsIcon strokeWidth={2} icon={KIND_ICON[item.kind]} className="size-4" />
          )}
        </button>
      ))}
      {extra > 0 ? (
        <button
          type="button"
          onClick={() => setViewing(STRIP_MAX)}
          className="inline-flex h-8 items-center rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {t("preview.moreItems", { count: extra })}
        </button>
      ) : null}
      {viewing !== null ? (
        <Viewer items={visible} index={Math.min(viewing, visible.length - 1)} onIndex={setViewing} onClose={() => setViewing(null)} />
      ) : null}
    </span>
  );
}
