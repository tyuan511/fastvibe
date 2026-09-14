import type { ComponentProps, JSX, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * An icon-only button that always carries a tooltip, so the glyph is never the
 * only affordance. `label` doubles as the accessible name; pass `shortcut` to
 * append a key hint. Equivalent to composing Button + Tooltip by hand — use this
 * instead of leaving an icon button with just an `aria-label`.
 */
export function IconButton({
  label,
  shortcut,
  side,
  disabled,
  children,
  ...props
}: {
  label: string;
  shortcut?: string;
  side?: ComponentProps<typeof TooltipContent>["side"];
  children: ReactNode;
} & ComponentProps<typeof Button>): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Button aria-label={label} disabled={disabled} {...props} />}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side={side} className={shortcut ? "gap-2" : undefined}>
        {label}
        {shortcut ? <Kbd>{shortcut}</Kbd> : null}
      </TooltipContent>
    </Tooltip>
  );
}
