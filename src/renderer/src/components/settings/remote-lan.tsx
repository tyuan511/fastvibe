import { useEffect, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { Delete02Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { QrCode } from "@/components/ui/qr-code";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { RemoteDeviceInfo, RemoteLanAddressFamily, RemoteServerState } from "@shared/ipc";
import { formatRemoteAddress, remoteQrValue } from "@shared/remote-address";
import { CopyAction } from "./address-actions";
import { SettingsGroup, SettingsRow } from "./settings-group";

/**
 * 局域网: phones on the same network reach this computer by address and password.
 *
 * The listener answers on IPv4 and IPv6 at once, so there is no choice of family to make
 * for it — only for the code: one QR per address, switched here, because a phone on a
 * network that routes only one of them has to scan the other. With the switch on and a
 * password set the code is simply there; there is no second switch for the LAN.
 *
 * Without a password there is no listener (the server refuses to start one), so the first
 * thing this shows is the form that sets it.
 */
export function RemoteLan({
  state,
  busy,
  run,
  onState,
}: {
  state: RemoteServerState;
  busy: boolean;
  run: <T>(action: () => Promise<T>) => Promise<T | null>;
  onState: (next: RemoteServerState) => void;
}): JSX.Element {
  const { t } = useTranslation("settings");
  const [devices, setDevices] = useState<RemoteDeviceInfo[]>([]);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  /** Shows the password form again over an already-configured server, to replace it. */
  const [changing, setChanging] = useState(false);
  const [chosen, setChosen] = useState<RemoteLanAddressFamily>("ipv4");

  const { ipv4, ipv6 } = state.lanAddresses;
  // The family on screen is the one asked for while it exists, else whichever does.
  const family: RemoteLanAddressFamily = chosen === "ipv6" ? (ipv6 ? "ipv6" : "ipv4") : ipv4 ? "ipv4" : "ipv6";
  const host = state.lanAddresses[family];
  const name = state.deviceName || state.defaultDeviceName;

  async function refreshDevices(): Promise<void> {
    try {
      setDevices(await window.fastvibe.remote.listDevices());
    } catch {
      setDevices([]);
    }
  }

  // Re-read when the listener or its clients change: a login from a phone adds a device
  // without this pane having done anything.
  useEffect(() => {
    if (state.configured) void refreshDevices();
    else setDevices([]);
  }, [state.configured, state.clients, state.running]);

  async function setNewPassword(): Promise<void> {
    if (password !== confirm) {
      toast.error(t("remote.passwordMismatch"));
      return;
    }
    const next = await run(() => window.fastvibe.remote.setPassword(password));
    if (next) {
      onState(next);
      setPassword("");
      setConfirm("");
      setChanging(false);
    }
  }

  async function turnOff(): Promise<void> {
    const next = await run(() => window.fastvibe.remote.clearPassword());
    if (next) {
      onState(next);
      setDevices([]);
    }
  }

  async function revoke(id: string): Promise<void> {
    const next = await run(() => window.fastvibe.remote.revokeDevice(id));
    if (next) setDevices(next);
  }

  if (!state.configured || changing) {
    return (
      <SettingsGroup title={changing ? t("remote.changePassword") : t("remote.setup")}>
        <div className="space-y-3 px-4 py-3">
          <p className="text-xs text-muted-foreground">
            {changing ? t("remote.changePasswordWarning") : t("remote.setupDesc")}
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
            {changing ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setChanging(false);
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
    );
  }

  const address = host && state.port ? formatRemoteAddress(host, state.port) : null;
  const url = host && state.port ? `http://${formatRemoteAddress(host, state.port, true)}` : null;

  return (
    <>
      <SettingsGroup title={t("remote.lan")}>
        <div className="space-y-3 px-4 py-3">
          {ipv4 && ipv6 ? (
            <Tabs value={family} onValueChange={(value) => setChosen(value === "ipv6" ? "ipv6" : "ipv4")}>
              <TabsList aria-label={t("remote.lanFamily")}>
                <TabsTrigger value="ipv4">IPv4</TabsTrigger>
                <TabsTrigger value="ipv6">IPv6</TabsTrigger>
              </TabsList>
            </Tabs>
          ) : null}
          {!state.running ? (
            <p className="text-xs text-destructive">{t("remote.lanNotRunning")}</p>
          ) : address && url ? (
            <div className="flex items-start gap-4">
              <QrCode value={remoteQrValue(url, name)} title={name} className="size-40 shrink-0" />
              <div className="min-w-0 space-y-1.5">
                <p className="text-sm font-medium">{name}</p>
                <p className="flex items-center gap-1.5 font-mono text-xs break-all">
                  {address}
                  <CopyAction value={url} />
                </p>
                <p className="text-xs leading-5 text-muted-foreground">{t("remote.lanScan")}</p>
              </div>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t("remote.lanNoAddress", { family: family === "ipv6" ? "IPv6" : "IPv4" })}
            </p>
          )}
        </div>
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
            <Button size="xs" variant="outline" disabled={busy} onClick={() => setChanging(true)}>
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
  );
}
