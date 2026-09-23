import { bootRemote } from "@/remote/bridge";

// The phone page. It re-reads what it shows after a reconnect, so a locked screen or an
// app switch comes back in place instead of reloading.
bootRemote({ load: () => import("./main"), resumeInPlace: true });
