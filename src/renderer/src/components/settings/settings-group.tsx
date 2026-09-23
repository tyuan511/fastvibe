import type { JSX, ReactNode } from "react";
import { Label } from "@/components/ui/label";

/**
 * One card of settings rows. Every pane in Settings renders its preferences through
 * these two, so a row in 关于, 通用 and 更新 cannot drift apart.
 */
export function SettingsGroup({ title, children }: { title?: string; children: ReactNode }): JSX.Element {
  return (
    <section className="space-y-2">
      {title ? <h3 className="px-1 text-sm font-medium">{title}</h3> : null}
      <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
        {children}
      </div>
    </section>
  );
}

/**
 * A label, an optional one-line description under it, and the control on the right.
 * `description` is a node because a path or a value needs its own markup.
 */
export function SettingsRow({
  title,
  description,
  control,
}: {
  title: ReactNode;
  description?: ReactNode;
  control: ReactNode;
}): JSX.Element {
  return (
    // The label claims a 12rem basis and the row wraps: on a desktop pane nothing changes,
    // while on a phone a wide control (a 44-unit select) drops under its label instead of
    // squeezing the label down to a word per line.
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3">
      <div className="min-w-0 flex-1 basis-48">
        {typeof title === "string" ? (
          <Label className="text-sm font-medium">{title}</Label>
        ) : (
          <div className="flex items-center gap-1 text-sm font-medium">{title}</div>
        )}
        {description ? (
          <p className="mt-0.5 text-xs leading-4 text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}
