import type { JSX, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useAccount } from "@/lib/use-account";
import type { OfficialPath, OfficialState } from "@shared/official";
import { SettingsGroup, SettingsRow } from "./settings-group";

/**
 * 已连接设备: the phones connected to this computer right now, and how — directly, or
 * through FastVibe's relay, which is the one case that costs the account something and so
 * the one worth telling the person about.
 *
 * Nothing here is configured: it follows the 远程访问 switch and needs only an account. So
 * the status row appears only when there is something to do or wait for — sign in, try
 * again, or hold on while it connects — and says nothing while all is well.
 */
export function RemoteOfficial({
  official,
  enabled,
  busy,
  onRetry,
}: {
  official: OfficialState;
  /** The 远程访问 switch. */
  enabled: boolean;
  busy: boolean;
  onRetry: () => void;
}): JSX.Element {
  const { t } = useTranslation("settings");
  const account = useAccount();
  const signedIn = account?.status === "signed-in";
  const signingIn = account?.status === "signing-in";
  // Signing in is offered whether or not the switch is on: the account is the way in, so a
  // person who has not signed in has nothing else on this page to try — and no phone to list.
  const needsLogin = !signedIn || official.status === "signed-out";

  let status: { description: ReactNode; control: ReactNode } | null = null;
  if (needsLogin) {
    status = {
      description: signingIn ? t("remote.official.signingIn") : t("remote.official.signedOut"),
      control: signingIn ? (
        <Button size="sm" variant="ghost" onClick={() => void window.fastvibe.account.cancelLogin()}>
          {t("remote.cancel")}
        </Button>
      ) : (
        <Button size="sm" onClick={() => void window.fastvibe.account.login()}>
          {t("remote.official.login")}
        </Button>
      ),
    };
  } else if (enabled) {
    if (official.status === "error") {
      status = {
        description: <span className="text-destructive">{official.error}</span>,
        control: (
          <Button size="sm" variant="outline" disabled={busy} onClick={onRetry}>
            {t("remote.official.retry")}
          </Button>
        ),
      };
    } else if (official.status !== "online") {
      status = {
        description: (
          <span className="inline-flex items-center gap-1.5">
            <Spinner className="size-3" />
            {t("remote.official.connecting")}
          </span>
        ),
        control: null,
      };
    }
  }

  return (
    <>
      {status ? (
        <SettingsGroup>
          <SettingsRow title={t("remote.official.title")} description={status.description} control={status.control} />
        </SettingsGroup>
      ) : null}

      {needsLogin ? null : (
        <SettingsGroup title={t("remote.official.peers")}>
          {official.peers.length > 0 ? (
            official.peers.map((peer) => (
              <div key={peer.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm">{peer.name}</p>
                  {peer.platform ? <p className="text-xs text-muted-foreground">{peer.platform}</p> : null}
                </div>
                <Badge variant={peer.path === "relay" ? "outline" : "secondary"}>{pathLabel(peer.path, t)}</Badge>
              </div>
            ))
          ) : (
            <p className="px-4 py-3 text-xs text-muted-foreground">{t("remote.official.noPeers")}</p>
          )}
        </SettingsGroup>
      )}
    </>
  );
}

function pathLabel(path: OfficialPath, t: (key: string) => string): string {
  if (path === "direct") return t("remote.official.pathDirect");
  if (path === "relay") return t("remote.official.pathRelay");
  return t("remote.official.pathConnecting");
}
