import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area";
import { Add01Icon, Delete02Icon, Image01Icon, MoreHorizontalIcon, PencilEdit02Icon } from "@hugeicons/core-free-icons";
import type { ImageSession } from "@shared/image-generation";
import { inlineSrc } from "@shared/inline-media";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

/**
 * A creation library, not a text list: every session shows the newest image it produced as
 * its cover, so the rail reads like a shelf of outcomes. Covers are derived on the host
 * (`previewPath`, never persisted), and a session with no image yet keeps a quiet glyph.
 * The desktop rail and the narrow-screen dialog render this same list.
 */
export function ImageSessionList({ sessions, selectedId, generating, onSelect, onCreate, onRename, onDelete }: {
  sessions: ImageSession[];
  selectedId?: string;
  generating: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRename: (session: ImageSession) => void;
  onDelete: (session: ImageSession) => void;
}): JSX.Element {
  const { t, i18n } = useTranslation("images");
  const timestamp = (time: number): string => {
    const date = new Date(time);
    const today = new Date();
    return new Intl.DateTimeFormat(i18n.language, date.toDateString() === today.toDateString()
      ? { hour: "2-digit", minute: "2-digit" }
      : { month: "short", day: "numeric", ...(date.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}) }).format(date);
  };
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col text-sidebar-foreground" data-image-session-list>
    <div className="flex h-11 shrink-0 items-center gap-1 px-3">
      <span className="min-w-0 flex-1 truncate text-xs font-medium tracking-wide text-muted-foreground">{t("sessions")}</span>
      {sessions.length ? <span className="shrink-0 text-xs tabular-nums text-muted-foreground/70">{sessions.length}</span> : null}
      <Button type="button" variant="ghost" size="icon-xs" aria-label={t("newSession")} title={t("newSession")} className="shrink-0 rounded-md text-muted-foreground" onClick={onCreate}><HugeiconsIcon icon={Add01Icon} className="size-3.5" /></Button>
    </div>
    <ScrollArea className="sidebar-scroll min-h-0 flex-1 [&>[data-slot=scroll-area-viewport]]:absolute [&>[data-slot=scroll-area-viewport]]:inset-0" aria-label={t("sessions")}>
      <ScrollAreaPrimitive.Content className="px-2 pb-3 pt-1" style={{ minWidth: 0 }}>
        {sessions.length ? <div className="space-y-1">{sessions.map((session) => {
          const selected = selectedId === session.id;
          const running = selected && generating;
          return <ContextMenu key={session.id}>
            <ContextMenuTrigger render={<div className={cn("group/image-session relative flex h-15 min-w-0 items-center rounded-xl pr-1 transition-colors", selected ? "bg-primary/10" : "hover:bg-sidebar-accent/60")} data-image-session={session.id} />}>
              <button type="button" onClick={() => onSelect(session.id)} aria-current={selected ? "page" : undefined} title={session.title || t("untitled")} className="flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-xl py-2 pr-1 pl-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
                <span className={cn("relative flex size-10 shrink-0 overflow-hidden rounded-lg border bg-muted/40", selected ? "border-primary/30" : "border-border/60")}>
                  <span className="absolute inset-0 flex items-center justify-center text-muted-foreground/50"><HugeiconsIcon icon={Image01Icon} strokeWidth={1.5} className="size-4" /></span>
                  {session.previewPath ? <img src={inlineSrc({ ref: session.previewPath })} alt="" loading="lazy" decoding="async" className="relative size-full object-cover" onError={(event) => { event.currentTarget.style.visibility = "hidden"; }} /> : null}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className={cn("truncate text-sm leading-4", selected ? "font-medium" : "font-normal")}>{session.title || t("untitled")}</span>
                  <span className="flex items-center gap-1.5 text-xs leading-3.5 text-muted-foreground">
                    {running ? <><span className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary" aria-hidden /><span>{t("status.generating")}</span></> : <time dateTime={new Date(session.updatedAt).toISOString()}>{timestamp(session.updatedAt)}</time>}
                  </span>
                </span>
              </button>
              <span className="relative flex size-6 shrink-0 items-center justify-center">
                <DropdownMenu>
                  <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="icon-xs" aria-label={t("more")} className="absolute inset-0 rounded-md text-muted-foreground opacity-0 transition-opacity group-hover/image-session:opacity-100 group-focus-within/image-session:opacity-100 aria-expanded:opacity-100 pointer-coarse:opacity-100" />}><HugeiconsIcon icon={MoreHorizontalIcon} className="size-3.5" /></DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => onRename(session)}><HugeiconsIcon icon={PencilEdit02Icon} />{t("rename")}</DropdownMenuItem>
                    <DropdownMenuItem variant="destructive" onClick={() => onDelete(session)}><HugeiconsIcon icon={Delete02Icon} />{t("actions.delete")}</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </span>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onClick={() => onRename(session)}><HugeiconsIcon icon={PencilEdit02Icon} />{t("rename")}</ContextMenuItem>
              <ContextMenuItem variant="destructive" onClick={() => onDelete(session)}><HugeiconsIcon icon={Delete02Icon} />{t("actions.delete")}</ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>;
        })}</div> : <div className="flex flex-col items-center gap-2 px-4 py-4 text-center">
          <span className="flex size-8 items-center justify-center rounded-xl border border-border/60 bg-muted/40 text-muted-foreground/70"><HugeiconsIcon icon={Image01Icon} strokeWidth={1.5} className="size-4" /></span>
          <p className="text-sm font-medium leading-5">{t("sessionList.emptyTitle")}</p>
          <p className="max-w-44 text-xs leading-5 text-muted-foreground">{t("sessionList.emptyDescription")}</p>
        </div>}
      </ScrollAreaPrimitive.Content>
    </ScrollArea>
  </div>;
}
