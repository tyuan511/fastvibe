"use client"

import * as React from "react"
import {
  MessageScroller as MessageScrollerPrimitive,
  useMessageScroller as useMessageScrollerPrimitive,
  useMessageScrollerScrollable,
  useMessageScrollerVisibility,
} from "@shadcn/react/message-scroller"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import { HugeiconsIcon } from "@hugeicons/react"
import { ArrowDown02Icon } from "@hugeicons/core-free-icons"

function MessageScrollerProvider(
  props: React.ComponentProps<typeof MessageScrollerPrimitive.Provider>
) {
  return <MessageScrollerPrimitive.Provider {...props} />
}

function MessageScroller({
  className,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Root>) {
  return (
    <MessageScrollerPrimitive.Root
      data-slot="message-scroller"
      className={cn(
        "group/message-scroller relative flex size-full min-h-0 flex-col overflow-hidden",
        className
      )}
      {...props}
    />
  )
}

function MessageScrollerViewport({
  className,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Viewport>) {
  return (
    <MessageScrollerPrimitive.Viewport
      data-slot="message-scroller-viewport"
      className={cn(
        "size-full min-h-0 min-w-0 scroll-fade-b transcript-gutter overflow-y-auto overscroll-contain contain-content data-autoscrolling:scrollbar-thumb-transparent data-autoscrolling:scrollbar-track-transparent data-pending-scroll:invisible",
        className
      )}
      {...props}
    />
  )
}

function MessageScrollerContent({
  className,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Content>) {
  return (
    <MessageScrollerPrimitive.Content
      data-slot="message-scroller-content"
      className={cn("flex h-max min-h-full flex-col gap-6", className)}
      {...props}
    />
  )
}

function MessageScrollerItem({
  className,
  scrollAnchor = false,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Item>) {
  return (
    <MessageScrollerPrimitive.Item
      data-slot="message-scroller-item"
      scrollAnchor={scrollAnchor}
      className={cn(
        "min-w-0 shrink-0 [contain-intrinsic-size:auto_10rem] [content-visibility:auto]",
        className
      )}
      {...props}
    />
  )
}

function MessageScrollerButton({
  direction = "end",
  className,
  children,
  render,
  variant = "secondary",
  size = "icon-sm",
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Button> &
  Pick<React.ComponentProps<typeof Button>, "variant" | "size">) {
  return (
    <MessageScrollerPrimitive.Button
      data-slot="message-scroller-button"
      data-direction={direction}
      data-variant={variant}
      data-size={size}
      direction={direction}
      className={cn(
        "absolute inset-s-1/2 -translate-x-1/2 border-border bg-background text-foreground transition-[translate,scale,opacity] duration-200 hover:bg-muted hover:text-foreground data-[active=false]:pointer-events-none data-[active=false]:scale-95 data-[active=false]:opacity-0 data-[active=false]:duration-400 data-[active=false]:ease-[cubic-bezier(0.7,0,0.84,0)] data-[active=true]:translate-y-0 data-[active=true]:scale-100 data-[active=true]:opacity-100 data-[active=true]:ease-[cubic-bezier(0.23,1,0.32,1)] data-[direction=end]:bottom-4 data-[direction=end]:data-[active=false]:translate-y-full data-[direction=start]:top-4 data-[direction=start]:data-[active=false]:-translate-y-full rtl:translate-x-1/2 data-[direction=start]:[&_svg]:rotate-180",
        className
      )}
      render={render ?? <Button variant={variant} size={size} />}
      {...props}
    >
      {children ?? (
        <>
          <HugeiconsIcon icon={ArrowDown02Icon} strokeWidth={2} />
          <span className="sr-only">
            {direction === "end" ? "Scroll to end" : "Scroll to start"}
          </span>
        </>
      )}
    </MessageScrollerPrimitive.Button>
  )
}

/**
 * Mount a row that is not in the DOM yet, and say whether it had to.
 *
 * A long thread keeps only its tail mounted, so a row named from outside the
 * viewport — a turn-rail mark, a find hit — may have no element to scroll to. The
 * thread installs this; `scrollToMessage` below consults it before giving up.
 */
type RevealMessage = (messageId: string) => boolean

const MessageRevealContext = React.createContext<RevealMessage | null>(null)

function MessageRevealProvider({
  reveal,
  children,
}: {
  reveal: RevealMessage
  children: React.ReactNode
}) {
  return <MessageRevealContext.Provider value={reveal}>{children}</MessageRevealContext.Provider>
}

/**
 * The primitive's scroller, with `scrollToMessage` taught about unmounted rows.
 *
 * The identities stay stable across renders — a caller's effect depends on
 * `scrollToMessage`, and a fresh function each render would re-run it (and re-scroll)
 * on every streamed flush.
 */
function useMessageScroller(): ReturnType<typeof useMessageScrollerPrimitive> {
  const { scrollToEnd, scrollToMessage: scrollToMounted, scrollToStart } = useMessageScrollerPrimitive()
  const reveal = React.useContext(MessageRevealContext)
  const scrollToMessage = React.useCallback<typeof scrollToMounted>(
    (messageId, options) => {
      if (scrollToMounted(messageId, options)) return true
      // Nothing to scroll to yet: mount the row, then scroll once it is in the DOM.
      if (!reveal?.(messageId)) return false
      requestAnimationFrame(() => scrollToMounted(messageId, options))
      return true
    },
    [reveal, scrollToMounted],
  )
  return React.useMemo(
    () => ({ scrollToEnd, scrollToMessage, scrollToStart }),
    [scrollToEnd, scrollToMessage, scrollToStart],
  )
}

export {
  MessageRevealProvider,
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerButton,
  useMessageScroller,
  useMessageScrollerScrollable,
  useMessageScrollerVisibility,
}
