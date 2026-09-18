import { useEffect, useRef, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { CheckmarkCircle02Icon, Copy01Icon, Delete02Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cleanError } from "@/lib/ipc-error";
import type { RemoteDeviceInfo, RemoteServerState, RemoteTunnelProvider } from "@shared/ipc";
import { SettingsGroup, SettingsRow } from "./settings-group";
import { RemoteTunnel } from "./remote-tunnel";

/**
 * 远程访问: turn this machine's agent into a server another device can reach.
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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
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
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

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

  useEffect(() => () => clearTimeout(copyTimer.current), []);

  async function run<T>(action: () => Promise<T>): Promise<T | null> {
    setBusy(true);
    setError(null);
    try {
      return await action();
    } catch (err) {
      setError(cleanError(err));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function setNewPassword(): Promise<void> {
    if (password !== confirm) {
      setError(t("remote.passwordMismatch"));
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

  async function setTunnel(provider: RemoteTunnelProvider | null): Promise<void> {
    const next = await run(() => window.fastvibe.remote.setTunnel(provider));
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

  const address = state?.port ? `${state.host}:${state.port}` : null;

  async function copyAddress(): Promise<void> {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      copyTimer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable: the address stays selectable on screen.
    }
  }

  return (
    <div className="space-y-4">
      <p className="px-1 text-xs leading-5 text-muted-foreground">{t("remote.intro")}</p>

      {error ? (
        <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}

      {unavailable ? (
        <SettingsGroup>
          <div className="px-4 py-3">
            <p className="text-sm font-medium">{t("remote.localOnly")}</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{unavailable}</p>
          </div>
        </SettingsGroup>
      ) : !state?.configured || changingPassword ? (
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
                    setError(null);
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
          <SettingsGroup>
            <SettingsRow
              title={t("remote.enable")}
              description={
                state.running && address ? (
                  <span className="flex items-center gap-1.5 font-mono">
                    {address}
                    <button
                      type="button"
                      onClick={() => void copyAddress()}
                      className="text-muted-foreground/70 hover:text-foreground"
                      aria-label={t("remote.copyAddress")}
                    >
                      <HugeiconsIcon strokeWidth={2} icon={copied ? CheckmarkCircle02Icon : Copy01Icon} className="size-3.5" />
                    </button>
                  </span>
                ) : (
                  t("remote.enableDesc")
                )
              }
              control={<Switch checked={state.running} disabled={busy} onCheckedChange={(v) => void toggle(v)} />}
            />
            {state.running ? (
              <SettingsRow
                title={t("remote.clients")}
                description={t("remote.clientsDesc")}
                control={<Badge variant="secondary">{state.clients}</Badge>}
              />
            ) : null}
          </SettingsGroup>

          {/*
           * What the address above actually is.
           *
           * Loopback is where this server listens, not where a client goes, so the row
           * can only ever show a string no phone can open. The tunnel below is what turns
           * it into one — the app runs it now rather than printing instructions — and
           * this line stays only to say why the address above is not the answer, for
           * anyone who decides to bring their own.
           */}
          {state.running && address ? (
            <p className="px-1 text-xs leading-5 text-muted-foreground">{t("remote.tunnelHint", { address })}</p>
          ) : null}

          <RemoteTunnel state={state} busy={busy} onSet={(provider) => void setTunnel(provider)} />

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
    </div>
  );
}
