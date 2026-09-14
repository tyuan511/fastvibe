import type { JSX } from "react";
import { Check, GitBranch, Minus, Plus, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { GitStatus } from "@shared/ipc";

export function GitStatusDialog({ open, status, onOpenChange, onOpenTerminal }: { open: boolean; status: GitStatus | null; onOpenChange: (open: boolean) => void; onOpenTerminal?: () => void }): JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="border-b border-border px-4 py-3">
          <DialogTitle className="flex items-center gap-2 text-sm"><GitBranch className="size-4" />工作区变更</DialogTitle>
        </DialogHeader>
        <div className="flex items-center gap-3 border-b border-border px-4 py-3 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{status?.branch ?? "HEAD"}</span>
          <span>{status?.staged ?? 0} 个已暂存</span>
          <span>{status?.changed ?? 0} 个改动</span>
          {status?.ahead ? <span>↑ {status.ahead}</span> : null}
          {status?.behind ? <span>↓ {status.behind}</span> : null}
        </div>
        <ScrollArea className="max-h-[min(60vh,460px)]">
          <div className="p-2">
            {status?.files.length ? status.files.map((file) => {
              const staged = file.index !== " " && file.index !== "?";
              const added = file.index === "A" || file.worktree === "A" || file.index === "?";
              return <div key={`${file.index}${file.worktree}:${file.path}`} className="flex items-center gap-2 rounded-md px-3 py-2 text-xs hover:bg-accent/60">
                {added ? <Plus className="size-3.5 text-emerald-600" /> : staged ? <Check className="size-3.5 text-blue-600" /> : <Minus className="size-3.5 text-amber-600" />}
                <span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
                <span className="text-[10px] text-muted-foreground">{file.index}{file.worktree}</span>
              </div>;
            }) : <p className="px-3 py-8 text-center text-xs text-muted-foreground">工作区干净</p>}
          </div>
        </ScrollArea>
        {status?.cwd && onOpenTerminal ? <div className="flex justify-end border-t border-border px-4 py-3"><Button size="sm" variant="outline" onClick={onOpenTerminal}><Terminal className="size-3.5" />打开终端</Button></div> : null}
      </DialogContent>
    </Dialog>
  );
}
