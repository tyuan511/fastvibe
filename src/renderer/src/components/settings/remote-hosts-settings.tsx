import { useEffect, useMemo, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, Delete02Icon, Edit02Icon, Loading03Icon, PowerOffIcon, Pulse01Icon, RefreshIcon, Folder01Icon } from "@hugeicons/core-free-icons";
import { IconButton } from "@/components/icon-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cleanError } from "@/lib/ipc-error";
import type { RemoteAgentStatus, RemoteHostProfile, SshErrorCode } from "@shared/remote-host";
import { SshHostKeyNotice } from "@/components/ssh-host-key";
import { IS_REMOTE } from "@/lib/platform";
import { SettingsGroup } from "./settings-group";

type Form = { id: string; label: string; host: string; user: string; port: string; servicePort: string; authMethod: "default-key" | "identity-file" | "password"; identityFile: string; password: string };
const EMPTY: Form = { id: "", label: "", host: "", user: "", port: "", servicePort: "", authMethod: "default-key", identityFile: "", password: "" };

export function RemoteHostsSettings(): JSX.Element {
  const { t } = useTranslation("settings");
  const [saved, setSaved] = useState<RemoteHostProfile[]>([]);
  const [discovered, setDiscovered] = useState<RemoteHostProfile[]>([]);
  const [form, setForm] = useState<Form>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  /** The profile being edited, so fields the form does not show survive a save. */
  const [original, setOriginal] = useState<RemoteHostProfile | null>(null);
  const [stoppingId, setStoppingId] = useState<string | null>(null);
  /** A test that OpenSSH refused over the host key, opened from the toast's action. */
  const [hostKey, setHostKey] = useState<{ host: RemoteHostProfile; code: SshErrorCode } | null>(null);

  async function load(): Promise<void> {
    try {
      const next = await window.fastvibe.ssh.hosts();
      setSaved(next.saved);
      setDiscovered(next.discovered);
    } catch (err) {
      setError(cleanError(err));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  /**
   * Try to log in to one host, and say how it went.
   *
   * The result is a toast, not a row state: it is a one-shot answer about *right now*, and
   * a row that carried it would go stale the moment the machine's key changed. Testing is
   * also the row's only action — connecting is what 新建项目 does, and it keeps its own
   * live state where that decision is actually made. The probe runs in Main; the pane only
   * draws its verdict.
   */
  async function testHost(host: RemoteHostProfile): Promise<void> {
    setTestingId(host.id);
    try {
      const result = await window.fastvibe.ssh.test(host.id);
      const target = result.target || host.label;
      if (result.ok) {
        toast.success(t("remoteHosts.testOk", { target }), { description: describeAgent(result.agent) });
        return;
      }
      const code = result.errorCode;
      toast.error(t("remoteHosts.testFailed", { target }), {
        description: result.error,
        ...(code === "host-key-unknown" || code === "host-key-changed"
          ? { action: { label: t("remoteHosts.viewHostKey"), onClick: () => setHostKey({ host, code }) } }
          : {}),
      });
    } catch (err) {
      toast.error(t("remoteHosts.testFailed", { target: host.label }), { description: cleanError(err) });
    } finally {
      setTestingId(null);
    }
  }

  function describeAgent(agent: RemoteAgentStatus | undefined): string | undefined {
    if (!agent) return undefined;
    if (agent.running) return t("remoteHosts.agentRunning", { version: agent.running });
    if (agent.installed) return t("remoteHosts.agentInstalled", { version: agent.installed });
    return t("remoteHosts.agentMissing");
  }

  /** Stop the resident Agent. Main disconnects the host first, so nothing reconnects it. */
  async function stopAgent(host: RemoteHostProfile): Promise<void> {
    setStoppingId(host.id);
    try {
      const message = await window.fastvibe.ssh.stopAgent(host.id);
      toast.success(message || t("remoteHosts.stopAgent"));
    } catch (err) {
      toast.error(t("remoteHosts.stopAgentFailed"), { description: cleanError(err) });
    } finally {
      setStoppingId(null);
    }
  }

  const hosts = useMemo(() => {
    const map = new Map<string, RemoteHostProfile>();
    for (const host of [...discovered, ...saved]) map.set(host.id, host);
    return [...map.values()];
  }, [discovered, saved]);

  function edit(host: RemoteHostProfile): void {
    setOriginal(host);
    setError(null);
    setForm({
      id: host.id,
      label: host.label,
      host: host.host,
      user: host.user ?? "",
      port: host.port ? String(host.port) : "",
      // Empty means "let the remote OS pick"; only an explicitly pinned port is shown.
      servicePort: host.servicePort ? String(host.servicePort) : "",
      authMethod: host.authMethod === "password" ? "password" : "default-key",
      identityFile: host.identityFile ?? "",
      // A saved password never reaches the renderer; empty means "keep the one on file".
      password: "",
    });
    setDialogOpen(true);
  }

  async function save(): Promise<void> {
    if (!form.host.trim()) return;
    const port = parsePort(form.port);
    const servicePort = parsePort(form.servicePort);
    if (port === null || servicePort === null) {
      setError(t("remoteHosts.invalidPort"));
      return;
    }
    setBusy(true);
    setError(null);
    // Carried over from the stored profile, then overwritten by what the form shows, so an
    // edit keeps `localPort`, `knownHostsFile` and `hostName` instead of silently dropping them.
    const {
      user: _user, port: _port, servicePort: _servicePort, identityFile: _identityFile,
      password: _password, authMethod: _authMethod, ...kept
    } = original ?? ({} as Partial<RemoteHostProfile>);
    try {
      const next = await window.fastvibe.ssh.saveHost({
        ...kept,
        // A fresh id per new profile: two entries for one machine (another user, another
        // port) must not overwrite each other.
        id: form.id.trim() || `manual:${crypto.randomUUID()}`,
        label: form.label.trim() || form.host.trim(),
        host: form.host.trim(),
        source: "manual",
        ...(form.user.trim() ? { user: form.user.trim() } : {}),
        ...(port ? { port } : {}),
        ...(servicePort ? { servicePort } : {}),
        authMethod: form.authMethod === "password" ? "password" : form.identityFile.trim() ? "identity-file" : "default-key",
        ...(form.authMethod !== "password" && form.identityFile.trim() ? { identityFile: form.identityFile.trim() } : {}),
        ...(form.authMethod === "password" && form.password ? { password: form.password } : {}),
      });
      setSaved(next.saved);
      setDiscovered(next.discovered);
      setForm(EMPTY);
      setOriginal(null);
      setDialogOpen(false);
    } catch (err) {
      setError(cleanError(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(hostId: string): Promise<void> {
    setBusy(true);
    try {
      const next = await window.fastvibe.ssh.removeHost(hostId);
      setSaved(next.saved);
      setDiscovered(next.discovered);
    } catch (err) {
      setError(cleanError(err));
    } finally {
      setBusy(false);
    }
  }

  if (IS_REMOTE) {
    return (
      <SettingsGroup>
        <div className="px-4 py-3">
          <p className="text-sm font-medium">{t("remoteHosts.localOnly")}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t("remoteHosts.localOnlyDesc")}</p>
        </div>
      </SettingsGroup>
    );
  }

  return (
    <div className="space-y-4">
      <p className="px-1 text-xs leading-5 text-muted-foreground">{t("remoteHosts.intro")}</p>
      {error && !dialogOpen ? <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p> : null}
      <div className="flex items-center justify-between gap-3 px-1">
        <h3 className="text-sm font-medium">{t("remoteHosts.list")}</h3>
        <div className="flex items-center gap-2">
          <Button size="xs" variant="ghost" disabled={busy} onClick={() => void load()}>
            <HugeiconsIcon strokeWidth={2} icon={RefreshIcon} />{t("remoteHosts.refresh")}
          </Button>
          <Button size="sm" onClick={() => { setForm(EMPTY); setOriginal(null); setDialogOpen(true); }}>
            <HugeiconsIcon strokeWidth={2} icon={Add01Icon} />{t("remoteHosts.add")}
          </Button>
        </div>
      </div>
      <SettingsGroup>
        {hosts.length ? hosts.map((host) => {
          return (
          <div key={host.id} className="flex items-center gap-3 px-4 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">{host.label}</p>
              <p className="truncate text-xs text-muted-foreground">
                {host.user ? `${host.user}@` : ""}{host.hostName ?? host.host}:{host.port ?? 22}
              </p>
            </div>
            {host.source === "config" ? <Badge variant="secondary">{t("remoteHosts.fromSshConfig")}</Badge> : null}
            <IconButton
              size="icon-xs"
              variant="ghost"
              label={t("remoteHosts.test")}
              disabled={testingId === host.id}
              onClick={() => void testHost(host)}
            >
              <HugeiconsIcon
                strokeWidth={2}
                icon={testingId === host.id ? Loading03Icon : Pulse01Icon}
                className={testingId === host.id ? "animate-spin" : undefined}
              />
            </IconButton>
            <IconButton
              size="icon-xs"
              variant="ghost"
              label={t("remoteHosts.stopAgent")}
              disabled={stoppingId === host.id}
              onClick={() => void stopAgent(host)}
            >
              <HugeiconsIcon
                strokeWidth={2}
                icon={stoppingId === host.id ? Loading03Icon : PowerOffIcon}
                className={stoppingId === host.id ? "animate-spin" : undefined}
              />
            </IconButton>
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => edit(host)} aria-label={t("remoteHosts.edit")}>
              <HugeiconsIcon strokeWidth={2} icon={Edit02Icon} />
            </Button>
            {host.source !== "config" ? (
              <Button size="xs" variant="ghost" disabled={busy} onClick={() => void remove(host.id)} aria-label={t("remoteHosts.remove")}>
                <HugeiconsIcon strokeWidth={2} icon={Delete02Icon} />
              </Button>
            ) : null}
          </div>
          );
        }) : <p className="px-4 py-3 text-xs text-muted-foreground">{t("remoteHosts.empty")}</p>}
      </SettingsGroup>
      <Dialog open={hostKey !== null} onOpenChange={(open) => { if (!open) setHostKey(null); }}>
        <DialogContent className="min-w-0 overflow-hidden sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("remoteHosts.hostKeyTitle")}</DialogTitle>
            <DialogDescription>{hostKey?.host.label}</DialogDescription>
          </DialogHeader>
          {hostKey ? (
            <SshHostKeyNotice
              hostId={hostKey.host.id}
              code={hostKey.code}
              onTrusted={() => {
                const host = hostKey.host;
                setHostKey(null);
                void testHost(host);
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>
      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          setError(null);
          if (!open) {
            setForm(EMPTY);
            setOriginal(null);
          }
        }}
      >
        <DialogContent className="min-w-0 overflow-hidden sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{form.id ? t("remoteHosts.editTitle") : t("remoteHosts.addTitle")}</DialogTitle>
            <DialogDescription>{t("remoteHosts.dialogDesc")}</DialogDescription>
          </DialogHeader>
          <div className="grid min-w-0 gap-4 py-2">
            {/* Save errors belong in the dialog: the page behind it is covered by the overlay. */}
            {error ? <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p> : null}
            <div className="grid min-w-0 gap-1.5">
              <Label htmlFor="ssh-label">{t("remoteHosts.label")}</Label>
              <Input id="ssh-label" placeholder={t("remoteHosts.labelPlaceholder")} value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
              <p className="text-xs text-muted-foreground">{t("remoteHosts.labelHint")}</p>
            </div>
            <div className="grid min-w-0 gap-1.5">
              <Label htmlFor="ssh-host">{t("remoteHosts.host")}</Label>
              <Input id="ssh-host" placeholder={t("remoteHosts.hostPlaceholder")} value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} />
              <p className="text-xs text-muted-foreground">{t("remoteHosts.hostHint")}</p>
            </div>
            <div className="grid min-w-0 gap-3 sm:grid-cols-2">
              <div className="grid min-w-0 gap-1.5">
                <Label htmlFor="ssh-user">{t("remoteHosts.user")}</Label>
                <Input id="ssh-user" placeholder={t("remoteHosts.userPlaceholder")} value={form.user} onChange={(e) => setForm({ ...form, user: e.target.value })} />
              </div>
              <div className="grid min-w-0 gap-1.5">
                <Label htmlFor="ssh-port">{t("remoteHosts.port")}</Label>
                <Input id="ssh-port" placeholder={t("remoteHosts.portPlaceholder")} inputMode="numeric" value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} />
              </div>
            </div>
            <div className="grid min-w-0 gap-1.5">
              <Label>{t("remoteHosts.authMethod")}</Label>
              <Select value={form.authMethod} onValueChange={(value) => setForm({ ...form, authMethod: value as Form["authMethod"] })}>
                <SelectTrigger className="w-full">
                  <SelectValue>{form.authMethod === "password" ? t("remoteHosts.passwordAuth") : t("remoteHosts.keyAuth")}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default-key">{t("remoteHosts.keyAuth")}</SelectItem>
                  <SelectItem value="password">{t("remoteHosts.passwordAuth")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {/* Full width, never a grid cell: a private key path is arbitrarily long, and a
                column sized to its content pushed the whole dialog past its own max width. */}
            {form.authMethod === "default-key" ? (
              <div className="grid min-w-0 gap-1.5">
                <Label>{t("remoteHosts.identityFile")}</Label>
                <Button
                  type="button"
                  variant="outline"
                  className="w-full min-w-0 justify-between gap-2 font-normal"
                  title={form.identityFile || t("remoteHosts.identityFilePath")}
                  aria-label={t("remoteHosts.identityFile")}
                  onClick={() => {
                    void window.fastvibe.ssh.pickIdentityFile().then((path) => {
                      if (path) setForm((current) => ({ ...current, identityFile: path }));
                    }).catch((err) => setError(cleanError(err)));
                  }}
                >
                  <span className={form.identityFile ? "min-w-0 flex-1 truncate text-foreground" : "min-w-0 flex-1 truncate text-muted-foreground"}>
                    {form.identityFile || t("remoteHosts.identityFilePath")}
                  </span>
                  <HugeiconsIcon strokeWidth={2} icon={Folder01Icon} className="shrink-0" />
                </Button>
              </div>
            ) : null}
            {form.authMethod === "password" ? (
              <div className="grid min-w-0 gap-1.5">
                <Label htmlFor="ssh-password">{t("remoteHosts.passwordAuth")}</Label>
                <Input id="ssh-password" type="password" placeholder={original?.hasPassword ? t("remoteHosts.passwordSaved") : t("remoteHosts.passwordPlaceholder")} autoComplete="off" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)}>{t("remoteHosts.cancel")}</Button>
            <Button disabled={busy || !form.host.trim()} onClick={() => void save()}>
              <HugeiconsIcon strokeWidth={2} icon={Add01Icon} />{form.id ? t("remoteHosts.update") : t("remoteHosts.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Empty is "not set" (undefined); anything else must be a whole port number, or null. */
function parsePort(value: string): number | undefined | null {
  const text = value.trim();
  if (!text) return undefined;
  if (!/^\d+$/.test(text)) return null;
  const port = Number(text);
  return port >= 1 && port <= 65_535 ? port : null;
}
