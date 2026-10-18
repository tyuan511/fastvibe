import { useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import type { DirEntry } from "@shared/types";
import { Button } from "@/components/ui/button";
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
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

/**
 * What the file tree's right-click menu is about to do.
 *
 * `parent` is the directory the tree must re-read afterwards, and it is carried rather than
 * derived from `path`: a row of a remote project holds a namespaced path, and re-reading the
 * folder is the one thing that must not be computed by string surgery in the wrong direction.
 */
export type FileTreeIntent =
  | { kind: "create"; cwd: string; parent: string; entryKind: DirEntry["kind"] }
  | { kind: "rename"; cwd: string; path: string; parent: string; name: string }
  | {
      kind: "delete";
      cwd: string;
      path: string;
      parent: string;
      name: string;
      entryKind: DirEntry["kind"];
      /** An SSH host has no Trash, and the dialog owes the user that difference. */
      remote?: boolean;
    };

/**
 * The one dialog the file tree's file and folder operations go through: a name field for
 * create and rename, a confirmation for delete.
 *
 * A refused name stays on screen rather than closing the dialog: the usual reason is a name
 * that is already taken, and the fix is to edit the field that is right there.
 */
export function FileTreeDialog({
  intent,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  intent: FileTreeIntent;
  busy: boolean;
  error?: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const { t } = useTranslation("sidepane");

  if (intent.kind === "delete") {
    return (
      <AlertDialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t(intent.entryKind === "directory" ? "files.deleteFolderTitle" : "files.deleteFileTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              <span>{t("files.deleteConfirm", { name: intent.name })}</span>
              {/* The two hosts delete differently, and only one of them can take it back. */}
              <span className="mt-1 block">{t(intent.remote ? "files.deletePermanent" : "files.deleteToTrash")}</span>
            </AlertDialogDescription>
            {/* A Trash that refuses, an EPERM, a host that is unreachable: the dialog is the
                only place that can say so, because nothing else on screen changed. */}
            {error ? (
              <p className="mt-2 rounded-md bg-destructive/10 px-2 py-1.5 text-sm text-destructive">{error}</p>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("files.cancel")}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={busy} onClick={() => onSubmit("")}>
              {t("files.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  }

  return <NameDialog intent={intent} busy={busy} error={error} onSubmit={onSubmit} onCancel={onCancel} />;
}

function NameDialog({
  intent,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  intent: Extract<FileTreeIntent, { kind: "create" | "rename" }>;
  busy: boolean;
  error?: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const { t } = useTranslation("sidepane");
  const initial = intent.kind === "rename" ? intent.name : "";
  const [name, setName] = useState(initial);

  // Rename opens on the name that is there with the extension left out of the selection: the
  // usual edit is the stem, and a `.tsx` is not something the reader means to retype. It is
  // done on focus rather than in an effect because the dialog is what moves focus in here,
  // and a selection set before that lands is collapsed by it.
  const stemEnd = initial.lastIndexOf(".");
  const selectStem = (event: { currentTarget: HTMLInputElement }): void => {
    event.currentTarget.setSelectionRange(0, stemEnd > 0 ? stemEnd : initial.length);
  };

  const title = intent.kind === "rename"
    ? t("files.renameTitle")
    : t(intent.entryKind === "directory" ? "files.newFolderTitle" : "files.newFileTitle");

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel(); }} disablePointerDismissal>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim()) onSubmit(name.trim());
          }}
        >
          <Input
            value={name}
            spellCheck={false}
            autoComplete="off"
            placeholder={t("files.namePlaceholder")}
            onFocus={selectStem}
            onChange={(event) => setName(event.target.value)}
          />
          {/* Where the new thing lands — a name alone is not enough to know you are not
              about to create a third `index.ts` somewhere else in the project. */}
          <p className="truncate text-xs text-muted-foreground" title={intent.parent}>
            {t("files.inFolder", { folder: intent.parent })}
          </p>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onCancel}>{t("files.cancel")}</Button>
            <Button type="submit" disabled={busy || !name.trim()}>
              {t(intent.kind === "rename" ? "files.rename" : "files.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
