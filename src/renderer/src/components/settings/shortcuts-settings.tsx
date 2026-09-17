import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { RotateCcwIcon, Search01Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/icon-button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Kbd } from "@/components/ui/kbd";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  SHORTCUT_CATALOG,
  SHORTCUT_GROUPS,
  beginShortcutRecording,
  chordFromEvent,
  chordUsable,
  defaultBinding,
  endShortcutRecording,
  formatChord,
  resolveBinding,
  serializeChord,
  shortcutDescription,
  shortcutGroupLabel,
  shortcutLabel,
  type ShortcutId,
  type ShortcutOverrides,
} from "@/lib/shortcuts";
import { useSettingsStore } from "@/stores/settings";

export function ShortcutsSettings(): JSX.Element {
  const { t, i18n } = useTranslation("settings");
  const settings = useSettingsStore((state) => state.settings);
  const update = useSettingsStore((state) => state.update);
  const [query, setQuery] = useState("");
  const [recording, setRecording] = useState<ShortcutId | null>(null);
  const [error, setError] = useState<string | null>(null);

  const overrides = settings.shortcuts;
  const needle = query.trim().toLowerCase();
  const customized = Boolean(overrides && Object.keys(overrides).length > 0);

  const grouped = useMemo(() => {
    return SHORTCUT_GROUPS.map((group) => ({
      id: group,
      label: shortcutGroupLabel(group),
      items: SHORTCUT_CATALOG.filter((item) => {
        if (item.group !== group) return false;
        if (!needle) return true;
        const haystack = `${shortcutLabel(item.id)} ${shortcutDescription(item.id) ?? ""} ${item.id}`;
        return haystack.toLowerCase().includes(needle);
      }),
    })).filter((group) => group.items.length > 0);
  }, [needle, i18n.language]);

  function write(next: ShortcutOverrides | undefined): void {
    update({ shortcuts: next && Object.keys(next).length > 0 ? next : undefined });
  }

  function setBinding(id: ShortcutId, chord: string | null | undefined): void {
    const current: ShortcutOverrides = { ...overrides };
    const fallback = defaultBinding(id);
    if (chord === undefined || chord === fallback) delete current[id];
    else current[id] = chord;
    if (chord) {
      for (const item of SHORTCUT_CATALOG) {
        if (item.id === id) continue;
        if (resolveBinding(item.id, current) === chord) current[item.id] = null;
      }
    }
    write(current);
  }

  function resetAll(): void {
    setRecording(null);
    setError(null);
    write(undefined);
  }

  return (
    <div className="space-y-6">
      <InputGroup>
        <InputGroupAddon>
          <HugeiconsIcon strokeWidth={2} icon={Search01Icon} />
        </InputGroupAddon>
        <InputGroupInput
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("shortcuts.search")}
        />
      </InputGroup>

      <section className="space-y-2">
        <h3 className="px-1 text-sm font-medium">{t("shortcuts.send")}</h3>
        <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          <div className="flex items-center justify-between gap-6 px-4 py-3">
            <div className="min-w-0">
              <Label className="text-sm font-medium">{t("shortcuts.sendOnEnter")}</Label>
              <p className="mt-0.5 text-xs leading-4 text-muted-foreground">{t("shortcuts.sendOnEnterDesc")}</p>
            </div>
            <Switch
              checked={settings.sendOnEnter}
              onCheckedChange={(checked) => update({ sendOnEnter: checked })}
            />
          </div>
        </div>
      </section>

      {grouped.length === 0 ? (
        <p className="px-1 text-sm text-muted-foreground">{t("shortcuts.none")}</p>
      ) : (
        grouped.map((group) => (
          <section key={group.id} className="space-y-2">
            <h3 className="px-1 text-sm font-medium">{group.label}</h3>
            <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
              {group.items.map((item) => {
                const binding = resolveBinding(item.id, overrides);
                const isCustom = resolveBinding(item.id, overrides) !== item.default;
                const description = shortcutDescription(item.id);
                return (
                  <div key={item.id} className="flex items-center justify-between gap-6 px-4 py-3">
                    <div className="min-w-0">
                      <Label className="text-sm font-medium">{shortcutLabel(item.id)}</Label>
                      {recording === item.id ? (
                        <p className={cn("mt-0.5 text-xs leading-4", error ? "text-destructive" : "text-muted-foreground")}>
                          {error ?? t("shortcuts.recordingHint")}
                        </p>
                      ) : description ? (
                        <p className="mt-0.5 text-xs leading-4 text-muted-foreground">{description}</p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {isCustom ? (
                        <IconButton
                          size="icon-xs"
                          variant="ghost"
                          label={t("shortcuts.restoreDefault")}
                          className="text-muted-foreground"
                          onClick={() => {
                            if (recording === item.id) setRecording(null);
                            setBinding(item.id, undefined);
                          }}
                        >
                          <HugeiconsIcon strokeWidth={2} icon={RotateCcwIcon} />
                        </IconButton>
                      ) : null}
                      <ShortcutButton
                        binding={binding}
                        recording={recording === item.id}
                        onStart={() => {
                          setError(null);
                          setRecording(item.id);
                        }}
                        onCancel={() => {
                          setError(null);
                          setRecording(null);
                        }}
                        onClear={() => {
                          setError(null);
                          setRecording(null);
                          setBinding(item.id, null);
                        }}
                        onBind={(chord) => {
                          setError(null);
                          setRecording(null);
                          setBinding(item.id, chord);
                        }}
                        onReject={(message) => setError(message)}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ))
      )}

      <Button variant="outline" size="sm" disabled={!customized} onClick={resetAll}>
        <HugeiconsIcon strokeWidth={2} icon={RotateCcwIcon} />
        {t("shortcuts.restoreAll")}
      </Button>
    </div>
  );
}

function ShortcutButton({
  binding,
  recording,
  onStart,
  onCancel,
  onClear,
  onBind,
  onReject,
}: {
  binding: string | null;
  recording: boolean;
  onStart: () => void;
  onCancel: () => void;
  onClear: () => void;
  onBind: (chord: string) => void;
  onReject: (message: string) => void;
}): JSX.Element {
  const { t } = useTranslation("settings");
  const onCancelRef = useRef(onCancel);
  const onClearRef = useRef(onClear);
  const onBindRef = useRef(onBind);
  const onRejectRef = useRef(onReject);
  onCancelRef.current = onCancel;
  onClearRef.current = onClear;
  onBindRef.current = onBind;
  onRejectRef.current = onReject;

  useEffect(() => {
    if (!recording) return;
    beginShortcutRecording();
    function onKey(event: KeyboardEvent): void {
      if (event.repeat || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        onCancelRef.current();
        return;
      }
      if (event.key === "Backspace" || event.key === "Delete") {
        onClearRef.current();
        return;
      }
      const chord = chordFromEvent(event);
      if (!chord) return;
      const reason = chordUsable(chord);
      if (reason) {
        onRejectRef.current(reason);
        return;
      }
      onBindRef.current(serializeChord(chord));
    }
    window.addEventListener("keydown", onKey, true);
    return () => {
      endShortcutRecording();
      window.removeEventListener("keydown", onKey, true);
    };
  }, [recording]);

  return (
    <Button
      type="button"
      size="sm"
      variant={recording ? "secondary" : "outline"}
      data-shortcut-recording={recording ? "" : undefined}
      className={cn("min-w-24 justify-center px-2 font-normal", recording && "ring-3 ring-ring/50")}
      aria-label={recording ? t("shortcuts.recording") : binding ? t("shortcuts.chord", { chord: formatChord(binding) }) : t("shortcuts.unset")}
      onClick={() => (recording ? onCancel() : onStart())}
    >
      {recording ? (
        <span className="text-xs text-muted-foreground">{t("shortcuts.press")}</span>
      ) : binding ? (
        <Kbd>{formatChord(binding)}</Kbd>
      ) : (
        <span className="text-xs text-muted-foreground">{t("shortcuts.notSet")}</span>
      )}
    </Button>
  );
}
