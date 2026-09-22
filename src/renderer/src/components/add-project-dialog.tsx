import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { ArrowLeft01Icon, CheckmarkCircle02Icon, Folder01Icon, Link01Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cleanError } from "@/lib/ipc-error";
import { SshHostKeyNotice } from "@/components/ssh-host-key";
import { displayRemotePath, encodeRemoteReadPath, parentRemotePath } from "@/lib/remote-project";
import type { RemoteHostConnectionState, RemoteHostProfile, RemoteTransferProgress } from "@shared/remote-host";
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
  /**
   * A connect this dialog started and has not seen finish. Closing the dialog or picking
   * another host disconnects it, so a deploy nobody is waiting for does not run on for
   * minutes. A host that was already connected is never recorded here: it may be serving
   * projects that are open elsewhere.
   */
  const pendingConnectRef = useRef<string | null>(null);
  const openRef = useRef(open);
  openRef.current = open;

  const selectedHost = hosts.find((host) => host.id === hostId);
  const directories = useMemo(() => entries.filter((entry) => entry.kind === "directory"), [entries]);
  const connectionLines = connection.output?.filter(Boolean) ?? [];
  const connectionOutput = connectionLines.join("\n") || t("projectDialog.initializing");
  const currentConnectionStep = connectionLines.at(-1) || t("projectDialog.initializing");

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

  function abandonPendingConnect(): void {
    const pending = pendingConnectRef.current;
    pendingConnectRef.current = null;
    if (pending) void window.fastvibe.ssh.disconnect(pending).catch(() => undefined);
  }

  function close(): void {
    nextRequest();
    abandonPendingConnect();
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
    setConnection({ hostId: requested, status: "connecting" });
    try {
      const live = await window.fastvibe.ssh.states().catch(() => [] as RemoteHostConnectionState[]);
      if (stale(token)) return;
      if (!live.some((item) => item.hostId === requested && item.status === "connected")) pendingConnectRef.current = requested;
      const state = await window.fastvibe.ssh.connect(requested);
      if (pendingConnectRef.current === requested) pendingConnectRef.current = null;
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
      // Start where the user's projects almost always are, not at `/`.
      await readPath(state.home ?? "/", server, token).catch(async (err: unknown) => {
        if (!state.home) throw err;
        await readPath("/", server, token);
      });
      if (stale(token)) return;
      setConnected(true);
    } catch (err) {
      if (pendingConnectRef.current === requested) pendingConnectRef.current = null;
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
    abandonPendingConnect();
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
      <DialogContent className="max-h-[80vh] min-w-0 overflow-hidden sm:max-w-xl">
        <DialogHeader className="min-w-0 pr-8">
          <DialogTitle>{busy ? t("projectDialog.initializing") : connected ? t("projectDialog.folderTitle") : t("projectDialog.remoteTitle")}</DialogTitle>
          <DialogDescription>{busy ? t("projectDialog.initializingDescription") : connected ? t("projectDialog.folderDescription") : t("projectDialog.remoteDescription")}</DialogDescription>
        </DialogHeader>

        {!connected && busy ? (
          <div className="min-w-0 py-1">
            <div className="min-w-0 rounded-xl border border-border bg-muted/40 p-3">
              <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
                <span className="size-2 shrink-0 animate-pulse rounded-full bg-primary" />
                <span className="truncate">{currentConnectionStep}</span>
              </div>
              {connection.progress ? <TransferBar progress={connection.progress} label={t(`projectDialog.progress.${connection.progress.phase}`)} /> : null}
              <pre className="mt-3 max-h-44 min-h-28 w-full min-w-0 overflow-auto whitespace-pre-wrap break-words border-t border-border/70 pt-3 font-mono text-xs leading-5 text-muted-foreground">{connectionOutput}</pre>
            </div>
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
            {connection.status === "error" && connection.errorCode && connection.hostId === hostId ? (
              <SshHostKeyNotice
                key={`${hostId}:${connection.errorCode}`}
                hostId={hostId}
                code={connection.errorCode}
                trustLabel={t("projectDialog.hostKey.trust")}
                onTrusted={() => void connect()}
                onEditHost={() => { close(); navigate("/settings/ssh"); }}
              />
            ) : null}
            {connection.status === "error" && connection.output?.length ? (
              <pre className="max-h-48 w-full min-w-0 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted px-3 py-2 font-mono text-xs leading-5 text-muted-foreground">{connection.output.join("\n")}</pre>
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
        {error ? <p className="min-w-0 whitespace-pre-wrap break-words rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs leading-5 text-destructive">{error}</p> : null}
        <DialogFooter className="min-w-0 sm:justify-between">
          {!connected && !busy ? (
            <Button variant="link" className="min-w-0 px-0 text-left text-xs text-muted-foreground" onClick={() => { close(); navigate("/settings/ssh"); }}>
              <span className="truncate">{t("projectDialog.manageHosts")}</span>
            </Button>
          ) : <span className="min-w-0" />}
          <div className="flex shrink-0 items-center justify-end gap-2">
            <Button variant="ghost" onClick={close}>{t("projectDialog.cancel")}</Button>
            {!connected ? (
              <Button className="whitespace-nowrap" disabled={busy || !hostId} onClick={() => void connect()}>
                <HugeiconsIcon icon={busy ? RefreshIcon : Link01Icon} className={busy ? "animate-spin" : undefined} />
                {busy ? t("projectDialog.initializing") : t("projectDialog.connect")}
              </Button>
            ) : (
              <Button className="whitespace-nowrap" disabled={busy || rawPath === "/"} onClick={() => void addRemote()}>{t("projectDialog.addRemote")}</Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * One transfer of a connect: bytes, speed and, when the size is known, a determinate bar.
 * An unknown size (a server that sent no length) gets a moving bar instead of a guess.
 */
function TransferBar({ progress, label }: { progress: RemoteTransferProgress; label: string }): JSX.Element {
  const percent = progress.total ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : null;
  const amount = progress.total ? `${formatBytes(progress.done)} / ${formatBytes(progress.total)}` : formatBytes(progress.done);
  return (
    <div className="mt-3 min-w-0 space-y-1.5" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} {...(percent !== null ? { "aria-valuenow": percent } : {})}>
      <div className="flex min-w-0 items-center justify-between gap-3 text-xs text-muted-foreground">
        <span className="truncate">{label}</span>
        <span className="shrink-0 font-mono tabular-nums">
          {amount}{progress.rate ? ` · ${formatBytes(progress.rate)}/s` : ""}{percent !== null ? ` · ${percent}%` : ""}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-border">
        {percent !== null
          ? <div className="h-full rounded-full bg-primary transition-[width] duration-300" style={{ width: `${percent}%` }} />
          : <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />}
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
