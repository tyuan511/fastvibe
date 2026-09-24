import { useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Archive04Icon,
  Delete02Icon,
  Folder01Icon,
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
import { isRemoteRef } from "@/lib/remote-project";
import { archiveConversations, restoreConversations } from "@/stores/archive";
import { useSessionStore } from "@/stores/session";
import { OptionSheet } from "./option-sheet";
import { navigate } from "./route";

const NO_PROJECT = "__none__";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * What can be done to the chat on screen, behind the header's ⋯.
 *
 * The desktop offers these from the sidebar row's context menu; a phone has no hover and
 * no right click, and a long-press on a drawer row competes with the scroll. One menu on
 * the chat you are looking at is the unambiguous place.
 *
 * Leaving a chat that was archived or deleted goes to the new-chat page, never to the
 * next chat in the list: the desktop's version *opens* that next chat, which would move
 * the engine's active conversation — the thing this page exists not to do.
 */
export function ConversationMenu({ conversation }: { conversation: Conversation }): JSX.Element {
  const { t } = useTranslation("app");
  const projects = useSessionStore((state) => state.projects);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState("");
  const [moving, setMoving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const remote = isRemoteRef(conversation.id);

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

  async function move(value: string): Promise<void> {
    const project = value === NO_PROJECT ? null : value;
    if ((conversation.project ?? null) === project) return;
    try {
      useSessionStore.getState().applySnapshot(await window.fastvibe.conversations.setProject(conversation.id, project));
      toast.success(t("mobile.moved", { project: project ? projects.find((item) => item.cwd === project)?.name ?? project : t("mobile.noProject") }));
    } catch (error) {
      toast.error(errorText(error));
    }
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
    navigate({ kind: "new" }, { replace: true });
  }

  async function remove(): Promise<void> {
    const id = conversation.id;
    setDeleting(false);
    try {
      const result = await window.fastvibe.conversations.delete(id);
      const store = useSessionStore.getState();
      store.applySnapshot(result);
      store.forgetConversationExtensionState(id);
      navigate({ kind: "new" }, { replace: true });
    } catch (error) {
      toast.error(errorText(error));
    }
  }

  const localProjects = projects.filter((item) => item.kind !== "remote");

  return (
    <>
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
            {/* A chat moves only within the server that owns it; a remote one has no
                local project to go to, and the gateway refuses the attempt anyway. */}
            {!remote ? (
              <DropdownMenuItem className="h-10" onClick={() => setMoving(true)}>
                <HugeiconsIcon icon={Folder01Icon} strokeWidth={2} />
                {t("mobile.moveToProject")}
              </DropdownMenuItem>
            ) : null}
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

      <OptionSheet
        open={moving}
        onOpenChange={setMoving}
        title={t("mobile.moveToProject")}
        value={conversation.project ?? NO_PROJECT}
        groups={[
          {
            options: [
              { value: NO_PROJECT, label: t("mobile.noProject") },
              ...localProjects.map((item) => ({ value: item.cwd, label: item.name, description: item.cwd })),
            ],
          },
        ]}
        onSelect={(value) => void move(value)}
      />

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
