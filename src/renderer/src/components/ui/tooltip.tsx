import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"
import { cn } from "cn"

function TooltipProvider({
  delay = 0,
  ...props
}: TooltipPrimitive.Provider.Props) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delay={delay}
      {...props}
    />
  )
}

function Tooltip({ ...props }: TooltipPrimitive.Root.Props) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({ ...props }: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  side = "top",
  sideOffset = 4,
  align = "center",
  alignOffset = 0,
  children,
  ...props
}: TooltipPrimitive.Popup.Props &
  Pick<
    TooltipPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset"
  >) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        // A trigger that leaves the layout while its tooltip is closing (the
        // sidebar's hover actions are `hidden`, i.e. `display: none`) stops being
        // measurable, so the library parks the closing popup at the viewport origin
        // and paints it there for the whole exit animation - a tooltip flashing in
        // the top-left corner. It flags that state `data-anchor-hidden` and otherwise
        // leaves it alone, so hide it here: there is nothing left to point at, and
        // the exit fades a popup that is no longer on screen.
        className="isolate z-50 data-[anchor-hidden]:hidden"
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          data-overlay-surface
          className={cn(
            "overlay-surface z-50 inline-flex w-fit max-w-xs origin-(--transform-origin) items-center gap-1 rounded-[5px] bg-popover/95 px-2.5 py-1 text-xs text-popover-foreground has-data-[slot=kbd]:pr-1.5 data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
            className
          )}
          {...props}
        >
          {children}
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
