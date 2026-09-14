import type { JSX } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon, Folder01Icon } from "@hugeicons/core-free-icons";
import { IconButton } from "@/components/icon-button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { FilePreview } from "@shared/types";
import { highlightCode } from "@/lib/highlight";
import { MarkdownView } from "./markdown-view";

export function PreviewPanel({
  preview,
  onClose,
}: {
  preview: FilePreview;
  onClose: () => void;
}): JSX.Element {
  return (
    <aside className="flex w-[min(28rem,42%)] shrink-0 flex-col border-l border-border bg-background">
      <div className="flex h-12 items-center gap-2 border-b border-border px-3">
        <div className="min-w-0 flex-1 truncate text-sm font-medium">{preview.name}</div>
        {preview.kind !== "error" ? (
          <IconButton
            size="icon-xs"
            variant="ghost"
            label="在访达中显示"
            onClick={() => void window.fastvibe.workspace.reveal(preview.path)}
          >
            <HugeiconsIcon strokeWidth={2} icon={Folder01Icon} />
          </IconButton>
        ) : null}
        <IconButton size="icon-xs" variant="ghost" label="关闭" onClick={onClose}>
          <HugeiconsIcon strokeWidth={2} icon={Cancel01Icon} />
        </IconButton>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-3">
          <PreviewBody preview={preview} />
        </div>
      </ScrollArea>
    </aside>
  );
}

export function PreviewBody({ preview }: { preview: FilePreview }): JSX.Element {
  if (preview.kind === "error") {
    return <p className="text-sm text-destructive">{preview.message}</p>;
  }
  if (preview.kind === "binary") {
    return <p className="text-sm text-muted-foreground">文件过大（{Math.round(preview.size / 1024)} KB），请在访达中打开。</p>;
  }
  if (preview.kind === "image") {
    return <img src={preview.dataUrl} alt={preview.name} className="max-w-full rounded-lg border border-border" />;
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
      <div className="chat-markdown text-sm">
        <MarkdownView text={preview.text} />
      </div>
    );
  }
  if (preview.kind === "html") {
    return (
      <iframe
        title={preview.name}
        sandbox=""
        className="h-[70vh] w-full rounded-lg border border-border bg-white"
        srcDoc={preview.text}
      />
    );
  }
  if (preview.kind === "csv") {
    return (
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full border-collapse text-left text-xs">
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
    );
  }
  if (preview.kind === "diff") {
    return (
      <pre className="overflow-x-auto rounded-lg bg-muted/50 p-3 font-mono text-[12px] leading-5">
        {preview.text.split("\n").map((line, index) => (
          <div
            key={index}
            className={
              line.startsWith("+")
                ? "text-success"
                : line.startsWith("-")
                  ? "text-destructive"
                  : line.startsWith("@@")
                    ? "text-info"
                    : "text-muted-foreground"
            }
          >
            {line || " "}
          </div>
        ))}
      </pre>
    );
  }
  return (
    <pre className="overflow-x-auto rounded-lg bg-muted/50 p-3 font-mono text-[12px] leading-5">
      <code dangerouslySetInnerHTML={{ __html: highlightCode(preview.text) }} />
    </pre>
  );
}
