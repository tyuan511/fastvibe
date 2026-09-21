import { useCallback, useEffect, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { Alert02Icon, CheckmarkCircle02Icon, Delete02Icon, DragDropIcon, RefreshIcon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import { SettingsGroup, SettingsRow } from "./settings-group";
import { useSettingsStore } from "@/stores/settings";
import { blockedRemotely } from "@/lib/remote-unavailable";
import { Ipc } from "@shared/ipc";
import type { ComputerAppInfo, ComputerPermissionStatus, GrantFlowState } from "@shared/types";
import { cn } from "@/lib/utils";

/**
 * 电脑操控.
 *
 * Two things make this pane different from the rest of Settings. It is the only one
 * whose switches are meaningless until the *operating system* agrees, so the grant state
 * is rendered first and the controls below it are disabled until it is satisfied. And
 * the macOS grant cannot be completed from inside this app at all — the pane's job is to
 * open the right pane of System Settings and hand the user something to drop into it.
 */
export function ComputerSettings(): JSX.Element {
  const { t } = useTranslation("settings");
  const settings = useSettingsStore((state) => state.settings);
  const save = useSettingsStore((state) => state.update);

  const [status, setStatus] = useState<ComputerPermissionStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const [apps, setApps] = useState<ComputerAppInfo[] | null>(null);
  const [appsLoading, setAppsLoading] = useState(false);

  const remote = blockedRemotely(Ipc.computerPermissions);

  const refresh = useCallback(async () => {
    if (remote) {
      setChecking(false);
      return;
    }
    setChecking(true);
    try {
      setStatus(await window.fastvibe.computer.permissions());
    } catch {
      setStatus(null);
    } finally {
      setChecking(false);
    }
  }, [remote]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A grant is made in System Settings, not here, so this pane only learns about it by
  // looking again. Re-checking when the window regains focus is what turns "I just
  // flipped the toggle" into a pane that already agrees.
  useEffect(() => {
    if (remote) return undefined;
    const onFocus = (): void => {
      void refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh, remote]);

  const ready = status?.ready === true;
  const allowedApps = settings.computerAllowedApps ?? [];

  const loadApps = async (): Promise<void> => {
    setAppsLoading(true);
    try {
      setApps(await window.fastvibe.computer.listApps());
    } catch {
      setApps([]);
    } finally {
      setAppsLoading(false);
    }
  };

  const allowedIds = new Set(allowedApps.map((item) => item.id));

  const addApp = (app: ComputerAppInfo): void => {
    // Keyed by bundle id where there is one: a display name is not an identity, and a
    // rename must not quietly change which application the user allowed. The name is
    // stored beside it so the list stays readable when the app is not running.
    const id = app.bundleId || app.name;
    if (allowedIds.has(id)) return;
    save({ computerAllowedApps: [...allowedApps, { id, name: app.name }] });
  };

  const removeApp = (id: string): void => {
    save({ computerAllowedApps: allowedApps.filter((item) => item.id !== id) });
  };

  if (remote) {
    return (
      <SettingsGroup>
        <div className="px-4 py-6 text-sm text-muted-foreground">{t("computer.remoteOnly")}</div>
      </SettingsGroup>
    );
  }

  return (
    <div className="space-y-6">
      <PermissionCard status={status} checking={checking} onRefresh={refresh} />

      <SettingsGroup title={t("computer.controlTitle")}>
        <SettingsRow
          title={t("computer.enable")}
          description={t("computer.enableDesc")}
          control={
            <Switch
              checked={settings.computerEnabled}
              disabled={!ready}
              onCheckedChange={(checked) => save({ computerEnabled: checked })}
            />
          }
        />
        <SettingsRow
          title={t("computer.background")}
          description={t("computer.backgroundDesc")}
          control={
            <Switch
              checked={settings.computerPreferBackground}
              disabled={!ready || !settings.computerEnabled}
              onCheckedChange={(checked) => save({ computerPreferBackground: checked })}
            />
          }
        />
        <SettingsRow
          title={t("computer.clipboard")}
          description={t("computer.clipboardDesc")}
          control={
            <Switch
              checked={settings.computerClipboard}
              disabled={!ready || !settings.computerEnabled}
              onCheckedChange={(checked) => save({ computerClipboard: checked })}
            />
          }
        />
      </SettingsGroup>

      <section className="space-y-2">
        <div className="flex items-center justify-between px-1">
          <h3 className="text-sm font-medium">{t("computer.allowedTitle")}</h3>
          <Button
            size="sm"
            variant="ghost"
            disabled={appsLoading || !ready}
            onClick={() => void loadApps()}
          >
            {appsLoading ? <Spinner className="size-3.5" /> : <HugeiconsIcon strokeWidth={2} icon={RefreshIcon} className="size-3.5" />}
            {t("computer.allowedPick")}
          </Button>
        </div>
        <p className="px-1 text-xs leading-4 text-muted-foreground">{t("computer.allowedDesc")}</p>
        <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          {allowedApps.length === 0 && apps === null ? (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">{t("computer.allowedEmpty")}</div>
          ) : null}
          {allowedApps.map((item) => (
            <div key={item.id} className="flex items-center justify-between gap-6 px-4 py-3">
              <div className="min-w-0">
                <span className="text-sm">{item.name}</span>
                {item.id === item.name ? null : (
                  <p className="mt-0.5 truncate text-xs leading-4 text-muted-foreground">{item.id}</p>
                )}
              </div>
              <Button size="sm" variant="ghost" onClick={() => removeApp(item.id)}>
                <HugeiconsIcon strokeWidth={2} icon={Delete02Icon} className="size-3.5" />
                {t("computer.allowedRemove")}
              </Button>
            </div>
          ))}
          {apps?.map((app) => {
            const id = app.bundleId || app.name;
            if (allowedIds.has(id)) return null;
            return (
              <div key={`${app.pid}:${id}`} className="flex items-center justify-between gap-6 px-4 py-3">
                <div className="min-w-0">
                  <span className="text-sm">{app.name}</span>
                  {app.bundleId ? (
                    <p className="mt-0.5 truncate text-xs leading-4 text-muted-foreground">{app.bundleId}</p>
                  ) : null}
                </div>
                <Button size="sm" variant="ghost" onClick={() => addApp(app)}>
                  {t("computer.allowedAdd")}
                </Button>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

/**
 * The grant state, and the two ways out of it.
 *
 * `请求授权` shows the system prompts, which is what *registers* FastVibe in the Privacy
 * & Security list — an app that has never asked does not appear there at all, so the
 * drag target below is useless until this has been pressed at least once.
 */
function PermissionCard({
  status,
  checking,
  onRefresh,
}: {
  status: ComputerPermissionStatus | null;
  checking: boolean;
  onRefresh: () => Promise<void>;
}): JSX.Element {
  const { t } = useTranslation("settings");
  const [starting, setStarting] = useState(false);
  const [flow, setFlow] = useState<GrantFlowState>({ active: false, step: 0, total: 0 });

  // The flow runs in Main and advances on its own as the user works in System Settings,
  // so the pane follows it rather than driving it. Each step's grant also re-reads the
  // permissions, which is what moves a row to 已授权 without waiting for window focus.
  //
  // Read once as well as subscribed: the broadcast only fires when a step changes, so a
  // pane opened in the middle of a sequence would otherwise show the idle state.
  useEffect(() => {
    void window.fastvibe.computer.getGrantFlow().then(setFlow);
    return window.fastvibe.computer.onGrantFlowState((next) => {
      setFlow(next);
      void onRefresh();
    });
  }, [onRefresh]);

  if (checking && !status) {
    return (
      <SettingsGroup title={t("computer.permissionTitle")}>
        <div className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground">
          <Spinner className="size-4" />
          {t("computer.checking")}
        </div>
      </SettingsGroup>
    );
  }

  // No native engine for this architecture. Offering a grant button here would be a
  // button that cannot work, so say what is actually wrong instead.
  if (status && !status.available) {
    return (
      <SettingsGroup title={t("computer.permissionTitle")}>
        <div className="space-y-1 px-4 py-4">
          <div className="flex items-center gap-2 text-sm">
            <HugeiconsIcon strokeWidth={2} icon={Alert02Icon} className="size-4 text-destructive" />
            {t("computer.unavailable")}
          </div>
          {status.error ? <p className="text-xs leading-4 text-muted-foreground">{status.error}</p> : null}
        </div>
      </SettingsGroup>
    );
  }

  const mac = status?.platform === "darwin";

  const start = async (): Promise<void> => {
    setStarting(true);
    try {
      setFlow(await window.fastvibe.computer.startGrantFlow());
    } finally {
      setStarting(false);
      await onRefresh();
    }
  };

  return (
    <SettingsGroup title={t("computer.permissionTitle")}>
      {mac ? (
        <>
          {/* Screen Recording first, matching the order the flow collects them in. */}
          <PermissionRow
            label={t("computer.screenRecording")}
            description={t("computer.screenRecordingDesc")}
            granted={status?.screenRecording === true}
            current={flow.active && flow.permission === "screenRecording"}
          />
          <PermissionRow
            label={t("computer.accessibility")}
            description={t("computer.accessibilityDesc")}
            granted={status?.accessibility === true}
            current={flow.active && flow.permission === "accessibility"}
          />
          {status?.ready ? null : (
            <div className="space-y-2 px-4 py-4">
              <div className="flex items-center gap-2">
                {flow.active ? (
                  <>
                    <Button size="sm" variant="outline" onClick={() => void window.fastvibe.computer.cancelGrantFlow()}>
                      {t("computer.cancelFlow")}
                    </Button>
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Spinner className="size-3.5" />
                      {t("computer.flowProgress", { step: flow.step, total: flow.total })}
                    </span>
                  </>
                ) : (
                  <>
                    <Button size="sm" disabled={starting} onClick={() => void start()}>
                      {starting ? <Spinner className="size-3.5" /> : null}
                      {t("computer.grant")}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void onRefresh()}>
                      {t("computer.recheck")}
                    </Button>
                  </>
                )}
              </div>
              <p className="text-xs leading-4 text-muted-foreground">
                {flow.active ? t("computer.flowHint") : t("computer.grantHint")}
              </p>
            </div>
          )}
        </>
      ) : (
        <div className="px-4 py-4 text-sm text-muted-foreground">
          {status?.platform === "win32" ? t("computer.windowsNote") : t("computer.linuxNote")}
        </div>
      )}
    </SettingsGroup>
  );
}

/**
 * One permission and its state.
 *
 * `current` marks the step the flow is waiting on, so the row and the floating panel
 * agree about which list the user is being asked to drag into — the panel is over
 * System Settings, and this pane is the other half of the same instruction.
 */
function PermissionRow({
  label,
  description,
  granted,
  current,
}: {
  label: string;
  description: string;
  granted: boolean;
  current: boolean;
}): JSX.Element {
  const { t } = useTranslation("settings");
  return (
    <SettingsRow
      title={label}
      description={description}
      control={
        <Badge
          variant={granted ? "secondary" : "outline"}
          className={cn(
            "gap-1",
            granted ? "text-emerald-600 dark:text-emerald-400" : current ? "text-foreground" : "text-muted-foreground",
          )}
        >
          <HugeiconsIcon
            strokeWidth={2}
            icon={granted ? CheckmarkCircle02Icon : current ? DragDropIcon : Alert02Icon}
            className="size-3"
          />
          {granted ? t("computer.granted") : current ? t("computer.dragNow") : t("computer.notGranted")}
        </Badge>
      }
    />
  );
}

