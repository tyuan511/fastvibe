import { useEffect, useRef, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { Delete02Icon, PencilEdit02Icon } from "@hugeicons/core-free-icons";
import { toast } from "sonner";
import { IconButton } from "@/components/icon-button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cleanError } from "@/lib/ipc-error";
import { providerLabel } from "@/lib/provider-label";
import type { ProviderConfig } from "@shared/types";

/** Inline name editing stays separate from the header's expand/drag trigger. */
export function ProviderCardName({ provider, disabled, onRename }: {
  provider: ProviderConfig;
  disabled: boolean;
  onRename: (name: string) => Promise<void>;
}): JSX.Element {
  const { t } = useTranslation("settings");
  const [name, setName] = useState(provider.name);
  const [editingName, setEditingName] = useState(false);
  const [pending, setPending] = useState(false);
  const cancelled = useRef(false);
  useEffect(() => {
    setName(provider.name);
    setEditingName(false);
  }, [provider.id, provider.name]);

  async function saveName(): Promise<void> {
    if (cancelled.current || pending) return;
    const next = name.trim();
    setEditingName(false);
    if (!next || next === provider.name) { setName(provider.name); return; }
    setPending(true);
    try {
      await onRename(next);
    } catch (error) {
      toast.error(cleanError(error));
      setEditingName(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <span className="flex min-w-0 max-w-full items-center gap-1">
      {editingName ? (
        <Input
          autoFocus
          value={name}
          disabled={disabled || pending}
          className="pointer-events-auto h-6 w-48 min-w-0 max-w-full py-0 text-sm font-medium"
          aria-label={t("providers.name")}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => void saveName()}
          onKeyDown={(event) => {
            if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              cancelled.current = true;
              setName(provider.name);
              setEditingName(false);
            }
          }}
        />
      ) : (
        <>
          <span className="truncate">{providerLabel(provider.name || provider.id)}</span>
          {provider.kind === "custom" ? (
            <IconButton size="icon-xs" variant="ghost" label={t("providers.rename")} disabled={disabled || pending}
              className="pointer-events-auto shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/provider-header:opacity-100 group-focus-within/provider-header:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
              onClick={() => { cancelled.current = false; setEditingName(true); }}>
              <HugeiconsIcon strokeWidth={2} icon={PencilEdit02Icon} />
            </IconButton>
          ) : null}
        </>
      )}
    </span>
  );
}

/** Available on a collapsed card too, outside its expand/drag trigger. */
export function ProviderCardActions({ provider, disabled, onUpdate, onRemove }: {
  provider: ProviderConfig;
  disabled: boolean;
  onUpdate: (patch: { enabled: boolean }) => Promise<void>;
  onRemove: () => Promise<void>;
}): JSX.Element {
  const { t } = useTranslation("settings");
  const [pending, setPending] = useState(false);

  async function run(action: () => Promise<void>): Promise<void> {
    setPending(true);
    try {
      await action();
    } catch (error) {
      toast.error(cleanError(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex max-w-full items-center justify-end gap-2 text-muted-foreground">
      <IconButton size="icon-xs" variant="ghost" label={t("providers.delete")} disabled={disabled || pending} onClick={() => void run(onRemove)}>
        <HugeiconsIcon strokeWidth={2} icon={Delete02Icon} />
      </IconButton>
      <Switch size="sm" checked={provider.enabled} disabled={disabled || pending} aria-label={t("providers.enableProvider", { name: providerLabel(provider.name || provider.id) })} onCheckedChange={(enabled) => void run(() => onUpdate({ enabled }))} />
    </div>
  );
}
