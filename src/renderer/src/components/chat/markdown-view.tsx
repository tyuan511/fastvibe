import { memo, useState, type JSX, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { highlightCode } from "@/lib/highlight";
import { useSessionStore } from "@/stores/session";

function CodeBlock({ language, code }: { language?: string; code: string }): JSX.Element {
  const [copied, setCopied] = useState(false);

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
        <span className="text-[11px] font-medium text-muted-foreground">{language || "code"}</span>
        <Button size="xs" variant="ghost" onClick={() => void copy()}>
          {copied ? <Check /> : <Copy />}
          {copied ? "已复制" : "复制"}
        </Button>
      </div>
      <pre className="overflow-x-auto p-3 text-[12px] leading-5">
        <code className="font-mono" dangerouslySetInnerHTML={{ __html: highlightCode(code) }} />
      </pre>
    </div>
  );
}

/**
 * Memoised on `text`: without this, every streamed token re-parsed the markdown
 * of every message already on screen.
 */
export const MarkdownView = memo(function MarkdownView({ text }: { text: string }): JSX.Element {
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
            <table className="w-full min-w-96 border-collapse text-left text-xs">{children}</table>
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
      {text}
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
