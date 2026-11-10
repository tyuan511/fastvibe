import { useMemo, type JSX } from "react";
import { useHighlightedCode } from "@/lib/highlight";
import { resolveLanguage } from "@/lib/syntax-highlighter";

/**
 * The host builds `location.snippet` as `<line>: <code>` rows around the finding, so the
 * real line numbers are already in the text — the gutter reads them instead of counting
 * from 1. A row the host did not number (a wrapped continuation) keeps its own index.
 */
function snippetLines(snippet: string, startLine: number): Array<{ number: number; text: string }> {
  return snippet.split("\n").map((row, index) => {
    // The host writes `<line>: <code>`; the colon is optional so a hand-written fixture
    // (`<line>  <code>`) does not leave its number in the code column twice.
    const numbered = /^(\d+):?[ \t]+(.*)$/.exec(row);
    return numbered
      ? { number: Number(numbered[1]), text: numbered[2] }
      : { number: startLine + index, text: row };
  });
}

/**
 * The language a file's own extension names. `resolveLanguage` folds aliases (`ts`, `rs`,
 * `py`) onto the grammar ids the highlighter loads, and an unknown extension stays plain —
 * a wrong guess would colour the snippet as some other language.
 */
function pathLanguage(path: string): string | undefined {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? resolveLanguage(base.slice(dot + 1)) : undefined;
}

/**
 * A finding's code excerpt as the transcript renders code: a line-number gutter and Shiki
 * highlighting, both on the review snapshot's own version of the file. Copying is not
 * offered because the excerpt is a frozen window, not the file the reader may now have.
 */
export function ReviewCode({ path, snippet, startLine }: { path: string; snippet: string; startLine: number }): JSX.Element {
  const lines = useMemo(() => snippetLines(snippet, startLine), [snippet, startLine]);
  const code = useMemo(() => lines.map((line) => line.text).join("\n"), [lines]);
  const language = useMemo(() => pathLanguage(path), [path]);
  const html = useHighlightedCode(code, language);
  const digits = String(lines.at(-1)?.number ?? startLine).length;
  const numbers = useMemo(() => lines.map((line) => line.number).join("\n"), [lines]);

  return <div className="min-w-0 overflow-hidden rounded-md border border-border bg-muted/40">
    <div className="code-shiki flex text-sm leading-5">
      <div
        aria-hidden
        style={{ width: `calc(${digits}ch + 0.75rem + 1px)` }}
        className="shrink-0 select-none overflow-hidden whitespace-pre border-r border-border px-1.5 py-2 text-right font-mono text-xs leading-5 tabular-nums text-muted-foreground/60"
      >
        {numbers}
      </div>
      <div className="min-w-0 flex-1 overflow-x-auto px-3 py-2">
        {html ? <div dangerouslySetInnerHTML={{ __html: html }} /> : <pre className="font-mono">{code}</pre>}
      </div>
    </div>
  </div>;
}
