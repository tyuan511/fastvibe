import { useRef, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Alert02Icon,
  Cancel01Icon,
  Copy01Icon,
  FileNotFoundIcon,
  Folder01Icon,
  FolderOpenIcon,
  LockIcon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import { IconButton } from "@/components/icon-button";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";
import type { FilePreview, FilePreviewFailure } from "@shared/types";
import { mediaPreviewUrl } from "@shared/media-preview";
import { useHighlightedCode } from "@/lib/highlight";
import { cn } from "@/lib/utils";
import { copyPath } from "@/components/path-menu";
import { MarkdownView } from "./markdown-view";
import { CsvPreview } from "./csv-preview";
import { DiffView } from "./diff-view";
import { OfficeFrame, UnsupportedFile } from "./office-frame";
import { isRemoteRef } from "@/lib/remote-project";
import { SelectionActionBar } from "./selection-action-bar";

export function PreviewPanel({
  preview,
  onClose,
}: {
  preview: FilePreview;
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation("chat");
  return (
    <aside className="flex w-[min(28rem,42%)] shrink-0 flex-col border-l border-border bg-background">
      <div className="flex h-12 items-center gap-2 border-b border-border px-3">
        <div className="min-w-0 flex-1 truncate text-sm font-medium">{preview.name}</div>
        {preview.kind !== "error" && !isRemoteRef(preview.path) ? (
          <IconButton
            size="icon-xs"
            variant="ghost"
            label={t("preview.reveal")}
            onClick={() => {
              void window.fastvibe.workspace.reveal(preview.path);
            }}
          >
            <HugeiconsIcon strokeWidth={2} icon={Folder01Icon} />
          </IconButton>
        ) : null}
        <IconButton size="icon-xs" variant="ghost" label={t("preview.close")} onClick={onClose}>
          <HugeiconsIcon strokeWidth={2} icon={Cancel01Icon} />
        </IconButton>
      </div>
      <PreviewSurface preview={preview} />
    </aside>
  );
}

export function previewText(preview: FilePreview): string | undefined {
  switch (preview.kind) {
    case "markdown":
    case "html":
    case "diff":
    case "code":
      return preview.text;
    case "csv":
      return preview.rows.map((row) => row.join("\t")).join("\n");
    default:
      return undefined;
  }
}

/** Selected text uses the same floating bar as the chat, not a separate context menu. */
function SelectableText({
  onQuote,
  onAttachToContext,
  children,
}: {
  onQuote?: (text: string) => void;
  onAttachToContext?: (text: string) => void;
  children: JSX.Element;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref}>
      {children}
      <SelectionActionBar containerRef={ref} onQuote={onQuote} onAttachToContext={onAttachToContext} />
    </div>
  );
}

/** A video fills the pane so its controls stay on screen; everything else scrolls. */
export function PreviewSurface({
  preview,
  onQuote,
  onAttachToContext,
  onRetry,
  className,
  document,
  officeLive,
  onOfficeLive,
}: {
  preview: FilePreview;
  onQuote?: (text: string) => void;
  /** Selection bar: put the selected text on the composer's citations. */
  onAttachToContext?: (text: string) => void;
  /** Re-read the file: the way out of a preview that failed because it was not there yet. */
  onRetry?: () => void;
  className?: string;
  /** Local side-pane Office file: live watch instead of a static page. */
  officeLive?: boolean;
  onOfficeLive?: (ready: boolean) => void;
  /**
   * Draw the file as a document rather than as a reply.
   *
   * The file pane wants a measured column, a frontmatter block and a contents rail; the
   * transcript's inline preview wants the same prose the reply used, so it keeps the
   * plain surface. One component, two shapes, rather than two renderers that drift.
   */
  document?: boolean;
}): JSX.Element {
  // A video and an Office page fill the pane: each has its own scrollbar, and wrapping
  // either in the pane's scroller hides it.
  if (preview.kind === "video" || preview.kind === "office") {
    return (
      <div className={cn("relative min-h-0 flex-1", className)}>
        <div className="absolute inset-0">
          <PreviewBody preview={preview} document={document} officeLive={officeLive} onOfficeLive={onOfficeLive} />
        </div>
      </div>
    );
  }
  return (
    <ScrollArea className={cn("min-h-0 flex-1", className)}>
      <PreviewBody
        preview={preview}
        onQuote={onQuote}
        onAttachToContext={onAttachToContext}
        onRetry={onRetry}
        document={document}
        officeLive={officeLive}
        onOfficeLive={onOfficeLive}
      />
    </ScrollArea>
  );
}

export function PreviewBody({
  preview,
  onQuote,
  onAttachToContext,
  onRetry,
  document,
  officeLive,
  onOfficeLive,
}: {
  preview: FilePreview;
  onQuote?: (text: string) => void;
  onAttachToContext?: (text: string) => void;
  onRetry?: () => void;
  document?: boolean;
  officeLive?: boolean;
  onOfficeLive?: (ready: boolean) => void;
}): JSX.Element {
  const { t } = useTranslation("chat");
  if (preview.kind === "error") {
    return <PreviewFailure preview={preview} onRetry={onRetry} />;
  }
  if (preview.kind === "binary") {
    return <p className="px-3 py-3 text-sm text-muted-foreground">{t("preview.tooLarge", { size: Math.round(preview.size / 1024) })}</p>;
  }
  if (preview.kind === "unsupported") {
    return <UnsupportedFile path={preview.path} format={preview.format} />;
  }
  if (preview.kind === "office") {
    return <OfficeFrame path={preview.path} name={preview.name} className="min-h-0" live={officeLive} onLive={onOfficeLive} />;
  }
  if (preview.kind === "video") {
    return <VideoPreview key={preview.path} preview={preview} />;
  }
  if (preview.kind === "image") {
    return <ImagePreview key={preview.path} preview={preview} />;
  }
  if (preview.kind === "pdf") {
    return (
      <iframe
        title={preview.name}
        className="h-[70vh] w-full rounded-lg border border-border bg-white"
        src={mediaPreviewUrl(preview.path)}
      />
    );
  }
  if (preview.kind === "markdown") {
    // The file pane and the transcript share the release renderer. The document
    // column is a different style, and it is not what a markdown preview draws.
    return (
      <SelectableText onAttachToContext={onAttachToContext}>
        <div className="chat-markdown px-3 py-3 text-sm">
          <MarkdownView text={preview.text} />
        </div>
      </SelectableText>
    );
  }
  if (preview.kind === "html") {
    return (
      <SelectableText>
        {/*
         * A page is served by the media scheme and framed, not handed to `srcDoc`: an
         * `about:srcdoc` document inherits this window's CSP, whose `script-src 'self'`
         * blocks every inline `<script>` the page wrote — the animation never starts.
         * Served, it is a document of its own under `INLINE_HTML_CSP`, so it may run
         * inline code and load https libraries while the sandbox (no `allow-same-origin`)
         * keeps it out of the app.
         */}
        <iframe
          title={preview.name}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          className="h-[70vh] w-full rounded-lg border border-border bg-white"
          src={mediaPreviewUrl(preview.path)}
        />
      </SelectableText>
    );
  }
  if (preview.kind === "csv") {
    const truncated = preview.truncated
      ? (
          <p className="px-3 pt-3 text-xs text-muted-foreground">
            {t(preview.truncated === "size" ? "preview.csvTruncatedSize" : "preview.csvTruncatedRows", {
              shown: preview.rows.length,
              total: preview.totalRows ?? preview.rows.length,
            })}
          </p>
        )
      : null;
    if (document) {
      return (
        <SelectableText onAttachToContext={onAttachToContext}>
          <div>
            {truncated}
            <CsvPreview rows={preview.rows} name={preview.name} />
          </div>
        </SelectableText>
      );
    }
    return (
      <SelectableText onAttachToContext={onAttachToContext}>
        <div>
          {truncated}
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full border-collapse text-left">
            <tbody>
              {preview.rows.map((row, index) => (
                <tr key={index}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex} className="border-b border-border px-2 py-1.5">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </div>
      </SelectableText>
    );
  }
  if (preview.kind === "diff") {
    return (
      <SelectableText onQuote={onQuote} onAttachToContext={onAttachToContext}>
        <DiffView text={preview.text} className="mt-0 max-h-none rounded-none border-0 bg-transparent text-xs" />
      </SelectableText>
    );
  }
  return (
    <SelectableText onQuote={onQuote} onAttachToContext={onAttachToContext}>
      <CodePreview text={preview.text} language={preview.language} />
    </SelectableText>
  );
}

/**
 * A file the pane could not open.
 *
 * This used to be the host's own sentence in red — `ENOENT: no such file or directory, stat
 * '/…/DESIGN.md'` — which is a debugger's line, not a reader's: it names no way out and reads
 * as badly for a file that is merely gone as for one the app has no business touching. Main
 * classifies the failure into `reason`, so the pane can say the one thing that is true, show
 * the path it looked at, and offer what still works: the folder it should be in, the path for
 * pasting, and another look (the usual cause is a file the last turn has since moved).
 *
 * The raw error stays on screen only when nothing classified it — there the host's words *are*
 * the information.
 */
function PreviewFailure({
  preview,
  onRetry,
}: {
  preview: Extract<FilePreview, { kind: "error" }>;
  onRetry?: () => void;
}): JSX.Element {
  const { t } = useTranslation("chat");
  // A resident SSH Agent from before `reason` exists answers with only a message. Read an
  // unclassified failure as one rather than looking up an icon that is not there.
  const reason: FilePreviewFailure = preview.reason in FAILURE_ICON ? preview.reason : "unknown";
  // Reveal and copy name a place on *this* computer; a remote file's folder is on another one,
  // and `workspace.reveal` would open Finder over nothing.
  const remote = isRemoteRef(preview.path);
  const directory = preview.directory || parentDirectory(preview.path);
  const revealFailed = t("preview.pathMissing");
  return (
    <div className="flex min-h-40 flex-col items-start justify-center gap-3 px-4 py-6">
      <div className="flex min-w-0 items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <HugeiconsIcon strokeWidth={1.8} icon={FAILURE_ICON[reason]} className="size-5" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{t(`preview.fail.${reason}`)}</p>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
            {reason === "unknown" ? preview.message : t(`preview.failHint.${reason}`)}
          </p>
        </div>
      </div>
      {preview.path ? (
        <p
          className="max-w-full break-all rounded-md bg-muted/60 px-2 py-1 font-mono text-xs text-muted-foreground"
          title={preview.path}
        >
          {preview.path}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {onRetry ? (
          <Button type="button" size="xs" variant="outline" onClick={onRetry}>
            <HugeiconsIcon strokeWidth={2} icon={RefreshIcon} />
            {t("preview.retry")}
          </Button>
        ) : null}
        {!remote && directory ? (
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => {
              void window.fastvibe.workspace.reveal(directory).then((result) => {
                if (result && result.ok === false) toast.error(revealFailed);
              });
            }}
          >
            <HugeiconsIcon strokeWidth={2} icon={FolderOpenIcon} />
            {t("preview.openFolder")}
          </Button>
        ) : null}
        {preview.path ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => void copyPath(preview.path, t("preview.pathCopied"))}
          >
            <HugeiconsIcon strokeWidth={2} icon={Copy01Icon} />
            {t("preview.pathCopy")}
          </Button>
        ) : null}
      </div>
      {reason === "unknown" && preview.detail ? (
        <p className="max-w-md break-all text-xs text-muted-foreground/70">{preview.detail}</p>
      ) : null}
    </div>
  );
}

const FAILURE_ICON: Record<FilePreviewFailure, typeof FileNotFoundIcon> = {
  missing: FileNotFoundIcon,
  permission: LockIcon,
  "not-a-file": Folder01Icon,
  unknown: Alert02Icon,
};

/** A host that said nothing about where the file lives: take the folder off the path. */
function parentDirectory(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index > 0 ? path.slice(0, index) : "";
}

function MediaFallback(): JSX.Element {
  const { t } = useTranslation("chat");
  return <p className="px-3 py-3 text-sm text-muted-foreground">{t("preview.mediaFailed")}</p>;
}

function ImagePreview({ preview }: { preview: Extract<FilePreview, { kind: "image" }> }): JSX.Element {
  const [failed, setFailed] = useState(false);
  if (failed) return <MediaFallback />;
  return (
    <img
      src={mediaPreviewUrl(preview.path)}
      alt={preview.name}
      className="max-w-full"
      onError={() => setFailed(true)}
    />
  );
}

function VideoPreview({ preview }: { preview: Extract<FilePreview, { kind: "video" }> }): JSX.Element {
  const [failed, setFailed] = useState(false);
  if (failed) return <MediaFallback />;
  return (
    <video
      controls
      playsInline
      preload="metadata"
      src={mediaPreviewUrl(preview.path)}
      className="h-full w-full bg-black object-contain"
      onError={() => setFailed(true)}
    />
  );
}

/**
 * One code block, highlighted with Shiki once it resolves (plain until then).
 * A non-selectable gutter of line numbers stays put while wide lines scroll: only the
 * code column scrolls sideways, so nothing ever passes *under* the gutter and it needs
 * no fill of its own — it is the code area's own ground in every theme. (It used to be
 * a sticky column over the scrolling lines, painted opaque to hide them; under 玻璃效果
 * that fill could only be a different colour from the code beside it.)
 */
function CodePreview({ text, language }: { text: string; language?: string }): JSX.Element {
  const html = useHighlightedCode(text, language);
  const lineCount = text.split("\n").length;
  return (
    <div className="code-shiki flex bg-muted/50 text-xs leading-5">
      <div
        aria-hidden
        className="shrink-0 select-none border-r border-border py-3 pl-3 pr-2 text-right font-mono tabular-nums text-muted-foreground"
      >
        {Array.from({ length: lineCount }, (_, index) => (
          <div key={index}>{index + 1}</div>
        ))}
      </div>
      <div className="min-w-0 flex-1 overflow-x-auto px-3 py-3">
        {html ? (
          <div dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <pre className="font-mono">{text}</pre>
        )}
      </div>
    </div>
  );
}
