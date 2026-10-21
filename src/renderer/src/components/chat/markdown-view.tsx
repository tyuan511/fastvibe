import { createContext, forwardRef, memo, useContext, useDeferredValue, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import Markdown, { defaultUrlTransform, type Components } from "react-markdown";
import { REMARK_PLUGINS, REHYPE_PLUGINS, REHYPE_PLUGINS_WITH_HEADING_IDS } from "@/lib/markdown-pipeline";
import { isPathLike } from "@/lib/remark-path-links";
import { useValidatedMarkdownPaths } from "@/lib/markdown-path-validation";
import { HugeiconsIcon } from "@hugeicons/react";
import { Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { FileIcon } from "@/components/file-icon";
import { codeFenceIconName } from "@/lib/code-fence-icon";
import { PathLink } from "@/components/path-menu";
import { useHighlightedCode } from "@/lib/highlight";
import { splitMarkdownBlocks } from "@/lib/markdown-blocks";
import { collapseBlankRuns } from "@/lib/blank-output";
import { useSessionStore } from "@/stores/session";
import { resolvePath } from "@/lib/workspace-path";
import { stripMemoryCitation } from "@shared/memory-citation";
import { markdownMedia } from "@/lib/markdown-media";
import { cn } from "@/lib/utils";
import { DiffView } from "./diff-view";
import { InlineMediaItem } from "./inline-preview";

/**
 * Markdown, with math and raw HTML.
 *
 * The pipeline itself is `@/lib/markdown-pipeline` — a module this file can share with a test,
 * which is what lets the order of `rehype-raw`, the sanitizer and KaTeX be pinned rather than
 * eyeballed. What stays here is only how the tokens it produces are drawn: the fence becomes
 * `CodeBlock`, a path link becomes a `PathLink`, a table gets its scroll wrapper.
 *
 * The constants are module-level in that module for the same reason they are here: an inline
 * array would be a new identity on every render of every streamed token, and that is the one
 * thing `memo` on the block component exists to prevent.
 */
/** Fence languages whose body is a diff, drawn by `DiffView` rather than Shiki. */
const DIFF_LANGUAGES = new Set(["diff", "patch"]);
const MAX_CODE_PREVIEW_CHARS = 24_000;

/**
 * The line-number column beside a fenced block.
 *
 * One box of `digits` characters plus its padding plus the 1px rule — the same arithmetic
 * `DiffView` uses, and for the same reason: a `min-width` floor is exceeded by the rows that
 * carry a number, so the rule between the gutter and the code would step in and out as the
 * block grows. `overflow-hidden` on the cell keeps a long line from doing it either.
 */
const gutterWidth = (digits: number) => ({ width: `calc(${digits}ch + 0.75rem + 1px)` });

/**
 * Line numbers as one `whitespace-pre` box rather than one element per line.
 *
 * A reply's fence is re-rendered on every streamed flush, and a 600-line block would then
 * rebuild 600 number nodes each time to say the same thing it said one token ago. One text
 * node of `"1\n2\n…"` right-aligned in a fixed-width column puts a number on every line
 * because nothing here wraps: the code column is `overflow-x-auto`, so one logical line is
 * one visual line, and the two columns share `leading-5` and the same vertical padding.
 */
const MarkdownCodeGutter = memo(function MarkdownCodeGutter({ lines }: { lines: number }): JSX.Element {
  const numbers = useMemo(() => Array.from({ length: lines }, (_, index) => index + 1).join("\n"), [lines]);
  return (
    <div
      aria-hidden
      style={gutterWidth(String(lines).length)}
      className="shrink-0 select-none overflow-hidden whitespace-pre border-r border-border px-1.5 py-2 text-right font-mono text-xs leading-5 tabular-nums text-muted-foreground/60"
    >
      {numbers}
    </div>
  );
});

const MarkdownPathContext = createContext<ReadonlySet<string>>(new Set());

export const CodeBlock = memo(function CodeBlock({ language, code, scrollClassName }: {
  language?: string;
  code: string;
  /** Constrain the code viewport inside its border, leaving the toolbar in place. */
  scrollClassName?: string;
}): JSX.Element {
  const { t } = useTranslation("chat");
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  // The head alone is not an identity: two streamed/replaced blocks can share it while
  // differing in the tail, which would leak the expanded state from one block to another.
  const identity = `${language ?? ""}:${code.length}:${code.slice(0, 128)}:${code.slice(-128)}`;
  const previousIdentity = useRef(identity);
  useEffect(() => {
    if (previousIdentity.current === identity) return;
    previousIdentity.current = identity;
    setExpanded(false);
  }, [identity]);
  const diff = language !== undefined && DIFF_LANGUAGES.has(language.toLowerCase());
  const truncated = code.length > MAX_CODE_PREVIEW_CHARS;
  const displayCode = truncated && !expanded
    ? `${code.slice(0, MAX_CODE_PREVIEW_CHARS)}\n…`
    : code;
  // Keep copying lossless, but do not parse or syntax-highlight a pathological
  // block until the reader explicitly asks to see it all. This bounds both the
  // initial DOM and the work done by a streaming code fence.
  const html = useHighlightedCode(diff ? "" : displayCode, diff ? undefined : language);
  // A one-line fence needs no number: the digit column would only push the snippet right.
  // A diff brings its own gutter from `DiffView`, whose numbers come from the hunk header
  // rather than from a count of rows.
  const lines = displayCode.split("\n").length;
  const numbered = !diff && lines > 1;
  const icon = codeFenceIconName(language);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // ignore
    }
  }

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-border bg-muted/40">
      <div className="flex items-center justify-between border-b border-border px-2 py-1">
        <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-muted-foreground">
          {icon ? <FileIcon name={icon} className="size-3.5" /> : null}
          <span className="truncate">{language || "code"}</span>
        </span>
        <Button size="xs" variant="ghost" onClick={() => void copy()}>
          {copied ? <HugeiconsIcon strokeWidth={2} icon={Tick02Icon} /> : <HugeiconsIcon strokeWidth={2} icon={Copy01Icon} />}
          {copied ? t("message.copied") : t("message.copy")}
        </Button>
      </div>
      {diff ? (
        <DiffView text={displayCode} className={cn("mt-0 rounded-none border-0 bg-transparent", scrollClassName)} />
      ) : (
        /*
         * Two boxes rather than one: the outer is the vertical viewport (`scrollClassName` caps
         * the codemode script), the inner is the horizontal scroller. They cannot be the same
         * element — `overflow-x: auto` makes the used value of `overflow-y` `auto` too, so one
         * capped box would scroll the *code* inside its own frame and leave the numbers behind.
         */
        <div className={scrollClassName}>
          <div className="code-shiki flex text-sm leading-5">
            {numbered ? <MarkdownCodeGutter lines={lines} /> : null}
            <div className="min-w-0 flex-1 overflow-x-auto px-3 py-2">
              {html ? (
                <div dangerouslySetInnerHTML={{ __html: html }} />
              ) : (
                <pre className="font-mono">{displayCode}</pre>
              )}
            </div>
          </div>
        </div>
      )}
      {truncated ? (
        <div className="border-t border-border px-2 py-1">
          <Button size="xs" variant="ghost" onClick={() => setExpanded((value) => !value)}>
            {t(expanded ? "message.collapseCode" : "message.expandCode", { count: code.length - MAX_CODE_PREVIEW_CHARS })}
          </Button>
        </div>
      ) : null}
    </div>
  );
});

