import { bootRemote } from "./bridge";

// The full client: the desktop's own React tree over a WebSocket.
bootRemote({ load: () => import("@/main") });
