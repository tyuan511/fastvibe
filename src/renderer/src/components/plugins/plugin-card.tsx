import type { JSX, ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  File01Icon,
  PackageIcon,
  PaintBrushIcon,
  PuzzleIcon,
  SparklesIcon,
} from "@hugeicons/core-free-icons";
import { i18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const TYPE_LABEL_KEYS: Record<string, string> = {
  extension: "extensions.kindExtension",
  skill: "extensions.kindSkill",
  theme: "extensions.kindTheme",
  prompt: "extensions.kindPrompt",
  package: "extensions.kindPackage",
};

const TYPE_ICONS: Record<string, typeof PackageIcon> = {
  extension: PuzzleIcon,
  skill: SparklesIcon,
  theme: PaintBrushIcon,
  prompt: File01Icon,
  package: PackageIcon,
};

const TYPE_TONES: Record<string, string> = {
  extension: "bg-info/10 text-info ring-info/15",
  skill: "bg-warning/10 text-warning ring-warning/15",
  theme: "bg-success/10 text-success ring-success/15",
  prompt: "bg-primary/10 text-primary ring-primary/15",
  package: "bg-muted text-muted-foreground ring-border",
};

export function typeLabel(type: string): string {
  const key = TYPE_LABEL_KEYS[type];
  return key ? (i18n.t(`settings:${key}`) as string) : type;
}

/** `npm:@scope/name@1.0` → `@scope/name`; `npm:name` → `name`. */
export function packageName(source: string): string {
  const withoutScheme = source.replace(/^(npm|git):/, "");
  const withoutVersion = withoutScheme.replace(/@[\d^~>=][^/]*$/, "");
  return withoutVersion.split("/").slice(-2).join("/");
}

export function formatDownloads(value?: number): string | null {
  if (!value || value <= 0) return null;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M/mo`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K/mo`;
  return `${value}/mo`;
}

/** Type-tinted mark, the same tile shape as an agent icon. */
export function PluginMark({ types, className }: { types: string[]; className?: string }): JSX.Element {
  const primary = types[0] ?? "package";
  return (
    <span
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-xl ring-1",
        TYPE_TONES[primary] ?? TYPE_TONES.package,
        className,
      )}
    >
      <HugeiconsIcon strokeWidth={1.8} icon={TYPE_ICONS[primary] ?? PackageIcon} className="size-5" />
    </span>
  );
}

/**
 * One plugin on the page. The card opens its details; the corner action (install)
 * runs without opening the dialog, the same split an agent card uses for 使用.
 */
export function PluginCard({
  name,
  meta,
  description,
  types,
  action,
  onOpen,
}: {
  name: string;
  meta: string;
  description: string;
  types: string[];
  action?: ReactNode;
  onOpen: () => void;
}): JSX.Element {
  return (
    <div
      role="button"
      tabIndex={0}
      className={cn(
        "group flex min-w-0 cursor-pointer flex-col gap-2.5 rounded-xl border border-border bg-card/80 p-3 text-left transition-colors",
        "hover:border-primary/30 hover:bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
      )}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <PluginMark types={types} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" title={name}>{name}</p>
          <p className="truncate text-xs text-muted-foreground">{meta}</p>
        </div>
      </div>
      <p className="line-clamp-2 min-h-8 text-xs leading-4 text-muted-foreground">{description}</p>
      {action ? <div className="flex items-center justify-end">{action}</div> : null}
    </div>
  );
}
