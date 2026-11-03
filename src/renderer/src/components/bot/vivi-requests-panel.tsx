import { useRef, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/icon-button";
import { Spinner } from "@/components/ui/spinner";
import { PermissionPanel, type PermissionResponse } from "@/components/chat/permission-panel";
import { respondPermission } from "@/lib/engine-client";
import { useSessionStore } from "@/stores/session";
import { useSidePaneStore } from "@/stores/side-pane";
import type { ViviRequest } from "@/lib/vivi-requests";
import { BotQuestions } from "./bot-questions";

type Props = {
  requests: ViviRequest[];
  onAnswer: (attentionId: string, value: string) => Promise<void>;
};

/** One interaction surface; inactive, visited forms keep their unsent drafts. */
export function ViviRequestsPanel({ requests, onAnswer }: Props): JSX.Element | null {
  const { t } = useTranslation("app");
  const [view, setView] = useState(() => ({ selected: requests[0]?.key ?? null, visited: requests[0] ? [requests[0].key] : [] }));
  const locks = useRef(new Set<string>());
  const [sending, setSending] = useState<Set<string>>(() => new Set());
  const [errors, setErrors] = useState<Record<string, boolean>>({});
  const selected = requests.find((item) => item.key === view.selected) ?? requests[0];
  if (!selected) return null;
  // A request disappearing is a queue transition. Claim its successor before
  // rendering children, so a new arrival cannot steal an in-progress answer.
  if (view.selected !== selected.key) setView({ selected: selected.key, visited: [...view.visited.filter((key) => requests.some((item) => item.key === key)), selected.key] });
  const index = requests.findIndex((item) => item.key === selected.key);
  const busy = sending.has(selected.key);
  const choose = (nextIndex: number): void => {
    const item = requests[nextIndex];
    if (!item) return;
    setView((current) => ({ selected: item.key, visited: current.visited.includes(item.key) ? current.visited : [...current.visited, item.key] }));
  };
  const respond = (item: ViviRequest, payload: PermissionResponse): void => {
    if (item.kind !== "plugin" || locks.current.has(item.key)) return;
    // The component can outlive an engine withdrawal until the next render.
    const live = useSessionStore.getState().pendingPermissions[item.conversationId]?.some((request) => request.id === item.request.id);
    if (!live) return;
    locks.current.add(item.key);
    setSending((current) => new Set(current).add(item.key));
    setErrors((current) => ({ ...current, [item.key]: false }));
    void respondPermission({ ...payload, id: item.request.id }).then(() => {
      // Only a successful reply may retire the request. Main can also dismiss it
      // first; resolve-by-id never removes the next request in that case.
      useSessionStore.getState().resolvePermission(item.request.id);
    }).catch((error) => {
      console.warn("[vivi] request response failed", error);
      setErrors((current) => ({ ...current, [item.key]: true }));
    }).finally(() => {
      locks.current.delete(item.key);
      setSending((current) => { const next = new Set(current); next.delete(item.key); return next; });
    });
  };
  return <section className="glass-rim relative mb-3 flex max-h-[min(30rem,50dvh)] min-w-0 flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-sm" aria-label={t("viviBot.requests.title")} data-vivi-requests>
    <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/50 px-3 py-2">
      <span className="text-xs font-medium">{t("viviBot.requests.count", { count: requests.length })}</span>
      <Button variant="ghost" size="sm" className="h-6 min-w-0 flex-1 justify-start px-1 text-xs font-normal text-muted-foreground" onClick={() => useSidePaneStore.getState().openBotConversation(selected.conversationId, selected.title)} title={selected.title ?? "Vivi"}>
        <span className="truncate">{selected.title ?? "Vivi"}</span>
      </Button>
      {requests.length > 1 ? <div className="ml-auto flex shrink-0 items-center gap-1">
        <IconButton type="button" variant="ghost" size="icon-xs" label={t("viviBot.requests.previous")} disabled={index === 0} onClick={() => choose(index - 1)}><HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} /></IconButton>
        <span className="min-w-9 text-center text-xs tabular-nums text-muted-foreground">{index + 1} / {requests.length}</span>
        <IconButton type="button" variant="ghost" size="icon-xs" label={t("viviBot.requests.next")} disabled={index === requests.length - 1} onClick={() => choose(index + 1)}><HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} /></IconButton>
      </div> : null}
      {busy ? <Spinner className="size-3.5" /> : null}
    </header>
    <div className="min-h-0 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]">
      {requests.filter((item) => item.key === selected.key || view.visited.includes(item.key)).map((item) => {
        const active = item.key === selected.key;
        const submitting = sending.has(item.key);
        return <div key={item.key} hidden={!active} data-vivi-request={item.key}>
          <div inert={submitting} aria-busy={submitting}>
            {item.kind === "plugin" ? <div className="p-2.5"><PermissionPanel request={item.request} onRespond={(payload) => respond(item, payload)} embedded active={active && !submitting} /></div> : <BotQuestions questions={[item.question]} onAnswer={onAnswer} embedded />}
          </div>
          {errors[item.key] ? <p role="alert" className="px-3 pb-3 text-sm text-destructive wrap-anywhere">{t("viviBot.requests.responseFailed")}</p> : null}
        </div>;
      })}
    </div>
  </section>;
}
