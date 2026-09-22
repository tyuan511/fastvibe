import { useEffect, useRef, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { Loading03Icon, RefreshIcon, Settings01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { cleanError } from "@/lib/ipc-error";
import { invokeIpc } from "@/lib/invoke-ipc";
import type { GatewayBalanceResult, ProviderConfig } from "@shared/types";
import { gatewayRowState } from "@/lib/gateway-row";

/**
 * The balance the provider's panel reports, and the credential that unlocks it.
 *
 * Sits on the provider's title row, so it is drawn as **a value, a refresh and at most
 * one more button**: the provider's own name is already beside it, the panel behind the
 * endpoint is a fact about the endpoint rather than about the provider, and the detail it
 * exposes (rate tiers, quota units, expiry) is the panel's job, not a settings row's.
 *
 * Three states, and the two that are not a balance both offer the action that fixes them:
 *
 * - **Not identified yet** — a provider added before the probe existed has no gateway, and
 *   drawing nothing left the whole feature undiscoverable. It offers 识别 instead, which
 *   probes and remembers the answer.
 * - **An identified new-api with no panel credential** — there *is* a balance, and the
 *   panel will not report it to a relay key (it answers `401`). That is a thing the user
 *   can fix, so the row says so and offers 配置.
 * - **Anything else** — the value, a refresh, and (for new-api) the credential dialog.
 *
 * Nothing is drawn for a built-in or native provider, which has no panel of its own.
 */
export function GatewayBalance({
  provider,
  onConfigure,
  onIdentified,
}: {
  provider: ProviderConfig;
  /** Opens the panel-credential dialog. Only ever called for a new-api provider. */
  onConfigure: () => void;
  /** The probe just identified this provider, so the pane has to re-read the list. */
  onIdentified: () => void;
}): JSX.Element | null {
  const { t } = useTranslation("settings");
  const [result, setResult] = useState<GatewayBalanceResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [identifying, setIdentifying] = useState(false);
  const request = useRef(0);
  const row = gatewayRowState(provider);
  const { readable, needsCredential } = row;
  function refresh(force = false): void {
    const current = ++request.current;
    setLoading(true);
    setError(null);
    void invokeIpc(() => window.fastvibe.providers.gatewayBalance(provider.id, force))
      .then((next) => {
        if (request.current === current) setResult(next);
      })
      .catch((reason: unknown) => {
        if (request.current === current) setError(cleanError(reason));
      })
      .finally(() => {
        if (request.current === current) setLoading(false);
      });
  }

  useEffect(() => {
    setResult(null);
    setError(null);
    request.current += 1;
    if (row.showValue) refresh();
    return () => {
      request.current += 1;
    };
    // Only the fields that change the request matter; every `list()` reply replaces the
    // object wholesale and would otherwise re-fetch on each settings write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider.id, provider.gateway, provider.hasKey, provider.gatewayCredential, provider.baseUrl]);

  if (row.offerIdentify) {
    return (
      <span className="flex min-w-0 items-center gap-1.5 text-sm">
        <Button
          size="xs"
          variant="outline"
          disabled={identifying || !provider.baseUrl}
          onClick={() => {
            setIdentifying(true);
            setError(null);
            // `invokeIpc` so that a preload too old to have this method reports itself
            // instead of throwing before there is a promise to catch — which would leave
            // the spinner below running with no way back.
            void invokeIpc(() => window.fastvibe.providers.identifyGateway(provider.id))
              .then((kind) => {
                // An `undefined` verdict is a real answer — most relays have no panel — and
                // the pane re-reads either way, so the row settles into its final state
                // instead of looking like the click did nothing.
                onIdentified();
                if (!kind) setError(t("providers.gatewayIdentifyNone"));
              })
              .catch((reason: unknown) => setError(cleanError(reason)))
              .finally(() => setIdentifying(false));
          }}
        >
          {identifying ? (
            <HugeiconsIcon strokeWidth={2} icon={Loading03Icon} className="size-3.5 animate-spin" />
          ) : (
            <HugeiconsIcon strokeWidth={2} icon={Search01Icon} />
          )}
          {t("providers.gatewayIdentify")}
        </Button>
        {error ? (
          <span className="truncate text-xs text-muted-foreground" title={error}>
            {error}
          </span>
        ) : null}
      </span>
    );
  }

  if (!readable) return null;

  if (needsCredential) {
    return (
      <span className="flex min-w-0 items-center gap-1.5 text-sm tabular-nums">
        <span className="truncate text-xs text-muted-foreground" title={t("providers.gatewayCredentialHint")}>
          {t("providers.gatewayCredentialHint")}
        </span>
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={onConfigure}
          aria-label={t("providers.gatewayCredentialConfigure")}
        >
          <HugeiconsIcon strokeWidth={2} icon={Settings01Icon} />
        </Button>
      </span>
    );
  }

  return (
    <span className="flex min-w-0 items-center gap-1.5 text-sm tabular-nums">
      {loading ? (
        <HugeiconsIcon strokeWidth={2} icon={Loading03Icon} className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
      ) : null}
      {/*
        A read that fails says so inline rather than vanishing: a silent disappearance
        reads as 「this provider has no balance」, which is a different thing from
        「the panel refused」 — and the controls beside it are the retry and the fix.
      */}
      {error ? (
        <span className="truncate text-xs text-destructive" title={error}>
          {error}
        </span>
      ) : result ? (
        <BalanceValue result={result} />
      ) : null}
      {provider.gateway === "new-api" ? (
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={onConfigure}
          aria-label={t("providers.gatewayCredentialConfigure")}
        >
          <HugeiconsIcon strokeWidth={2} icon={Settings01Icon} />
        </Button>
      ) : null}
      <Button
        size="icon-xs"
        variant="ghost"
        disabled={loading}
        onClick={() => refresh(true)}
        aria-label={t("providers.gatewayBalanceRefresh")}
      >
        <HugeiconsIcon strokeWidth={2} icon={RefreshIcon} />
      </Button>
    </span>
  );
}

function BalanceValue({ result }: { result: GatewayBalanceResult }): JSX.Element {
  const { t, i18n } = useTranslation("settings");
  const { unlimited, available } = result.balance;
  if (unlimited) return <span className="truncate">{t("providers.gatewayBalanceUnlimited")}</span>;
  // A panel that answered without a number is not an error and not a balance either.
  if (available === undefined) return <span className="truncate text-muted-foreground">—</span>;
  return <span className="truncate">{formatUsd(available, i18n.resolvedLanguage)}</span>;
}

function formatUsd(value: number, locale?: string): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
}
