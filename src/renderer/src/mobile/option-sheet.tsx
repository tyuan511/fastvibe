import type { JSX, ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Tick02Icon } from "@hugeicons/core-free-icons";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

export type SheetOption = {
  value: string;
  label: string;
  description?: string;
  icon?: ReactNode;
};

export type SheetOptionGroup = { label?: string; options: SheetOption[] };

/**
 * One choice from a list, as a sheet from the bottom of the screen.
 *
 * The phone's answer to the desktop composer's dropdown menus. A dropdown anchored to a
 * chip at the bottom of a 375pt screen opens upward over the transcript with rows the
 * height of a mouse target; a bottom sheet is where a thumb already is, with rows it can
 * hit, and it scrolls when a provider brings forty models.
 */
export function OptionSheet({
  open,
  onOpenChange,
  title,
  description,
  groups,
  value,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  groups: SheetOptionGroup[];
  value: string | null;
  onSelect: (value: string) => void;
}): JSX.Element {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[75dvh] gap-0 rounded-t-2xl p-0">
        <SheetHeader className="pb-2">
          <SheetTitle>{title}</SheetTitle>
          {description ? <SheetDescription>{description}</SheetDescription> : null}
        </SheetHeader>
        <div className="safe-bottom min-h-0 flex-1 overflow-y-auto overscroll-contain pb-2">
          {groups.map((group, index) => (
            <div key={group.label ?? index} className="pb-1">
              {group.label ? (
                <p className="px-4 pt-2 pb-1 text-xs font-medium text-muted-foreground">{group.label}</p>
              ) : null}
              {group.options.map((option) => {
                const selected = option.value === value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={selected}
                    className={cn(
                      "flex min-h-12 w-full items-center gap-3 px-4 py-2 text-left active:bg-muted/60",
                      selected && "bg-muted/50",
                    )}
                    onClick={() => {
                      onOpenChange(false);
                      if (!selected) onSelect(option.value);
                    }}
                  >
                    {option.icon ? <span className="flex shrink-0 items-center text-muted-foreground">{option.icon}</span> : null}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{option.label}</span>
                      {option.description ? (
                        <span className="block text-xs text-muted-foreground">{option.description}</span>
                      ) : null}
                    </span>
                    {selected ? <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} className="size-4 shrink-0 text-primary" /> : null}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}
