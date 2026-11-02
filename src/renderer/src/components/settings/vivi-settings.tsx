import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { Alert02Icon, Refresh01Icon } from "@hugeicons/core-free-icons";
import type { FastVibeApi } from "@shared/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { FastVibeMascot } from "@/components/fastvibe-mascot";
import { cn } from "@/lib/utils";
import {
  DEFAULT_VIVI_SETTINGS,
  VIVI_PALETTES,
  type ViviPalette,
  type ViviSettings as SharedViviSettings,
  type ViviSnapshot,
} from "@shared/vivi";
import { SettingsGroup, SettingsRow } from "./settings-group";

const PALETTE_IDS = Object.keys(VIVI_PALETTES) as ViviPalette[];
const SAVE_DEBOUNCE_MS = 160;
const REQUEST_TIMEOUT_MS = 8_000;

type MutableSetting = keyof SharedViviSettings;

type ViviApi = FastVibeApi["vivi"];

function viviApi(): ViviApi {
  return window.fastvibe.vivi;
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function errorText(t: (key: string) => string, kind: "load" | "save"): string {
  return t(`vivi.${kind}Failed`);
}

export function ViviSettings(): JSX.Element {
  const { t } = useTranslation("settings");
  const api = useMemo(viviApi, []);
  const [settings, setSettings] = useState<SharedViviSettings | null>(null);
  const [snapshot, setSnapshot] = useState<ViviSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const serverSettingsRef = useRef<SharedViviSettings>({ ...DEFAULT_VIVI_SETTINGS });
  const pendingValuesRef = useRef<Partial<SharedViviSettings>>({});
  const pendingVersionsRef = useRef<Partial<Record<MutableSetting, number>>>({});
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const failedPatchRef = useRef<Partial<SharedViviSettings> | null>(null);
  const sliderTimersRef = useRef<Partial<Record<"scale" | "opacity", ReturnType<typeof setTimeout>>>>({});
  const refreshRef = useRef<() => Promise<void>>(() => Promise.resolve());

  const mergePending = useCallback((next: SharedViviSettings): SharedViviSettings => {
    return { ...next, ...pendingValuesRef.current };
  }, []);

  const applySnapshot = useCallback((next: ViviSnapshot): void => {
    if (!mountedRef.current) return;
    serverSettingsRef.current = { ...next.settings };
    setSnapshot(next);
    setSettings(mergePending(next.settings));
    setError(next.error ? t("vivi.runtimeError") : null);
  }, [mergePending, t]);

  const enqueue = useCallback(<T,>(operation: () => Promise<T>): Promise<T> => {
    const next = saveQueueRef.current.then(operation, operation);
    saveQueueRef.current = next.then(() => undefined, () => undefined);
    return next;
  }, []);

  const markPending = useCallback((patch: Partial<SharedViviSettings>): Record<string, number> => {
    const versions: Record<string, number> = {};
    for (const [key, value] of Object.entries(patch) as Array<[MutableSetting, SharedViviSettings[MutableSetting]]>) {
      pendingValuesRef.current[key] = value as never;
      const version = (pendingVersionsRef.current[key] ?? 0) + 1;
      pendingVersionsRef.current[key] = version;
      versions[key] = version;
    }
    return versions;
  }, []);

  const finishPending = useCallback((patch: Partial<SharedViviSettings>, versions: Record<string, number>): void => {
    for (const [key, value] of Object.entries(patch) as Array<[MutableSetting, SharedViviSettings[MutableSetting]]>) {
      if (pendingVersionsRef.current[key] !== versions[key] || pendingValuesRef.current[key] !== value) continue;
      delete pendingValuesRef.current[key];
    }
  }, []);

  const queueSettingsPatch = useCallback((patch: Partial<SharedViviSettings>, alreadyMarked = false): void => {
    const versions = alreadyMarked ? Object.fromEntries(
      Object.keys(patch).map((key) => [key, pendingVersionsRef.current[key as MutableSetting] ?? 0]),
    ) : markPending(patch);

    const operation = enqueue(async () => {
      try {
        const updated = await api.setSettings(patch);
        if (!mountedRef.current) return;
        serverSettingsRef.current = { ...updated };
        finishPending(patch, versions);
        failedPatchRef.current = null;
        setSettings(mergePending(updated));
        setError(null);
      } catch {
        if (!mountedRef.current) return;
        finishPending(patch, versions);
        failedPatchRef.current = patch;
        setSettings(mergePending(serverSettingsRef.current));
        setError(errorText(t, "save"));
        throw new Error("vivi-settings-save-failed");
      }
    });
    void operation.catch(() => undefined);
  }, [api, enqueue, finishPending, markPending, mergePending, t]);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const [currentSettings, next] = await withTimeout(Promise.all([api.getSettings(), api.getSnapshot()]), REQUEST_TIMEOUT_MS);
      if (!mountedRef.current) return;
      const complete = { ...next, settings: next.settings ?? currentSettings };
      serverSettingsRef.current = { ...complete.settings };
      applySnapshot(complete);
    } catch {
      if (mountedRef.current) setError(errorText(t, "load"));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [api, applySnapshot, t]);

  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    mountedRef.current = true;
    const unsubscribe = api.onChanged(applySnapshot);
    void refresh();
    return () => {
      mountedRef.current = false;
      unsubscribe();
      for (const timer of Object.values(sliderTimersRef.current)) {
        if (timer) clearTimeout(timer);
      }
    };
  }, [api, applySnapshot, refresh]);

  const updateSetting = useCallback(<K extends MutableSetting>(key: K, value: SharedViviSettings[K]): void => {
    const patch = { [key]: value } as Pick<SharedViviSettings, K>;
    setSettings((current) => current ? { ...current, ...patch } : current);
    queueSettingsPatch(patch);
  }, [queueSettingsPatch]);

  const updateSlider = useCallback((key: "scale" | "opacity", value: number): void => {
    const patch = { [key]: value } as Pick<SharedViviSettings, typeof key>;
    setSettings((current) => current ? { ...current, ...patch } : current);
    const versions = markPending(patch);
    const previous = sliderTimersRef.current[key];
    if (previous) clearTimeout(previous);
    sliderTimersRef.current[key] = setTimeout(() => {
      delete sliderTimersRef.current[key];
      const currentVersion = pendingVersionsRef.current[key];
      if (currentVersion !== versions[key]) return;
      queueSettingsPatch(patch, true);
    }, SAVE_DEBOUNCE_MS);
  }, [markPending, queueSettingsPatch]);

  const retry = useCallback((): void => {
    const failed = failedPatchRef.current;
    failedPatchRef.current = null;
    if (failed) {
      queueSettingsPatch(failed);
    } else {
      void refreshRef.current();
    }
  }, [queueSettingsPatch]);

  if (loading && !settings) {
    return (
      <div className="flex min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground">
        <Spinner className="size-4" />
        {t("vivi.loading")}
      </div>
    );
  }

  if (!settings) {
    return (
      <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-5 text-sm">
        <div className="flex items-center gap-2 font-medium text-destructive">
          <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} className="size-4" />
          {error ?? t("vivi.loadFailed")}
        </div>
        <Button className="mt-4" size="sm" variant="outline" onClick={retry}>
          <HugeiconsIcon icon={Refresh01Icon} strokeWidth={2} className="size-4" />
          {t("vivi.retry")}
        </Button>
      </div>
    );
  }

  const actors = snapshot?.actors ?? [];
  const primaryActor = actors[0];

  return (
    <div className="space-y-6">
      {error ? (
        <div className="flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm">
          <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div className="min-w-0 flex-1">
            <p className="font-medium text-destructive">{error}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{t("vivi.errorHint")}</p>
          </div>
          <Button size="sm" variant="outline" onClick={retry} disabled={loading}>
            {loading ? <Spinner className="size-3.5" /> : <HugeiconsIcon icon={Refresh01Icon} strokeWidth={2} className="size-3.5" />}
            {t("vivi.retry")}
          </Button>
        </div>
      ) : null}

      <section className="overflow-hidden rounded-2xl border border-border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-5 bg-gradient-to-br from-primary/10 via-card to-card px-5 py-5 md:px-6">
          <div className="flex min-w-0 items-center gap-4">
            <div className="flex size-24 shrink-0 items-center justify-center rounded-2xl bg-background/70 ring-1 ring-border/70">
              <FastVibeMascot
                status={primaryActor?.mood ?? "idle"}
                palette={primaryActor?.palette ?? settings.palette}
                size="size-20"
                shadow
                label={t("vivi.title")}
              />
            </div>
            <div className="min-w-0">
              <h3 className="text-lg font-semibold tracking-tight">{t("vivi.title")}</h3>
              <p className="mt-1 max-w-xl text-sm leading-5 text-muted-foreground">{t("vivi.description")}</p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Badge variant={settings.enabled ? "default" : "secondary"}>{settings.enabled ? t("vivi.enabled") : t("vivi.disabled")}</Badge>
              </div>
            </div>
          </div>
          <Switch
            checked={settings.enabled}
            onCheckedChange={(checked) => updateSetting("enabled", checked)}
            aria-label={t("vivi.enabled")}
          />
        </div>
      </section>

      <SettingsGroup title={t("vivi.appearance")}>
        <SettingsRow
          title={t("vivi.palette")}
          description={t("vivi.paletteDesc")}
          control={
            <div className="flex items-center gap-1">
              {PALETTE_IDS.map((palette) => {
                const selected = settings.palette === palette;
                const info = VIVI_PALETTES[palette];
                const name = t(`vivi.paletteNames.${palette}`);
                return (
                  <Button
                    key={palette}
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className={cn("size-7 rounded-full p-0", selected && "ring-2 ring-primary ring-offset-2 ring-offset-background")}
                    aria-pressed={selected}
                    aria-label={name}
                    title={name}
                    onClick={() => updateSetting("palette", palette)}
                  >
                    <span
                      className="size-5 rounded-full ring-1 ring-black/10"
                      style={{ backgroundImage: `linear-gradient(135deg, ${info.stops[0]}, ${info.stops[1]} 52%, ${info.stops[2]})` }}
                    />
                  </Button>
                );
              })}
            </div>
          }
        />
        <SettingsRow
          title={t("vivi.scale")}
          description={t("vivi.scaleDesc")}
          control={
            <div className="w-48 space-y-2">
              <div className="flex justify-end text-xs tabular-nums text-muted-foreground">{Math.round(settings.scale * 100)}%</div>
              <Slider
                min={0.3}
                max={1.5}
                step={0.05}
                value={[settings.scale]}
                onValueChange={(value) => {
                  const next = Array.isArray(value) ? value[0] : value;
                  if (typeof next === "number") updateSlider("scale", next);
                }}
                aria-label={t("vivi.scale")}
              />
            </div>
          }
        />
        <SettingsRow
          title={t("vivi.opacity")}
          description={t("vivi.opacityDesc")}
          control={
            <div className="w-48 space-y-2">
              <div className="flex justify-end text-xs tabular-nums text-muted-foreground">{Math.round(settings.opacity * 100)}%</div>
              <Slider
                min={0.3}
                max={1}
                step={0.05}
                value={[settings.opacity]}
                onValueChange={(value) => {
                  const next = Array.isArray(value) ? value[0] : value;
                  if (typeof next === "number") updateSlider("opacity", next);
                }}
                aria-label={t("vivi.opacity")}
              />
            </div>
          }
        />
      </SettingsGroup>

      <SettingsGroup title={t("vivi.behavior")}>
        <SettingsRow
          title={t("vivi.messages")}
          description={t("vivi.messagesDesc")}
          control={
            <Switch
              checked={settings.messages}
              onCheckedChange={(checked) => updateSetting("messages", checked)}
              aria-label={t("vivi.messages")}
            />
          }
        />
      </SettingsGroup>
    </div>
  );
}
