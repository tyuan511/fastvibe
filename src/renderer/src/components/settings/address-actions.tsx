import { useEffect, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { CheckmarkCircle02Icon, Copy01Icon, LinkSquare02Icon, QrCode01Icon } from "@hugeicons/core-free-icons";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { QrCode } from "@/components/ui/qr-code";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isReachableFromAnotherDevice } from "@/lib/address-reachability";
import { cn } from "@/lib/utils";

/**
 * The ways an address gets onto another device: copied, opened, or scanned.
 *
 * Every settings row that shows an address draws these — the one under 允许远程连接 and
 * 内网穿透's public URL — so they live here rather than twice. Three icons and no words:
 * the address is already on screen beside them, and a row of one-line settings has no
 * space for two labelled buttons meaning 复制 and 打开. The two that are not self-evident
 * name themselves on hover.
 *
 * One string drives all three: `value` is what the copy button writes, what the anchor
 * points at, and what the code encodes. A QR that opens a different address than the one
 * you copied is a bug nobody notices until they are holding a phone.
 */
export function AddressActions({
  value,
  className,
}: {
  value: string;
  className?: string;
}): JSX.Element {
  const { t } = useTranslation("settings");

  return (
    <span className={cn("inline-flex items-center gap-0.5", className)}>
      <CopyAction value={value} />
      {/*
       * A code is only offered when another device could actually open the address.
       *
       * The row under 允许远程连接 shows whatever the server is listening on — with
       * 局域网访问 off that is the reported loopback address, which is where the server is,
       * not where a client goes. A code for it scans perfectly and then fails with
       * 连接被拒绝 on the phone, so offering one would be worse than offering nothing. The
       * address itself is still worth copying and still opens on this machine, so those
       * two stay.
       *
       * Derived from the address rather than passed in by each caller (`lib/
       * address-reachability.ts`): a flag would be one more place to be wrong, and the
       * first version of this component had two of them and drew two icons.
       */}
      {isReachableFromAnotherDevice(value) ? <QrAction value={value} /> : null}
      {/*
       * `nativeButton={false}` because the rendered element is an anchor, not a button:
       * Base UI otherwise keeps the native button semantics it assumes and warns, and the
       * element ends up claiming to be something it is not. An anchor is what this has to
       * be — the desktop turns a real link into `shell.openExternal` through
       * `setWindowOpenHandler`, and the browser client navigates in a new tab.
       */}
      <Tooltip>
        <TooltipTrigger
          render={
            <a
              href={value}
              target="_blank"
              rel="noreferrer"
              className={ICON_CLASS}
              aria-label={t("remote.tunnelOpen")}
            />
          }
        >
          <HugeiconsIcon strokeWidth={2} icon={LinkSquare02Icon} className="size-3.5" />
        </TooltipTrigger>
        <TooltipContent>{t("remote.tunnelOpen")}</TooltipContent>
      </Tooltip>
    </span>
  );
}

const ICON_CLASS = "text-muted-foreground/70 hover:text-foreground";

/** Copy the address, and say so on the glyph itself. */
function CopyAction({ value }: { value: string }): JSX.Element {
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
function QrAction({ value }: { value: string }): JSX.Element {
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
        <QrCode value={value} title={value} className="size-40" />
        <div className="font-mono text-xs break-all">{value}</div>
        <div className="text-xs text-muted-foreground">{t("remote.qrHint")}</div>
      </PopoverContent>
    </Popover>
  );
}
