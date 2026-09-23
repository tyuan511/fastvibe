import { useEffect, useLayoutEffect, useState, type RefObject, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type SelectionRect = { left: number; top: number; bottom: number; width: number };

export function SelectionActionBar({
  containerRef,
  onAddToConversation,
  onAskInSideChat,
}: {
  containerRef: RefObject<HTMLElement | null>;
  onAddToConversation?: (text: string) => void;
  onAskInSideChat?: (text: string) => void;
}): JSX.Element | null {
  const { t } = useTranslation("chat");
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

  useLayoutEffect(() => {
    if (!selection) return;
    // Re-check after layout so a newly mounted toolbar does not affect the range.
    const current = window.getSelection();
    if (!current || current.isCollapsed) setSelection(null);
  }, [selection]);

  if (!selection || (!onAddToConversation && !onAskInSideChat)) return null;

  const toolbarWidth = 310;
  const left = Math.max(8, Math.min(window.innerWidth - toolbarWidth - 8, selection.rect.left + selection.rect.width / 2 - toolbarWidth / 2));
  const above = selection.rect.top > 64;
  return (
    <div
      role="toolbar"
      aria-label={t("message.selection.label")}
      className={cn(
        "fixed z-50 flex items-center overflow-hidden rounded-xl border border-border/70 bg-popover p-0.5 text-popover-foreground shadow-lg",
        "animate-in fade-in-0 zoom-in-95 duration-100",
      )}
      style={{ left, top: above ? selection.rect.top - 8 : selection.rect.bottom + 8, transform: above ? "translateY(-100%)" : undefined }}
      onMouseDown={(event) => event.preventDefault()}
    >
      {onAddToConversation ? (
        <Button
          variant="ghost"
          size="sm"
          className="h-8 rounded-lg px-3 text-sm"
          onClick={() => {
            const text = selection.text;
            setSelection(null);
            onAddToConversation(text);
          }}
        >
          {t("message.selection.addToConversation")}
        </Button>
      ) : null}
      {onAddToConversation && onAskInSideChat ? <div className="h-5 w-px bg-border" /> : null}
      {onAskInSideChat ? (
        <Button
          variant="ghost"
          size="sm"
          className="h-8 rounded-lg px-3 text-sm"
          onClick={() => {
            const text = selection.text;
            setSelection(null);
            onAskInSideChat(text);
          }}
        >
          {t("message.selection.askInSideChat")}
        </Button>
      ) : null}
    </div>
  );
}
