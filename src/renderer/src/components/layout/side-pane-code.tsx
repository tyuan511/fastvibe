import type { JSX } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Folder01Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { PreviewBody } from "@/components/chat/preview-panel";
import type { FilePreview } from "@shared/types";

export function SidePaneCode({ preview }: { preview: FilePreview }): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {preview.kind !== "error" ? (
        <div className="flex items-center justify-end border-b border-border px-2 py-1">
          <Button size="xs" variant="ghost" onClick={() => void window.fastvibe.workspace.reveal(preview.path)}>
            <HugeiconsIcon strokeWidth={2} icon={Folder01Icon} />
            在访达中显示
          </Button>
        </div>
      ) : null}
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-3">
          <PreviewBody preview={preview} />
        </div>
      </ScrollArea>
    </div>
  );
}
