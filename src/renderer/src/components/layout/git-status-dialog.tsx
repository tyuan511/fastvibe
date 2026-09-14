import { useState, type JSX } from "react";
import { ArrowDown, ArrowUp, Check, GitBranch, Minus, Plus, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { GitBranch as GitBranchInfo, GitStatus } from "@shared/ipc";
import { Input } from "@/components/ui/input";

export function GitStatusDialog({ open, status, branches, diffPath, diffText, onOpenChange, onOpenTerminal, onCheckout, onStageAll, onCommit, onDiff, onPull, onPush }: { open: boolean; status: GitStatus | null; branches: GitBranchInfo[]; diffPath?: string; diffText?: string; onOpenChange: (open: boolean) => void; onOpenTerminal?: () => void; onCheckout?: (branch: string) => void; onStageAll?: () => void; onCommit?: (message: string) => void; onDiff?: (path: string) => void; onPull?: () => void; onPush?: () => void }): JSX.Element {
  const [message, setMessage] = useState("");
  const [branchDraft, setBranchDraft] = useState("");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="border-b border-border px-4 py-3">
          <DialogTitle className="flex items-center gap-2 text-sm"><GitBranch className="size-4" />工作区变更</DialogTitle>
        </DialogHeader>
        <div className="flex items-center gap-3 border-b border-border px-4 py-3 text-xs text-muted-foreground">
          {branches.length > 0 && onCheckout ? <select value={status?.branch ?? ""} onChange={(event) => onCheckout(event.target.value)} className="max-w-40 rounded-md border border-border bg-background px-2 py-1 text-xs font-medium"><option value="" disabled>选择分支</option>{branches.map((branch) => <option key={branch.name} value={branch.name}>{branch.name}</option>)}</select> : <span className="font-medium text-foreground">{status?.branch ?? "HEAD"}</span>}
          {onCheckout ? <><Input value={branchDraft} placeholder="新分支" className="h-7 w-28 text-xs" onChange={(event) => setBranchDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && branchDraft.trim()) { onCheckout(`__create__:${branchDraft.trim()}`); setBranchDraft(""); } }} /><Button size="xs" variant="ghost" disabled={!branchDraft.trim()} onClick={() => { onCheckout(`__create__:${branchDraft.trim()}`); setBranchDraft(""); }}>创建</Button></> : null}
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
              return <button type="button" key={`${file.index}${file.worktree}:${file.path}`} className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-xs text-left hover:bg-accent/60" onClick={() => onDiff?.(file.path)}>
                {added ? <Plus className="size-3.5 text-emerald-600" /> : staged ? <Check className="size-3.5 text-blue-600" /> : <Minus className="size-3.5 text-amber-600" />}
                <span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
                <span className="text-[10px] text-muted-foreground">{file.index}{file.worktree}</span>
              </button>;
            }) : <p className="px-3 py-8 text-center text-xs text-muted-foreground">工作区干净</p>}
          </div>
        </ScrollArea>
        {diffText ? <div className="border-t border-border bg-muted/30 p-3"><p className="mb-2 text-[11px] font-medium text-muted-foreground">{diffPath ?? "diff"}</p><pre className="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[10px] leading-4">{diffText}</pre></div> : null}
        {status?.isRepository && onStageAll && onCommit ? <div className="flex gap-2 border-t border-border px-4 py-3"><Button size="sm" variant="outline" onClick={onStageAll}>暂存全部</Button><Input value={message} placeholder="提交信息" className="h-8 text-xs" onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && message.trim()) { onCommit(message.trim()); setMessage(""); } }} /><Button size="sm" disabled={!message.trim()} onClick={() => { onCommit(message.trim()); setMessage(""); }}>提交</Button></div> : null}
        {status?.cwd && (onOpenTerminal || onPull || onPush) ? <div className="flex justify-end gap-2 border-t border-border px-4 py-3">{onPull ? <Button size="sm" variant="outline" onClick={onPull}><ArrowDown className="size-3.5" />拉取</Button> : null}{onPush ? <Button size="sm" variant="outline" onClick={onPush}><ArrowUp className="size-3.5" />推送</Button> : null}{onOpenTerminal ? <Button size="sm" variant="outline" onClick={onOpenTerminal}><Terminal className="size-3.5" />打开终端</Button> : null}</div> : null}
      </DialogContent>
    </Dialog>
  );
}
