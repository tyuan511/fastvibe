import type { JSX } from "react";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import type { OmpSessionState, OmpStatus } from "@shared/types";

export function StatusPill({
  status,
  session,
}: {
  status: OmpStatus;
  session: OmpSessionState | null;
}): JSX.Element {
  if (status.state === "ready") {
    return <Badge variant="secondary">{session?.model?.id ?? "就绪"}</Badge>;
  }
  if (status.state === "starting") {
    return (
      <Badge variant="outline">
        <Spinner />
        启动中
      </Badge>
    );
  }
  if (status.state === "needsAuth") {
    return <Badge variant="outline">待连接</Badge>;
  }
  if (status.state === "missing" || status.state === "error") {
    return <Badge variant="destructive">未就绪</Badge>;
  }
  return <Badge variant="outline">未连接</Badge>;
}
