import { useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent, type UIEvent } from "react";
import { gutterSpans, type GutterSpan } from "@/lib/editor-gutter";
import { useHighlightedCode } from "@/lib/highlight";
import { cn } from "@/lib/utils";

/**
 * Soft-wrapped files past this keep a fixed line box. Measuring every row lays
 * out the whole file, and a multi-megabyte page is not what wrap is for — code,
 * which is the editor's normal case, does not wrap at all.
 */
const MAX_MEASURED_LINES = 4000;

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
 * Line numbers sit in their own gutter, outside that scroller. A wide line scrolls
 * sideways under the numbers; the numbers only move when the file scrolls vertically.
 * The gutter's children are written from layout, not rendered by React: a scroll has to
 * move them in the same frame as the text, and a React child list would be wiped or a
 * frame late. React never renders into that node, so a re-render leaves the numbers put.
 *
 * What this deliberately is not: a full editor. No folding, no bracket matching, no
 * multiple cursors. The file pane's job is showing a file and letting a small edit be
 * made and saved; a real editor is a different surface.
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
  const editor = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const highlight = useRef<HTMLDivElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const probe = useRef<HTMLDivElement>(null);
  // The caret position to restore after React re-renders the value.
  const caret = useRef<number | null>(null);
  const lines = useRef<string[]>([""]);
  const digits = useRef(0);
  const measured = useRef<Measured | null>(null);
  lines.current = value.split("\n");
  // The highlight lags the keystroke by a frame; without this the text under the caret
  // would flicker back to the previous colouring on every character.
  const [deferred, setDeferred] = useState(value);
  const html = useHighlightedCode(deferred, language);

  useEffect(() => {
    setDeferred(value);
  }, [value]);

  useLayoutEffect(() => {
    const node = area.current;
    if (!node || caret.current === null) return;
    const next = caret.current;
    caret.current = null;
    node.selectionStart = node.selectionEnd = next;
  }, [value]);

  const layoutRef = useRef<() => void>(() => {});
  layoutRef.current = () => layoutGutter({
    editor: editor.current,
    area: area.current,
    gutter: gutter.current,
    measure: measure.current,
    value,
    lines: lines.current,
    wrap,
    digits,
    measured,
  });

  useLayoutEffect(() => {
    const node = area.current;
    const layer = highlight.current;
    if (node && layer) {
      layer.scrollTop = node.scrollTop;
      layer.scrollLeft = node.scrollLeft;
    }
    layoutRef.current();
  });

  useEffect(() => {
    const node = area.current;
    const line = probe.current;
    if (!node) return;
    // The pane resizing changes which lines are on screen, and — when soft-wrap is
    // on — how tall each one is. The probe is one line of the editor's own font, so a
    // change of interface size retunes the gutter without the textarea's box moving.
    const observer = new ResizeObserver(() => layoutRef.current());
    observer.observe(node);
    if (line) observer.observe(line);
    return () => observer.disconnect();
  }, []);

  // The layers scroll together: the textarea owns the scrollbar and the highlight
  // follows it, so a long file does not show its text drifting away from its colour.
  function syncScroll(): void {
    const node = area.current;
    const layer = highlight.current;
    if (!node || !layer) return;
    layer.scrollTop = node.scrollTop;
    layer.scrollLeft = node.scrollLeft;
    layoutRef.current();
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
    <div ref={editor} className="chat-editor">
      <div ref={gutter} aria-hidden className="chat-editor-gutter" />
      <div className="chat-editor-body">
        {/* Same metrics as the textarea, so a soft-wrapped logical line can be measured
            and the number beside it stays on that line's first row. */}
        <div ref={measure} aria-hidden className="chat-editor-layer chat-editor-measure is-wrapped" />
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
      <div ref={probe} aria-hidden className="chat-editor-probe">0</div>
    </div>
  );
}

interface Measured {
  value: string;
  width: number;
  lineHeight: number;
  paddingTop: number;
  wrap: boolean;
  heights: number[] | null;
}

function layoutGutter(parts: {
  editor: HTMLDivElement | null;
  area: HTMLTextAreaElement | null;
  gutter: HTMLDivElement | null;
  measure: HTMLDivElement | null;
  value: string;
  lines: string[];
  wrap: boolean;
  digits: { current: number };
  measured: { current: Measured | null };
}): void {
  const { editor, area, gutter, measure, value, lines, wrap, digits, measured } = parts;
  if (!editor || !area || !gutter) return;
  const lineCount = Math.max(lines.length, 1);
  const nextDigits = Math.max(2, String(lineCount).length);
  if (digits.current !== nextDigits) {
    digits.current = nextDigits;
    // The track width changes the textarea's wrap width, so measure after it lands.
    editor.style.setProperty("--editor-gutter", `calc(${nextDigits}ch + 1.25rem)`);
    void area.offsetWidth;
  }
  if (area.clientWidth === 0 || area.clientHeight === 0) return;
  const style = getComputedStyle(area);
  const paddingTop = Number.parseFloat(style.paddingTop) || 0;
  const parsed = Number.parseFloat(style.lineHeight);
  const lineHeight = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  const width = area.clientWidth;
  let heights = measured.current?.heights ?? null;
  const same = measured.current?.value === value
    && measured.current.width === width
    && measured.current.lineHeight === lineHeight
    && measured.current.paddingTop === paddingTop
    && measured.current.wrap === wrap;
  if (!same) {
    // A scroll only moves numbers. Measuring every soft-wrapped row lays the file
    // out again, so it happens when the text, the width or the line box changes.
    const canMeasure = wrap && measure !== null && lineCount <= MAX_MEASURED_LINES && lineHeight > 0;
    heights = canMeasure ? lineHeights(measure, lines) : null;
    if (!canMeasure && measure && measure.childElementCount > 0) measure.replaceChildren();
    measured.current = { value, width, lineHeight, paddingTop, wrap, heights };
  }
  paintGutter(gutter, gutterSpans(
    area.scrollTop,
    area.clientHeight,
    lineCount,
    { lineHeight, paddingTop },
    heights,
  ));
}

/** One box per logical line, in the textarea's own wrapping width. */
function lineHeights(measure: HTMLDivElement, lines: string[]): number[] {
  const children = measure.children;
  while (children.length > lines.length) measure.lastElementChild?.remove();
  for (let index = 0; index < lines.length; index++) {
    let child = children[index] as HTMLElement | undefined;
    if (!child) {
      child = document.createElement("div");
      measure.appendChild(child);
    }
    // An empty row collapses, and the textarea still gives that line a line box.
    const text = lines[index].length === 0 ? "\u00a0" : lines[index];
    if (child.textContent !== text) child.textContent = text;
  }
  return Array.from(measure.children, (child) => (child as HTMLElement).getBoundingClientRect().height);
}

function paintGutter(gutter: HTMLDivElement, spans: GutterSpan[]): void {
  const children = gutter.children;
  while (children.length > spans.length) gutter.lastElementChild?.remove();
  for (let index = 0; index < spans.length; index++) {
    let child = children[index] as HTMLElement | undefined;
    if (!child) {
      child = document.createElement("div");
      child.className = "chat-editor-gutter-line";
      gutter.appendChild(child);
    }
    const span = spans[index];
    const label = String(span.index + 1);
    if (child.textContent !== label) child.textContent = label;
    child.style.transform = `translateY(${span.top}px)`;
    child.style.height = `${span.height}px`;
  }
}
