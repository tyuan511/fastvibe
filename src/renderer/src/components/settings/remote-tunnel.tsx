import { useEffect, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Alert02Icon,
  CheckmarkCircle02Icon,
  Copy01Icon,
  LinkSquare02Icon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { APP_PLATFORM } from "@/lib/platform";
import type { RemoteServerState, RemoteTunnelProvider, RemoteTunnelTools } from "@shared/ipc";
import { AddressActions } from "./address-actions";
import { RemoteFrp } from "./remote-frp";
import { SettingsGroup, SettingsRow } from "./settings-group";

/**
 * 内网穿透: the half of 远程访问 that makes the loopback address reachable.
 *
 * The server binds to `127.0.0.1` by design, so on its own it is an address no phone can
 * open. This pane used to say so in a paragraph and leave the rest to the user: install a
 * tunnel, find a terminal, get `--url` right, then read a URL off a terminal and type it
 * into a phone. Now the app runs the tunnel and shows the result — a link and a QR code —
 * and the paragraph is only what is left when a binary is missing.
 *
 * What it cannot do is install anything. `cloudflared` and `ngrok` are third-party
 * binaries with their own update channels, and one of them needs an account; shipping
 * either would mean shipping somebody else's stale client. So the missing-binary state is
 * a first-class one here, with the command for this platform ready to copy.
 */

/** The one-line install command for each tool, per platform. */
const INSTALL: Record<RemoteTunnelProvider, Partial<Record<string, string>>> = {
  cloudflared: {
    darwin: "brew install cloudflared",
    win32: "winget install --id Cloudflare.cloudflared",
    linux: "sudo apt install cloudflared",
  },
  ngrok: {
    darwin: "brew install ngrok",
    win32: "winget install --id ngrok.ngrok",
    linux: "sudo snap install ngrok",
  },
  // Homebrew is the one package manager with an official-looking frpc. Elsewhere the
  // release archive is the install, which the 安装文档 link points at.
  frp: {
    darwin: "brew install frpc",
  },
};

/** Where to go when the command above is not how this machine installs things. */
const DOCS: Record<RemoteTunnelProvider, string> = {
  cloudflared:
    "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/",
  ngrok: "https://ngrok.com/download",
  frp: "https://github.com/fatedier/frp/releases",
};

/**
 * The second step, for a tool that needs a credential as well as a binary.
 *
 * Only ngrok has one. Keyed by provider rather than special-cased on the string
 * `"ngrok"`, so a third provider that also needs an account cannot end up printing
 * ngrok's command at somebody.
 */
const AUTH: Partial<Record<RemoteTunnelProvider, { command: string; page: string }>> = {
  ngrok: {
    command: "ngrok config add-authtoken <token>",
    page: "https://dashboard.ngrok.com/get-started/your-authtoken",
  },
};

const LABELS: Record<RemoteTunnelProvider, string> = {
  cloudflared: "Cloudflare Tunnel",
  ngrok: "ngrok",
  frp: "frp",
};

/** What each provider's missing-binary block says about the setup around the binary. */
const SETUP_TEXT: Record<RemoteTunnelProvider, string> = {
  cloudflared: "remote.tunnelSetupCloudflared",
  ngrok: "remote.tunnelSetupNgrok",
  frp: "remote.tunnelSetupFrp",
};

export function RemoteTunnel({
  state,
  busy,
  onSet,
}: {
  state: RemoteServerState;
  busy: boolean;
  onSet: (provider: RemoteTunnelProvider | null) => void;
}): JSX.Element {
  const { t } = useTranslation("settings");
  const [tools, setTools] = useState<RemoteTunnelTools | null>(null);
  const { tunnel, tunnelChoice } = state;

  /**
   * Re-probed on every phase change, not just once.
   *
   * The interesting case is the user who reads the install command, runs it, and comes
   * back: nothing about the app changed, so a probe that ran once at mount would still
   * be saying the tool is missing. `phase` moves whenever they press 重试, which is
   * exactly when the answer might be different.
   */
  useEffect(() => {
    let cancelled = false;
    void window.fastvibe.remote
      .tunnelTools()
      .then((next) => {
        if (!cancelled) setTools(next);
      })
      .catch(() => {
        if (!cancelled) setTools(null);
      });
    return () => {
      cancelled = true;
    };
  }, [tunnel.phase, tunnelChoice]);

  const items: Record<string, string> = {
    none: t("remote.tunnelNone"),
    ...LABELS,
    frp: t("remote.tunnelFrpLabel"),
  };
  const tool = tunnelChoice ? tools?.[tunnelChoice] : undefined;
  const missing = tunnelChoice !== null && tools !== null && tool?.installed !== true;
  /**
   * Installed, but the credential it needs is not here.
   *
   * Two sources, one control. The probe answers it *before* anything runs, which is what
   * makes picking ngrok with no authtoken say so at the moment of the choice rather than
   * after a failed start; `tunnel.needsAuth` answers it after a run was refused, which
   * covers a token that exists and is wrong — no file check can see that. The `AUTH`
   * lookup is what gates the block, so a provider with no credential step can never
   * reach it.
   */
  const authStep = tunnelChoice ? AUTH[tunnelChoice] : undefined;
  const needsAuth = Boolean(
    tunnelChoice && !missing && authStep && (tool?.authenticated === false || tunnel.needsAuth),
  );

  return (
    <SettingsGroup title={t("remote.tunnel")}>
      <SettingsRow
        title={t("remote.tunnelProvider")}
        description={t("remote.tunnelProviderDesc")}
        control={
          <Select
            items={items}
            value={tunnelChoice ?? "none"}
            onValueChange={(next) => onSet(next === "none" ? null : (next as RemoteTunnelProvider))}
          >
            <SelectTrigger size="sm" className="w-44" disabled={busy}>
              <SelectValue className="truncate" />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(items).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />

      {/*
       * The install guidance. Shown whenever the chosen tool is not on PATH — including
       * while the server is off, so the setup can be finished before the switch is ever
       * flipped rather than discovered to be incomplete afterwards.
       */}
      {missing && tunnelChoice ? (
        <Setup provider={tunnelChoice} onRetry={() => onSet(tunnelChoice)} busy={busy} />
      ) : null}

      {/*
       * The credential step. Its own block rather than a line inside the generic failure,
       * because unlike every other way a tunnel can fail there is exactly one command
       * that fixes this one — so the answer is the command, on screen, ready to copy.
       */}
      {needsAuth && tunnelChoice && authStep ? (
        <NeedsAuth
          name={LABELS[tunnelChoice]}
          step={authStep}
          // The tool's own words only when a run actually produced them. Reached from the
          // probe instead, nothing has run yet and there is nothing to quote.
          message={tunnel.needsAuth ? tunnel.error : null}
          output={tunnel.needsAuth ? tunnel.output : []}
          busy={busy}
          onRetry={() => onSet(tunnelChoice)}
        />
      ) : null}

      {/* The self-hosted server's settings. Shown even while frpc is missing, so the
          form can be filled in before the binary is installed. */}
      {tunnelChoice === "frp" ? <RemoteFrp busy={busy} /> : null}

      {!missing && !needsAuth && tunnelChoice && !state.running ? (
        <p className="px-4 py-3 text-xs leading-5 text-muted-foreground">{t("remote.tunnelIdle")}</p>
      ) : null}

      {tunnel.phase === "starting" ? (
        <div className="flex items-center gap-2 px-4 py-3 text-xs text-muted-foreground">
          <Spinner className="size-3.5" />
          {t("remote.tunnelStarting", { name: LABELS[tunnel.provider ?? "cloudflared"] })}
        </div>
      ) : null}

      {tunnel.phase === "online" && tunnel.url ? (
        <Online url={tunnel.url} stable={tunnel.provider === "frp"} />
      ) : null}

      {/* Not while the credential block is up: that one already carries this reason and
          its own 重试, and two retry buttons for one failure is a question, not an answer. */}
      {tunnel.phase === "error" && tunnel.error && !needsAuth ? (
        <Failure
          message={tunnel.error}
          output={tunnel.output}
          busy={busy}
          onRetry={() => onSet(tunnelChoice)}
        />
      ) : null}
    </SettingsGroup>
  );
}

/**
 * The public address, the way it is actually used: scanned, opened, or copied.
 *
 * One row and no code on screen until it is asked for. The square used to sit open beside
 * the text — 9rem of a settings pane spent on a picture that is scanned once and then is
 * furniture, and the tallest thing in a pane otherwise made of one-line rows. It is the
 * same address either way, so it reads exactly like 允许远程连接's row above: the URL and
 * three icons, two of which name themselves on hover (`AddressActions`).
 *
 * The tunnel hostname itself breaks anywhere rather than truncating: it is one unbroken
 * token of 30-odd characters whose tail is the part that differs between runs.
 */
function Online({ url, stable }: { url: string; stable: boolean }): JSX.Element {
  const { t } = useTranslation("settings");

  return (
    <div className="space-y-2 px-4 py-3">
      <p className="text-sm font-medium">{t("remote.tunnelOnline")}</p>
      <p className="text-xs leading-5 text-muted-foreground">
        {/* A quick tunnel's hostname is new every run; the user's own frps is not. */}
        {t(stable ? "remote.tunnelScanStable" : "remote.tunnelScan")}
      </p>
      {/* `min-w-0` so the hostname is what wraps: it is one unbroken token whose tail is
          the part that differs between runs, and a group that cannot shrink would push
          the icons out of the card instead. */}
      <span className="flex min-w-0 items-center gap-1.5 font-mono text-xs">
        <span className="min-w-0 break-all text-foreground">{url}</span>
        <AddressActions value={url} className="shrink-0" />
      </span>
    </div>
  );
}

/**
 * Why it did not start.
 *
 * The tool's own last lines are printed under our sentence rather than instead of it,
 * because between the two they answer different questions: ours says which step failed,
 * and theirs says the thing we could not have known — that the authtoken is missing, or
 * that the edge was unreachable.
 */
function Failure({
  message,
  output,
  busy,
  onRetry,
}: {
  message: string;
  output: string[];
  busy: boolean;
  onRetry: () => void;
}): JSX.Element {
  const { t } = useTranslation("settings");

  return (
    <div className="space-y-2 px-4 py-3">
      <p className="flex items-start gap-2 text-xs leading-5 text-destructive">
        <HugeiconsIcon strokeWidth={2} icon={Alert02Icon} className="mt-0.5 size-3.5 shrink-0" />
        <span className="min-w-0 break-words">{message}</span>
      </p>
      {output.length > 0 ? (
        <pre className="max-h-32 overflow-auto rounded-lg bg-muted px-3 py-2 font-mono text-[11px] leading-4 whitespace-pre-wrap text-muted-foreground">
          {output.join("\n")}
        </pre>
      ) : null}
      <Button size="xs" variant="outline" disabled={busy} onClick={onRetry}>
        <HugeiconsIcon strokeWidth={2} icon={RefreshIcon} />
        {t("remote.tunnelRetry")}
      </Button>
    </div>
  );
}

/**
 * The tool is installed and has no usable credential.
 *
 * Reached two ways, and it reads the same from both: chosen with no authtoken on the
 * machine (caught before anything is spawned), or a run that came back refused. The
 * second is the only one that can catch a token that is present and wrong, which is why
 * the refusal's own text is shown when there is one and left out when nothing has run.
 */
function NeedsAuth({
  name,
  step,
  message,
  output,
  busy,
  onRetry,
}: {
  name: string;
  step: { command: string; page: string };
  message: string | null;
  output: string[];
  busy: boolean;
  onRetry: () => void;
}): JSX.Element {
  const { t } = useTranslation("settings");

  return (
    <div className="space-y-2 px-4 py-3">
      <p className="flex items-start gap-2 text-sm font-medium">
        <HugeiconsIcon strokeWidth={2} icon={Alert02Icon} className="mt-0.5 size-4 shrink-0 text-destructive" />
        {t("remote.tunnelNeedsAuth", { name })}
      </p>
      <p className="text-xs leading-5 text-muted-foreground">{t("remote.tunnelNeedsAuthDesc", { name })}</p>
      <div className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2">
        <code className="min-w-0 flex-1 truncate font-mono text-xs">{step.command}</code>
        <CopyButton value={step.command} label={t("remote.tunnelCopyCommand")} />
      </div>
      {message ? <p className="text-xs leading-5 text-destructive">{message}</p> : null}
      {output.length > 0 ? (
        <pre className="max-h-32 overflow-auto rounded-lg bg-muted px-3 py-2 font-mono text-[11px] leading-4 whitespace-pre-wrap text-muted-foreground">
          {output.join("\n")}
        </pre>
      ) : null}
      <div className="flex items-center gap-2">
        <Button size="xs" variant="outline" disabled={busy} onClick={onRetry}>
          <HugeiconsIcon strokeWidth={2} icon={RefreshIcon} />
          {t("remote.tunnelAuthDone")}
        </Button>
        <Button
          size="xs"
          variant="ghost"
          nativeButton={false}
          render={<a href={step.page} target="_blank" rel="noreferrer" />}
        >
          <HugeiconsIcon strokeWidth={2} icon={LinkSquare02Icon} />
          {t("remote.tunnelToken")}
        </Button>
      </div>
    </div>
  );
}

/** What to run to get the missing binary, and where to go if that command is wrong. */
function Setup({
  provider,
  busy,
  onRetry,
}: {
  provider: RemoteTunnelProvider;
  busy: boolean;
  onRetry: () => void;
}): JSX.Element {
  const { t } = useTranslation("settings");
  const command = INSTALL[provider][APP_PLATFORM];
  const step = AUTH[provider];

  return (
    <div className="space-y-2 px-4 py-3">
      <p className="text-sm font-medium">{t("remote.tunnelMissing", { name: LABELS[provider] })}</p>
      <p className="text-xs leading-5 text-muted-foreground">
        {t(SETUP_TEXT[provider])}
      </p>
      {command ? (
        <div className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2">
          <code className="min-w-0 flex-1 truncate font-mono text-xs">{command}</code>
          <CopyButton value={command} label={t("remote.tunnelCopyCommand")} />
        </div>
      ) : null}
      {/* The second step, for a tool that needs a credential too. Shown here as well as
          in its own block, so the whole setup is visible before the first attempt rather
          than arriving one failure at a time. */}
      {step ? (
        <div className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2">
          <code className="min-w-0 flex-1 truncate font-mono text-xs">{step.command}</code>
          <CopyButton value={step.command} label={t("remote.tunnelCopyCommand")} />
          <Button
            size="xs"
            variant="ghost"
            nativeButton={false}
            render={<a href={step.page} target="_blank" rel="noreferrer" />}
          >
            <HugeiconsIcon strokeWidth={2} icon={LinkSquare02Icon} />
            {t("remote.tunnelToken")}
          </Button>
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <Button size="xs" variant="outline" disabled={busy} onClick={onRetry}>
          <HugeiconsIcon strokeWidth={2} icon={RefreshIcon} />
          {t("remote.tunnelInstalled")}
        </Button>
        <Button
          size="xs"
          variant="ghost"
          nativeButton={false}
          render={<a href={DOCS[provider]} target="_blank" rel="noreferrer" />}
        >
          {t("remote.tunnelDocs")}
        </Button>
      </div>
    </div>
  );
}

/** Copy one string, and say so for a moment. Used for both the URL and the command. */
function CopyButton({ value, label }: { value: string; label: string }): JSX.Element {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <Button
      size="xs"
      variant="ghost"
      onClick={() => {
        void navigator.clipboard
          .writeText(value)
          .then(() => setCopied(true))
          .catch(() => undefined);
      }}
    >
      <HugeiconsIcon strokeWidth={2} icon={copied ? CheckmarkCircle02Icon : Copy01Icon} />
      {label}
    </Button>
  );
}
