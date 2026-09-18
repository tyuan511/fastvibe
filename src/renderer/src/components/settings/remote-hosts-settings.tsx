import { useEffect, useMemo, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, Delete02Icon, Edit02Icon, RefreshIcon, Folder01Icon } from "@hugeicons/core-free-icons";
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
import type { RemoteHostProfile } from "@shared/remote-host";
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
  const [dialogOpen, setDialogOpen] = useState(false);

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

  const hosts = useMemo(() => {
    const map = new Map<string, RemoteHostProfile>();
    for (const host of [...discovered, ...saved]) map.set(host.id, host);
    return [...map.values()];
  }, [discovered, saved]);

  function edit(host: RemoteHostProfile): void {
    setForm({
      id: host.id,
      label: host.label,
      host: host.host,
      user: host.user ?? "",
      port: host.port ? String(host.port) : "",
      servicePort: String(host.servicePort ?? 7777),
      authMethod: host.authMethod === "password" ? "password" : "default-key",
      identityFile: host.identityFile ?? "",
      password: host.password ?? "",
    });
    setDialogOpen(true);
  }

  async function save(): Promise<void> {
    if (!form.host.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const next = await window.fastvibe.ssh.saveHost({
        id: form.id.trim() || `manual:${form.host.trim()}`,
        label: form.label.trim() || form.host.trim(),
        host: form.host.trim(),
        source: "manual",
        ...(form.user.trim() ? { user: form.user.trim() } : {}),
        ...(form.port ? { port: Number(form.port) } : {}),
        ...(form.servicePort ? { servicePort: Number(form.servicePort) } : {}),
        authMethod: form.authMethod === "password" ? "password" : form.identityFile.trim() ? "identity-file" : "default-key",
        ...(form.authMethod !== "password" && form.identityFile.trim() ? { identityFile: form.identityFile.trim() } : {}),
        ...(form.authMethod === "password" && form.password ? { password: form.password } : {}),
      });
      setSaved(next.saved);
      setDiscovered(next.discovered);
      setForm(EMPTY);
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
      {error ? <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p> : null}
      <div className="flex items-center justify-between gap-3 px-1">
        <h3 className="text-sm font-medium">{t("remoteHosts.list")}</h3>
        <div className="flex items-center gap-2">
          <Button size="xs" variant="ghost" disabled={busy} onClick={() => void load()}>
            <HugeiconsIcon strokeWidth={2} icon={RefreshIcon} />{t("remoteHosts.refresh")}
          </Button>
          <Button size="sm" onClick={() => { setForm(EMPTY); setDialogOpen(true); }}>
            <HugeiconsIcon strokeWidth={2} icon={Add01Icon} />{t("remoteHosts.add")}
          </Button>
        </div>
      </div>
      <SettingsGroup>
        {hosts.length ? hosts.map((host) => (
          <div key={host.id} className="flex items-center gap-3 px-4 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">{host.label}</p>
              <p className="truncate text-xs text-muted-foreground">
                {host.user ? `${host.user}@` : ""}{host.hostName ?? host.host}:{host.port ?? 22}
              </p>
            </div>
            {host.source === "config" ? <Badge variant="secondary">{t("remoteHosts.fromSshConfig")}</Badge> : null}
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => edit(host)} aria-label={t("remoteHosts.edit")}>
              <HugeiconsIcon strokeWidth={2} icon={Edit02Icon} />
            </Button>
            {host.source !== "config" ? (
              <Button size="xs" variant="ghost" disabled={busy} onClick={() => void remove(host.id)} aria-label={t("remoteHosts.remove")}>
                <HugeiconsIcon strokeWidth={2} icon={Delete02Icon} />
              </Button>
            ) : null}
          </div>
        )) : <p className="px-4 py-3 text-xs text-muted-foreground">{t("remoteHosts.empty")}</p>}
      </SettingsGroup>
      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setForm(EMPTY);
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{form.id ? t("remoteHosts.editTitle") : t("remoteHosts.addTitle")}</DialogTitle>
            <DialogDescription>{t("remoteHosts.dialogDesc")}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid gap-1.5">
              <Label htmlFor="ssh-label">{t("remoteHosts.label")}</Label>
              <Input id="ssh-label" placeholder={t("remoteHosts.labelPlaceholder")} value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
              <p className="text-xs text-muted-foreground">{t("remoteHosts.labelHint")}</p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ssh-host">{t("remoteHosts.host")}</Label>
              <Input id="ssh-host" placeholder={t("remoteHosts.hostPlaceholder")} value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} />
              <p className="text-xs text-muted-foreground">{t("remoteHosts.hostHint")}</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="ssh-user">{t("remoteHosts.user")}</Label>
                <Input id="ssh-user" placeholder={t("remoteHosts.userPlaceholder")} value={form.user} onChange={(e) => setForm({ ...form, user: e.target.value })} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="ssh-port">{t("remoteHosts.port")}</Label>
                <Input id="ssh-port" placeholder={t("remoteHosts.portPlaceholder")} inputMode="numeric" value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} />
              </div>
              <div className="grid gap-1.5">
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
            {form.authMethod === "default-key" ? (
              <div className="grid gap-1.5">
                <Label>{t("remoteHosts.identityFile")}</Label>
                <Button
                  type="button"
                  variant="outline"
                  className="w-full justify-between gap-2 font-normal"
                  title={form.identityFile || t("remoteHosts.identityFilePath")}
                  aria-label={t("remoteHosts.identityFile")}
                  onClick={() => {
                    void window.fastvibe.ssh.pickIdentityFile().then((path) => {
                      if (path) setForm((current) => ({ ...current, identityFile: path }));
                    }).catch((err) => setError(cleanError(err)));
                  }}
                >
                  <span className={form.identityFile ? "min-w-0 truncate text-foreground" : "min-w-0 truncate text-muted-foreground"}>
                    {form.identityFile || t("remoteHosts.identityFilePath")}
                  </span>
                  <HugeiconsIcon strokeWidth={2} icon={Folder01Icon} className="shrink-0" />
                </Button>
              </div>
            ) : null}
            {form.authMethod === "password" ? (
              <div className="grid gap-1.5">
                <Label htmlFor="ssh-password">{t("remoteHosts.passwordAuth")}</Label>
                <Input id="ssh-password" type="password" placeholder={t("remoteHosts.passwordPlaceholder")} autoComplete="off" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
              </div>
            ) : null}
            </div>
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