function markdownPath(href: string): string | undefined {
  if (href.startsWith("fvpath:")) return decodeURIComponent(href.slice("fvpath:".length));
  if (href.startsWith("file:")) return decodeURI(href.replace("file://", ""));
  if (href.startsWith("/")) return href;
  return undefined;
}

/**
 * `react-markdown` drops any protocol it does not know — `file:`, `data:` — and every image
 * a reply writes by path would arrive with an empty `src`. These are the sources the media
 * mapping below turns into a loadable preview, and a path link the path-link plugin made.
 */
function urlTransform(url: string): string {
  if (url.startsWith("file://") || url.startsWith("fvpath:")) return url;
  if (/^data:(image|video)\//i.test(url)) return url;
  return defaultUrlTransform(url);
}

/** A markdown image: a picture, or — when the path says so — a video or an HTML page. */
function MarkdownImage({ src, alt }: { src?: string; alt?: string }): JSX.Element | null {
  const cwd = useSessionStore((state) => state.conversations.find((item) => item.id === state.activeId)?.cwd);
  const preview = markdownMedia(src, alt, (path) => resolvePath(path, cwd));
  if (preview) return <InlineMediaItem preview={preview} />;
  if (!src) return null;
  return <img src={src} alt={alt ?? ""} className="my-2 max-h-80 max-w-full rounded-lg border border-border" />;
}

// Stable component identities keep streamed updates from remounting CodeBlock.
const MARKDOWN_COMPONENTS: Components = {
  a: ({ href, children }) => {
    const validPaths = useContext(MarkdownPathContext);
    const path = href ? markdownPath(href) : undefined;
    // `remarkPathLinks` deliberately marks candidates before the async stat result
    // arrives. Keep an invalid candidate as ordinary text; leaving the generated
    // `fvpath:` anchor in the DOM would still make a branch or endpoint look linked.
    if (path) return validPaths.has(path) ? <PathLink path={path}>{children}</PathLink> : <>{children}</>;
    return (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    );
  },
  img: ({ src, alt }) => <MarkdownImage src={typeof src === "string" ? src : undefined} alt={alt} />,
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-96 border-collapse text-left">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b border-border bg-muted/60 px-2 py-1.5 font-medium">{children}</th>
  ),
  td: ({ children }) => <td className="border-b border-border px-2 py-1.5 align-top">{children}</td>,
  pre: ({ node, children }) => {
    // Block code always has a pre parent, even for empty or unlabelled single-line fences.
    const codeNode = node?.children.find((child) => child.type === "element" && child.tagName === "code");
    if (!codeNode || codeNode.type !== "element") return <pre>{children}</pre>;
    const classes = codeNode.properties.className;
    const className = Array.isArray(classes) ? classes.join(" ") : String(classes ?? "");
    const language = /language-([^\s]+)/.exec(className)?.[1];
    return <CodeBlock language={language} code={nodeText(children).replace(/\n$/, "")} />;
  },
  code: ({ children }) => {
    const validPaths = useContext(MarkdownPathContext);
    const text = nodeText(children);
    // File paths are commonly written as inline code in agent replies. Keep the
    // code styling, but make the whole span behave like a previewable path.
    if (isPathLike(text) && validPaths.has(text)) {
      return (
        <code>
          <PathLink path={text}>{children}</PathLink>
        </code>
      );
    }
    return <code>{children}</code>;
  },
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-border pl-3 text-muted-foreground">{children}</blockquote>
  ),
};

