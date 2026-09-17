import { memo, useDeferredValue, useState, type JSX, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { HugeiconsIcon } from "@hugeicons/react";
import { Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { useHighlightedCode } from "@/lib/highlight";
import { useSessionStore } from "@/stores/session";

const CodeBlock = memo(function CodeBlock({ language, code }: { language?: string; code: string }): JSX.Element {
  const { t } = useTranslation("chat");
  const [copied, setCopied] = useState(false);
  const html = useHighlightedCode(code, language);

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
      <div className="code-shiki overflow-x-auto p-3 text-sm leading-5">
        {html ? (
          <div dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <pre className="font-mono">{code}</pre>
        )}
      </div>
    </div>
  );
});

/**
 * Memoised on `text`: without this, every streamed token re-parsed the markdown
 * of every message already on screen.
 */
export const MarkdownView = memo(function MarkdownView({ text }: { text: string }): JSX.Element {
  // Re-parsing the whole answer on every streamed token is O(n²); keep the urgent
  // UI (spinner, scroll) responsive and let React apply the markdown at lower priority.
  const deferred = useDeferredValue(text);
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ href, children }) => (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => {
              if (!href) return;
              if (href.startsWith("file:") || href.startsWith("/")) {
                event.preventDefault();
                const path = href.startsWith("file:") ? decodeURI(href.replace("file://", "")) : href;
                void useSessionStore.getState().openPreview(path);
              }
            }}
          >
            {children}
          </a>
        ),
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
        pre: ({ children }) => <>{children}</>,
        code: ({ className, children }) => {
          const language = /language-([^\s]+)/.exec(className ?? "")?.[1];
          const code = nodeText(children).replace(/\n$/, "");
          if (language || code.includes("\n")) {
            return <CodeBlock language={language} code={code} />;
          }
          return <code>{code}</code>;
        },
        blockquote: ({ children }) => (
          <blockquote className="my-2 border-l-2 border-border pl-3 text-muted-foreground">{children}</blockquote>
        ),
      }}
    >
      {deferred}
    </Markdown>
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
