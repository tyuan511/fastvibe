import type { JSX } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { THEMES, themesFor, type ThemeDefinition, type ThemeId, type ThemeKind } from "@/lib/themes";
import { cn } from "@/lib/utils";

/** A tiny three-stripe sample of a theme: accent, string and muted on the bg. */
export function ThemeSwatch({ theme, className }: { theme: ThemeDefinition; className?: string }): JSX.Element {
  return (
    <span
      aria-hidden
      className={cn("flex size-5 shrink-0 items-center justify-center gap-px rounded-[5px] border border-border/70", className)}
      style={{ background: theme.bg }}
    >
      <span className="h-2.5 w-0.5 rounded-full" style={{ background: theme.accent }} />
      <span className="h-2.5 w-0.5 rounded-full" style={{ background: theme.syntax.string }} />
      <span className="h-2.5 w-0.5 rounded-full" style={{ background: theme.mutedFg }} />
    </span>
  );
}

export function ThemeSelect({
  kind,
  value,
  onChange,
}: {
  kind: ThemeKind;
  value: ThemeId;
  onChange: (id: ThemeId) => void;
}): JSX.Element {
  const themes = themesFor(kind);
  const current = THEMES[value];
  const items = Object.fromEntries(themes.map((theme) => [theme.id, theme.label]));

  return (
    <Select items={items} value={value} onValueChange={(next) => onChange(next as ThemeId)}>
      <SelectTrigger size="sm" className="w-44">
        <span className="flex min-w-0 items-center gap-2">
          <ThemeSwatch theme={current} />
          <SelectValue className="truncate" />
        </span>
      </SelectTrigger>
      <SelectContent>
        {themes.map((theme) => (
          <SelectItem key={theme.id} value={theme.id}>
            <span className="flex items-center gap-2">
              <ThemeSwatch theme={theme} />
              <span className="flex flex-col">
                <span>{theme.label}</span>
                <span className="text-xs text-muted-foreground">{theme.source}</span>
              </span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
