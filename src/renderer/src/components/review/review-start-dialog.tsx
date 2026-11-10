import { useEffect, useId, useRef, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { startReview } from "@/lib/engine-client";
import { useSessionStore } from "@/stores/session";
import { useSidePaneStore } from "@/stores/side-pane";
import type { ReviewScope } from "@shared/review";

const SCOPES: ReviewScope[] = ["worktree", "staged", "branch", "commit"];

export function ReviewStartDialog({ open, onOpenChange, cwd, defaultScope = "worktree", revision, initialBase, initialInstructions, conversationId: ownerConversationId }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cwd: string;
  conversationId?: string;
  defaultScope?: ReviewScope;
  revision?: string;
  initialBase?: string;
  initialInstructions?: string;
}): JSX.Element {
  const { t } = useTranslation("sidepane");
  const id = useId();
  const activeId = useSessionStore((state) => state.activeId);
  const conversationId = ownerConversationId ?? activeId;
  const [scope, setScope] = useState<ReviewScope>(defaultScope);
  const [base, setBase] = useState(initialBase ?? "");
  const [commit, setCommit] = useState(revision ?? "");
  const [instructions, setInstructions] = useState(initialInstructions ?? "");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const pending = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  async function start(): Promise<void> {
    if (pending.current || !conversationId) return;
    pending.current = true;
    setStarting(true);
    setError("");
    try {
      const thread = await startReview({
        conversationId, cwd, scope,
        ...(scope === "branch" && base.trim() ? { base: base.trim() } : {}),
        ...(scope === "commit" && commit.trim() ? { revision: commit.trim() } : {}),
        ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
      });
      const pane = useSidePaneStore.getState();
      // Keep a late response with its owner without switching the current pane.
      pane.openReview(thread.id, conversationId, useSessionStore.getState().activeId !== conversationId);
      if (mounted.current) onOpenChange(false);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : t("review.startFailed"));
    } finally {
      pending.current = false;
      if (mounted.current) setStarting(false);
    }
  }

  return <Dialog open={open} onOpenChange={(next) => { if (!starting) onOpenChange(next); }}>
    <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>{t("review.start")}</DialogTitle>
        <DialogDescription>{t("review.startDescription")}</DialogDescription>
      </DialogHeader>
      <div className="grid min-w-0 gap-4">
        <p className="truncate text-xs text-muted-foreground" title={cwd}>{cwd}</p>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-scope`}>{t("review.scopeLabel")}</Label>
          <Select value={scope} onValueChange={(value) => { if (SCOPES.includes(value as ReviewScope)) setScope(value as ReviewScope); }} disabled={starting}>
            <SelectTrigger id={`${id}-scope`} className="w-full"><SelectValue>{t(`review.scopes.${scope}`)}</SelectValue></SelectTrigger>
            <SelectContent>{SCOPES.map((value) => <SelectItem key={value} value={value}>{t(`review.scopes.${value}`)}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        {scope === "branch" ? <div className="grid gap-1.5">
          <Label htmlFor={`${id}-base`}>{t("review.baseLabel")}</Label>
          <Input id={`${id}-base`} value={base} onChange={(event) => setBase(event.target.value)} disabled={starting} placeholder={t("review.basePlaceholder")} />
          <p className="text-xs text-muted-foreground">{t("review.baseHint")}</p>
        </div> : null}
        {scope === "commit" ? <div className="grid gap-1.5">
          <Label htmlFor={`${id}-commit`}>{t("review.commitLabel")}</Label>
          <Input id={`${id}-commit`} value={commit} onChange={(event) => setCommit(event.target.value)} disabled={starting} placeholder={t("review.commitPlaceholder")} />
        </div> : null}
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-instructions`}>{t("review.instructionsLabel")}</Label>
          <Textarea id={`${id}-instructions`} value={instructions} onChange={(event) => setInstructions(event.target.value)} disabled={starting} placeholder={t("review.instructionsPlaceholder")} className="min-h-24 text-sm" />
        </div>
        {error ? <p role="alert" className="whitespace-pre-wrap text-sm text-destructive wrap-anywhere">{error}</p> : null}
      </div>
      <DialogFooter>
        <Button variant="outline" disabled={starting} onClick={() => onOpenChange(false)}>{t("review.cancel")}</Button>
        <Button disabled={starting || !conversationId || (scope === "commit" && !commit.trim())} onClick={() => void start()}>{starting ? <Spinner /> : null}{t(starting ? "review.starting" : "review.start")}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
