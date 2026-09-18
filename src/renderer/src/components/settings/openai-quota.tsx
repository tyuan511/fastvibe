import { useEffect, useRef, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { Loading03Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cleanError } from "@/lib/ipc-error";
import type { OpenAIAccountQuota, OpenAIQuotaWindow, ProviderConfig } from "@shared/types";

export function OpenAIQuota({ provider }: { provider: ProviderConfig }): JSX.Element | null {
  const { t, i18n } = useTranslation("settings");
  const [quota, setQuota] = useState<OpenAIAccountQuota | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const supported = provider.id === "openai" || provider.id === "openai-codex";
  const connected = provider.id === "openai-codex" ? provider.hasOAuth : provider.hasKey;

  function refresh(force = false): void {
    if (!supported || !connected) return;
    const current = ++request.current;
    setLoading(true);
    setError(null);
    void window.fastvibe.providers
      .quota(provider.id as "openai" | "openai-codex", force)
      .then((next) => {
        if (request.current === current) setQuota(next);
      })
      .catch((reason: unknown) => {
        if (request.current === current) setError(cleanError(reason));
      })
      .finally(() => {
        if (request.current === current) setLoading(false);
      });
  }

  useEffect(() => {
    setQuota(null);
    setError(null);
    request.current += 1;
    if (supported && connected) refresh();
    return () => {
      request.current += 1;
    };
  }, [provider]);

  if (!supported || !connected) return null;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{t("providers.quota")}</span>
        <Button
          size="icon-xs"
          variant="ghost"
          disabled={loading}
          onClick={() => refresh(true)}
          aria-label={t("providers.quotaRefresh")}
        >
          <HugeiconsIcon strokeWidth={2} icon={RefreshIcon} className={loading ? "animate-spin" : undefined} />
        </Button>
      </div>
      <div className="rounded-lg border border-border p-3">
        {loading && !quota ? (
          <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
            <HugeiconsIcon strokeWidth={2} icon={Loading03Icon} className="size-4 animate-spin" />
            {t("providers.quotaLoading")}
          </div>
        ) : null}

        {quota ? (
          quota.kind === "codex" ? (
            <CodexQuotaView quota={quota} locale={i18n.resolvedLanguage} />
          ) : (
            <ApiCreditQuotaView quota={quota} locale={i18n.resolvedLanguage} />
          )
        ) : null}

        {error ? (
          <div className={quota ? "mt-3 border-t border-border pt-3" : ""}>
            <p className="text-xs text-destructive">{error}</p>
            {!quota ? (
              <Button size="xs" variant="outline" className="mt-2" onClick={() => refresh(true)} disabled={loading}>
                {t("providers.quotaRetry")}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function CodexQuotaView({
  quota,
  locale,
}: {
  quota: Extract<OpenAIAccountQuota, { kind: "codex" }>;
  locale?: string;
}): JSX.Element {
  const { t } = useTranslation("settings");
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">{t("providers.quotaCodex")}</p>
        {quota.plan ? <Badge variant="secondary">{planLabel(quota.plan, t)}</Badge> : null}
      </div>
      {quota.windows.map((window) => (
        <QuotaWindowRow key={window.id} window={window} locale={locale} />
      ))}
      {quota.credits ? (
        <div className="flex items-center justify-between gap-3 border-t border-border pt-3 text-sm">
          <span className="text-muted-foreground">{t("providers.quotaCredits")}</span>
          <span className="font-medium tabular-nums">
            {quota.credits.unlimited
              ? t("providers.quotaUnlimited")
              : quota.credits.balance !== undefined
                ? formatNumber(quota.credits.balance, locale)
                : quota.credits.hasCredits
                  ? t("providers.quotaAvailable")
                  : t("providers.quotaUnavailable")}
          </span>
        </div>
      ) : null}
      <UpdatedAt value={quota.fetchedAt} locale={locale} />
    </div>
  );
}

function QuotaWindowRow({ window, locale }: { window: OpenAIQuotaWindow; locale?: string }): JSX.Element {
  const { t } = useTranslation("settings");
  const remaining = Math.max(0, 100 - window.usedPercent);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="min-w-0 truncate">{quotaWindowLabel(window, t)}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {t("providers.quotaRemaining", { percent: formatNumber(remaining, locale, 0) })}
        </span>
      </div>
      <Progress value={window.usedPercent} />
      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>{t("providers.quotaUsed", { percent: formatNumber(window.usedPercent, locale, 0) })}</span>
        {window.resetAt ? <span>{t("providers.quotaReset", { time: formatDate(window.resetAt, locale) })}</span> : null}
      </div>
    </div>
  );
}

function ApiCreditQuotaView({
  quota,
  locale,
}: {
  quota: Extract<OpenAIAccountQuota, { kind: "api-credits" }>;
  locale?: string;
}): JSX.Element {
  const { t } = useTranslation("settings");
  const usedPercent = quota.totalGranted > 0
    ? Math.min(100, Math.max(0, quota.totalUsed / quota.totalGranted * 100))
    : quota.totalAvailable > 0 ? 0 : 100;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium">{t("providers.quotaApiCredits")}</p>
        <span className="text-sm font-medium tabular-nums">
          {t("providers.quotaAvailableAmount", { amount: formatUsd(quota.totalAvailable, locale) })}
        </span>
      </div>
      <Progress value={usedPercent} />
      <div className="grid grid-cols-2 gap-3 text-xs">
        <div>
          <p className="text-muted-foreground">{t("providers.quotaUsedAmount")}</p>
          <p className="mt-0.5 font-medium tabular-nums">{formatUsd(quota.totalUsed, locale)}</p>
        </div>
        <div>
          <p className="text-muted-foreground">{t("providers.quotaGrantedAmount")}</p>
          <p className="mt-0.5 font-medium tabular-nums">{formatUsd(quota.totalGranted, locale)}</p>
        </div>
      </div>
      {quota.nextExpiry ? (
        <p className="text-xs text-muted-foreground">
          {t("providers.quotaExpiry", { time: formatDate(quota.nextExpiry, locale) })}
        </p>
      ) : null}
      <UpdatedAt value={quota.fetchedAt} locale={locale} />
    </div>
  );
}

function UpdatedAt({ value, locale }: { value: number; locale?: string }): JSX.Element {
  const { t } = useTranslation("settings");
  return <p className="text-xs text-muted-foreground">{t("providers.quotaUpdated", { time: formatDate(value, locale) })}</p>;
}

function quotaWindowLabel(window: OpenAIQuotaWindow, t: (key: string, options?: Record<string, unknown>) => string): string {
  const duration = window.windowSeconds;
  let period: string;
  if (duration && duration >= 6.5 * 24 * 60 * 60 && duration <= 7.5 * 24 * 60 * 60) {
    period = t("providers.quotaWeekly");
  } else if (duration && duration >= 4.5 * 60 * 60 && duration <= 5.5 * 60 * 60) {
    period = t("providers.quotaFiveHours");
  } else if (duration && duration >= 24 * 60 * 60) {
    period = t("providers.quotaDays", { count: Math.round(duration / (24 * 60 * 60)) });
  } else if (duration) {
    period = t("providers.quotaHours", { count: Math.round(duration / (60 * 60)) });
  } else {
    period = window.kind === "secondary" ? t("providers.quotaLongTerm") : t("providers.quotaShortTerm");
  }
  return window.name ? `${window.name} · ${period}` : period;
}

function planLabel(plan: string, t: (key: string) => string): string {
  const keys: Record<string, string> = {
    free: "providers.quotaPlanFree",
    go: "providers.quotaPlanGo",
    plus: "providers.quotaPlanPlus",
    pro: "providers.quotaPlanPro",
    team: "providers.quotaPlanTeam",
    business: "providers.quotaPlanBusiness",
    enterprise: "providers.quotaPlanEnterprise",
    education: "providers.quotaPlanEducation",
    edu: "providers.quotaPlanEdu",
  };
  return keys[plan] ? t(keys[plan]) : plan;
}

function formatDate(value: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

function formatUsd(value: number, locale?: string): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
}

function formatNumber(value: number, locale?: string, maximumFractionDigits = 2): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits }).format(value);
}
