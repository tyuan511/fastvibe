import { useEffect, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { Add01Icon, Cancel01Icon, Folder01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { folderName, projectFolderPaths } from "@shared/project-folders";
import type { Project, WorkspaceSnapshot } from "@shared/types";
import { Button } from "@/components/ui/button";
import { isRemoteProject } from "@/lib/remote-project";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cleanError } from "@/lib/ipc-error";
import { cn } from "@/lib/utils";

type Props = {
  open: boolean;
  mode: "create" | "manage";
  project?: Project;
  onOpenChange: (open: boolean) => void;
  onSaved: (snapshot: WorkspaceSnapshot, cwd?: string) => void;
};

export function ProjectFoldersDialog({ open, mode, project, onOpenChange, onSaved }: Props): JSX.Element {
  const { t } = useTranslation("app");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [folders, setFolders] = useState<string[]>([]);
  const [missing, setMissing] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const managing = mode === "manage";
  const remote = managing && isRemoteProject(project);
  const primary = folders[0];
  const placeholder = primary ? folderName(primary) : t("projectFolders.namePlaceholder");
  const savedFolders = project ? projectFolderPaths(project).join("\0") : "";
  const dirty = managing
    ? nameTouched || folders.join("\0") !== savedFolders
    : nameTouched || folders.length > 0;

  useEffect(() => {
    if (!open) return;
    setError(null);
    setBusy(false);
    setNameTouched(false);
    if (managing && project) {
      setName(project.name);
      setFolders(projectFolderPaths(project));
    } else {
      setName("");
      setFolders([]);
    }
    // Seed once per open. Applying the edit replaces the project, which must not
    // wipe what the user has typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open || remote || folders.length === 0) {
      setMissing(new Set());
      return;
    }
    let cancelled = false;
    void Promise.all(folders.map(async (folder) => {
      try {
        await window.fastvibe.workspace.readDir(folder);
        return null;
      } catch {
        return folder;
      }
    })).then((results) => {
      if (!cancelled) setMissing(new Set(results.filter((item): item is string => Boolean(item))));
    });
    return () => {
      cancelled = true;
    };
  }, [open, remote, folders]);

  async function pick(): Promise<void> {
    setError(null);
    try {
      const picked = await window.fastvibe.projects.pickFolder();
      if (!picked) return;
      setFolders((current) => current.includes(picked) ? current : [...current, picked]);
    } catch (err) {
      setError(cleanError(err));
    }
  }

  function remove(folder: string): void {
    setFolders((current) => current.filter((item) => item !== folder));
  }

  function makePrimary(folder: string): void {
    setFolders((current) => [folder, ...current.filter((item) => item !== folder)]);
  }

  async function create(): Promise<void> {
    if (folders.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const added = await window.fastvibe.projects.create({
        name: nameTouched ? name.trim() : undefined,
        folders,
      });
      onSaved(added, added.project.cwd);
      onOpenChange(false);
    } catch (err) {
      setError(cleanError(err));
    } finally {
      setBusy(false);
    }
  }

  async function confirm(): Promise<void> {
    if (!project || busy || (!remote && folders.length === 0)) return;
    setBusy(true);
    setError(null);
    try {
      let current = project;
      let snapshot: WorkspaceSnapshot | undefined;
      if (remote) {
        const trimmed = name.trim();
        if (nameTouched && trimmed && trimmed !== current.name) {
          snapshot = await window.fastvibe.projects.rename(current.cwd, trimmed);
        }
        if (snapshot) onSaved(snapshot, current.cwd);
        onOpenChange(false);
        return;
      }
      const desired = [...folders];
      for (let index = 0; index < desired.length; index += 1) {
        const folder = desired[index];
        if (projectFolderPaths(current).includes(folder)) continue;
        snapshot = await window.fastvibe.projects.addFolder(current.cwd, folder);
        const next = snapshot.projects.find((item) => item.cwd === current.cwd) ?? current;
        const stored = projectFolderPaths(next).find((item) => !projectFolderPaths(current).includes(item));
        if (stored) desired[index] = stored;
        current = next;
      }
      if (desired[0] && desired[0] !== current.cwd) {
        const previous = current.cwd;
        snapshot = await window.fastvibe.projects.setPrimary(current.cwd, desired[0]);
        const next = snapshot.projects.find((item) => (item.folders ?? []).includes(previous))
          ?? snapshot.projects.find((item) => item.cwd === desired[0]);
        if (next) {
          if (next.cwd !== desired[0]) desired[0] = next.cwd;
          current = next;
        }
      }
      for (const folder of projectFolderPaths(current)) {
        if (folder === current.cwd || desired.includes(folder)) continue;
        snapshot = await window.fastvibe.projects.removeFolder(current.cwd, folder);
        current = snapshot.projects.find((item) => item.cwd === current.cwd) ?? current;
      }
      const trimmed = name.trim();
      if (nameTouched && trimmed && trimmed !== current.name) {
        snapshot = await window.fastvibe.projects.rename(current.cwd, trimmed);
      }
      if (snapshot) onSaved(snapshot, current.cwd);
      onOpenChange(false);
    } catch (err) {
      setError(cleanError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} disablePointerDismissal={dirty}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{managing ? t("projectFolders.manageTitle") : t("projectFolders.createTitle")}</DialogTitle>
        </DialogHeader>
        <div className="flex items-center gap-2 rounded-lg border border-border px-2">
          <HugeiconsIcon strokeWidth={2} icon={Folder01Icon} className="size-4 shrink-0 text-muted-foreground" />
          <Input
            value={name}
            placeholder={placeholder}
            onChange={(event) => {
              setNameTouched(true);
              setName(event.target.value);
            }}
            className="border-0 shadow-none focus-visible:ring-0"
          />
        </div>
        {remote ? null : <div className="flex flex-col gap-1">
          <p className="text-sm text-muted-foreground">{t("projectFolders.sources")}</p>
          <div className="overflow-hidden rounded-lg border border-border">
            {folders.map((folder, index) => (
              <div key={folder} className="group/folder flex items-center gap-2 border-b border-border px-3 py-2 last:border-b-0">
                <HugeiconsIcon strokeWidth={2} icon={Folder01Icon} className="size-4 shrink-0 text-muted-foreground" />
                <span className={cn("min-w-0 flex-1 truncate text-sm", missing.has(folder) && "text-destructive")} title={folder}>
                  {folderName(folder)}
                </span>
                {missing.has(folder) ? (
                  <span className="shrink-0 text-xs text-destructive">{t("projectFolders.missing")}</span>
                ) : null}
                {index === 0 ? (
                  <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{t("projectFolders.primary")}</span>
                ) : (
                  // Collapsed, not merely faded: the label is wide enough to leave a blank
                  // at the end of every row. Touch has no hover, so the actions stay shown.
                  <div className="flex w-0 min-w-0 items-center gap-0.5 overflow-hidden opacity-0 transition-opacity group-hover/folder:w-auto group-hover/folder:overflow-visible group-hover/folder:opacity-100 group-focus-within/folder:w-auto group-focus-within/folder:overflow-visible group-focus-within/folder:opacity-100 pointer-coarse:w-auto pointer-coarse:overflow-visible pointer-coarse:opacity-100">
                    <Button type="button" size="xs" variant="ghost" onClick={() => makePrimary(folder)}>
                      {t("projectFolders.makePrimary")}
                    </Button>
                    <Button type="button" size="icon-xs" variant="ghost" aria-label={t("projectFolders.remove")} onClick={() => remove(folder)}>
                      <HugeiconsIcon strokeWidth={2} icon={Cancel01Icon} className="size-3.5" />
                    </Button>
                  </div>
                )}
              </div>
            ))}
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-muted-foreground hover:bg-muted"
              onClick={() => void pick()}
            >
              <HugeiconsIcon strokeWidth={2} icon={Add01Icon} className="size-4" />
              {t("projectFolders.add")}
            </button>
          </div>
        </div>}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>{t("projectFolders.cancel")}</Button>
          {managing ? (
            <Button type="button" disabled={busy || !dirty || (remote ? !name.trim() : folders.length === 0)} onClick={() => void confirm()}>
              {t("projectFolders.confirm")}
            </Button>
          ) : (
            <Button type="button" disabled={folders.length === 0 || busy} onClick={() => void create()}>
              {t("projectFolders.create")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
