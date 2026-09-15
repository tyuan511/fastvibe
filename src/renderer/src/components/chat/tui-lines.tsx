import type { CSSProperties, JSX } from "react";
import type { TuiRun } from "@shared/types";
import { cn } from "@/lib/utils";

/**
 * pi theme color names mapped onto the app's semantic tokens, so a plugin's
 * terminal component reads correctly in every FastVibe light/dark theme.
 * Unmapped names fall back to their literal color (see `runStyle`).
 */
const FG_TOKEN: Record<string, string> = {
  text: "var(--foreground)",
  dim: "var(--muted-foreground)",
  muted: "var(--muted-foreground)",
  accent: "var(--primary)",
  border: "var(--border)",
  borderAccent: "var(--primary)",
  borderMuted: "var(--border)",
  success: "var(--success)",
  warning: "var(--warning)",
  error: "var(--destructive)",
  mdHeading: "var(--foreground)",
  mdLink: "var(--primary)",
  mdLinkUrl: "var(--muted-foreground)",
  mdCode: "var(--foreground)",
  mdQuote: "var(--muted-foreground)",
  toolTitle: "var(--foreground)",
  toolOutput: "var(--muted-foreground)",
  customMessageText: "var(--foreground)",
  customMessageLabel: "var(--muted-foreground)",
};

const BG_TOKEN: Record<string, string> = {
  selectedBg: "var(--accent)",
  toolPendingBg: "var(--muted)",
  toolSuccessBg: "var(--muted)",
  toolErrorBg: "var(--muted)",
  userMessageBg: "var(--muted)",
  customMessageBg: "var(--muted)",
  searchMatchBg: "var(--muted)",
};

function runStyle(run: TuiRun): CSSProperties {
  const style: CSSProperties = {};
  const fg = run.fg ? FG_TOKEN[run.fg] : undefined;
  if (fg) style.color = fg;
  else if (run.color) style.color = run.color;
  const bg = run.bg ? BG_TOKEN[run.bg] : undefined;
  if (bg) style.backgroundColor = bg;
  else if (run.bgColor) style.backgroundColor = run.bgColor;
  if (run.bold) style.fontWeight = 600;
  if (run.dim) style.opacity = 0.72;
  if (run.italic) style.fontStyle = "italic";
  const decorations = [run.underline ? "underline" : null, run.strike ? "line-through" : null].filter(Boolean);
  if (decorations.length > 0) style.textDecoration = decorations.join(" ");
  return style;
}

/**
 * Renders structured lines decoded from a pi-tui component (an extension message
 * renderer or a component-factory widget) as monospace spans.
 */
export function TuiLines({ runs, className }: { runs: TuiRun[][]; className?: string }): JSX.Element {
  return (
    <div className={cn("font-mono text-sm leading-5", className)}>
      {runs.map((line, index) => (
        <div key={index} className="whitespace-pre">
          {line.length === 0
            ? "\u00a0"
            : line.map((run, runIndex) => (
                <span key={runIndex} style={runStyle(run)}>
                  {run.text}
                </span>
              ))}
        </div>
      ))}
    </div>
  );
}
