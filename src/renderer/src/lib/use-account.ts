import { useEffect, useState } from "react";
import type { AccountState } from "@shared/account";

/**
 * Who this desktop is signed in as. `null` until Main answers. The token lives in Main; the
 * renderer is only ever told who.
 */
export function useAccount(): AccountState | null {
  const [state, setState] = useState<AccountState | null>(null);

  useEffect(() => {
    const api = window.fastvibe?.account;
    if (!api) return;
    void api.getState().then(setState).catch(() => undefined);
    return api.onState(setState);
  }, []);

  return state;
}
