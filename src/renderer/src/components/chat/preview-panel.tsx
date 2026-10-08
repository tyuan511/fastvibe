import { useRef, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon, Folder01Icon } from "@hugeicons/core-free-icons";
import { IconButton } from "@/components/icon-button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { FilePreview } from "@shared/types";
import { useHighlightedCode } from "@/lib/highlight";
import { MarkdownView } from "./markdown-view";
import { DiffView } from "./diff-view";
import { isRemoteRef } from "@/lib/remote-project";
import { blockedRemotely } from "@/lib/remote-unavailable";
import { Ipc } from "@shared/ipc";
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
              if (blockedRemotely(Ipc.workspaceReveal)) return;
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
      <ScrollArea className="min-h-0 flex-1">
        <PreviewBody preview={preview} />
      </ScrollArea>
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
  children,
}: {
  onQuote?: (text: string) => void;
  children: JSX.Element;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref}>
      {children}
      <SelectionActionBar containerRef={ref} onQuote={onQuote} />
    </div>
  );
}

export function PreviewBody({ preview, onQuote }: { preview: FilePreview; onQuote?: (text: string) => void }): JSX.Element {
  const { t } = useTranslation("chat");
  if (preview.kind === "error") {
    return <p className="px-3 py-3 text-sm text-destructive">{preview.message}</p>;
  }
  if (preview.kind === "binary") {
    return <p className="px-3 py-3 text-sm text-muted-foreground">{t("preview.tooLarge", { size: Math.round(preview.size / 1024) })}</p>;
  }
  if (preview.kind === "image") {
    return <img src={preview.dataUrl} alt={preview.name} className="max-w-full" />;
  }
  if (preview.kind === "pdf") {
    return (
      <iframe
        title={preview.name}
        className="h-[70vh] w-full rounded-lg border border-border bg-white"
        src={preview.dataUrl}
      />
    );
  }
  if (preview.kind === "markdown") {
    return (
      <SelectableText>
        <div className="chat-markdown px-3 py-3 text-sm">
          <MarkdownView text={preview.text} />
        </div>
      </SelectableText>
    );
  }
  if (preview.kind === "html") {
    return (
      <SelectableText>
        <iframe
          title={preview.name}
          sandbox=""
          className="h-[70vh] w-full rounded-lg border border-border bg-white"
          srcDoc={preview.text}
        />
      </SelectableText>
    );
  }
  if (preview.kind === "csv") {
    return (
      <SelectableText>
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
      </SelectableText>
    );
  }
  if (preview.kind === "diff") {
    return (
      <SelectableText onQuote={onQuote}>
        <DiffView text={preview.text} className="mt-0 max-h-none rounded-none border-0 bg-transparent text-xs" />
      </SelectableText>
    );
  }
  return (
    <SelectableText onQuote={onQuote}>
      <CodePreview text={preview.text} language={preview.language} />
    </SelectableText>
  );
}

/**
 * One code block, highlighted with Shiki once it resolves (plain until then).
 * A non-selectable gutter of line numbers is sticky at the left edge, so the
 * numbers stay put while wide lines scroll under them.
 */
function CodePreview({ text, language }: { text: string; language?: string }): JSX.Element {
  const html = useHighlightedCode(text, language);
  const lineCount = text.split("\n").length;
  return (
    <div className="code-shiki overflow-x-auto bg-muted/50 text-xs leading-5">
      <div className="flex min-w-full">
        <div
          aria-hidden
          className="sticky left-0 z-10 shrink-0 select-none border-r border-border bg-[color-mix(in_oklab,var(--muted)_50%,var(--background))] py-3 pl-3 pr-2 text-right font-mono tabular-nums text-muted-foreground"
        >
          {Array.from({ length: lineCount }, (_, index) => (
            <div key={index}>{index + 1}</div>
          ))}
        </div>
        <div className="min-w-0 flex-1 px-3 py-3">
          {html ? (
            <div dangerouslySetInnerHTML={{ __html: html }} />
          ) : (
            <pre className="font-mono">{text}</pre>
          )}
        </div>
      </div>
    </div>
  );
}
