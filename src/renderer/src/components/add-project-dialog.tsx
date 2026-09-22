import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { ArrowLeft01Icon, CheckmarkCircle02Icon, Folder01Icon, Link01Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cleanError } from "@/lib/ipc-error";
import { displayRemotePath, encodeRemoteReadPath, parentRemotePath } from "@/lib/remote-project";
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
  const [rawPath, setRawPath] = useState("/");
  const [serverInstanceId, setServerInstanceId] = useState<string | null>(null);
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const [connection, setConnection] = useState<RemoteHostConnectionState>({ hostId: null, status: "disconnected" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const openRef = useRef(open);
  openRef.current = open;

  const selectedHost = hosts.find((host) => host.id === hostId);
  const directories = useMemo(() => entries.filter((entry) => entry.kind === "directory"), [entries]);

  function nextRequest(): number {
    requestRef.current += 1;
    return requestRef.current;
  }

  function stale(token: number): boolean {
    return token !== requestRef.current || !openRef.current;
  }

  useEffect(() => {
    const apply = (state: RemoteHostConnectionState): void => {
      if (!state.hostId || state.hostId !== hostId) return;
      setConnection(state);
    };
    const offState = window.fastvibe.ssh.onState(apply);
    const offStates = window.fastvibe.ssh.onStates((states) => {
      const match = states.find((state) => state.hostId === hostId);
      if (match) apply(match);
    });
    return () => {
      offState();
      offStates();
    };
  }, [hostId]);

  useEffect(() => {
    if (!open) return;
    nextRequest();
    setHostId("");
    setRawPath("/");
    setServerInstanceId(null);
    setEntries([]);
    setConnected(false);
    setConnection({ hostId: null, status: "disconnected" });
    setError(null);
    setBusy(false);
    let cancelled = false;
    void window.fastvibe.ssh.hosts().then((snapshot) => {
      if (cancelled) return;
      const map = new Map<string, RemoteHostProfile>();
      for (const host of [...snapshot.discovered, ...snapshot.saved]) map.set(host.id, host);
      setHosts([...map.values()]);
    }).catch((err: unknown) => {
      if (!cancelled) setError(t("projectDialog.errors.loadHosts", { message: cleanError(err) }));
    });
    return () => { cancelled = true; };
  }, [open, t]);

  function close(): void {
    nextRequest();
    onOpenChange(false);
    setHosts([]);
    setHostId("");
    setRawPath("/");
    setServerInstanceId(null);
    setEntries([]);
    setConnected(false);
    setBusy(false);
    setError(null);
  }

  async function readPath(nextRaw: string, server: string, token: number): Promise<void> {
    const scoped = encodeRemoteReadPath(server, nextRaw);
    const listed = await window.fastvibe.workspace.readDir(scoped);
    if (stale(token)) return;
    setEntries(listed);
    setRawPath(nextRaw.trim() || "/");
  }

  async function connect(): Promise<void> {
    if (!hostId) return;
    const requested = hostId;
    const token = nextRequest();
    setBusy(true);
    setError(null);
    setConnected(false);
    setServerInstanceId(null);
    setEntries([]);
    setRawPath("/");
    try {
      const state = await window.fastvibe.ssh.connect(requested);
      if (stale(token) || state.hostId !== requested) return;
      setConnection(state);
      if (state.status === "error") {
        setError(state.error || t("projectDialog.errors.connect", { message: "" }).trim());
        return;
      }
      const server = state.serverInstanceId?.trim() ?? "";
      if (!server) {
        setError(t("projectDialog.errors.noServer"));
        return;
      }
      setServerInstanceId(server);
      await readPath("/", server, token);
      if (stale(token)) return;
      setConnected(true);
    } catch (err) {
      if (stale(token)) return;
      setError(t("projectDialog.errors.connect", { message: cleanError(err) }));
    } finally {
      if (!stale(token)) setBusy(false);
    }
  }

  async function browse(nextRaw = rawPath): Promise<void> {
    const server = serverInstanceId;
    if (!server) return;
    const token = nextRequest();
    setBusy(true);
    setError(null);
    try {
      await readPath(nextRaw, server, token);
    } catch (err) {
      if (stale(token)) return;
      setError(t("projectDialog.errors.readDir", { message: cleanError(err) }));
    } finally {
      if (!stale(token)) setBusy(false);
    }
  }

  async function addRemote(): Promise<void> {
    const host = selectedHost;
    const server = serverInstanceId;
    const path = rawPath.trim();
    if (!host || !connected || !server || !path || path === "/") return;
    const token = nextRequest();
    setBusy(true);
    setError(null);
    try {
      const cwd = encodeRemoteReadPath(server, path);
      const added: ProjectAddResult = await window.fastvibe.projects.addRemote(cwd, {
        hostId: host.id,
        serverInstanceId: server,
        workspaceId: path,
        name: path.split("/").filter(Boolean).pop() || host.label,
      });
      if (stale(token)) return;
      onAdded(added);
      close();
    } catch (err) {
      if (stale(token)) return;
      setError(t("projectDialog.errors.addRemote", { message: cleanError(err) }));
    } finally {
      if (!stale(token) && openRef.current) setBusy(false);
    }
  }

  function selectHost(id: string): void {
    if (id === hostId) return;
    nextRequest();
    setHostId(id);
    setConnected(false);
    setServerInstanceId(null);
    setEntries([]);
    setRawPath("/");
    setError(null);
    setBusy(false);
    setConnection({ hostId: null, status: "disconnected" });
  }

  function openFolder(entry: DirEntry): void {
    const next = displayRemotePath(entry.path);
    setRawPath(next);
    void browse(next);
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
                      onClick={() => selectHost(host.id)}
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
                <Button size="icon-xs" variant="ghost" disabled={busy || rawPath === "/"} onClick={() => void browse(parentRemotePath(rawPath))} aria-label={t("projectDialog.parent")}>
                  <HugeiconsIcon icon={ArrowLeft01Icon} />
                </Button>
                <Input value={rawPath} onChange={(event) => setRawPath(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !busy) void browse(); }} className="h-8 font-mono text-xs" />
                <Button size="icon-xs" variant="ghost" disabled={busy} onClick={() => void browse()} aria-label={t("projectDialog.refresh")}>
                  <HugeiconsIcon icon={RefreshIcon} />
                </Button>
              </div>
              <div className="max-h-64 overflow-y-auto p-1">
                {directories.length ? directories.map((entry) => {
                  const shown = displayRemotePath(entry.path);
                  return (
                    <button key={entry.path} type="button" disabled={busy} className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted ${shown === rawPath ? "bg-primary/10" : ""}`} onDoubleClick={() => { if (!busy) openFolder(entry); }} onClick={() => setRawPath(shown)}>
                      <HugeiconsIcon icon={Folder01Icon} className="size-4 text-muted-foreground" />
                      <span className="truncate">{entry.name}</span>
                    </button>
                  );
                }) : <p className="px-2 py-4 text-center text-xs text-muted-foreground">{t("projectDialog.emptyDirectory")}</p>}
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
            <Button disabled={busy || rawPath === "/"} onClick={() => void addRemote()}>{t("projectDialog.addRemote")}</Button>
          )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
