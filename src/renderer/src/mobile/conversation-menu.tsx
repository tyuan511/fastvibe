import { useState, type JSX, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Archive04Icon,
  Delete02Icon,
  MoreHorizontalIcon,
  PencilEdit02Icon,
} from "@hugeicons/core-free-icons";
import type { Conversation } from "@shared/types";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { engine } from "@/lib/engine-client";
import { archiveConversations, restoreConversations } from "@/stores/archive";
import { useSessionStore } from "@/stores/session";
import { navigate } from "./route";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Actions for the chat on screen, behind the header's ⋯. */
export function ConversationMenu({ conversation }: { conversation: Conversation }): JSX.Element {
  return <ConversationActionMenu conversation={conversation} />;
}

/**
 * The same small chat menu for a drawer row. Base UI's context menu opens on a
 * long-press on touch devices and on a secondary click elsewhere, so the row
 * remains a normal one-tap target for opening the chat.
 */
export function ConversationContextMenu({
  conversation,
  children,
  onLeave,
}: {
  conversation: Conversation;
  children: ReactNode;
  onLeave?: () => void;
}): JSX.Element {
  return <ConversationActionMenu conversation={conversation} trigger={children} onLeave={onLeave} />;
}

function ConversationActionMenu({
  conversation,
  trigger,
  onLeave,
}: {
  conversation: Conversation;
  trigger?: ReactNode;
  onLeave?: () => void;
}): JSX.Element {
  const { t } = useTranslation("app");
  const current = useSessionStore((state) => state.activeId === conversation.id);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState("");
  const [deleting, setDeleting] = useState(false);

  async function rename(): Promise<void> {
    const next = title.trim();
    setRenaming(false);
    if (!next || next === conversation.title) return;
    try {
      useSessionStore.getState().applySnapshot(await window.fastvibe.conversations.rename(conversation.id, next));
    } catch (error) {
      toast.error(errorText(error));
    }
  }

  function leave(): void {
    onLeave?.();
    navigate({ kind: "new" }, { replace: true });
  }

  function archive(): void {
    const id = conversation.id;
    const busy = useSessionStore.getState().running[id] === true;
    archiveConversations(id);
    toast.success(t("mobile.archived", { title: conversation.title || t("mobile.untitled") }), {
      id: `archived:${id}`,
      action: { label: t("mobile.undo"), onClick: () => restoreConversations(id) },
    });
    // An archived chat keeps no run going nobody can see: the desktop does the same.
    if (busy) void engine.abort(id).catch((error: unknown) => toast.error(errorText(error)));
    if (current) leave();
  }

  async function remove(): Promise<void> {
    const id = conversation.id;
    setDeleting(false);
    try {
      const result = await window.fastvibe.conversations.delete(id);
      const store = useSessionStore.getState();
      store.applySnapshot(result);
      store.forgetConversationExtensionState(id);
      if (current) leave();
    } catch (error) {
      toast.error(errorText(error));
    }
  }

  const menu = trigger ? (
    <ContextMenu>
      <ContextMenuTrigger className="w-full touch-pan-y">{trigger}</ContextMenuTrigger>
      <ContextMenuContent side="bottom" align="start" className="min-w-44">
        <ContextMenuGroup>
          <ContextMenuItem
            className="h-10"
            onClick={() => {
              setTitle(conversation.title);
              setRenaming(true);
            }}
          >
            <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={2} />
            {t("mobile.rename")}
          </ContextMenuItem>
          <ContextMenuItem className="h-10" onClick={archive}>
            <HugeiconsIcon icon={Archive04Icon} strokeWidth={2} />
            {t("mobile.archive")}
          </ContextMenuItem>
        </ContextMenuGroup>
        <ContextMenuSeparator />
        <ContextMenuGroup>
          <ContextMenuItem className="h-10" variant="destructive" onClick={() => setDeleting(true)}>
            <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
            {t("mobile.delete")}
          </ContextMenuItem>
        </ContextMenuGroup>
      </ContextMenuContent>
    </ContextMenu>
  ) : (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-lg" aria-label={t("mobile.more")} />}>
        <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} className="size-5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuGroup>
          <DropdownMenuItem
            className="h-10"
            onClick={() => {
              setTitle(conversation.title);
              setRenaming(true);
            }}
          >
            <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={2} />
            {t("mobile.rename")}
          </DropdownMenuItem>
          <DropdownMenuItem className="h-10" onClick={archive}>
            <HugeiconsIcon icon={Archive04Icon} strokeWidth={2} />
            {t("mobile.archive")}
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem className="h-10" variant="destructive" onClick={() => setDeleting(true)}>
            <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
            {t("mobile.delete")}
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <>
      {menu}
      <Dialog open={renaming} onOpenChange={setRenaming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("mobile.renameTitle")}</DialogTitle>
            <DialogDescription className="sr-only">{t("mobile.renameTitle")}</DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void rename();
            }}
            className="space-y-4"
          >
            <Input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              aria-label={t("mobile.renameTitle")}
              autoFocus
              enterKeyHint="done"
              className="h-10"
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setRenaming(false)}>
                {t("mobile.cancel")}
              </Button>
              <Button type="submit" disabled={!title.trim()}>
                {t("mobile.save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleting} onOpenChange={setDeleting}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("mobile.deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("mobile.deleteDesc", { title: conversation.title || t("mobile.untitled") })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("mobile.cancel")}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void remove()}>
              {t("mobile.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
