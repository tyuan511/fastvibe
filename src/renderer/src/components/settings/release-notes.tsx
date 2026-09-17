import { useMemo, type JSX, type ReactNode } from "react";
import { MarkdownView } from "@/components/chat/markdown-view";

/**
 * Release notes reach us in one of two shapes, and we cannot pick which.
 *
 * electron-updater's GitHub provider builds `releaseNotes` from the releases
 * **Atom feed**, whose `<content type="html">` is GitHub's already-rendered HTML
 * (`<h3>`, `<ul>`, `<a class="commit-link"><tt>…`). A `latest*.yml` that carries a
 * `releaseNotes` field, or another provider, hands us markdown instead.
 *
 * So: markdown goes to the app's normal renderer, and HTML is parsed here and
 * rebuilt as React elements from a whitelist. Nothing is ever injected as raw
 * HTML — unknown tags are unwrapped to their children — because these notes come
 * off the network and this dialog is not a place to trust it.
 */

const HTML_HINT = /<(h[1-6]|p|ul|ol|li|pre|blockquote|table|div)\b[^>]*>/i;

export function isHtmlReleaseNotes(notes: string): boolean {
  return HTML_HINT.test(notes);
}

/** Only http(s) and mailto links survive; `javascript:` and friends are dropped. */
function safeHref(href: string | null): string | undefined {
  if (!href) return undefined;
  try {
    const url = new URL(href, "https://github.com");
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function renderChildren(node: Node): ReactNode[] {
  return Array.from(node.childNodes).map((child, index) => renderNode(child, index));
}

function renderNode(node: Node, key: number): ReactNode {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue;
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const element = node as Element;
  const tag = element.tagName.toLowerCase();
  const children = renderChildren(element);
  switch (tag) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return (
        <p key={key} className="text-sm font-medium text-foreground">
          {children}
        </p>
      );
    case "p":
    case "div":
      return (
        <p key={key} className="text-sm">
          {children}
        </p>
      );
    case "ul":
      return (
        <ul key={key} className="list-disc space-y-1 pl-5 text-sm">
          {children}
        </ul>
      );
    case "ol":
      return (
        <ol key={key} className="list-decimal space-y-1 pl-5 text-sm">
          {children}
        </ol>
      );
    case "li":
      return <li key={key}>{children}</li>;
    case "strong":
    case "b":
      return (
        <strong key={key} className="font-medium text-foreground">
          {children}
        </strong>
      );
    case "em":
    case "i":
      return <em key={key}>{children}</em>;
    case "code":
    case "tt":
      return (
        <code key={key} className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
          {children}
        </code>
      );
    case "pre":
      return (
        <pre key={key} className="overflow-x-auto rounded-lg border border-border bg-muted/40 p-3 font-mono text-xs">
          {children}
        </pre>
      );
    case "blockquote":
      return (
        <blockquote key={key} className="border-l-2 border-border pl-3 text-muted-foreground">
          {children}
        </blockquote>
      );
    case "a": {
      const href = safeHref(element.getAttribute("href"));
      return href ? (
        <a key={key} href={href} target="_blank" rel="noreferrer" className="underline underline-offset-3 hover:text-foreground">
          {children}
        </a>
      ) : (
        <span key={key}>{children}</span>
      );
    }
    case "br":
      return <br key={key} />;
    case "hr":
      return <hr key={key} className="border-border" />;
    case "table":
      return (
        <div key={key} className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-96 border-collapse text-left text-sm">{children}</table>
        </div>
      );
    case "thead":
      return <thead key={key}>{children}</thead>;
    case "tbody":
      return <tbody key={key}>{children}</tbody>;
    case "tr":
      return <tr key={key}>{children}</tr>;
    case "th":
      return (
        <th key={key} className="border-b border-border bg-muted/60 px-2 py-1.5 font-medium">
          {children}
        </th>
      );
    case "td":
      return (
        <td key={key} className="border-b border-border px-2 py-1.5 align-top">
          {children}
        </td>
      );
    case "script":
    case "style":
      return null;
    default:
      // Unknown wrapper (e.g. `<details>`): keep the words, drop the element.
      return <span key={key}>{children}</span>;
  }
}

export function ReleaseNotes({ notes }: { notes: string }): JSX.Element {
  const isHtml = isHtmlReleaseNotes(notes);
  const body = useMemo(() => {
    if (!isHtml) return null;
    try {
      const doc = new DOMParser().parseFromString(notes, "text/html");
      return Array.from(doc.body.childNodes).map((child, index) => renderNode(child, index));
    } catch {
      // A parser that will not take the fragment is not worth a blank panel.
      return notes;
    }
  }, [isHtml, notes]);

  if (!isHtml) return <MarkdownView text={notes} />;
  return <div className="space-y-2 text-sm">{body}</div>;
}
