import { useEffect, useMemo, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { Alert02Icon, CheckmarkCircle02Icon, InformationCircleIcon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cleanError } from "@/lib/ipc-error";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import {
  FRP_EMPTY,
  frpProblems,
  frpPublicUrl,
  isFrpDomain,
  type FrpDnsCheck,
  type FrpMode,
  type FrpProblem,
  type FrpSettingsView,
} from "@shared/frp";

/**
 * 内网穿透 → frp: the user's own frps, which this form describes.
 *
 * The one provider that is configured rather than discovered, so it is the one with a
 * form. The public URL is previewed as the user types, because it is *derived* — frpc
 * never says where a proxy can be reached — and a user who sees `http://` next to a
 * domain they serve over HTTPS knows to fill in the override before a phone ever tries.
 *
 * The token never comes back from Main (`hasToken` does), so the field starts empty with
 * a placeholder saying one is saved, and an untouched field is sent as *absent*, which
 * keeps it.
 */

type Draft = {
  serverAddr: string;
  serverPort: string;
  token: string;
  mode: FrpMode;
  domain: string;
  vhostPort: string;
  remotePort: string;
  publicUrl: string;
};

function toDraft(view: FrpSettingsView | null): Draft {
  const source = view ?? { ...FRP_EMPTY, hasToken: false };
  return {
    serverAddr: source.serverAddr,
    serverPort: String(source.serverPort),
    token: "",
    mode: source.mode,
    domain: source.domain,
    vhostPort: source.vhostPort === null ? "" : String(source.vhostPort),
    remotePort: source.remotePort === null ? "" : String(source.remotePort),
    publicUrl: source.publicUrl,
  };
}

/** A port field: empty is `null`, anything else must read as a number to count. */
function port(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}

function toConfig(draft: Draft) {
  return {
    serverAddr: draft.serverAddr.trim(),
    serverPort: port(draft.serverPort) ?? Number.NaN,
    mode: draft.mode,
    domain: draft.domain.trim(),
    vhostPort: port(draft.vhostPort),
    remotePort: port(draft.remotePort),
    publicUrl: draft.publicUrl.trim(),
  };
}

export function RemoteFrp({ busy }: { busy: boolean }): JSX.Element {
  const { t } = useTranslation("settings");
  const [saved, setSaved] = useState<FrpSettingsView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => toDraft(null));
  const [tokenTouched, setTokenTouched] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void window.fastvibe.remote
      .frpGet()
      .then((view) => {
        if (cancelled) return;
        setSaved(view);
        setDraft(toDraft(view));
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const config = useMemo(() => toConfig(draft), [draft]);
  const problems = useMemo(() => frpProblems(config), [config]);
  const url = problems.length === 0 ? frpPublicUrl(config) : null;
  const dirty = tokenTouched || JSON.stringify(draft) !== JSON.stringify(toDraft(saved));

  function update<K extends keyof Draft>(key: K, value: Draft[K]): void {
    setDraft((previous) => ({ ...previous, [key]: value }));
  }

  function errorFor(field: FrpProblem["field"]): string | null {
    if (!showErrors) return null;
    return problems.some((problem) => problem.field === field) ? t(`remote.frpErrors.${field}`) : null;
  }

  async function save(): Promise<void> {
    if (problems.length > 0) {
      setShowErrors(true);
      return;
    }
    setSaving(true);
    try {
      const next = await window.fastvibe.remote.frpSet({
        ...config,
        ...(tokenTouched ? { token: draft.token } : {}),
      });
      setSaved(next);
      setDraft(toDraft(next));
      setTokenTouched(false);
      setShowErrors(false);
      toast.success(t("remote.frpSaved"));
    } catch (err) {
      toast.error(cleanError(err));
    } finally {
      setSaving(false);
    }
  }

  const modes: Record<FrpMode, string> = { http: t("remote.frpModeHttp"), tcp: t("remote.frpModeTcp") };
  const disabled = busy || saving || !loaded;

  return (
    <div className="space-y-3 px-4 py-3">
      <p className="text-xs leading-5 text-muted-foreground">{t("remote.frpIntro")}</p>

      <div className="grid grid-cols-[1fr_6rem] gap-2">
        <Field label={t("remote.frpServer")} error={errorFor("serverAddr")}>
          <Input
            value={draft.serverAddr}
            placeholder="frp.example.com"
            disabled={disabled}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => update("serverAddr", event.target.value)}
          />
        </Field>
        <Field label={t("remote.frpServerPort")} error={errorFor("serverPort")}>
          <Input
            value={draft.serverPort}
            inputMode="numeric"
            disabled={disabled}
            onChange={(event) => update("serverPort", event.target.value)}
          />
        </Field>
      </div>

      <Field label={t("remote.frpToken")}>
        <Input
          type="password"
          value={draft.token}
          placeholder={saved?.hasToken && !tokenTouched ? t("remote.frpTokenSaved") : t("remote.frpTokenPlaceholder")}
          disabled={disabled}
          autoComplete="new-password"
          onChange={(event) => {
            setTokenTouched(true);
            update("token", event.target.value);
          }}
        />
      </Field>

      <Field label={t("remote.frpMode")}>
        <Select items={modes} value={draft.mode} onValueChange={(next) => update("mode", next as FrpMode)}>
          <SelectTrigger size="sm" className="w-full" disabled={disabled}>
            <SelectValue className="truncate" />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(modes).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      {draft.mode === "http" ? (
        <>
        <div className="grid grid-cols-[1fr_6rem] gap-2">
          <Field label={t("remote.frpDomain")} error={errorFor("domain")}>
            <Input
              value={draft.domain}
              placeholder="fastvibe.example.com"
              disabled={disabled}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => update("domain", event.target.value)}
            />
          </Field>
          <Field label={t("remote.frpVhostPort")} error={errorFor("vhostPort")}>
            <Input
              value={draft.vhostPort}
              placeholder="80"
              inputMode="numeric"
              disabled={disabled}
              onChange={(event) => update("vhostPort", event.target.value)}
            />
          </Field>
        </div>
        <DomainHelp domain={draft.domain.trim()} serverAddr={draft.serverAddr.trim()} />
        </>
      ) : (
        <Field label={t("remote.frpRemotePort")} error={errorFor("remotePort")}>
          <Input
            value={draft.remotePort}
            placeholder="7777"
            inputMode="numeric"
            disabled={disabled}
            onChange={(event) => update("remotePort", event.target.value)}
          />
        </Field>
      )}

      <Field label={t("remote.frpPublicUrl")} error={errorFor("publicUrl")}>
        <Input
          value={draft.publicUrl}
          placeholder={frpPublicUrl({ ...config, publicUrl: "" }) ?? "https://fastvibe.example.com"}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => update("publicUrl", event.target.value)}
        />
      </Field>
      <p className="text-xs leading-5 text-muted-foreground">{t("remote.frpPublicUrlDesc")}</p>

      {/*
       * Plain http is allowed — it is what a bare frps gives — but not silently: the
       * login password and every transcript would cross the network readable.
       */}
      {url?.startsWith("http://") ? (
        <p className="flex items-start gap-2 text-xs leading-5 text-warning">
          <HugeiconsIcon strokeWidth={2} icon={Alert02Icon} className="mt-0.5 size-3.5 shrink-0" />
          <span>{t("remote.frpInsecure")}</span>
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        <Button size="xs" disabled={disabled || !dirty} onClick={() => void save()}>
          {t("remote.frpSave")}
        </Button>
        {url ? <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{url}</span> : null}
      </div>
    </div>
  );
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string | null;
  children: JSX.Element;
}): JSX.Element {
  return (
    <div className="min-w-0 space-y-1.5">
      <Label className="text-xs font-normal text-muted-foreground">{label}</Label>
      {children}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

/** How long typing has to pause before the domain is looked up. */
const DNS_CHECK_DELAY_MS = 600;

type DnsState =
  | { status: "idle" }
  | { status: "checking"; domain: string }
  | { status: "done"; result: FrpDnsCheck }
  | { status: "error"; message: string };

/**
 * What the domain needs, and whether it already has it.
 *
 * HTTP mode is the one setup where the user has to do something *outside* FastVibe and
 * frps before anything can work: point the domain at the server. frpc cannot tell — it
 * registers the proxy and reports success whatever the DNS says — so a missing record
 * used to surface only as a phone that could not open the link. The pane says what to
 * add, then looks the domain up (in Main, with the system resolver) and says whether it
 * reaches the server yet.
 */
function DomainHelp({ domain, serverAddr }: { domain: string; serverAddr: string }): JSX.Element {
  const { t } = useTranslation("settings");
  const [state, setState] = useState<DnsState>({ status: "idle" });
  const [attempt, setAttempt] = useState(0);
  const checkable = isFrpDomain(domain);

  useEffect(() => {
    if (!checkable) {
      setState({ status: "idle" });
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setState({ status: "checking", domain });
      window.fastvibe.remote
        .frpCheckDns({ domain, serverAddr })
        .then((result) => {
          if (!cancelled) setState({ status: "done", result });
        })
        .catch((err: unknown) => {
          if (!cancelled) setState({ status: "error", message: cleanError(err) });
        });
    }, DNS_CHECK_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [attempt, checkable, domain, serverAddr]);

  const serverIsIp = /^[\d.]+$/.test(serverAddr) || serverAddr.includes(":");
  const target = !serverAddr
    ? ""
    : serverIsIp
      ? t("remote.frpDomainHelpIp", { server: serverAddr })
      : t("remote.frpDomainHelpHost", { server: serverAddr });

  return (
    <div className="space-y-2 rounded-lg bg-muted/50 px-3 py-2.5">
      <p className="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
        <HugeiconsIcon strokeWidth={2} icon={InformationCircleIcon} className="mt-0.5 size-3.5 shrink-0" />
        <span>
          {t("remote.frpDomainHelp", { target })}
          {" "}
          {t("remote.frpNoDomain")}
        </span>
      </p>
      <DnsStatus state={state} serverAddr={serverAddr} onRecheck={() => setAttempt((value) => value + 1)} />
    </div>
  );
}

function DnsStatus({
  state,
  serverAddr,
  onRecheck,
}: {
  state: DnsState;
  serverAddr: string;
  onRecheck: () => void;
}): JSX.Element | null {
  const { t } = useTranslation("settings");
  if (state.status === "idle") return null;
  if (state.status === "checking") {
    return (
      <p className="flex items-center gap-2 text-xs leading-5 text-muted-foreground">
        <Spinner className="size-3.5" />
        <span>{t("remote.frpDnsChecking", { domain: state.domain })}</span>
      </p>
    );
  }
  const recheck = (
    <Button size="xs" variant="ghost" className="-my-1 h-6 shrink-0" onClick={onRecheck}>
      {t("remote.frpDnsRecheck")}
    </Button>
  );
  if (state.status === "error") {
    return (
      <div className="flex items-start gap-2 text-xs leading-5 text-warning">
        <HugeiconsIcon strokeWidth={2} icon={Alert02Icon} className="mt-0.5 size-3.5 shrink-0" />
        <span className="min-w-0 flex-1">{t("remote.frpDnsFailed", { message: state.message })}</span>
        {recheck}
      </div>
    );
  }
  const { result } = state;
  const values = {
    domain: result.domain,
    address: result.domainAddresses.slice(0, 2).join(", "),
    server: result.serverAddresses[0] ?? serverAddr,
  };
  const ok = result.verdict === "match";
  const message =
    result.verdict === "match"
      ? t("remote.frpDnsMatch", values)
      : result.verdict === "mismatch"
        ? t("remote.frpDnsMismatch", values)
        : result.verdict === "unresolved"
          ? t("remote.frpDnsUnresolved", values)
          : t("remote.frpDnsResolved", values);
  return (
    <div className={cn("flex items-start gap-2 text-xs leading-5", ok ? "text-success" : "text-warning")}>
      <HugeiconsIcon
        strokeWidth={2}
        icon={ok ? CheckmarkCircle02Icon : Alert02Icon}
        className="mt-0.5 size-3.5 shrink-0"
      />
      <span className="min-w-0 flex-1">{message}</span>
      {ok ? null : recheck}
    </div>
  );
}
