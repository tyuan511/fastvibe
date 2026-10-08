import { Fragment, useEffect, useLayoutEffect, useRef, useState, type RefObject, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type SelectionRect = { left: number; top: number; bottom: number; width: number };

export function SelectionActionBar({
  containerRef,
  onAddToConversation,
  onAskInSideChat,
  onQuote,
}: {
  containerRef: RefObject<HTMLElement | null>;
  onAddToConversation?: (text: string) => void;
  onAskInSideChat?: (text: string) => void;
  /** Quote the selection into the composer. File previews use this; the chat does not. */
  onQuote?: (text: string) => void;
}): JSX.Element | null {
  const { t } = useTranslation("chat");
  const barRef = useRef<HTMLDivElement>(null);
  const [barWidth, setBarWidth] = useState(0);
  const [selection, setSelection] = useState<{ text: string; rect: SelectionRect } | null>(null);

  useEffect(() => {
    const update = () => {
      const root = containerRef.current;
      const current = window.getSelection();
      if (!root || !current || current.isCollapsed || !current.toString().trim()) {
        setSelection(null);
        return;
      }
      const anchor = current.anchorNode;
      const focus = current.focusNode;
      if (!anchor || !focus || (!root.contains(anchor) && !root.contains(focus))) {
        setSelection(null);
        return;
      }
      const range = current.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (!rect.width && !rect.height) {
        setSelection(null);
        return;
      }
      setSelection({
        text: current.toString().trim(),
        rect: { left: rect.left, top: rect.top, bottom: rect.bottom, width: rect.width },
      });
    };
    document.addEventListener("selectionchange", update);
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      document.removeEventListener("selectionchange", update);
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [containerRef]);

  const buttons: { key: string; label: string; run: (text: string) => void }[] = [
    {
      key: "copy",
      label: t("message.selection.copy"),
      run: (text) => void navigator.clipboard?.writeText(text),
    },
  ];
  if (onQuote) {
    buttons.push({ key: "quote", label: t("message.selection.quoteCode"), run: onQuote });
  }
  if (onAddToConversation) {
    buttons.push({ key: "add", label: t("message.selection.addToConversation"), run: onAddToConversation });
  }
  if (onAskInSideChat) {
    buttons.push({ key: "ask", label: t("message.selection.askInSideChat"), run: onAskInSideChat });
  }

  useLayoutEffect(() => {
    if (!selection) return;
    // Re-check after layout so a newly mounted toolbar does not affect the range.
    const current = window.getSelection();
    if (!current || current.isCollapsed) {
      setSelection(null);
      return;
    }
    const next = barRef.current?.offsetWidth ?? 0;
    if (next && next !== barWidth) setBarWidth(next);
  }, [selection, barWidth, buttons.length]);

  if (!selection) return null;

  const width = barWidth || 240;
  const left = Math.max(8, Math.min(window.innerWidth - width - 8, selection.rect.left + selection.rect.width / 2 - width / 2));
  const above = selection.rect.top > 64;
  return (
    <div
      ref={barRef}
      role="toolbar"
      aria-label={t("message.selection.label")}
      className={cn(
        // `overlay-surface`: the same edge, depth and (under 玻璃效果) glass as every
        // other floating layer, which a hand-rolled bar would silently miss.
        "overlay-surface fixed z-50 flex items-center overflow-hidden rounded-xl border border-border/70 bg-popover p-0.5 text-popover-foreground shadow-lg",
        "animate-in fade-in-0 zoom-in-95 duration-100",
      )}
      style={{ left, top: above ? selection.rect.top - 8 : selection.rect.bottom + 8, transform: above ? "translateY(-100%)" : undefined }}
      onMouseDown={(event) => event.preventDefault()}
    >
      {buttons.map((button, index) => (
        <Fragment key={button.key}>
          {index > 0 ? <div className="h-5 w-px bg-border" /> : null}
          <Button
            variant="ghost"
            size="sm"
            className="h-8 rounded-lg px-3 text-sm whitespace-nowrap"
            onClick={() => {
              const text = selection.text;
              setSelection(null);
              button.run(text);
            }}
          >
            {button.label}
          </Button>
        </Fragment>
      ))}
    </div>
  );
}
