import { useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, ArrowDown02Icon, ArrowUp02Icon, GitBranchIcon, MinusSignIcon, TerminalIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { GitBranch as GitBranchInfo, GitStatus } from "@shared/ipc";
import { Input } from "@/components/ui/input";

export function GitStatusDialog({ open, status, branches, diffPath, diffText, onOpenChange, onOpenTerminal, onCheckout, onStageAll, onCommit, onDiff, onPull, onPush }: { open: boolean; status: GitStatus | null; branches: GitBranchInfo[]; diffPath?: string; diffText?: string; onOpenChange: (open: boolean) => void; onOpenTerminal?: () => void; onCheckout?: (branch: string) => void; onStageAll?: () => void; onCommit?: (message: string) => void; onDiff?: (path: string) => void; onPull?: () => void; onPush?: () => void }): JSX.Element {
  const { t } = useTranslation("sidepane");
  const [message, setMessage] = useState("");
  const [branchDraft, setBranchDraft] = useState("");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="border-b border-border px-4 py-3">
          <DialogTitle className="flex items-center gap-2 text-sm"><HugeiconsIcon strokeWidth={2} icon={GitBranchIcon} className="size-4" />{t("gitDialog.title")}</DialogTitle>
        </DialogHeader>
        <div className="flex items-center gap-3 border-b border-border px-4 py-3 text-xs text-muted-foreground">
          {branches.length > 0 && onCheckout ? <select value={status?.branch ?? ""} onChange={(event) => onCheckout(event.target.value)} className="max-w-40 rounded-md border border-border bg-background px-2 py-1 text-xs font-medium"><option value="" disabled>{t("gitDialog.pickBranch")}</option>{branches.map((branch) => <option key={branch.name} value={branch.name}>{branch.name}</option>)}</select> : <span className="font-medium text-foreground">{status?.branch ?? "HEAD"}</span>}
          {onCheckout ? <><Input value={branchDraft} placeholder={t("gitDialog.newBranch")} className="h-7 w-28 text-xs" onChange={(event) => setBranchDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && branchDraft.trim()) { onCheckout(`__create__:${branchDraft.trim()}`); setBranchDraft(""); } }} /><Button size="xs" variant="ghost" disabled={!branchDraft.trim()} onClick={() => { onCheckout(`__create__:${branchDraft.trim()}`); setBranchDraft(""); }}>{t("gitDialog.create")}</Button></> : null}
          <span>{t("gitDialog.staged", { count: status?.staged ?? 0 })}</span>
          <span>{t("gitDialog.changed", { count: status?.changed ?? 0 })}</span>
          {status?.ahead ? <span>↑ {status.ahead}</span> : null}
          {status?.behind ? <span>↓ {status.behind}</span> : null}
        </div>
        <ScrollArea className="max-h-[min(60vh,460px)]">
          <div className="p-2">
            {status?.files.length ? status.files.map((file) => {
              const staged = file.index !== " " && file.index !== "?";
              const added = file.index === "A" || file.worktree === "A" || file.index === "?";
              return <button type="button" key={`${file.index}${file.worktree}:${file.path}`} className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-xs text-left hover:bg-accent/60" onClick={() => onDiff?.(file.path)}>
                {added ? <HugeiconsIcon strokeWidth={2} icon={Add01Icon} className="size-3.5 text-success" /> : staged ? <HugeiconsIcon strokeWidth={2} icon={Tick02Icon} className="size-3.5 text-info" /> : <HugeiconsIcon strokeWidth={2} icon={MinusSignIcon} className="size-3.5 text-warning" />}
                <span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
                <span className="text-xs text-muted-foreground">{file.index}{file.worktree}</span>
              </button>;
            }) : <p className="px-3 py-8 text-center text-xs text-muted-foreground">{t("gitDialog.clean")}</p>}
          </div>
        </ScrollArea>
        {diffText ? <div className="border-t border-border bg-muted/30 p-3"><p className="mb-2 text-xs font-medium text-muted-foreground">{diffPath ?? "diff"}</p><pre className="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-xs leading-4">{diffText}</pre></div> : null}
        {status?.isRepository && onStageAll && onCommit ? <div className="flex gap-2 border-t border-border px-4 py-3"><Button size="sm" variant="outline" onClick={onStageAll}>{t("gitDialog.stageAll")}</Button><Input value={message} placeholder={t("gitDialog.commitMessage")} className="h-8 text-xs" onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && message.trim()) { onCommit(message.trim()); setMessage(""); } }} /><Button size="sm" disabled={!message.trim()} onClick={() => { onCommit(message.trim()); setMessage(""); }}>{t("gitDialog.commit")}</Button></div> : null}
        {status?.cwd && (onOpenTerminal || onPull || onPush) ? <div className="flex justify-end gap-2 border-t border-border px-4 py-3">{onPull ? <Button size="sm" variant="outline" onClick={onPull}><HugeiconsIcon strokeWidth={2} icon={ArrowDown02Icon} className="size-3.5" />{t("gitDialog.pull")}</Button> : null}{onPush ? <Button size="sm" variant="outline" onClick={onPush}><HugeiconsIcon strokeWidth={2} icon={ArrowUp02Icon} className="size-3.5" />{t("gitDialog.push")}</Button> : null}{onOpenTerminal ? <Button size="sm" variant="outline" onClick={onOpenTerminal}><HugeiconsIcon strokeWidth={2} icon={TerminalIcon} className="size-3.5" />{t("gitDialog.openTerminal")}</Button> : null}</div> : null}
      </DialogContent>
    </Dialog>
  );
}
