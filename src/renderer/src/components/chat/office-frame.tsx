import { useEffect, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { ComputerIcon, RefreshIcon } from "@hugeicons/core-free-icons";
import { mediaPreviewUrl } from "@shared/media-preview";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cleanError } from "@/lib/ipc-error";
import { isRemoteRef } from "@/lib/remote-project";
import { useSessionStore } from "@/stores/session";
import { cn } from "@/lib/utils";

/**
 * An Office document, drawn as the page OfficeCLI rendered for it.
 *
 * The preview names the file; this is the call that turns it into a page. A render takes a
 * second or two and can fail (encrypted, corrupt, the binary missing on this install), so the
 * frame has a state for each of those rather than a blank iframe. The page itself scrolls
 * inside the frame — a document is taller than the pane, and the pane scrolling the frame
 * would hide the page's own scrollbar.
 */

function isDirectUrl(value: string): boolean {
  return value.startsWith("data:") || value.startsWith("blob:") || /^https?:\/\//i.test(value);
}

function isRelative(value: string): boolean {
  return !value.startsWith("remote:") && !value.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(value) && !isDirectUrl(value);
}

export function OfficeFrame({
  path,
  name,
  className,
  live: livePreview = false,
  onLive,
}: {
  path: string;
  name: string;
  className?: string;
  /**
   * Side pane, local file: keep a watch server so the page follows edits and a selection
   * can be cited. The transcript and a remote file stay on the static snapshot.
   */
  live?: boolean;
  onLive?: (ready: boolean) => void;
}): JSX.Element {
  const { t } = useTranslation("chat");
  const activeId = useSessionStore((state) => state.activeId);
  const [attempt, setAttempt] = useState(0);
  const [fallback, setFallback] = useState(false);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [src, setSrc] = useState("");
  const [message, setMessage] = useState("");
  const watching = livePreview && !fallback && !isRemoteRef(path) && !isDirectUrl(path);

  // The page on screen is the live one only once the watch server has answered. Until then (and
  // when it never does) the static render stands in for it, so the sandbox follows what is
  // actually loaded rather than what was asked for.
  const [liveReady, setLiveReady] = useState(false);

  useEffect(() => {
    onLive?.(phase === "ready" && watching && liveReady);
  }, [phase, watching, liveReady, onLive]);

  useEffect(() => {
    let cancelled = false;
    setPhase("loading");
    setSrc("");
    setLiveReady(false);
    // A relative path belongs to the conversation on screen. An absolute one, and a remote
    // ref, already say which machine they live on — adding the active chat would route the
    // call to a different server than the path names.
    const conversationId = isRelative(path) ? activeId ?? undefined : undefined;
    const fail = (error: unknown): void => {
      if (cancelled) return;
      setMessage(cleanError(error));
      setPhase("error");
    };
    const renderStatic = (): Promise<string> =>
      window.fastvibe.office
        .render({ path, conversationId })
        .then((result) => (isDirectUrl(result.path) ? result.path : mediaPreviewUrl(result.path)));
    if (watching) {
      // The watch server takes 1–3 s to start, and nothing is on screen until it does. The
      // static render (cached, ~0.5 s, or instant on a repeat) is asked for beside it and shown
      // as soon as it lands; the live page replaces it when ready. If the server never starts
      // the static page simply stays — the error only appears when there is nothing to show.
      let shownStatic = false;
      void renderStatic()
        .then((url) => {
          if (cancelled) return;
          shownStatic = true;
          setSrc((current) => current || url);
          setPhase("ready");
        })
        .catch(() => undefined);
      void window.fastvibe.office
        .watchStart({ path, conversationId })
        .then((result) => {
          // A cancelled start was already released by the cleanup below, which runs for every
          // start exactly once. Stopping here too would release it twice and take a reference
          // away from the effect that replaced this one.
          if (cancelled) return;
          setSrc(result.url);
          setLiveReady(true);
          setPhase("ready");
        })
        .catch((error: unknown) => {
          if (!shownStatic) fail(error);
        });
      return () => {
        cancelled = true;
        void window.fastvibe.office.watchStop(path);
      };
    }
    void renderStatic()
      .then((url) => {
        if (cancelled) return;
        setSrc(url);
        setPhase("ready");
      })
      .catch(fail);
    return () => {
      cancelled = true;
    };
  }, [path, activeId, attempt, watching]);

  if (phase === "error") {
    return (
      <OfficeNotice
        title={t(watching ? "preview.officeWatchFailed" : "preview.officeFailed")}
        detail={message}
        className={className}
        actions={
          <>
            <Button type="button" size="xs" variant="outline" onClick={() => setAttempt((value) => value + 1)}>
              <HugeiconsIcon strokeWidth={2} icon={RefreshIcon} />
              {t("preview.retry")}
            </Button>
            {livePreview && !fallback ? (
              <Button type="button" size="xs" variant="outline" onClick={() => setFallback(true)}>
                {t("preview.officeStatic")}
              </Button>
            ) : null}
            <OpenWithSystem path={path} />
          </>
        }
      />
    );
  }
  if (phase !== "ready" || !src) {
    return (
      <div className={cn("flex h-full min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground", className)}>
        <Spinner className="size-3.5" />
        {t("preview.officeRendering")}
      </div>
    );
  }
  return (
    <iframe
      title={name}
      // allow-same-origin is required for the live server only: without it the page's Origin
      // is null, and the watch process refuses selection reports and writes. The page is still
      // a different origin from the app (127.0.0.1 versus the window), so it cannot reach in.
      sandbox={liveReady ? "allow-scripts allow-same-origin" : "allow-scripts"}
      referrerPolicy="no-referrer"
      src={src}
      className={cn("h-full min-h-[70vh] w-full border-0 bg-white", className)}
    />
  );
}

/** A format this app will not render, with the one thing that still can. */
export function UnsupportedFile({
  path,
  format,
  className,
}: {
  path: string;
  format: string;
  className?: string;
}): JSX.Element {
  const { t } = useTranslation("chat");
  return (
    <OfficeNotice
      title={t("preview.unsupported", { format })}
      detail={t("preview.unsupportedHint")}
      className={className}
      actions={<OpenWithSystem path={path} />}
    />
  );
}

function OpenWithSystem({ path }: { path: string }): JSX.Element | null {
  const { t } = useTranslation("chat");
  const [failed, setFailed] = useState("");
  if (isRemoteRef(path) || isDirectUrl(path)) return null;
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button
        type="button"
        size="xs"
        variant="outline"
        onClick={() => {
          setFailed("");
          void window.fastvibe.workspace.openExternal(path).then((result) => {
            if (!result.ok) setFailed(result.reason || t("preview.openExternalFailed"));
          }).catch((error: unknown) => setFailed(cleanError(error)));
        }}
      >
        <HugeiconsIcon strokeWidth={2} icon={ComputerIcon} />
        {t("preview.openWithSystem")}
      </Button>
      {failed ? <span className="text-xs text-destructive">{failed}</span> : null}
    </span>
  );
}

function OfficeNotice({
  title,
  detail,
  actions,
  className,
}: {
  title: string;
  detail?: string;
  actions?: JSX.Element;
  className?: string;
}): JSX.Element {
  return (
    <div className={cn("flex h-full min-h-40 flex-col items-start justify-center gap-3 px-4 py-6", className)}>
      <p className="text-sm text-foreground">{title}</p>
      {detail ? <p className="max-w-md text-sm text-muted-foreground">{detail}</p> : null}
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
