import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import type { EngineSessionState, EngineStatus } from "@shared/types";

export function StatusPill({
  status,
  session,
}: {
  status: EngineStatus;
  session: EngineSessionState | null;
}): JSX.Element {
  const { t } = useTranslation("app");
  if (status.state === "ready") {
    // Ready is a fact about the engine, not about having something to chat with: a
    // fresh install boots ready with an empty model list, and calling that 就绪 would
    // point at a composer that refuses to type.
    return session?.model ? (
      <Badge variant="secondary">{session.model.id}</Badge>
    ) : (
      <Badge variant="outline">{t("status.noModel")}</Badge>
    );
  }
  if (status.state === "starting") {
    return (
      <Badge variant="outline">
        <Spinner />
        {t("status.starting")}
      </Badge>
    );
  }
  if (status.state === "missing" || status.state === "error") {
    return <Badge variant="destructive">{t("status.notReady")}</Badge>;
  }
  return <Badge variant="outline">{t("status.disconnected")}</Badge>;
}