/**
 * One block of markdown, memoised on its exact text.
 *
 * `react-markdown` re-parses everything it is handed, so what makes a long answer
 * affordable is that a settled block's text never changes again: this component then
 * skips the render entirely, and only the block being streamed into is re-parsed.
 */
const MarkdownBlock = memo(function MarkdownBlock({ text, headingIds }: { text: string; headingIds?: boolean }): JSX.Element {
  // The block in flight still re-parses on each flush; keep the urgent UI (caret,
  // scroll) ahead of it and let React apply the markdown at lower priority.
  const deferred = useDeferredValue(text);
  const cwd = useSessionStore((state) => state.conversations.find((item) => item.id === state.activeId)?.cwd);
  const validPaths = useValidatedMarkdownPaths(deferred, cwd);
  return (
    <MarkdownPathContext.Provider value={validPaths}>
      <Markdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={headingIds ? REHYPE_PLUGINS_WITH_HEADING_IDS : REHYPE_PLUGINS}
        components={MARKDOWN_COMPONENTS}
        urlTransform={urlTransform}
      >
        {deferred}
      </Markdown>
    </MarkdownPathContext.Provider>
  );
});

/**
 * Memoised on `text`: without this, every streamed token re-parsed the markdown
 * of every message already on screen.
 *
 * The text is cut into independently parsed blocks (`splitMarkdownBlocks`), which is
 * what bounds the cost of a *single* long answer — one pass over 50 KB of prose costs
 * ~100 ms, and it used to be paid again at every flush. The blocks stay siblings
 * inside one column so a collapsed prompt can clip them together; a position still
 * keeps its content because blocks only grow at the end.
 */
export const MarkdownView = memo(forwardRef<HTMLDivElement, { text: string; className?: string; headingIds?: boolean }>(function MarkdownView({ text, className, headingIds }, ref): JSX.Element {
  // A reply that used memory ends with a citation block the pipeline reads; the reader does not.
  // And a reply padded with forty `<br>`s or lines of invisible space is shortened before it is
  // cut, so the gap survives as one gap rather than as a screen of nothing.
  const blocks = useMemo(() => splitMarkdownBlocks(collapseBlankRuns(stripMemoryCitation(text))), [text]);
  return (
    <div ref={ref} className={cn("chat-markdown-flow", className)}>
      {blocks.map((block, index) => (
        // Blocks only ever grow at the end, so a position keeps its content.
        <MarkdownBlock key={index} text={block} headingIds={headingIds} />
      ))}
    </div>
  );
}));

function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (node && typeof node === "object" && "props" in node) {
    const props = (node as { props?: { children?: ReactNode } }).props;
    return nodeText(props?.children);
  }
  return "";
}
