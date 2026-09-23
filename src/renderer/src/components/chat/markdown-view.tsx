import { memo, useDeferredValue, useMemo, useState, type JSX, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import Markdown, { type Components } from "react-markdown";
import type { PluggableList } from "unified";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { remarkStrictInlineMath } from "@/lib/remark-strict-inline-math";
import { isPathLike, remarkPathLinks } from "@/lib/remark-path-links";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { useHighlightedCode } from "@/lib/highlight";
import { splitMarkdownBlocks } from "@/lib/markdown-blocks";
import { useSessionStore } from "@/stores/session";
import { resolvePath } from "@/lib/workspace-path";
import { blockedRemotely } from "@/lib/remote-unavailable";
import { Ipc } from "@shared/ipc";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { DiffView } from "./diff-view";

/**
 * Markdown, with math.
 *
 * `remark-math` + `rehype-katex` are wired in with the options the app needs, and
 * both are **module-level constants**: `react-markdown` builds its processor from
 * these props, and inline arrays would be a new identity on every render of every
 * streamed token — the one thing `memo` on this component exists to prevent.
 *
 * `remarkStrictInlineMath` follows `remark-math` because it inspects what that
 * plugin tokenized: `$HOME`, `$PATH` and `$5 到 $10` are prose here, not formulas.
 */
const REMARK_PLUGINS: PluggableList = [remarkGfm, remarkMath, remarkStrictInlineMath, remarkPathLinks];
const REHYPE_PLUGINS: PluggableList = [
  [
    rehypeKatex,
    {
      // A half-streamed formula is the normal case, not an error: KaTeX must never
      // throw into React, just draw the offending fragment in the error colour.
      throwOnError: false,
      // …and it must not warn about the constructs it merely tolerates (\tag,
      // unicode text). A broken formula is shown, not logged.
      strict: false,
      errorColor: "var(--destructive)",
    },
  ],
];

/** Fence languages whose body is a diff, drawn by `DiffView` rather than Shiki. */
const DIFF_LANGUAGES = new Set(["diff", "patch"]);

const CodeBlock = memo(function CodeBlock({ language, code }: { language?: string; code: string }): JSX.Element {
  const { t } = useTranslation("chat");
  const [copied, setCopied] = useState(false);
  const diff = language !== undefined && DIFF_LANGUAGES.has(language.toLowerCase());
  const html = useHighlightedCode(diff ? "" : code, diff ? undefined : language);

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
        <span className="text-xs font-medium text-muted-foreground">{language || "code"}</span>
        <Button size="xs" variant="ghost" onClick={() => void copy()}>
          {copied ? <HugeiconsIcon strokeWidth={2} icon={Tick02Icon} /> : <HugeiconsIcon strokeWidth={2} icon={Copy01Icon} />}
          {copied ? t("message.copied") : t("message.copy")}
        </Button>
      </div>
      {diff ? (
        <DiffView text={code} className="mt-0 rounded-none border-0 bg-transparent" />
      ) : (
        <div className="code-shiki overflow-x-auto text-sm leading-5">
          {html ? (
            <div dangerouslySetInnerHTML={{ __html: html }} />
          ) : (
            <pre className="font-mono">{code}</pre>
          )}
        </div>
      )}
    </div>
  );
});

function markdownPath(href: string): string | undefined {
  if (href.startsWith("fvpath:")) return decodeURIComponent(href.slice("fvpath:".length));
  if (href.startsWith("file:")) return decodeURI(href.replace("file://", ""));
  if (href.startsWith("/")) return href;
  return undefined;
}

function resolvedMarkdownPath(path: string): string {
  const { conversations, activeId } = useSessionStore.getState();
  const cwd = conversations.find((item) => item.id === activeId)?.cwd;
  // Keep this in sync with openPreview: context-menu actions need the absolute path
  // before they call the host, while preview itself accepts the original path.
  return resolvePath(path, cwd);
}

async function revealMarkdownPath(path: string, missing: string): Promise<void> {
  if (blockedRemotely(Ipc.workspaceReveal)) return;
  const result = await window.fastvibe.workspace.reveal(path);
  if (result && result.ok === false) toast.error(missing);
}

function PathLink({ path, children }: { path: string; children: ReactNode }): JSX.Element {
  const { t } = useTranslation("chat");
  const resolved = resolvedMarkdownPath(path);
  return (
    <ContextMenu>
      <ContextMenuTrigger
        className="inline"
        onClick={() => void useSessionStore.getState().openPreview(resolved)}
      >
        <span className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary">
          {children}
        </span>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem onClick={() => void useSessionStore.getState().openPreview(resolved)}>{t("preview.pathPreview")}</ContextMenuItem>
        <ContextMenuItem onClick={() => void revealMarkdownPath(resolved, t("preview.pathMissing"))}>{t("preview.pathReveal")}</ContextMenuItem>
        <ContextMenuItem onClick={() => void navigator.clipboard?.writeText(resolved)}>{t("preview.pathCopy")}</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

// Stable component identities keep streamed updates from remounting CodeBlock.
const MARKDOWN_COMPONENTS: Components = {
  a: ({ href, children }) => {
    const path = href ? markdownPath(href) : undefined;
    if (path) return <PathLink path={path}>{children}</PathLink>;
    return (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    );
  },
  img: ({ src, alt }) => (
    <img src={src} alt={alt ?? ""} className="my-2 max-h-80 max-w-full rounded-lg border border-border" />
  ),
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
    const text = nodeText(children);
    // File paths are commonly written as inline code in agent replies. Keep the
    // code styling, but make the whole span behave like a previewable path.
    if (isPathLike(text)) {
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
const MarkdownBlock = memo(function MarkdownBlock({ text }: { text: string }): JSX.Element {
  // The block in flight still re-parses on each flush; keep the urgent UI (caret,
  // scroll) ahead of it and let React apply the markdown at lower priority.
  const deferred = useDeferredValue(text);
  return (
    <Markdown
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={REHYPE_PLUGINS}
      components={MARKDOWN_COMPONENTS}
    >
      {deferred}
    </Markdown>
  );
});

/**
 * Memoised on `text`: without this, every streamed token re-parsed the markdown
 * of every message already on screen.
 *
 * The text is cut into independently parsed blocks (`splitMarkdownBlocks`), which is
 * what bounds the cost of a *single* long answer — one pass over 50 KB of prose costs
 * ~100 ms, and it used to be paid again at every flush. Each block renders as a
 * sibling in this same parent, exactly as `react-markdown` would have emitted them,
 * so the DOM is unchanged.
 */
export const MarkdownView = memo(function MarkdownView({ text }: { text: string }): JSX.Element {
  const blocks = useMemo(() => splitMarkdownBlocks(text), [text]);
  if (blocks.length === 1) return <MarkdownBlock text={blocks[0]} />;
  return (
    <>
      {blocks.map((block, index) => (
        // Blocks only ever grow at the end, so a position keeps its content.
        <MarkdownBlock key={index} text={block} />
      ))}
    </>
  );
});

function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (node && typeof node === "object" && "props" in node) {
    const props = (node as { props?: { children?: ReactNode } }).props;
    return nodeText(props?.children);
  }
  return "";
}
