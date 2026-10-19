import { useEffect, useRef, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { AlertCircleIcon, CheckmarkCircle02Icon, Loading03Icon, Pulse01Icon } from "@hugeicons/core-free-icons";
import { toast } from "sonner";
import { IconButton } from "@/components/icon-button";
import { cn } from "@/lib/utils";
import type { ProviderConfig, ProviderModel } from "@shared/types";
import type { ProviderTestResult } from "@shared/provider-test";

/** A model's check lives on its row; results use the icon's tooltip and a toast. */
export function ProviderTest({ provider, model, disabled, onEditModel }: {
  provider: ProviderConfig;
  model: ProviderModel;
  disabled?: boolean;
  onEditModel: () => void;
}): JSX.Element {
  const { t } = useTranslation("settings");
  const [result, setResult] = useState<ProviderTestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    setResult(null);
    setBusy(false);
    return () => { generation.current++; };
  }, [provider, model]);

  function resultDetails(next: ProviderTestResult): string {
    return [
      t(`providerTest.${next.status}`),
      next.api ? t("providerTest.protocol", { api: next.api }) : null,
      next.firstTokenMs !== undefined ? t("providerTest.firstToken", { ms: next.firstTokenMs }) : null,
      t(`providerTest.tools.${next.tools}`),
      next.errorCode ? t(`providerTest.errors.${next.errorCode}`) : null,
    ].filter(Boolean).join(" · ");
  }

  async function run(): Promise<void> {
    if (busy) return;
    const ticket = ++generation.current;
    setBusy(true);
    setResult(null);
    let next: ProviderTestResult;
    try {
      next = await window.fastvibe.providers.test(provider.id, model.id);
    } catch {
      next = { model: model.id, api: "", status: "failed", tools: "not-tested", elapsedMs: 0, errorCode: "network" };
    }
    if (ticket !== generation.current) return;
    setResult(next);
    setBusy(false);
    const notify = next.status === "passed" ? toast.success : next.status === "partial" ? toast.warning : toast.error;
    notify(model.name || model.id, {
      description: resultDetails(next),
      action: next.status !== "passed" ? { label: t("providerTest.edit"), onClick: onEditModel } : undefined,
    });
  }

  const label = t(busy ? "providerTest.running" : "providerTest.runModel", { name: model.name || model.id });
  return (
    <IconButton
      size="icon-xs"
      variant="ghost"
      label={result ? `${label} · ${resultDetails(result)}` : `${label} · ${t("providerTest.description")}`}
      aria-label={label}
      disabled={disabled || busy || (!provider.hasKey && !provider.hasOAuth)}
      onClick={() => void run()}
      className={cn("text-muted-foreground", result?.status === "passed" && "text-success", result?.status === "partial" && "text-warning", result?.status === "failed" && "text-destructive")}
    >
      <HugeiconsIcon strokeWidth={2} icon={busy ? Loading03Icon : result?.status === "passed" ? CheckmarkCircle02Icon : result ? AlertCircleIcon : Pulse01Icon} className={busy ? "animate-spin" : undefined} />
    </IconButton>
  );
}
