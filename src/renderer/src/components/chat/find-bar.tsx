import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon, ArrowUp02Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useMessageScroller } from "@/components/ui/message-scroller";
import { cn } from "@/lib/utils";
import type { ChatMessage } from "@shared/types";

export type FindMatch = {
  /** Row / message id the match sits in, so `scrollToMessage` can reach it. */
  messageId: string;
  /** Index of this match among all matches, for the `n/N` readout. */
  ordinal: number;
  /** The text around the hit, for the result line. */
  excerpt: string;
};

/**
 * Which messages contain `query`, in reading order.
 *
 * Deliberately a plain `indexOf` over the rendered text rather than a regex or a
 * fuzzy match: this is a *find* control, and a reader typing `foo.bar` means that
 * literal string, not a pattern. Case-insensitive because a transcript is prose as
 * often as it is code, and case is rarely what is being looked for.
 *
 * Only `message.text` is searched. Thinking and tool output are addressable through
 * their cards, but folding them into the hit list would make `n/N` count places the
 * reader cannot see.
 */
export function findMatches(messages: ChatMessage[], query: string): FindMatch[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const matches: FindMatch[] = [];
  for (const message of messages) {
    const text = message.text ?? "";
    const haystack = text.toLowerCase();
    let from = 0;
    for (;;) {
      const index = haystack.indexOf(needle, from);
      if (index < 0) break;
      matches.push({
        messageId: message.id,
        ordinal: matches.length,
        excerpt: excerptAround(text, index, needle.length),
      });
      from = index + needle.length;
    }
  }
  return matches;
}

function excerptAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 28);
  const end = Math.min(text.length, index + length + 44);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ")}${end < text.length ? "…" : ""}`;
}

/**
 * 在会话中查找 — a find bar over the open transcript.
 *
 * Modelled on the editor convention (the shortcut opens it, Enter walks forward,
 * Shift+Enter back, Escape closes) rather than on a modal dialog: finding something in
 * a long transcript is a repeated, low-commitment action, and a dialog that has to be
 * dismissed interrupts exactly the loop it is meant to serve.
 *
 * Matching lives here rather than in the engine so it is instant and works offline; the
 * transcript is already in memory, and a full re-read over IPC per keystroke would be
 * both slower and inconsistent with what is on screen. Jumping is the scroller's own
 * `scrollToMessage`, so a hit on a row whose id came from a retry/edit branch still
 * lands correctly — the row ids are the engine's entry ids, not positions.
 *
 * Rendered *inside* `MessageScrollerProvider`, because that is where `useMessageScroller`
 * is available.
 */
export function FindBar({
  messages,
  open,
  onClose,
  initialQuery,
  onInitialQueryConsumed,
}: {
  messages: ChatMessage[];
  open: boolean;
  onClose: () => void;
  /** Query to prefill when the bar opens (a palette body-search hit). */
  initialQuery?: string;
  onInitialQueryConsumed?: () => void;
}): JSX.Element | null {
  const { t } = useTranslation("chat");
  const { scrollToMessage } = useMessageScroller();
  const [query, setQuery] = useState(initialQuery ?? "");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const matches = useMemo(() => findMatches(messages, query), [messages, query]);

  // A query handed in from the palette is adopted once, when it arrives — not on every
  // render, or a reader who clears the box would have it typed back in. Closing the bar
  // forgets that, so re-opening it from the palette for the *same* query still prefills.
  const consumed = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!open) consumed.current = undefined;
  }, [open]);
  useEffect(() => {
    if (!initialQuery || consumed.current === initialQuery) return;
    consumed.current = initialQuery;
    setQuery(initialQuery);
    onInitialQueryConsumed?.();
  }, [initialQuery, onInitialQueryConsumed]);

  // Reset the cursor when the query changes: keeping index 3 across a new search lands
  // the reader on an arbitrary hit of a completely different result set.
  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [open]);

  useEffect(() => {
    // Nothing to reveal while the bar is closed. This effect used to run regardless, and
    // `matches` is a fresh array on every transcript flush — so after a search, closing
    // the bar left the transcript pinned: each streamed token re-scrolled the viewport
    // back to the old hit and the thread stopped following the bottom.
    if (!open) return;
    const match = matches[active];
    if (match) scrollToMessage(match.messageId);
  }, [open, active, matches, scrollToMessage]);

  const step = useCallback(
    (delta: number): void => {
      if (matches.length === 0) return;
      setActive((current) => (current + delta + matches.length) % matches.length);
    },
    [matches.length],
  );

  if (!open) return null;

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border bg-background px-3 py-1.5">
      <Input
        ref={inputRef}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            step(event.shiftKey ? -1 : 1);
          } else if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
        placeholder={t("find.placeholder")}
        className="h-7 max-w-64 flex-1 text-sm"
      />
      <span className={cn("shrink-0 text-xs tabular-nums", matches.length === 0 && query ? "text-destructive" : "text-muted-foreground")}>
        {query ? t("find.position", { index: matches.length === 0 ? 0 : active + 1, total: matches.length }) : ""}
      </span>
      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          size="icon-xs"
          variant="ghost"
          className="text-muted-foreground"
          aria-label={t("find.previous")}
          disabled={matches.length === 0}
          onClick={() => step(-1)}
        >
          <HugeiconsIcon strokeWidth={2} icon={ArrowUp02Icon} className="size-3.5" />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          className="text-muted-foreground"
          aria-label={t("find.next")}
          disabled={matches.length === 0}
          onClick={() => step(1)}
        >
          <HugeiconsIcon strokeWidth={2} icon={ArrowDown01Icon} className="size-3.5" />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          className="text-muted-foreground"
          aria-label={t("find.close")}
          onClick={onClose}
        >
          <HugeiconsIcon strokeWidth={2} icon={Cancel01Icon} className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
