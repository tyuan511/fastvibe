import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { Activity02Icon, Loading03Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { i18n } from "@/lib/i18n";
import type { ProviderConfig, ProviderModel } from "@shared/types";
import type { ProviderTestResult } from "@shared/provider-test";

/**
 * The check used to be its own 模型自检 group with a model picker in it; it then lived on the
 * row it describes, with the verdict written under that row. Both are gone: a verdict under
 * the row pushed everything below it down and stayed on screen long after it mattered, and
 * what it had to say is news — it belongs in a notice that shows up and leaves again. So the
 * row keeps only the control (visible while the pointer is on the row), and the answer is
 * reported as a toast.
 */

export type ModelCheckState = { running: boolean };

/**
 * One check per model, kept while the pane shows the same provider.
 *
 * The request is a live round trip to the provider, so its answer can land after the pane
 * has moved on. `epoch` invalidates everything in flight when the provider or its endpoint
 * changes; the per-model ticket invalidates only the model that was asked again.
 */
export function useModelChecks(
  provider: ProviderConfig,
  onEdit?: (model: ProviderModel) => void,
): {
  checks: Record<string, ModelCheckState>;
  run: (model: ProviderModel) => void;
} {
  const [checks, setChecks] = useState<Record<string, ModelCheckState>>({});
  const epoch = useRef(0);
  const tickets = useRef(new Map<string, number>());
  // A new object identity for the same configuration is a settings refresh, not a change,
  // and must not clear a run that is still in flight.
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
      write(model.id, { running: true }, ticket, startedIn);
      window.fastvibe.providers
        .test(provider.id, model.id)
        .then(
          (result) => {
            write(model.id, { running: false }, ticket, startedIn);
            notifyCheck(model, result, onEdit);
          },
          // The call itself never reached the engine — no answer to report, so the toast says
          // what the user can act on: the network, not a model that failed to reply.
          () => {
            write(model.id, { running: false }, ticket, startedIn);
            notifyCheck(
              model,
              { model: model.id, api: "", status: "failed", tools: "not-tested", elapsedMs: 0, errorCode: "network" },
              onEdit,
            );
          },
        );
    },
    [provider.id, write, onEdit],
  );

  return { checks, run };
}

/** What the check said, as a notice that shows up once and leaves again. */
function notifyCheck(
  model: ProviderModel,
  result: ProviderTestResult,
  onEdit?: (model: ProviderModel) => void,
): void {
  const t = i18n.t.bind(i18n);
  // 「回答与工具调用均正常」 already says the tools passed, so the numbers are the only extra
  // facts worth a line. A run that did *not* pass has something to tell the user to do, and
  // that goes on its own line rather than joined into the numbers with a separator.
  const facts = [
    result.api ? t("settings:providerTest.protocol", { api: result.api }) : "",
    result.firstTokenMs !== undefined ? t("settings:providerTest.firstToken", { ms: result.firstTokenMs }) : "",
  ].filter(Boolean) as string[];
  const advice = result.errorCode
    ? (t(`settings:providerTest.errors.${result.errorCode}`) as string)
    : result.tools === "unconfirmed"
      ? (t("settings:providerTest.tools.unconfirmed") as string)
      : "";
  const options = {
    // A verdict worth acting on stays up long enough to be read; a pass can leave sooner.
    duration: result.status === "passed" ? 4000 : 7000,
    description: facts.length || advice ? (
      <span className="flex flex-col gap-0.5">
        {facts.length ? <span>{facts.join(" · ")}</span> : null}
        {advice ? <span>{advice}</span> : null}
      </span>
    ) : undefined,
    // The dialog the removed inline button used to open, kept one step away.
    action:
      onEdit && result.status !== "passed"
        ? { label: t("settings:providerTest.edit") as string, onClick: () => onEdit(model) }
        : undefined,
  };
  const title = `${model.name || model.id} · ${t(`settings:providerTest.${result.status}`)}`;
  if (result.status === "passed") toast.success(title, options);
  else if (result.status === "partial") toast.warning(title, options);
  else toast.error(title, options);
}

/** The row's control: run the check, and spin while it is in flight. */
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
  const label = i18n.t(running ? "settings:providerTest.checking" : "settings:providerTest.check");
  return (
    <Button
      size="icon-xs"
      variant="ghost"
      disabled={disabled || running}
      onClick={onRun}
      aria-label={label}
      title={label}
      className="text-muted-foreground"
    >
      <HugeiconsIcon strokeWidth={2} icon={running ? Loading03Icon : Activity02Icon} className={running ? "size-3.5 animate-spin" : "size-3.5"} />
    </Button>
  );
}
