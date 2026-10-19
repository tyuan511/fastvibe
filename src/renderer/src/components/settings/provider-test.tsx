import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { Activity02Icon, Loading03Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { i18n } from "@/lib/i18n";
import type { ProviderConfig, ProviderModel } from "@shared/types";
import type { ProviderTestResult } from "@shared/provider-test";

/**
 * The model check used to be its own 模型自检 group with a model picker in it. The picker
 * was a second copy of the list right below the list, and it could only ever ask about one
 * model at a time — so comparing two models on one gateway meant check, read, re-pick,
 * check again, with the previous answer gone before the next one arrived. The verdict
 * belongs on the row it describes, next to the protocol chip and the context size that
 * already say what this model is configured as.
 */

export type ModelCheckState = { running: boolean; result: ProviderTestResult | null };

const STATUS_CLASS: Record<ProviderTestResult["status"], string> = {
  passed: "text-success",
  partial: "text-warning",
  failed: "text-destructive",
};

/**
 * One check per model, kept while the pane shows the same provider.
 *
 * The request is a live round trip to the provider, so its answer can land after the pane
 * has moved on. `epoch` invalidates everything in flight when the provider or its endpoint
 * changes; the per-model ticket invalidates only the model that was asked again.
 */
export function useModelChecks(provider: ProviderConfig): {
  checks: Record<string, ModelCheckState>;
  run: (model: ProviderModel) => void;
} {
  const [checks, setChecks] = useState<Record<string, ModelCheckState>>({});
  const epoch = useRef(0);
  const tickets = useRef(new Map<string, number>());
  // A new object identity for the same configuration is a settings refresh, not a change,
  // and must not throw away verdicts the user just paid for.
  const config = `${provider.id}|${provider.baseUrl}|${provider.api}|${provider.hasKey}|${provider.hasOAuth}`;
  useEffect(() => {
    epoch.current += 1;
    tickets.current = new Map();
    setChecks({});
    return () => {
      epoch.current += 1;
    };
  }, [config]);

  const write = useCallback((modelId: string, next: ModelCheckState, ticket: number, startedIn: number): void => {
    if (startedIn !== epoch.current || tickets.current.get(modelId) !== ticket) return;
    setChecks((prev) => ({ ...prev, [modelId]: next }));
  }, []);

  const run = useCallback(
    (model: ProviderModel): void => {
      const ticket = (tickets.current.get(model.id) ?? 0) + 1;
      tickets.current.set(model.id, ticket);
      const startedIn = epoch.current;
      write(model.id, { running: true, result: null }, ticket, startedIn);
      window.fastvibe.providers
        .test(provider.id, model.id)
        .then(
          (result) => write(model.id, { running: false, result }, ticket, startedIn),
          // The call itself never reached the engine — no answer to report, so the row says
          // what the user can act on: the network, not a model that failed to reply.
          () =>
            write(
              model.id,
              {
                running: false,
                result: { model: model.id, api: "", status: "failed", tools: "not-tested", elapsedMs: 0, errorCode: "network" },
              },
              ticket,
              startedIn,
            ),
        );
    },
    [provider.id, write],
  );

  return { checks, run };
}

/** The row's rightmost control: run the check, and see the last verdict's colour. */
export function ModelCheckButton({
  state,
  disabled,
  onRun,
}: {
  state?: ModelCheckState;
  disabled: boolean;
  onRun: () => void;
}): JSX.Element {
  const running = state?.running === true;
  const result = state?.result ?? null;
  const label = i18n.t(running ? "settings:providerTest.checking" : "settings:providerTest.check");
  return (
    <Button
      size="icon-xs"
      variant="ghost"
      disabled={disabled || running}
      onClick={onRun}
      aria-label={label}
      title={label}
      className={cn(!running && result ? STATUS_CLASS[result.status] : "text-muted-foreground")}
    >
      <HugeiconsIcon strokeWidth={2} icon={running ? Loading03Icon : Activity02Icon} className={running ? "size-3.5 animate-spin" : "size-3.5"} />
    </Button>
  );
}

/** What the check actually said, tucked under the row it belongs to. */
export function ModelCheckDetails({
  result,
  onEdit,
}: {
  result: ProviderTestResult;
  onEdit: () => void;
}): JSX.Element {
  const { t } = useTranslation("settings");
  // 「回答与工具调用均正常」 already says the tools passed, so the numbers are the only
  // extra facts worth a line. A run that did *not* pass has something to tell the user to
  // do, and that goes below rather than joined into the numbers with a separator.
  const facts = [
    result.api ? t("providerTest.protocol", { api: result.api }) : "",
    result.firstTokenMs !== undefined ? t("providerTest.firstToken", { ms: result.firstTokenMs }) : "",
  ].filter(Boolean);
  const advice = result.errorCode
    ? t(`providerTest.errors.${result.errorCode}`)
    : result.tools === "unconfirmed"
      ? t("providerTest.tools.unconfirmed")
      : "";
  return (
    <div role="status" className="space-y-1 border-t border-dashed border-border/70 bg-muted/30 px-2 py-1.5 text-xs">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className={STATUS_CLASS[result.status]}>{t(`providerTest.${result.status}`)}</span>
        {facts.length ? <span className="text-muted-foreground">{facts.join(" · ")}</span> : null}
        {result.status !== "passed" ? (
          <Button size="xs" variant="outline" onClick={onEdit}>
            {t("providerTest.edit")}
          </Button>
        ) : null}
      </div>
      {advice ? <p className="text-muted-foreground">{advice}</p> : null}
    </div>
  );
}
