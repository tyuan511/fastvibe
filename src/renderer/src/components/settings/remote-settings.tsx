import { useEffect, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cleanError } from "@/lib/ipc-error";
import type { RemoteServerState } from "@shared/ipc";
import { deviceNameProblem } from "@shared/device-name";
import { SettingsGroup, SettingsRow } from "./settings-group";
import { RemoteOfficial } from "./remote-official";
import { RemoteLan } from "./remote-lan";

/**
 * 远程访问: let phones signed in to the same FastVibe account find and use this computer.
 *
 * One switch turns on two ways in. Phones signed in to the same account find this
 * computer on their own, with no address and no password (`RemoteOfficial`); and once a
 * LAN password is set, phones on the local network scan a code or find it by name
 * (`RemoteLan`). Neither is required for the other.
 *
 * State comes from `remote:state` pushes (`window.fastvibe.remote.onState`), the same
 * broadcast a second window would receive — so two settings panes cannot show the
 * connection as up in one and down in the other.
 */
export function RemoteSettings(): JSX.Element {
  const { t } = useTranslation("settings");
  const [state, setState] = useState<RemoteServerState | null>(null);
  const [busy, setBusy] = useState(false);
  const [deviceName, setDeviceName] = useState("");
  const savedName = state?.deviceName ?? "";
  const defaultName = state?.defaultDeviceName ?? "";
  useEffect(() => {
    setDeviceName(savedName || defaultName);
  }, [savedName, defaultName]);
  const nameProblem = deviceNameProblem(deviceName);
  /**
   * Why this pane cannot be used from here, when it cannot.
   *
   * Every `remote:*` method is refused for a remote caller on purpose — a stolen token
   * must not be able to switch the owner's remote access off. The pane has to say so,
   * rather than read the failed `getState` as "not set up".
   */
  const [unavailable, setUnavailable] = useState<string | null>(null);

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
    // Pushed by every write this pane (or a second window) makes, and by a phone
    // connecting or leaving, which nothing in this pane does.
    const off = window.fastvibe.remote.onState(setState);
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

  async function toggle(enabled: boolean): Promise<void> {
    const next = enabled
      ? await run(() => window.fastvibe.remote.start())
      : await run(() => window.fastvibe.remote.stop());
    if (next) setState(next);
  }

  /** An error from the official connection has nothing to retry but the whole switch. */
  async function retryOfficial(): Promise<void> {
    await run(() => window.fastvibe.remote.stop());
    const next = await run(() => window.fastvibe.remote.start());
    if (next) setState(next);
  }

  async function saveDeviceName(name = deviceName): Promise<void> {
    if (busy || deviceNameProblem(name)) return;
    const next = await run(() => window.fastvibe.remote.setDeviceName(name.trim()));
    if (next) {
      setState(next);
      setDeviceName(next.deviceName || next.defaultDeviceName);
    }
  }

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
            <SettingsRow
              title={t("remote.deviceName")}
              description={t("remote.deviceNameDesc")}
              control={
                <div className="w-64 space-y-2">
                  <div className="flex items-center gap-2">
                    <Input
                      className="min-w-0 flex-1"
                      aria-label={t("remote.deviceName")}
                      aria-invalid={Boolean(nameProblem)}
                      aria-describedby={nameProblem ? "remote-device-name-error" : undefined}
                      value={deviceName}
                      placeholder={defaultName}
                      disabled={busy}
                      onChange={(event) => setDeviceName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                          event.preventDefault();
                          void saveDeviceName();
                        }
                      }}
                    />
                    <Button
                      size="sm"
                      disabled={busy || Boolean(nameProblem) || deviceName.trim() === (savedName || defaultName)}
                      onClick={() => void saveDeviceName()}
                    >
                      {t("remote.deviceNameSave")}
                    </Button>
                  </div>
                  {nameProblem ? (
                    <p id="remote-device-name-error" role="alert" className="text-xs text-destructive">
                      {t(`remote.deviceNameErrors.${nameProblem}`)}
                    </p>
                  ) : null}
                </div>
              }
            />
          </SettingsGroup>

          <RemoteOfficial
            official={state.official}
            enabled={state.enabled}
            busy={busy}
            onRetry={() => void retryOfficial()}
          />

          {state.enabled ? <RemoteLan state={state} busy={busy} run={run} onState={setState} /> : null}
        </>
      )}
    </div>
  );
}
