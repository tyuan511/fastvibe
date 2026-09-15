import { useEffect, useState } from "react";
import type { AppUpdateState } from "@shared/ipc";

export function useAppUpdate(): AppUpdateState | null {
  const [state, setState] = useState<AppUpdateState | null>(null);

  useEffect(() => {
    const api = window.fastvibe?.updater;
    if (!api) return;
    void api.getState().then(setState).catch(() => undefined);
    return api.onState(setState);
  }, []);

  return state;
}
