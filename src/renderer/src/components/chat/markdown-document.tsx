import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { documentOutline, splitFrontmatter, type FrontmatterField } from "@shared/file-document";
import { MarkdownView } from "@/components/chat/markdown-view";

/**
 * The file pane's rendered Markdown, drawn as a document rather than as a reply.
 *
 * A reply fills the column it is given; a document is a fixed measure with the page
 * around it, which is what makes a long README readable in a pane that can be dragged
 * from 260px to the whole window. `max-width: 36em` and a centred column is the whole
 * of that idea, and the container query keeps the padding proportional to the pane
 * rather than to the window.
 *
 * The outline is read from the source (`documentOutline`) and the heading ids are
 * written by the same slugger (`rehype-heading-ids`), so a contents entry cannot point
 * at an id that does not exist.
 */

/** Claude only offers the contents rail once a document is long enough to need one. */
const RAIL_MIN_ENTRIES = 3;

/** Past this many entries the rail shows only the top two levels, like Claude's. */
const RAIL_FULL_LIMIT = 24;

/** How far a click may scroll the document before the rail gives up its highlight. */
const ACTIVE_BAND = 0.2;

export function MarkdownDocument({ text }: { text: string }): JSX.Element {
  const { t } = useTranslation("sidepane");
  const scroller = useRef<HTMLDivElement>(null);
  const parsed = useMemo(() => splitFrontmatter(text), [text]);
  const body = parsed?.body ?? text;
  const outline = useMemo(() => documentOutline(body), [body]);
  const [active, setActive] = useState<string | null>(null);

  // The rail's highlight follows the scroll position rather than a click, so the
  // reader can see where they are after scrolling by hand. Entries are matched by
  // their rendered headings, which the heading-id plugin guarantees exist.
  useEffect(() => {
    const node = scroller.current;
    if (!node || outline.length === 0) return;
    let frame = 0;
    const measure = (): void => {
      frame = 0;
      const band = node.getBoundingClientRect().top + node.clientHeight * ACTIVE_BAND;
      let current: string | null = outline[0]?.slug ?? null;
      for (const entry of outline) {
        const heading = node.querySelector(`#${CSS.escape(entry.slug)}`);
        if (!heading) continue;
        if (heading.getBoundingClientRect().top >= band) break;
        current = entry.slug;
      }
      setActive(current);
    };
    const schedule = (): void => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };
    measure();
    node.addEventListener("scroll", schedule, { passive: true });
    return () => {
      node.removeEventListener("scroll", schedule);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [outline]);

  function jump(slug: string): void {
    const node = scroller.current;
    const heading = node?.querySelector(`#${CSS.escape(slug)}`);
    if (!node || !heading) return;
    node.scrollTo({ top: heading.getBoundingClientRect().top - node.getBoundingClientRect().top + node.scrollTop, behavior: "smooth" });
  }

  return (
    <div className="chat-document" ref={scroller}>
      {/* The rail comes first and is zero-height, so it takes no layout space and sticks
          to the top of the scroll area — the marks sit in the gutter beside the text. */}
      {outline.length >= RAIL_MIN_ENTRIES ? (
        <DocumentRail
          entries={outline}
          active={active}
          label={t("files.contents")}
          onJump={jump}
        />
      ) : null}
      <div className="chat-document-column">
        {parsed && parsed.fields.length > 0 ? <Frontmatter fields={parsed.fields} /> : null}
        <MarkdownView text={body} headingIds className="chat-markdown text-sm" />
      </div>
    </div>
  );
}

/**
 * Frontmatter as a definition list, above a rule.
 *
 * A list value is drawn as chips: `tools: [read, write]` is two things, and a reader
 * scanning a skill file is looking for exactly that. A long prose field keeps its line
 * breaks rather than being joined into a paragraph.
 */
function Frontmatter({ fields }: { fields: FrontmatterField[] }): JSX.Element {
  return (
    <dl className="chat-document-frontmatter">
      {fields.map((field) => (
        <div key={field.key} className="contents">
          <dt>{fieldLabel(field.key)}</dt>
          <dd>
            {field.items && field.items.length > 0 ? (
              <ul role="list">
                {field.items.map((item, index) => (
                  <li key={`${item}-${index}`}>{item}</li>
                ))}
              </ul>
            ) : (
              field.value
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** `allowed-tools` reads as `Allowed tools`: a key is a word, not an identifier. */
function fieldLabel(key: string): string {
  const spaced = key.replace(/[-_]/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * The contents rail: a column of marks beside the text, one per heading, widening
 * into a labelled list on hover.
 *
 * A mark is one line of the list at rest, so the rail says how long a document is and
 * where the reader is without ever covering the text it indexes. It is `position:
 * sticky` inside the column rather than fixed to the pane, so a short document's rail
 * travels with it and a scrolled one stays put.
 */
function DocumentRail({
  entries,
  active,
  label,
  onJump,
}: {
  entries: { depth: number; text: string; slug: string }[];
  active: string | null;
  label: string;
  onJump: (slug: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const shallowest = Math.min(...entries.map((entry) => entry.depth));
  const items = useMemo(() => {
    const normalised = entries.map((entry) => ({ ...entry, depth: entry.depth - shallowest }));
    return normalised.length > RAIL_FULL_LIMIT ? normalised.filter((entry) => entry.depth <= 1) : normalised;
  }, [entries, shallowest]);
  return (
    <div
      className="chat-document-rail"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <nav aria-label={label} className={cn("chat-document-rail-nav", open && "is-open")}>
        <ol aria-hidden={!open}>
          {items.map((entry) => (
            <li key={entry.slug} data-depth={Math.min(entry.depth, 2)} data-active={entry.slug === active ? "" : undefined}>
              <span aria-hidden className="chat-document-rail-mark" />
            </li>
          ))}
        </ol>
        {open ? (
          <div className="chat-document-rail-panel overlay-surface">
            <ol role="list">
              {items.map((entry) => (
                <li key={entry.slug}>
                  <button
                    type="button"
                    aria-current={entry.slug === active ? "true" : undefined}
                    onClick={() => onJump(entry.slug)}
                  >
                    <span aria-hidden className="chat-document-rail-mark" data-depth={Math.min(entry.depth, 2)} data-active={entry.slug === active ? "" : undefined} />
                    <span className="chat-document-rail-label" style={{ paddingInlineStart: entry.depth * 10 }}>
                      {entry.text}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          </div>
        ) : null}
      </nav>
    </div>
  );
}
