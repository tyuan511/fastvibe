import { useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { Loading03Icon } from "@hugeicons/core-free-icons";
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
import { cleanError } from "@/lib/ipc-error";
import type { ProviderConfig } from "@shared/types";

/**
 * The panel credential a new-api deployment needs before it will report a wallet.
 *
 * It exists because new-api splits its credentials in two and we only ever ask for one:
 * the `sk-` key is scoped to *proxying* — everything the chat needs — while the account
 * balance is a **panel** route (`/api/user/self`) that authenticates the user's own
 * dashboard session. Asked with the relay key it answers `401`, which is not a mistake a
 * user can be told to correct by trying again; it needs a different secret.
 *
 * The token is write-only across IPC. It is stored next to the other secrets (0600, and
 * not in `providers.json`, which every window and every remote device receives), so
 * opening this dialog again shows whether one is on file and never what it is.
 */
export function GatewayCredentialDialog({
  provider,
  onClose,
  onSaved,
}: {
  /** The provider being configured, or null when the dialog is closed. */
  provider: ProviderConfig | null;
  onClose: () => void;
  /** Re-reads the provider list, so the row above picks up the new credential and balance. */
  onSaved: () => void;
}): JSX.Element {
  const { t } = useTranslation("settings");
  const [accessToken, setAccessToken] = useState("");
  const [userId, setUserId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(clear = false): Promise<void> {
    if (!provider) return;
    setBusy(true);
    setError(null);
    try {
      await window.fastvibe.providers.setGatewayCredentials({
        id: provider.id,
        accessToken: clear ? "" : accessToken.trim(),
        userId: clear ? "" : userId.trim(),
      });
      setAccessToken("");
      setUserId("");
      onSaved();
      onClose();
    } catch (err) {
      setError(cleanError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={provider !== null}
      onOpenChange={(open) => {
        if (!open) {
          setAccessToken("");
          setUserId("");
          setError(null);
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("providers.gatewayCredentialTitle")}</DialogTitle>
          <DialogDescription>
            {t("providers.gatewayCredentialDesc", { name: provider?.name ?? "" })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs font-normal text-muted-foreground">{t("providers.gatewayCredentialUser")}</Label>
            <Input
              inputMode="numeric"
              autoFocus
              value={userId}
              placeholder="1"
              onChange={(event) => setUserId(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-normal text-muted-foreground">{t("providers.gatewayCredentialToken")}</Label>
            <Input
              type="password"
              autoComplete="off"
              value={accessToken}
              placeholder={
                provider?.gatewayCredential
                  ? t("providers.gatewayCredentialStored")
                  : t("providers.gatewayCredentialTokenPlaceholder")
              }
              onChange={(event) => setAccessToken(event.target.value)}
            />
          </div>
          {/* Where to get the two values; the panel calls it 系统访问令牌 and hides it in 个人设置. */}
          <p className="text-xs text-muted-foreground">{t("providers.gatewayCredentialHintWhere")}</p>
        </div>
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        <DialogFooter className="gap-2">
          {provider?.gatewayCredential ? (
            <Button variant="outline" disabled={busy} onClick={() => void save(true)}>
              {t("providers.gatewayCredentialClear")}
            </Button>
          ) : null}
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t("providers.cancel")}
          </Button>
          <Button disabled={busy || !accessToken.trim()} onClick={() => void save()}>
            {busy ? <HugeiconsIcon strokeWidth={2} icon={Loading03Icon} className="size-3.5 animate-spin" /> : null}
            {t("providers.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
