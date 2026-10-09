import { useEffect, useState, type JSX } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

/** Offer recovery on a slow boot without exposing an unfinished conversation. */
export function BootRecovery(): JSX.Element | null {
  const [slow, setSlow] = useState(false);
  const { t } = useTranslation("common");
  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), 8000);
    return () => window.clearTimeout(timer);
  }, []);
  const splash = slow ? document.getElementById("fastvibe-boot") : null;
  if (!splash) return null;
  return createPortal(
    <div className="absolute inset-x-4 top-[calc(50%+5rem)] flex flex-col items-center gap-3 text-center">
      <p className="text-sm text-muted-foreground">{t("startup.slow")}</p>
      <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
        {t("crash.reload")}
      </Button>
    </div>,
    splash,
  );
}
