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
    always?: boolean;
  }) => void;
}): JSX.Element | null {
  const { t } = useTranslation("chat");
  const [value, setValue] = useState("");
  if (!request) return null;

  const title = request.title || (request.method === "confirm" ? t("permission.needConfirm") : t("permission.needDecision"));

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onRespond({ id: request.id, cancelled: true });
      }}
    >
      <DialogContent>
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
          <Input value={value} autoFocus onChange={(event) => setValue(event.target.value)} />
        ) : null}
        {request.method === "editor" ? (
          <Textarea value={value} autoFocus className="min-h-32" onChange={(event) => setValue(event.target.value)} />
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onRespond({ id: request.id, cancelled: true })}>
            {t("permission.cancel")}
          </Button>
          {request.method === "confirm" ? (
            <>
              <Button variant="outline" onClick={() => onRespond({ id: request.id, confirmed: false })}>
                {t("permission.deny")}
              </Button>
              <Button variant="outline" onClick={() => onRespond({ id: request.id, confirmed: true, always: true })}>
                {t("permission.alwaysAllow")}
              </Button>
              <Button onClick={() => onRespond({ id: request.id, confirmed: true })}>{t("permission.allow")}</Button>
            </>
          ) : request.method === "input" || request.method === "editor" ? (
            <Button onClick={() => onRespond({ id: request.id, value })}>{t("permission.submit")}</Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
