import { useEffect, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { CheckmarkCircle02Icon, Copy01Icon, QrCode01Icon } from "@hugeicons/core-free-icons";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { QrCode } from "@/components/ui/qr-code";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { remoteQrValue } from "@shared/remote-address";

const ICON_CLASS = "text-muted-foreground/70 hover:text-foreground";

/** Copy the address, and say so on the glyph itself. */
export function CopyAction({ value }: { value: string }): JSX.Element {
  const { t } = useTranslation("settings");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard
                .writeText(value)
                .then(() => setCopied(true))
                // Clipboard unavailable: the address stays selectable on screen.
                .catch(() => undefined);
            }}
            className={ICON_CLASS}
            aria-label={t("remote.copyAddress")}
          />
        }
      >
        <HugeiconsIcon strokeWidth={2} icon={copied ? CheckmarkCircle02Icon : Copy01Icon} className="size-3.5" />
      </TooltipTrigger>
      <TooltipContent>{t("remote.copyAddress")}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The address as a code, shown while the pointer is on the icon.
 *
 * `openOnHover` opens it on `mouseenter` and closes it on `mouseleave`; the popup is
 * hoverable by default, so moving the pointer from the icon onto the code keeps it open —
 * which is the whole point, since scanning it means pointing a phone at the screen rather
 * than reading the tooltip. A click still works (Base UI's trigger toggles too), so touch
 * — where there is no hover at all — is not left with an icon that does nothing.
 *
 * `delay` is small on purpose: the pane is 远程访问, where hovering an address to see its
 * code is the intended action, not an accident to be defended against. Base UI's default
 * of 300ms only makes the code feel like it is lagging behind the pointer. `closeDelay`
 * is what lets the pointer travel from the 14px icon to the code without the code
 * vanishing underneath it — the gap between them is a few pixels the pointer has to
 * cross, and a zero delay there would be a code that flickers away exactly as the user
 * reaches for it.
 *
 * Not a tooltip even though it reacts to hover: a tooltip closes as soon as the pointer
 * leaves its trigger, and scanning means leaving the trigger to point a camera at the
 * code. `openOnHover` + a hoverable popup is the shape that survives that.
 */
export function QrAction({ value, name }: { value: string; name?: string }): JSX.Element {
  const { t } = useTranslation("settings");

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={120}
        closeDelay={160}
        render={
          <button
            type="button"
            className={cn(ICON_CLASS, "aria-expanded:text-foreground")}
            aria-label={t("remote.showQr")}
          />
        }
      >
        <HugeiconsIcon strokeWidth={2} icon={QrCode01Icon} className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={8} className="w-auto items-center gap-2 p-3">
        <QrCode value={remoteQrValue(value, name)} title={name?.trim() || value} className="size-40" />
        {name?.trim() ? <div className="text-sm font-medium">{name.trim()}</div> : null}
        <div className="font-mono text-xs break-all">{value}</div>
        <div className="text-xs text-muted-foreground">{t("remote.qrHint")}</div>
      </PopoverContent>
    </Popover>
  );
}
