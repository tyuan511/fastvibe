import { useCallback, useEffect, useMemo, useState } from "react";
import { useSessionStore } from "@/stores/session";
import { refreshPendingUi } from "@/lib/pending-ui-client";
import { collectViviRequests } from "@/lib/vivi-requests";
import type { WorkSnapshot } from "@shared/bot";

export function useViviRequests(snapshot: WorkSnapshot | null) {
  const pending = useSessionStore((state) => state.pendingPermissions);
  const [loadError, setLoadError] = useState(false);
  const retry = useCallback(() => {
    setLoadError(false);
    return refreshPendingUi().catch((error) => {
      console.warn("[vivi] pending requests unavailable", error);
      setLoadError(true);
    });
  }, []);
  useEffect(() => { void retry(); }, [retry]);
  const requests = useMemo(() => collectViviRequests(snapshot?.conversations ?? [], snapshot?.attention ?? [], pending), [snapshot?.conversations, snapshot?.attention, pending]);
  return { requests, loadError, retry };
}
