import { useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cleanError } from "@/lib/ipc-error";
import type { SshErrorCode, SshHostKeyScan } from "@shared/remote-host";

type Props = {
  hostId: string;
  code: SshErrorCode;
  /** Called once the key is in known_hosts; the caller usually connects again. */
  onTrusted: () => void;
  /** Label for the trust button: "trust and connect" in a connect flow, plain elsewhere. */
  trustLabel?: string;
  onEditHost?: () => void;
};

/**
 * What to do about an SSH login OpenSSH refused for a reason the user can act on.
 *
 * Only an *unknown* host is offered for trust, and only after its fingerprint has been
 * shown: Main keeps the scanned key and writes exactly that one, so a key that changes
 * between showing and clicking is refused rather than trusted. A *changed* key is never
 * offered — that is the case strict checking exists for.
 */
export function SshHostKeyNotice({ hostId, code, onTrusted, trustLabel, onEditHost }: Props): JSX.Element {
  const { t } = useTranslation("app");
  const [scan, setScan] = useState<SshHostKeyScan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function readKey(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      setScan(await window.fastvibe.ssh.scanHostKey(hostId));
    } catch (err) {
      setError(t("projectDialog.hostKey.scanFailed", { message: cleanError(err) }));
    } finally {
      setBusy(false);
    }
  }

  async function trust(): Promise<void> {
    if (!scan) return;
    setBusy(true);
    setError(null);
    try {
      await window.fastvibe.ssh.trustHostKey(hostId, scan.keys.map((key) => key.fingerprint));
      onTrusted();
    } catch (err) {
      setError(t("projectDialog.hostKey.trustFailed", { message: cleanError(err) }));
      setScan(null);
    } finally {
      setBusy(false);
    }
  }

  if (code === "auth-failed") {
    return (
      <div className="min-w-0 rounded-lg border border-border px-3 py-2 text-xs leading-5">
        <p>{t("projectDialog.hostKey.authFailed")}</p>
        {onEditHost ? <Button variant="link" size="xs" className="h-auto px-0" onClick={onEditHost}>{t("projectDialog.hostKey.editHost")}</Button> : null}
      </div>
    );
  }

  if (code === "host-key-changed") {
    return (
      <div className="min-w-0 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs leading-5 text-destructive">
        <p className="font-medium">{t("projectDialog.hostKey.changedTitle")}</p>
        <p className="mt-1">{t("projectDialog.hostKey.changedBody")}</p>
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-2 rounded-lg border border-border px-3 py-2.5 text-xs leading-5">
      <p className="text-sm font-medium">{t("projectDialog.hostKey.unknownTitle")}</p>
      <p className="text-muted-foreground">{t("projectDialog.hostKey.unknownBody")}</p>
      {scan ? (
        <>
          <ul className="space-y-1">
            {scan.keys.map((key) => (
              <li key={key.fingerprint} className="min-w-0 break-all font-mono">
                <span className="text-muted-foreground">{key.type}</span> {key.fingerprint}
              </li>
            ))}
          </ul>
          <p className="break-all text-muted-foreground">{t("projectDialog.hostKey.file", { file: scan.knownHostsFile })}</p>
          <Button size="sm" disabled={busy} onClick={() => void trust()}>{trustLabel ?? t("projectDialog.hostKey.trustOnly")}</Button>
        </>
      ) : (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void readKey()}>
          {busy ? t("projectDialog.hostKey.scanning") : t("projectDialog.hostKey.scan")}
        </Button>
      )}
      {error ? <p className="break-words text-destructive">{error}</p> : null}
    </div>
  );
}
