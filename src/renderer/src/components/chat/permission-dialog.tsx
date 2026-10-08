import { useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { PermissionRequest } from "@shared/types";

export function PermissionDialog({
  request,
  onRespond,
}: {
  request: PermissionRequest | null;
  onRespond: (payload: {
    id: string;
    confirmed?: boolean;
    value?: string;
    cancelled?: boolean;
  }) => void;
}): JSX.Element | null {
  const { t } = useTranslation("chat");
  // The dialog stays mounted across requests. Remember which request the text
  // belongs to, and fall back to that request's prefill until the user types —
  // an editor that opened empty made `/handoff` throw the summary away.
  const requestId = request?.id ?? "";
  const [draft, setDraft] = useState<{ id: string; value: string } | null>(null);
  const value = draft?.id === requestId ? draft.value : (request?.prefill ?? "");
  if (!request) return null;

  const title = request.title || (request.method === "confirm" ? t("permission.needConfirm") : t("permission.needDecision"));
  // `editor` and `input` hold text the user had to write. A modal backdrop covers the
  // whole window, so an outside press anywhere would throw that away — there is an
  // explicit 取消 and a ✕ (and Escape) to leave on purpose. A `confirm` / `select` is a
  // single click with nothing to lose, so it keeps the usual dismissal.
  const typed = request.method === "editor" || request.method === "input";

  return (
    <Dialog
      open
      disablePointerDismissal={typed}
      onOpenChange={(open) => {
        if (!open) onRespond({ id: request.id, cancelled: true });
      }}
    >
      <DialogContent className={request.method === "editor" ? "sm:max-w-2xl" : undefined}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {request.message ? <DialogDescription className="whitespace-pre-wrap">{request.message}</DialogDescription> : null}
        </DialogHeader>
        {request.method === "select" && request.options ? (
          <div className="flex flex-col gap-1.5">
            {request.options.map((option, index) => (
              <Button
                key={option}
                variant="outline"
                className="h-auto justify-start py-2 text-left"
                onClick={() => onRespond({ id: request.id, value: option })}
              >
                <span>
                  <span className="block">{option}</span>
                  {request.optionDetails?.[index]?.description ? (
                    <span className="block text-xs font-normal text-muted-foreground">
                      {request.optionDetails[index]?.description}
                    </span>
                  ) : null}
                </span>
              </Button>
            ))}
          </div>
        ) : null}
        {request.method === "input" ? (
          <Input value={value} autoFocus onChange={(event) => setDraft({ id: requestId, value: event.target.value })} />
        ) : null}
        {request.method === "editor" ? (
          <Textarea
            value={value}
            autoFocus
            className="max-h-[50vh] min-h-40"
            onChange={(event) => setDraft({ id: requestId, value: event.target.value })}
          />
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onRespond({ id: request.id, cancelled: true })}>
            {t("permission.cancel")}
          </Button>
          {request.method === "confirm" ? (
            <>
              <Button variant="outline" onClick={() => onRespond({ id: request.id, confirmed: false })}>
                {t("permission.no")}
              </Button>
              <Button onClick={() => onRespond({ id: request.id, confirmed: true })}>{t("permission.yes")}</Button>
            </>
          ) : request.method === "input" || request.method === "editor" ? (
            <Button onClick={() => onRespond({ id: request.id, value })}>{t("permission.submit")}</Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
