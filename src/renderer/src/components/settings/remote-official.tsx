import type { JSX, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useAccount } from "@/lib/use-account";
import type { OfficialPath, OfficialState } from "@shared/official";
import { SettingsGroup, SettingsRow } from "./settings-group";

/**
 * 同账号的手机: whether phones signed in to this FastVibe account can find this computer.
 *
 * Nothing here is configured. It follows the 远程访问 switch and needs only an account, so
 * the pane's job is to say which of those is missing and to show who is connected and how
 * — directly, or through FastVibe's relay, which is the one case that costs the account
 * something and so the one worth telling the person about.
 */
export function RemoteOfficial({
  official,
  enabled,
  busy,
  onRetry,
  onDisconnect,
}: {
  official: OfficialState;
  /** The 远程访问 switch. */
  enabled: boolean;
  busy: boolean;
  onRetry: () => void;
  onDisconnect: () => void;
}): JSX.Element {
  const { t } = useTranslation("settings");
  const account = useAccount();
  const signedIn = account?.status === "signed-in";
  const signingIn = account?.status === "signing-in";

  let description: ReactNode;
  let control: ReactNode = null;
  if (!enabled) {
    description = t("remote.official.off");
  } else if (!signedIn || official.status === "signed-out") {
    description = signingIn ? t("remote.official.signingIn") : t("remote.official.signedOut");
    control = signingIn ? (
      <Button size="sm" variant="ghost" onClick={() => void window.fastvibe.account.cancelLogin()}>
        {t("remote.cancel")}
      </Button>
    ) : (
      <Button size="sm" onClick={() => void window.fastvibe.account.login()}>
        {t("remote.official.login")}
      </Button>
    );
  } else if (official.status === "error") {
    description = <span className="text-destructive">{official.error}</span>;
    control = (
      <Button size="sm" variant="outline" disabled={busy} onClick={onRetry}>
        {t("remote.official.retry")}
      </Button>
    );
  } else if (official.status === "online") {
    description = account?.user
      ? t("remote.official.online", { login: account.user.login, name: official.deviceName })
      : t("remote.official.onlineAnonymous", { name: official.deviceName });
  } else {
    description = (
      <span className="inline-flex items-center gap-1.5">
        <Spinner className="size-3" />
        {t("remote.official.connecting")}
      </span>
    );
  }

  return (
    <>
      <SettingsGroup>
        <SettingsRow title={t("remote.official.title")} description={description} control={control} />
        {enabled && signedIn ? (
          <p className="px-4 py-2.5 text-xs leading-5 text-muted-foreground">{t("remote.official.note")}</p>
        ) : null}
      </SettingsGroup>

      {official.peers.length > 0 ? (
        <SettingsGroup title={t("remote.official.peers")}>
          {official.peers.map((peer) => (
            <div key={peer.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm">{peer.name}</p>
                {peer.platform ? <p className="text-xs text-muted-foreground">{peer.platform}</p> : null}
              </div>
              <Badge variant={peer.path === "relay" ? "outline" : "secondary"}>{pathLabel(peer.path, t)}</Badge>
            </div>
          ))}
          <div className="flex justify-end px-4 py-2">
            <Button size="xs" variant="outline" disabled={busy} onClick={onDisconnect}>
              {t("remote.official.disconnectAll")}
            </Button>
          </div>
        </SettingsGroup>
      ) : null}
    </>
  );
}

function pathLabel(path: OfficialPath, t: (key: string) => string): string {
  if (path === "direct") return t("remote.official.pathDirect");
  if (path === "relay") return t("remote.official.pathRelay");
  return t("remote.official.pathConnecting");
}
