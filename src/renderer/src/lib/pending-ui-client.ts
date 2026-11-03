import { createPendingUiRefresh } from "./pending-ui";
import { getPendingUi, onEvent } from "./engine-client";
import { useSessionStore } from "@/stores/session";

/** One shared read for bootstrap and Vivi, with live events preserved across it. */
export const refreshPendingUi = createPendingUiRefresh({
  read: getPendingUi,
  subscribe: onEvent,
  adopt: (requests) => useSessionStore.getState().setPendingUi(requests),
});
