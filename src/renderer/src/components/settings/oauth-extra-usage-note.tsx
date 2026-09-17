import { type JSX } from "react";
import { useTranslation } from "react-i18next";
import type { NativeProviderOAuth } from "@shared/types";

/**
 * The billing note a subscription login has to carry wherever it is offered.
 *
 * A Claude Pro/Max login does not draw on the plan's included limits when a
 * third-party harness uses it: the request is charged per token against the account's
 * «extra usage» balance, and refused outright — `third-party apps not draw from your
 * extra usage` — while that balance is not enabled. pi's own CLI warns about this; the
 * GUI did not, so the failure was the first the user heard of it, after a provider had
 * already been connected and a prompt already sent.
 *
 * Which providers need the note is Main's call (`NativeProviderOAuth.extraUsage`), so
 * the copy stays generic and a second such provider needs no change here. Renders
 * nothing for the logins that simply bill through their own subscription.
 */
export function OAuthExtraUsageNote({ oauth }: { oauth: NativeProviderOAuth }): JSX.Element | null {
  const { t } = useTranslation("settings");
  if (!oauth.extraUsage) return null;
  return (
    <p className="text-xs text-muted-foreground">
      {t("providers.oauthExtraUsage")}{" "}
      <a
        href={oauth.extraUsage.url}
        target="_blank"
        rel="noreferrer"
        className="underline underline-offset-3 hover:text-foreground"
      >
        {t("providers.oauthExtraUsageLink")}
      </a>
    </p>
  );
}
