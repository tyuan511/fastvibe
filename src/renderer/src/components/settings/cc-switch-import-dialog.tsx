import { useEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  ArrowDown01Icon,
  ArrowLeft01Icon,
  BoxesIcon,
  Delete02Icon,
  Download01Icon,
  Loading03Icon,
  PencilEdit02Icon,
  CircleQuestionMarkIcon,
  DragDropVerticalIcon,
  RefreshIcon,
  Search01Icon,
  Tick02Icon,
  ViewIcon,
  ViewOffSlashIcon,
} from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cleanError } from "@/lib/ipc-error";
import { cn } from "@/lib/utils";
import { PROVIDER_APIS, type CcSwitchCandidate, type CcSwitchScan, type EngineModel, type FastVibeModel, type GatewayKind, type Project, type ProjectModelDefault, type NativeProviderConfig, type ProviderApi, type ProviderConfig, type ProviderModel } from "@shared/types";

export function CcSwitchImportDialog({
  open,
  onClose,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  onImported: (next: ProviderConfig[]) => Promise<void>;
}): JSX.Element {
  const { t } = useTranslation("settings");
  const [scan, setScan] = useState<CcSwitchScan | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setScan(null);
    void window.fastvibe.providers
      .scanCcSwitch()
      .then((next) => {
        if (cancelled) return;
        setScan(next);
        setSelected(new Set(next.candidates.filter((item) => item.importable).map((item) => item.id)));
      })
      .catch((err: unknown) => {
        if (!cancelled) toast.error(cleanError(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const importable = scan?.candidates.filter((item) => item.importable) ?? [];
  const chosen = importable.filter((item) => selected.has(item.id));

  function toggle(item: CcSwitchCandidate): void {
    if (!item.importable) return;
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(item.id)) next.delete(item.id);
      else next.add(item.id);
      return next;
    });
  }

  async function importSelected(): Promise<void> {
    if (chosen.length === 0) return;
    setBusy(true);
    try {
      await onImported(await window.fastvibe.providers.importCcSwitch(chosen.map((item) => item.id)));
    } catch (err) {
      toast.error(cleanError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("providers.ccSwitchTitle")}</DialogTitle>
          <DialogDescription>
            {t("providers.ccSwitchDesc")}
          </DialogDescription>
        </DialogHeader>
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <HugeiconsIcon strokeWidth={2} icon={Loading03Icon} className="size-4 animate-spin" />
            {t("providers.ccSwitchReading")}
          </div>
        ) : !scan?.found ? (
          <p className="py-6 text-sm text-muted-foreground">
            {t("providers.ccSwitchMissing", { path: scan?.path || "~/.cc-switch/cc-switch.db" })}
          </p>
        ) : scan.candidates.length === 0 ? (
          <p className="py-6 text-sm text-muted-foreground">
            {t("providers.ccSwitchEmpty")}
          </p>
        ) : (
          <div className="max-h-72 overflow-y-auto">
            {scan.candidates.map((item) => (
              <button
                key={item.id}
                type="button"
                disabled={!item.importable}
                className={cn(
                  "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left",
                  item.importable ? "hover:bg-muted" : "opacity-55",
                  selected.has(item.id) && item.importable && "bg-muted",
                )}
                onClick={() => toggle(item)}
              >
                <span
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded-[4px] border",
                    selected.has(item.id) && item.importable ? "border-primary bg-primary text-primary-foreground" : "border-input",
                  )}
                >
                  {selected.has(item.id) && item.importable ? (
                    <HugeiconsIcon strokeWidth={2} icon={Tick02Icon} className="size-3" />
                  ) : null}
                </span>
                <span className="min-w-0 flex-1 overflow-hidden">
                  <span className="block truncate text-sm">{item.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {item.appLabel}
                    {item.baseUrl ? ` · ${item.baseUrl.replace(/^https?:\/\//, "")}` : ""}
                    {item.modelCount ? ` · ${t("providers.modelCount", { count: item.modelCount })}` : ""}
                  </span>
                </span>
                {item.reason ? <span className="shrink-0 text-xs text-muted-foreground">{item.reason}</span> : null}
              </button>
            ))}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t("providers.cancel")}
          </Button>
          <Button disabled={busy || chosen.length === 0} onClick={() => void importSelected()}>
            {busy ? <HugeiconsIcon strokeWidth={2} icon={Loading03Icon} className="size-3.5 animate-spin" /> : null}
            {t("providers.importCount", { count: chosen.length > 0 ? chosen.length : "" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
