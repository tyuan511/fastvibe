import { Component, type ErrorInfo, type JSX, type ReactNode } from "react";
import { i18n } from "@/lib/i18n";
import { logError } from "@/lib/logger";
import { blockedRemotely } from "@/lib/remote-unavailable";
import { Ipc } from "@shared/ipc";

/**
 * The last line of defence for a render-time throw.
 *
 * A crash inside the tree unmounts everything React owns, and this app has had
 * exactly that: an empty model list drew a group label outside its group, Base UI
 * threw `MenuGroupContext is missing`, and the whole window went white — no message,
 * no way back except quitting. Typecheck cannot see it (the throw is a runtime
 * invariant, not a type error), and a subset of the tree cannot catch it.
 *
 * So the boundary sits at the root and does the only two useful things: say something
 * happened, and offer a way out. A reload is the right recovery because conversation
 * state lives in Main (transcripts on disk, runs in the engine), so re-mounting the
 * renderer loses nothing but the throw itself.
 *
 * Deliberately not keyed on the route: a boundary that resets on navigation would
 * hide a reproducible crash the user is trying to report, and the report (the error
 * text below) is what makes it fixable.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // The stack of the component that threw, alongside the message — the message
    // alone ("MenuGroupContext is missing") rarely names the surface it came from.
    logError(`renderer crash: ${error.message}\n${error.stack ?? ""}\n${info.componentStack ?? ""}`);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 bg-background p-8 text-center">
        <div className="max-w-md space-y-2">
          <h2 className="text-base font-semibold text-foreground">
            {i18n.t("common:crash.title")}
          </h2>
          <p className="text-sm text-muted-foreground">{i18n.t("common:crash.description")}</p>
          <pre className="max-h-40 overflow-auto rounded-md border border-border bg-muted/40 p-2 text-left text-xs text-muted-foreground">
            {error.message}
          </pre>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            onClick={() => window.location.reload()}
          >
            {i18n.t("common:crash.reload")}
          </button>
          <button
            type="button"
            className="rounded-md border border-border px-3 py-1.5 text-sm text-foreground hover:bg-accent"
            onClick={() => {
              if (blockedRemotely(Ipc.appExportLogs)) return;
              void window.fastvibe.app.exportLogs();
            }}
          >
            {i18n.t("common:crash.exportLogs")}
          </button>
        </div>
      </div>
    );
  }
}
