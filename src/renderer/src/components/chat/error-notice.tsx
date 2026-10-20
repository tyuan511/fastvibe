import { useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { AlertCircleIcon, ArrowRight01Icon, Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { describeAssistantError, errorHasDetail } from "@shared/assistant-error";
import { cn } from "@/lib/utils";

/**
 * 会话里的报错：一句结论 + 供应商的补充说明 + 可展开的原文 + 一键复制。
 *
 * What it replaced was a red bubble holding the provider's `errorMessage` whole. Three shapes
 * of that string broke it, and each one broke the *layout*, not just the reading:
 *
 * - a gateway status glued to JSON (`429: {"message":…`), which had to be parsed by eye;
 * - a setup error of three paragraphs ending in a `file:///Users/…` path, one long line with
 *   nothing to wrap on;
 * - a stack trace from a git or pnpm failure, indented and dozens of lines deep.
 *
 * So the card is a definite-width column of single lines: every row is `wrap-anywhere`, a
 * path or URL gets a monospaced row of its own rather than forcing the column wider, and the
 * provider's advice is capped at three lines with the rest behind 查看详情. `MessageContent`
 * sizes an unconstrained child to fit-content, and the min-content width of a 300-character
 * path is the whole path — that is what pushed the transcript's scrollWidth past its
 * clientWidth and drew a horizontal scrollbar across every row of the thread.
 *
 * 复制 copies the raw text, because that is what gets pasted into a support thread; the detail
 * block is `select-text` too, since a drag-select that produces nothing reads as broken.
 *
 * The card is quiet on purpose: a tinted border and a small mark, not a filled red box. A
 * failed request is one row in a transcript, and the loudest thing on screen should stay the
 * reply the person was reading.
 */

/** How many of the provider's own lines the card shows before the disclosure takes over. */
const MAX_BODY_LINES = 3;

/**
 * A line that carries no wrap point of its own: a filesystem path, a URL, a stack frame's
 * address. Drawn monospaced and broken, never truncated — a path is what the person is
 * expected to act on.
 */
const UNBREAKABLE = /^(?:[A-Za-z]:[\\/]|~?\/|[A-Za-z][\w+.-]*:\/\/)/;

function looksLikePath(line: string): boolean {
  if (line.length < 32) return false;
  if (!line.includes(" ")) return UNBREAKABLE.test(line);
  // `at file:///Users/…/App.tsx:12:3` and `For details, see: https://…` are the same problem as
  // a bare path: one token in the line has no wrap point, and it is the long one. Draw the whole
  // line monospaced and small instead, so a stack frame reads as a frame rather than as prose
  // with a giant word inside it.
  return line.split(/\s+/).some((token) => token.length >= 32 && UNBREAKABLE.test(token));
}

export function AssistantErrorNotice({ error }: { error: string }): JSX.Element {
  const { t } = useTranslation("chat");
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  const shape = describeAssistantError(error);
  const body = shape.body.filter((line) => line.trim() !== "");
  const shown = body.slice(0, MAX_BODY_LINES);
  // Nothing to disclose for a plain `Connection error.` — no body, no second line. The
  // control is then absent rather than opening onto the same sentence again.
  const hasMore = body.length > shown.length || errorHasDetail(shape);

  const copy = (): void => {
    void navigator.clipboard
      .writeText(shape.detail || error)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      // A refused clipboard (no user gesture, a locked-down surface) leaves the control as it
      // was: the detail is still selectable, so there is something to copy either way.
      .catch(() => undefined);
  };

  return (
    <div
      data-slot="assistant-error"
      className="flex w-full max-w-2xl items-start gap-2.5 rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2.5 text-sm"
    >
      <HugeiconsIcon strokeWidth={2} icon={AlertCircleIcon} className="mt-0.5 size-3.5 shrink-0 text-destructive" />
      <Collapsible open={open} onOpenChange={setOpen} className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {shape.status !== undefined ? (
            <span className="shrink-0 rounded border border-destructive/30 px-1.5 py-px font-mono text-xs leading-4 text-destructive tabular-nums">
              {shape.status}
            </span>
          ) : null}
          <span
            className={cn(
              // `wrap-anywhere` rather than `wrap-break-word`: only the former also shrinks
              // the element's min-content width, which is what a fit-content parent measures.
              "min-w-0 text-sm leading-5 wrap-anywhere select-text",
              shape.headline ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {shape.headline || t("message.errorNoMessage")}
          </span>
          {shape.code ? (
            <span className="shrink-0 rounded border border-destructive/25 px-1.5 py-px font-mono text-xs leading-4 text-destructive/80">
              {shape.code}
            </span>
          ) : null}
        </div>

        {shown.length > 0 ? (
          <div className="flex min-w-0 flex-col gap-0.5">
            {shown.map((line, index) => (
              <span
                key={`${index}-${line.slice(0, 16)}`}
                className={cn(
                  "min-w-0 leading-5 wrap-anywhere select-text",
                  looksLikePath(line)
                    ? "font-mono text-xs text-muted-foreground"
                    : "text-sm text-muted-foreground",
                )}
              >
                {line}
              </span>
            ))}
          </div>
        ) : null}

        <div className="flex items-center gap-2.5">
          {hasMore ? (
            <CollapsibleTrigger className="inline-flex cursor-pointer items-center gap-1 rounded-sm text-xs leading-4 text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
              <HugeiconsIcon
                strokeWidth={2}
                aria-hidden
                icon={ArrowRight01Icon}
                className={cn("size-3 shrink-0 transition-transform duration-200", open && "rotate-90")}
              />
              <span>{open ? t("message.errorDetailHide") : t("message.errorDetailShow")}</span>
            </CollapsibleTrigger>
          ) : null}
          {/* No hover requirement: this is the affordance the report asked for, and a phone
              has nowhere to hover. */}
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={t("message.errorDetailCopy")}
                  onClick={copy}
                  className="inline-flex cursor-pointer items-center gap-1 rounded-sm text-xs leading-4 text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                />
              }
            >
              <HugeiconsIcon strokeWidth={2} icon={copied ? Tick02Icon : Copy01Icon} className="size-3 shrink-0" />
              <span>{copied ? t("message.copied") : t("message.errorDetailCopy")}</span>
            </TooltipTrigger>
            <TooltipContent>{t("message.errorDetailCopy")}</TooltipContent>
          </Tooltip>
        </div>

        {hasMore ? (
          <CollapsibleContent className="min-w-0">
            {/*
             * Capped and scrollable: a provider can answer with a hundred lines, and the
             * transcript around this card must not be pushed around by that. `overflow-auto`
             * makes this the scroll container, so a long line wraps inside it instead of
             * widening the column — the card's own width stays `max-w-2xl`.
             */}
            <pre className="mt-0.5 max-h-64 min-w-0 overflow-auto rounded-md border border-border bg-muted/40 px-2.5 py-2 font-mono text-xs leading-5 whitespace-pre-wrap wrap-anywhere text-muted-foreground select-text">
              {shape.detail}
            </pre>
          </CollapsibleContent>
        ) : null}
      </Collapsible>
    </div>
  );
}
