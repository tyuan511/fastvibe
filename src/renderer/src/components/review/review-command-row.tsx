import { type JSX } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { SlashIcon } from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";

/**
 * The `/review` line a person typed, drawn as the command it is.
 *
 * `/review` starts a review run instead of becoming a prompt, so no model ever reads it
 * and a chat bubble would claim it was something asked of the assistant. It stays in the
 * transcript because it is still the thing the person did — the review card below it is
 * the answer — so it is shown as one quiet command chip rather than a second prompt.
 *
 * Only the command word is emphasised; everything after it is the requirement text the
 * run was started with, kept in its own wrapping block so a multi-line requirement stays
 * readable instead of turning into one long clipped line.
 */
export function ReviewCommandRow({ text }: { text: string }): JSX.Element {
  const match = /^(\/[^\s]+)([\s\S]*)$/.exec(text.trim());
  const name = match?.[1] ?? "/review";
  const rest = (match?.[2] ?? "").trim();

  return (
    <div data-review-command={name} className="flex justify-center py-1">
      <div className="flex w-full max-w-3xl min-w-0 items-start gap-2 rounded-xl border border-border/60 bg-muted/40 px-3 py-2">
        <HugeiconsIcon strokeWidth={2} icon={SlashIcon} className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1 space-y-1">
          <p className={cn("font-mono text-xs leading-5 text-foreground/90 wrap-anywhere")}>{name}</p>
          {rest ? <p className="text-xs leading-5 whitespace-pre-wrap text-muted-foreground wrap-anywhere">{rest}</p> : null}
        </div>
      </div>
    </div>
  );
}
