import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Alert02Icon,
  CheckmarkCircle02Icon,
  Copy01Icon,
  Loading03Icon,
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { NativeProviderOAuth, OAuthEvent, OAuthPrompt } from "@shared/types";
import { OAuthExtraUsageNote } from "./oauth-extra-usage-note";

/** The provider being authorised. `null` closes the dialog. */
export type OAuthTarget = {
  id: string;
  name: string;
  oauth: NativeProviderOAuth;
};

type Phase = "running" | "done" | "error";

type DeviceInfo = { userCode: string; verificationUri: string };

/**
 * The GUI half of a subscription login.
 *
 * pi-ai owns the flow; this only draws it. Four things can be on screen at once
 * because the flows genuinely overlap: somewhere to go (a link or a device code),
 * whatever the flow has narrated, the question it is currently waiting on, and a way
 * out. An Anthropic login is the case that forces it — the browser is opened *and* a
 * paste box is offered, and that box is withdrawn the moment the loopback callback
 * wins, so `prompt_cancelled` has to be able to take a prompt back off the screen.
 */
export function OAuthLoginDialog({
  target,
  onClose,
  onDone,
}: {
  target: OAuthTarget | null;
  /** Dismissed without logging in — cancelled, or the flow failed. */
  onClose: () => void;
  /** Authorised. The caller decides what happens next. */
  onDone: () => void;
}): JSX.Element {
  const { t } = useTranslation("settings");
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<Phase>("running");
  const [log, setLog] = useState<string[]>([]);
  const [link, setLink] = useState<string | null>(null);
  const [device, setDevice] = useState<DeviceInfo | null>(null);
  const [prompt, setPrompt] = useState<OAuthPrompt | null>(null);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  /** Guards the in-flight login against a stale attempt answering for a newer one. */
  const runId = useRef(0);
  /**
   * The caller's callbacks, read through a ref so the login effect depends only on the
   * provider and the attempt. Taking them as dependencies would re-run it on every
   * parent render — restarting the login each time.
   */
  const handlers = useRef({ close: onClose, done: onDone });
  useEffect(() => {
    handlers.current = { close: onClose, done: onDone };
  });
  const providerId = target?.id ?? null;

  const apply = useCallback((event: OAuthEvent): void => {
    switch (event.type) {
      case "info":
      case "progress":
        setLog((current) => [...current, event.message]);
        break;
      case "auth_url":
        setLink(event.url);
        break;
      case "device_code":
        setDevice({ userCode: event.userCode, verificationUri: event.verificationUri });
        break;
      case "prompt":
        setPrompt(event.prompt);
        setValue("");
        break;
      case "prompt_cancelled":
        setPrompt((current) => (current?.id === event.promptId ? null : current));
        break;
      default:
        break;
    }
  }, []);

  useEffect(() => {
    if (!providerId) return undefined;
    const run = ++runId.current;
    setPhase("running");
    setLog([]);
    setLink(null);
    setDevice(null);
    setPrompt(null);
    setValue("");
    setError(null);
    const off = window.fastvibe.providers.onOAuthEvent((payload) => {
      if (payload.id === providerId && run === runId.current) apply(payload.event);
    });
    void window.fastvibe.providers
      .oauthLogin(providerId)
      .then((result) => {
        if (run !== runId.current) return;
        if (result.ok) {
          setPhase("done");
          return;
        }
        // No error means the flow was aborted — the user cancelled, or the dialog went
        // away. There is nothing to report, so simply close.
        if (!result.error) {
          handlers.current.close();
          return;
        }
        setPhase("error");
        setError(result.error);
      })
      .catch((err: unknown) => {
        if (run !== runId.current) return;
        setPhase("error");
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      off();
      // Closing the dialog abandons the login. Harmless once it has resolved: the
      // engine drops the session before the promise settles.
      void window.fastvibe.providers.oauthCancel(providerId);
    };
  }, [providerId, attempt, apply]);

  async function answer(option?: string): Promise<void> {
    if (!prompt || !providerId) return;
    setBusy(true);
    setError(null);
    try {
      await window.fastvibe.providers.oauthAnswer({ id: providerId, promptId: prompt.id, value: option ?? value });
      setPrompt(null);
      setValue("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(text);
      setTimeout(() => setCopied((current) => (current === text ? null : current)), 1500);
    } catch {
      // Clipboard unavailable: the value stays selectable on screen.
    }
  }

  /** Main already opened it; this is the retry for a browser that did not come up. */
  function open(url: string): void {
    window.open(url, "_blank");
  }

  async function cancel(): Promise<void> {
    if (providerId) await window.fastvibe.providers.oauthCancel(providerId);
    handlers.current.close();
  }

  const openTarget = device?.verificationUri ?? link;

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && void cancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("providers.oauthTitle", { name: target?.name ?? "" })}</DialogTitle>
          <DialogDescription>{target?.oauth.name}</DialogDescription>
        </DialogHeader>

        <div className="min-w-0 space-y-3">
          {phase === "running" ? (
            <div className="flex items-center gap-2 text-sm">
              <HugeiconsIcon strokeWidth={2} icon={Loading03Icon} className="size-4 shrink-0 animate-spin text-muted-foreground" />
              {t("providers.oauthWaiting")}
            </div>
          ) : null}
          {phase === "done" ? (
            <div className="space-y-1.5">
              <div className="flex items-center gap-2 text-sm text-success">
                <HugeiconsIcon strokeWidth={2} icon={CheckmarkCircle02Icon} className="size-4 shrink-0" />
                {t("providers.oauthDone", { name: target?.oauth.name ?? "" })}
              </div>
              {/* A Claude subscription login is billed per token from extra usage rather
                  than the plan — said here, where the login just succeeded, so the
                  「third-party apps…」 refusal is not the user's first hint. */}
              {target ? <OAuthExtraUsageNote oauth={target.oauth} /> : null}
            </div>
          ) : null}

          {device ? (
            <div className="space-y-1.5">
              <p className="text-xs text-muted-foreground">{t("providers.oauthDeviceHint")}</p>
              <div className="flex items-center gap-2">
                <code className="flex h-9 flex-1 items-center rounded-lg border border-border bg-muted/40 px-3 font-mono text-base tracking-[0.2em]">
                  {device.userCode}
                </code>
                <Button
                  size="icon-sm"
                  variant="outline"
                  aria-label={t("providers.oauthCopy")}
                  onClick={() => void copy(device.userCode)}
                >
                  <HugeiconsIcon strokeWidth={2} icon={copied === device.userCode ? CheckmarkCircle02Icon : Copy01Icon} />
                </Button>
              </div>
              <button
                type="button"
                className="block max-w-full truncate text-left text-xs text-muted-foreground underline underline-offset-2"
                onClick={() => open(device.verificationUri)}
              >
                {device.verificationUri}
              </button>
            </div>
          ) : null}

          {link && !device ? (
            <div className="space-y-1.5">
              <p className="text-xs text-muted-foreground">{t("providers.oauthLinkHint")}</p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate rounded-lg border border-border px-3 py-2 text-left text-xs text-muted-foreground underline underline-offset-2"
                  title={link}
                  onClick={() => open(link)}
                >
                  {link}
                </button>
                <Button size="icon-sm" variant="outline" aria-label={t("providers.oauthCopy")} onClick={() => void copy(link)}>
                  <HugeiconsIcon strokeWidth={2} icon={copied === link ? CheckmarkCircle02Icon : Copy01Icon} />
                </Button>
              </div>
            </div>
          ) : null}

          {prompt ? (
            <div className="space-y-1.5">
              {/* The flow's own words, which are English — they come from the SDK. */}
              <Label className="text-xs font-normal text-foreground">{prompt.message}</Label>
              {prompt.kind === "select" ? (
                <div className="space-y-1">
                  {(prompt.options ?? []).map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      disabled={busy}
                      className="flex w-full flex-col items-start rounded-lg border border-border px-3 py-2 text-left hover:bg-muted/60 disabled:opacity-60"
                      onClick={() => void answer(option.id)}
                    >
                      <span className="text-sm">{option.label}</span>
                      {option.description ? (
                        <span className="text-xs text-muted-foreground">{option.description}</span>
                      ) : null}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="flex gap-2">
                  <Input
                    autoFocus
                    type={prompt.kind === "secret" ? "password" : "text"}
                    autoComplete="off"
                    value={value}
                    placeholder={prompt.placeholder ?? t("providers.oauthPasteHint")}
                    onChange={(event) => setValue(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && value.trim()) void answer();
                    }}
                  />
                  <Button disabled={busy || !value.trim()} onClick={() => void answer()}>
                    {t("providers.oauthSubmit")}
                  </Button>
                </div>
              )}
              {prompt.kind === "manual_code" ? (
                <p className="text-xs text-muted-foreground">{t("providers.oauthManualHint")}</p>
              ) : null}
            </div>
          ) : null}

          {log.length ? (
            <div className="max-h-24 space-y-0.5 overflow-y-auto rounded-lg bg-muted/40 px-3 py-2">
              {log.map((line, index) => (
                <p key={`${index}-${line}`} className="text-xs text-muted-foreground">
                  {line}
                </p>
              ))}
            </div>
          ) : null}

          {error ? (
            <div className="flex items-start gap-2 text-xs text-destructive">
              <HugeiconsIcon strokeWidth={2} icon={Alert02Icon} className="mt-0.5 size-3.5 shrink-0" />
              <span className="min-w-0 break-words">{error}</span>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          {phase === "done" ? (
            <Button onClick={() => handlers.current.done()}>{t("providers.oauthFinish")}</Button>
          ) : phase === "error" ? (
            <>
              <Button variant="outline" onClick={() => void cancel()}>
                {t("providers.cancel")}
              </Button>
              <Button
                onClick={() => {
                  // A failed login has no resumable state, so the retry is a fresh flow.
                  setError(null);
                  setAttempt((current) => current + 1);
                }}
              >
                {t("providers.oauthRetry")}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => void cancel()}>
                {t("providers.cancel")}
              </Button>
              {openTarget ? (
                <Button variant="outline" onClick={() => open(openTarget)}>
                  {t("providers.oauthOpen")}
                </Button>
              ) : null}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
