import { useEffect, useRef, useState, type JSX, type ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowRight01Icon, Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * Expand state survives re-renders because streaming clones the message object on
 * every token, and a re-group can remount the row. zcode keeps the same per-tool
 * map (`TU`), bounded so a long session cannot grow it without limit.
 */
const EXPANDED = new Map<string, boolean>();
const EXPANDED_LIMIT = 800;

function rememberExpanded(key: string, open: boolean): void {
  EXPANDED.set(key, open);
  if (EXPANDED.size <= EXPANDED_LIMIT) return;
  for (const stale of [...EXPANDED.keys()].slice(0, EXPANDED.size - EXPANDED_LIMIT)) EXPANDED.delete(stale);
}

/**
 * One tool summary line, modelled on zcode's `ToolLayout`:
 *
 *   [icon] [label(verb)] [subject] [muted context] [failure] [chevron]
 *
 * The chevron only appears on hover so a settled transcript stays quiet. Rows are
 * collapsed by default — zcode's `autoOpen`/`autoCollapseOnComplete` are opt-in
 * and unused for the built-in tools.
 */
export function ToolRow({
  icon,
  label,
  subject,
  context,
  error,
  running = false,
  title,
  canToggle = true,
  showIcon = true,
  persistKey,
  autoOpen = false,
  autoCollapseOnComplete = false,
  onSubjectClick,
  trailing,
  children,
}: {
  /** Stable identity used to remember whether the user expanded this row. */
  persistKey?: string;
  icon: ReactNode;
  label: string;
  subject?: string;
  context?: string;
  error?: string;
  running?: boolean;
  title?: string;
  canToggle?: boolean;
  /** Group children hide the icon so the group's kind label carries the category. */
  showIcon?: boolean;
  /** Open as soon as the call starts running. */
  autoOpen?: boolean;
  /** Fold the body back up when the call settles. */
  autoCollapseOnComplete?: boolean;
  /** When set, the subject becomes a link (zcode opens the file viewer this way). */
  onSubjectClick?: () => void;
  /** Extra chip rendered before the chevron, e.g. a diff stat. */
  trailing?: ReactNode;
  children?: ReactNode;
}): JSX.Element {
  const hasDetail = Boolean(children);
  const expandable = hasDetail && canToggle;
  const [open, setOpen] = useState(() => (persistKey ? EXPANDED.get(persistKey) ?? false : false));
  const wasRunning = useRef(running);

  useEffect(() => {
    if (!persistKey) return;
    setOpen(EXPANDED.get(persistKey) ?? false);
  }, [persistKey]);

  useEffect(() => {
    if (autoOpen && running) {
      setOpen(true);
      if (persistKey) rememberExpanded(persistKey, true);
    }
  }, [autoOpen, running, persistKey]);

  useEffect(() => {
    const previous = wasRunning.current;
    wasRunning.current = running;
    if (autoCollapseOnComplete && previous && !running) {
      setOpen(false);
      if (persistKey) rememberExpanded(persistKey, false);
    }
  }, [autoCollapseOnComplete, running, persistKey]);

  const handleOpenChange = (next: boolean): void => {
    setOpen(next);
    if (persistKey) rememberExpanded(persistKey, next);
  };

  const subjectNode =
    subject && onSubjectClick ? (
      <button
        type="button"
        title={title ?? subject}
        className="min-w-0 max-w-full shrink cursor-pointer truncate font-mono text-[11.5px] text-foreground underline-offset-2 hover:underline"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onSubjectClick();
        }}
      >
        {subject}
      </button>
    ) : subject ? (
      <span className="min-w-0 truncate font-mono text-[11.5px] text-foreground">{subject}</span>
    ) : null;

  const summary = (
    <>
      {showIcon ? <span className="shrink-0 text-muted-foreground [&_svg]:size-3.5">{icon}</span> : null}
      <span className={cn("shrink-0 font-medium", running ? "animated-gradient-text" : "text-muted-foreground")}>
        {label}
      </span>
      {subjectNode}
      {context ? (
        <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground/60">{context}</span>
      ) : null}
      {error ? <FailureHint error={error} /> : null}
      {trailing}
    </>
  );

  const row = (
    <div
      data-slot="tool-row"
      data-tool-id={persistKey}
      data-running={running ? "true" : undefined}
      className="group/tool-summary flex w-full min-w-0 items-center gap-2 text-left text-[12.5px]"
      title={title ?? subject}
    >
      {summary}
      {expandable ? (
        <HugeiconsIcon strokeWidth={2} icon={ArrowRight01Icon}
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground opacity-0 transition-all duration-200",
            "group-hover/tool-summary:opacity-100",
            open && "rotate-90 opacity-100",
          )}
        />
      ) : null}
    </div>
  );

  if (!expandable) return row;

  return (
    <Collapsible open={open} onOpenChange={handleOpenChange}>
      <CollapsibleTrigger className="w-full cursor-pointer rounded-sm text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
        {row}
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-2">
        <div className="ml-2 flex flex-col gap-2 border-l border-border pl-3.5">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Failure badge with the engine's message on hover, and a copy affordance. */
function FailureHint({ error }: { error: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const trimmed = error.trim();
  const text = trimmed.length > 4000 ? `${trimmed.slice(0, 4000)}\n…` : trimmed;

  if (!text) return <span className="shrink-0 text-[11.5px] text-destructive">执行失败</span>;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="shrink-0 cursor-help text-[11.5px] text-destructive underline decoration-dotted underline-offset-2">
            执行失败
          </span>
        }
      />
      <TooltipContent side="top" align="start" className="max-w-96">
        <div className="flex max-w-96 items-start gap-2">
          <span className="line-clamp-6 min-w-0 flex-1 text-[11.5px] whitespace-pre-wrap break-words">
            {text}
          </span>
          <button
            type="button"
            className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
            aria-label={copied ? "已复制" : "复制"}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void navigator.clipboard.writeText(trimmed).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            {copied ? <HugeiconsIcon strokeWidth={2} icon={Tick02Icon} className="size-3" /> : <HugeiconsIcon strokeWidth={2} icon={Copy01Icon} className="size-3" />}
          </button>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
