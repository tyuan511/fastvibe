import { useEffect, useMemo, useState, type JSX } from "react";
import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { ArrowLeft01Icon, CheckmarkCircle02Icon, Folder01Icon, Link01Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cleanError } from "@/lib/ipc-error";
import type { RemoteHostConnectionState, RemoteHostProfile } from "@shared/remote-host";
import type { DirEntry, ProjectAddResult, WorkspaceSnapshot } from "@shared/types";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: (snapshot: WorkspaceSnapshot) => void;
};

export function AddProjectDialog({ open, onOpenChange, onAdded }: Props): JSX.Element {
  const { t } = useTranslation("app");
  const navigate = useNavigate();
  const [hosts, setHosts] = useState<RemoteHostProfile[]>([]);
  const [hostId, setHostId] = useState("");
  const [path, setPath] = useState("/");
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const [connection, setConnection] = useState<RemoteHostConnectionState>({ hostId: null, status: "disconnected" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedHost = hosts.find((host) => host.id === hostId);
  const directories = useMemo(() => entries.filter((entry) => entry.kind === "directory"), [entries]);

  useEffect(() => window.fastvibe.ssh.onState(setConnection), []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setHostId("");
    setPath("/");
    setEntries([]);
    setConnected(false);
    setConnection({ hostId: null, status: "disconnected" });
    setError(null);
    void window.fastvibe.ssh.hosts().then((snapshot) => {
      if (cancelled) return;
      const map = new Map<string, RemoteHostProfile>();
      for (const host of [...snapshot.discovered, ...snapshot.saved]) map.set(host.id, host);
      setHosts([...map.values()]);
    }).catch((err: unknown) => {
      if (!cancelled) setError(cleanError(err));
    });
    return () => { cancelled = true; };
  }, [open]);

  function close(): void {
    onOpenChange(false);
    setHosts([]);
    setHostId("");
    setPath("/");
    setEntries([]);
    setConnected(false);
    setBusy(false);
    setError(null);
  }

  async function connect(): Promise<void> {
    if (!hostId) return;
    setBusy(true);
    setError(null);
    try {
      await window.fastvibe.ssh.connect(hostId);
      setPath("/");
      setEntries(await window.fastvibe.workspace.readDir("/"));
      setConnected(true);
    } catch (err) {
      setError(cleanError(err));
    } finally {
      setBusy(false);
    }
  }

  async function readPath(nextPath = path): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      setEntries(await window.fastvibe.workspace.readDir(nextPath));
      setPath(nextPath);
    } catch (err) {
      setError(cleanError(err));
    } finally {
      setBusy(false);
    }
  }

  async function addRemote(): Promise<void> {
    if (!selectedHost || !connected || !path.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const added: ProjectAddResult = await window.fastvibe.projects.addRemote(path.trim());
      onAdded(added);
      close();
    } catch (err) {
      setError(cleanError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => next ? onOpenChange(true) : close()}>
      <DialogContent className="max-h-[80vh] overflow-hidden sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{busy ? t("projectDialog.initializing") : connected ? t("projectDialog.folderTitle") : t("projectDialog.remoteTitle")}</DialogTitle>
          <DialogDescription>{busy ? t("projectDialog.initializingDescription") : connected ? t("projectDialog.folderDescription") : t("projectDialog.remoteDescription")}</DialogDescription>
        </DialogHeader>

        {!connected && busy ? (
          <div className="space-y-3 py-2">
            <p className="text-sm font-medium">{t("projectDialog.initializing")}</p>
            <pre className="h-40 max-h-40 max-w-full overflow-x-auto overflow-y-auto whitespace-pre rounded-lg bg-muted px-3 py-2 font-mono text-xs leading-5 text-muted-foreground">{connection.output?.join("\n") || t("projectDialog.initializing")}</pre>
          </div>
        ) : !connected ? (
          <div className="space-y-3 py-2">
            {hosts.length ? (
              <div className="max-h-64 overflow-y-auto rounded-lg border border-border p-1">
                {hosts.map((host) => {
                  const selected = host.id === hostId;
                  return (
                    <button
                      key={host.id}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => setHostId(host.id)}
                      className={`flex w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left transition-colors ${selected ? "border-primary/50 bg-primary/10 text-foreground shadow-sm" : "border-transparent hover:bg-muted"}`}
                    >
                      <HugeiconsIcon icon={Link01Icon} className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{host.label}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {host.user ? `${host.user}@` : ""}{host.hostName ?? host.host}:{host.port ?? 22}
                        </span>
                      </span>
                      {selected ? <HugeiconsIcon icon={CheckmarkCircle02Icon} className="size-5 shrink-0 text-primary" /> : null}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center">
                <p className="text-sm text-muted-foreground">{t("projectDialog.noHosts")}</p>
                <Button variant="link" onClick={() => { close(); navigate("/settings/ssh"); }}>{t("projectDialog.addHost")}</Button>
              </div>
            )}
            {connection.status === "error" && connection.output?.length ? (
              <pre className="max-h-48 max-w-full overflow-x-auto overflow-y-auto whitespace-pre rounded-lg bg-muted px-3 py-2 font-mono text-xs leading-5 text-muted-foreground">{connection.output.join("\n")}</pre>
            ) : null}
          </div>
        ) : (
          <div className="space-y-3 py-2">
            <div className="flex items-center gap-2 rounded-lg border border-border px-3 py-2">
              <HugeiconsIcon icon={Link01Icon} className="size-4 text-muted-foreground" />
              <span className="truncate text-sm">{selectedHost?.label}</span>
            </div>
            <div className="rounded-lg border border-border">
              <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                <Button size="icon-xs" variant="ghost" disabled={busy || path === "/"} onClick={() => void readPath(path.replace(/\/[^/]+$/, "") || "/")} aria-label={t("projectDialog.parent")}>
                  <HugeiconsIcon icon={ArrowLeft01Icon} />
                </Button>
                <Input value={path} onChange={(event) => setPath(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void readPath(); }} className="h-8 font-mono text-xs" />
                <Button size="icon-xs" variant="ghost" disabled={busy} onClick={() => void readPath()} aria-label={t("projectDialog.refresh")}>
                  <HugeiconsIcon icon={RefreshIcon} />
                </Button>
              </div>
              <div className="max-h-64 overflow-y-auto p-1">
                {directories.length ? directories.map((entry) => (
                  <button key={entry.path} type="button" className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted ${entry.path === path ? "bg-primary/10" : ""}`} onDoubleClick={() => void readPath(entry.path)} onClick={() => setPath(entry.path)}>
                    <HugeiconsIcon icon={Folder01Icon} className="size-4 text-muted-foreground" />
                    <span className="truncate">{entry.name}</span>
                  </button>
                )) : <p className="px-2 py-4 text-center text-xs text-muted-foreground">{t("projectDialog.emptyDirectory")}</p>}
              </div>
            </div>
          </div>
        )}
        {error ? <p className="max-w-full overflow-x-auto whitespace-nowrap rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p> : null}
        <DialogFooter className="justify-between">
          {!connected && !busy ? (
            <Button variant="link" className="mr-auto px-0 text-xs text-muted-foreground" onClick={() => { close(); navigate("/settings/ssh"); }}>
              {t("projectDialog.manageHosts")}
            </Button>
          ) : <span />}
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={close}>{t("projectDialog.cancel")}</Button>
          {!connected ? (
            <Button disabled={busy || !hostId} onClick={() => void connect()}>
              <HugeiconsIcon icon={Link01Icon} />{busy ? t("projectDialog.initializing") : t("projectDialog.connect")}
            </Button>
          ) : (
            <Button disabled={busy || path === "/"} onClick={() => void addRemote()}>{t("projectDialog.addRemote")}</Button>
          )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
