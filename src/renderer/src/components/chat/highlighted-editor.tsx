import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent, type UIEvent } from "react";
import { useHighlightedCode } from "@/lib/highlight";
import { cn } from "@/lib/utils";

/**
 * A source editor with syntax highlighting, without a second editor dependency.
 *
 * The trick is an overlay: a real `<textarea>` carries the caret, the selection, the
 * undo stack and every platform behaviour, and a Shiki-highlighted `<pre>` is painted
 * underneath it. The textarea's own text is transparent, so what the reader sees is the
 * highlight while what they type into is the textarea. Both layers must agree on every
 * metric that moves text — font, size, leading, padding, tab size and wrapping — which is
 * why they share one set of declarations (`chat-editor-layer`) rather than two that look
 * alike.
 *
 * What this deliberately is not: a full editor. No line numbers, no folding, no bracket
 * matching, no multiple cursors. The file pane's job is showing a file and letting a
 * small edit be made and saved; a real editor is a different surface.
 */
export function HighlightedEditor({
  value,
  language,
  wrap,
  label,
  onChange,
  onScroll,
}: {
  value: string;
  language?: string;
  /** Soft-wrap long lines. On for prose, off for code — a wrapped line is not a line. */
  wrap: boolean;
  label: string;
  onChange: (text: string) => void;
  onScroll?: (event: UIEvent<HTMLTextAreaElement>) => void;
}): JSX.Element {
  const area = useRef<HTMLTextAreaElement>(null);
  const highlight = useRef<HTMLDivElement>(null);
  // The caret position to restore after React re-renders the value.
  const caret = useRef<number | null>(null);
  // The highlight lags the keystroke by a frame; without this the text under the caret
  // would flicker back to the previous colouring on every character.
  const [deferred, setDeferred] = useState(value);

  const html = useHighlightedCode(deferred, language);

  useEffect(() => {
    // Highlighting is async (the grammar may still be loading), so the layer is only
    // worth painting once it is for the text currently on screen.
    setDeferred(value);
  }, [value]);

  useLayoutEffect(() => {
    const node = area.current;
    if (!node || caret.current === null) return;
    const next = caret.current;
    caret.current = null;
    node.selectionStart = node.selectionEnd = next;
  }, [value]);

  // The layers scroll together: the textarea owns the scrollbar and the highlight
  // follows it, so a long file does not show its text drifting away from its colour.
  function syncScroll(): void {
    const node = area.current;
    const layer = highlight.current;
    if (!node || !layer) return;
    layer.scrollTop = node.scrollTop;
    layer.scrollLeft = node.scrollLeft;
  }

  useEffect(() => {
    syncScroll();
  }, [value, html]);

  /**
   * Tab inserts two spaces instead of leaving the field.
   *
   * Indentation is the one thing a code editor must do that a text field does not; the
   * caret is placed by hand because setting `value` moves it to the end.
   */
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== "Tab" || event.altKey || event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    const node = event.currentTarget;
    const start = node.selectionStart;
    const end = node.selectionEnd;
    caret.current = start + 2;
    onChange(`${value.slice(0, start)}  ${value.slice(end)}`);
  }

  const trailing = useMemo(() => (value.endsWith("\n") ? " " : ""), [value]);

  return (
    <div className="chat-editor">
      {/* A div host, not a `<pre>`: Shiki's own markup is a `<pre class="shiki">` and a
          pre inside a pre is invalid HTML. `code-shiki` already neutralises that inner
          pre's background and padding, so it inherits this layer's metrics. */}
      <div
        ref={highlight}
        aria-hidden
        className={cn("chat-editor-layer chat-editor-highlight code-shiki", wrap ? "is-wrapped" : "is-scrolling")}
      >
        {html ? (
          <div dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <pre>{value}</pre>
        )}
        {/* A trailing newline has nothing after it to give the last line height, so the
            highlight would sit one line short of the textarea's own content. */}
        {trailing}
      </div>
      <textarea
        ref={area}
        aria-label={label}
        value={value}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        autoComplete="off"
        wrap={wrap ? "soft" : "off"}
        className={cn("chat-editor-layer chat-editor-input", wrap ? "is-wrapped" : "is-scrolling")}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        onScroll={(event) => {
          syncScroll();
          onScroll?.(event);
        }}
      />
    </div>
  );
}
