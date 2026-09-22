import { createContext, useCallback, useContext, useEffect, useMemo, useState, type JSX, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { PermissionMode } from "@shared/types";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { needsFullAccessConfirmation, permissionModePatch } from "@/lib/permission-mode-selection";
import { useSettingsStore } from "@/stores/settings";

type PermissionModeContextValue = {
  setPermissionMode: (mode: PermissionMode) => void;
};

const PermissionModeContext = createContext<PermissionModeContextValue | null>(null);

export function PermissionModeProvider({ children }: { children: ReactNode }): JSX.Element {
  const settings = useSettingsStore((state) => state.settings);
  const update = useSettingsStore((state) => state.update);
  const [pending, setPending] = useState<{ mode: PermissionMode; fromMode: PermissionMode } | null>(null);
  const { t } = useTranslation("common");

  const setPermissionMode = useCallback(
    (mode: PermissionMode) => {
      if (needsFullAccessConfirmation(settings, mode)) {
        setPending({ mode, fromMode: settings.permissionMode });
        return;
      }
      update(permissionModePatch(mode));
    },
    [settings, update],
  );

  // Settings are shared across windows. If another window confirms full access or
  // changes the mode while this warning is open, its old action must not override
  // that newer choice.
  useEffect(() => {
    if (!pending) return;
    if (settings.fullAccessConfirmed || settings.permissionMode !== pending.fromMode) setPending(null);
  }, [pending, settings.fullAccessConfirmed, settings.permissionMode]);

  const value = useMemo(() => ({ setPermissionMode }), [setPermissionMode]);

  return (
    <PermissionModeContext.Provider value={value}>
      {children}
      <AlertDialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("permission.fullConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("permission.fullConfirmDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("permission.fullConfirmCancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (pending) update(permissionModePatch(pending.mode, true));
                setPending(null);
              }}
            >
              {t("permission.fullConfirmAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PermissionModeContext.Provider>
  );
}

export function usePermissionModeSelection(): PermissionModeContextValue {
  const value = useContext(PermissionModeContext);
  if (!value) throw new Error("usePermissionModeSelection must be used inside PermissionModeProvider");
  return value;
}
