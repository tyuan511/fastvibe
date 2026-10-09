import { useEffect, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { Delete02Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cleanError } from "@/lib/ipc-error";
import type { RemoteDeviceInfo, RemoteLanAddressFamily, RemoteServerState } from "@shared/ipc";
import { formatRemoteAddress } from "@shared/remote-address";
import { discoveryNameProblem } from "@shared/discovery-name";
import { AddressActions } from "./address-actions";
import { SettingsGroup, SettingsRow } from "./settings-group";
import { RemoteOfficial } from "./remote-official";

/**
 * 远程访问: let other devices reach the agent on this machine.
 *
 * One switch turns on both ways in: phones signed in to the same FastVibe account find
 * this computer on their own (`RemoteOfficial`), and — if a password is set — devices on the
 * local network can use an address plus that password. Neither is required for the other.
 *
 * State comes from `remote:state` pushes (`window.fastvibe.remote.onState`), the same
 * broadcast a second window would receive — so two settings panes, or a window plus the
 * tray, cannot show the server as running in one and stopped in the other.
 */
export function RemoteSettings(): JSX.Element {
  const { t } = useTranslation("settings");
  const [state, setState] = useState<RemoteServerState | null>(null);
  const [devices, setDevices] = useState<RemoteDeviceInfo[]>([]);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [discoveryName, setDiscoveryName] = useState("");
  const savedDiscoveryName = state?.discoveryName ?? "";
  const defaultDiscoveryName = state?.defaultDiscoveryName ?? "";
  useEffect(() => {
    setDiscoveryName(savedDiscoveryName || defaultDiscoveryName);
  }, [savedDiscoveryName, defaultDiscoveryName]);
  const nameProblem = discoveryNameProblem(discoveryName);
  /** Shows the password form again over an already-configured server, to replace it. */
  const [changingPassword, setChangingPassword] = useState(false);
  /**
   * Why this pane cannot be used from here, when it cannot.
   *
   * Every `remote:*` method is refused for a remote caller on purpose — a stolen token
   * must not be able to change the password or revoke the owner's other devices. The
   * pane has to say so: without this it read the failed `getState` as "no password set"
   * and offered a setup form, telling someone who is *looking at it over remote access*
   * that remote access is not set up, then failing when they filled the form in.
   */
  const [unavailable, setUnavailable] = useState<string | null>(null);

  async function refreshDevices(): Promise<void> {
    try {
      setDevices(await window.fastvibe.remote.listDevices());
    } catch {
      setDevices([]);
    }
  }

  useEffect(() => {
    let cancelled = false;
    void window.fastvibe.remote
      .getState()
      .then((current) => {
        if (!cancelled) setState(current);
      })
      .catch((err: unknown) => {
        if (!cancelled) setUnavailable(cleanError(err));
      });
    void refreshDevices();
    // Pushed by every write this pane (or a second window) makes, so the two cannot
    // drift — including a `clients` count that a login from elsewhere changes without
    // this pane doing anything at all.
    const off = window.fastvibe.remote.onState((next) => {
      setState(next);
      void refreshDevices();
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  async function run<T>(action: () => Promise<T>): Promise<T | null> {
    setBusy(true);
    try {
      return await action();
    } catch (err) {
      toast.error(cleanError(err));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function setNewPassword(): Promise<void> {
    if (password !== confirm) {
      toast.error(t("remote.passwordMismatch"));
      return;
    }
    const next = await run(() => window.fastvibe.remote.setPassword(password));
    if (next) {
      setState(next);
      setPassword("");
      setConfirm("");
      setChangingPassword(false);
      // Every device token was just revoked along with the old password, so the list
      // the pane still shows is stale until this re-reads it as empty.
      void refreshDevices();
    }
  }

  async function toggle(enabled: boolean): Promise<void> {
    const next = enabled
      ? await run(() => window.fastvibe.remote.start())
      : await run(() => window.fastvibe.remote.stop());
    if (next) setState(next);
  }

  async function toggleLanAccess(enabled: boolean): Promise<void> {
    const next = await run(() => window.fastvibe.remote.setLanAccess(enabled));
    if (next) setState(next);
  }

  /** An error from the official connection has nothing to retry but the whole switch. */
  async function retryOfficial(): Promise<void> {
    await run(() => window.fastvibe.remote.stop());
    const next = await run(() => window.fastvibe.remote.start());
    if (next) setState(next);
  }

  async function disconnectOfficial(): Promise<void> {
    const next = await run(() => window.fastvibe.remote.officialDisconnect());
    if (next) setState(next);
  }

  async function saveDiscoveryName(name = discoveryName): Promise<void> {
    if (busy || discoveryNameProblem(name)) return;
    const next = await run(() => window.fastvibe.remote.setDiscoveryName(name.trim()));
    if (next) {
      setState(next);
      setDiscoveryName(next.discoveryName || next.defaultDiscoveryName);
    }
  }

  async function setLanAddressFamily(family: RemoteLanAddressFamily): Promise<void> {
    const next = await run(() => window.fastvibe.remote.setLanAccess(state?.lanAccess === true, family));
    if (next) setState(next);
  }

  async function revoke(id: string): Promise<void> {
    const next = await run(() => window.fastvibe.remote.revokeDevice(id));
    if (next) setDevices(next);
  }

  async function turnOff(): Promise<void> {
    const next = await run(() => window.fastvibe.remote.clearPassword());
    if (next) {
      setState(next);
      setDevices([]);
    }
  }

  const address = state?.port ? formatRemoteAddress(state.host, state.port) : null;
  const addressUrl = state?.port ? formatRemoteAddress(state.host, state.port, true) : null;

  const showPasswordForm = !state?.configured || changingPassword;

  return (
    <div className="space-y-4">
      <p className="px-1 text-xs leading-5 text-muted-foreground">{t("remote.intro")}</p>

      {unavailable ? (
        <SettingsGroup>
          <div className="px-4 py-3">
            <p className="text-sm font-medium">{t("remote.localOnly")}</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{unavailable}</p>
          </div>
        </SettingsGroup>
      ) : !state ? null : (
        <>
          <SettingsGroup>
            <SettingsRow
              title={t("remote.enable")}
              description={t("remote.enableDesc")}
              control={<Switch checked={state.enabled} disabled={busy} onCheckedChange={(v) => void toggle(v)} />}
            />
          </SettingsGroup>

          <RemoteOfficial
            official={state.official}
            enabled={state.enabled}
            busy={busy}
            onRetry={() => void retryOfficial()}
            onDisconnect={() => void disconnectOfficial()}
          />

          {showPasswordForm ? (
            <SettingsGroup title={changingPassword ? t("remote.changePassword") : t("remote.setup")}>
              <div className="space-y-3 px-4 py-3">
                <p className="text-xs text-muted-foreground">
                  {changingPassword ? t("remote.changePasswordWarning") : t("remote.setupDesc")}
                </p>
                <Input
                  type="password"
                  autoComplete="new-password"
                  placeholder={t("remote.passwordPlaceholder")}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
                <Input
                  type="password"
                  autoComplete="new-password"
                  placeholder={t("remote.confirmPlaceholder")}
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && password && confirm) void setNewPassword();
                  }}
                />
                <div className="flex gap-2">
                  <Button size="sm" disabled={busy || !password || !confirm} onClick={() => void setNewPassword()}>
                    {t("remote.setPassword")}
                  </Button>
                  {changingPassword ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => {
                        setChangingPassword(false);
                        setPassword("");
                        setConfirm("");
                      }}
                    >
                      {t("remote.cancel")}
                    </Button>
                  ) : null}
                </div>
              </div>
            </SettingsGroup>
          ) : (
            <>
              <SettingsGroup title={t("remote.lan")}>
                <SettingsRow
                  title={t("remote.lanAccess")}
                  description={
                    state.lanAccess && state.running && address
                      ? t("remote.lanAccessOnDesc", { address })
                      : t("remote.lanAccessDesc")
                  }
                  control={
                    <Switch checked={state.lanAccess} disabled={busy} onCheckedChange={(v) => void toggleLanAccess(v)} />
                  }
                />
                {state.running && address ? (
                  <SettingsRow
                    title={t("remote.address")}
                    description={
                      <>
                        <span className="flex items-center gap-1.5 font-mono">
                          {address}
                          {/*
                           * The address, as something another device can act on: copy it,
                           * open it, and — when it is one a phone could actually reach —
                           * scan it. With 局域网访问 off the server reports loopback, and
                           * `AddressActions` drops the code for it by itself.
                           */}
                          <AddressActions value={`http://${addressUrl}`} name={savedDiscoveryName || defaultDiscoveryName} />
                        </span>
                        {!state.lanAccess ? <span className="mt-0.5 block">{t("remote.addressLoopback")}</span> : null}
                      </>
                    }
                    control={null}
                  />
                ) : null}
                <SettingsRow
                  title={t("remote.discoveryName")}
                  description={t("remote.discoveryNameDesc")}
                  control={
                    <div className="w-64 space-y-2">
                      <div className="flex items-center gap-2">
                        <Input
                          className="min-w-0 flex-1"
                          aria-label={t("remote.discoveryName")}
                          aria-invalid={Boolean(nameProblem)}
                          aria-describedby={nameProblem ? "remote-discovery-name-error" : undefined}
                          value={discoveryName}
                          placeholder={defaultDiscoveryName}
                          disabled={busy}
                          onChange={(event) => setDiscoveryName(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                              event.preventDefault();
                              void saveDiscoveryName();
                            }
                          }}
                        />
                        <Button
                          size="sm"
                          disabled={busy || Boolean(nameProblem) || discoveryName.trim() === (savedDiscoveryName || defaultDiscoveryName)}
                          onClick={() => void saveDiscoveryName()}
                        >
                          {t("remote.discoveryNameSave")}
                        </Button>
                      </div>
                      {nameProblem ? (
                        <p id="remote-discovery-name-error" role="alert" className="text-xs text-destructive">
                          {t(`remote.discoveryNameErrors.${nameProblem}`)}
                        </p>
                      ) : null}
                    </div>
                  }
                />
                {state.lanAccess && state.lanAddresses.ipv4 && state.lanAddresses.ipv6 ? (
                  <SettingsRow
                    title={t("remote.lanAddressFamily")}
                    description={t("remote.lanAddressFamilyDesc")}
                    control={
                      <Select
                        value={state.lanAddressFamily}
                        disabled={busy}
                        onValueChange={(value) => {
                          if (value === "ipv4" || value === "ipv6") void setLanAddressFamily(value);
                        }}
                      >
                        <SelectTrigger size="sm" className="w-28">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="ipv4">IPv4</SelectItem>
                          <SelectItem value="ipv6">IPv6</SelectItem>
                        </SelectContent>
                      </Select>
                    }
                  />
                ) : null}
                {state.running ? (
                  <SettingsRow
                    title={t("remote.clients")}
                    description={t("remote.clientsDesc")}
                    control={<Badge variant="secondary">{state.clients}</Badge>}
                  />
                ) : null}
              </SettingsGroup>

              <SettingsGroup title={t("remote.devices")}>
                {devices.length ? (
                  devices.map((device) => (
                    <div key={device.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                      <div className="min-w-0">
                        <p className="truncate text-sm">{device.label}</p>
                        <p className="text-xs text-muted-foreground">
                          {device.lastSeenAt
                            ? t("remote.lastSeen", { time: new Date(device.lastSeenAt).toLocaleString() })
                            : t("remote.neverConnected")}
                        </p>
                      </div>
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => void revoke(device.id)}
                        aria-label={t("remote.revoke")}
                      >
                        <HugeiconsIcon strokeWidth={2} icon={Delete02Icon} />
                      </Button>
                    </div>
                  ))
                ) : (
                  <p className="px-4 py-3 text-xs text-muted-foreground">{t("remote.noDevices")}</p>
                )}
              </SettingsGroup>

              <SettingsGroup title={t("remote.danger")}>
                <SettingsRow
                  title={t("remote.changePassword")}
                  description={t("remote.changePasswordDesc")}
                  control={
                    <Button size="xs" variant="outline" disabled={busy} onClick={() => setChangingPassword(true)}>
                      <HugeiconsIcon strokeWidth={2} icon={RefreshIcon} />
                      {t("remote.changePassword")}
                    </Button>
                  }
                />
                <SettingsRow
                  title={t("remote.turnOff")}
                  description={t("remote.turnOffDesc")}
                  control={
                    <Button size="xs" variant="destructive" disabled={busy} onClick={() => void turnOff()}>
                      {t("remote.turnOff")}
                    </Button>
                  }
                />
              </SettingsGroup>
            </>
          )}
        </>
      )}
    </div>
  );
}
