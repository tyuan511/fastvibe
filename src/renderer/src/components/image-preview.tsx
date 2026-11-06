import { useEffect, useRef, useState, type JSX, type WheelEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";

const MIN_SCALE = 0.5;
const MAX_SCALE = 5;

function nextScale(current: number, deltaY: number): number {
  const factor = Math.exp(-deltaY * 0.002);
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, current * factor));
}

/**
 * Lightbox for a single image. Controlled so a chip, a file tree, or a markdown
 * figure can all open the same overlay: click the dimmed page or press Esc to
 * dismiss. The image can be zoomed with the mouse wheel while the overlay is open.
 */
export function ImagePreview({
  src,
  alt,
  open,
  onOpenChange,
}: {
  src: string;
  alt?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const { t } = useTranslation("app");
  const label = alt?.trim() || t("imagePreview");
  // Keep the last frame so the image does not vanish a tick before the overlay fades.
  const lastSrc = useRef(src);
  const [scale, setScale] = useState(1);
  const [transformOrigin, setTransformOrigin] = useState("center center");
  if (src) lastSrc.current = src;
  const imageSrc = src || lastSrc.current;

  useEffect(() => {
    if (!open) return;
    setScale(1);
    setTransformOrigin("center center");
  }, [open, src]);

  function zoom(event: WheelEvent<HTMLDivElement>): void {
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = bounds.width ? ((event.clientX - bounds.left) / bounds.width) * 100 : 50;
    const y = bounds.height ? ((event.clientY - bounds.top) / bounds.height) * 100 : 50;
    setTransformOrigin(`${x}% ${y}%`);
    setScale((current) => nextScale(current, event.deltaY));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton
        overlayClassName="bg-black/70"
        className="w-fit max-w-[min(calc(100%-2rem),80rem)] gap-0 bg-transparent p-0 shadow-none ring-0 sm:max-w-[min(calc(100%-2rem),80rem)]"
      >
        <DialogTitle className="sr-only">{label}</DialogTitle>
        <DialogDescription className="sr-only">
          {t("clickToClose")} {t("imageZoom")}
        </DialogDescription>
        {imageSrc ? (
          <div
            className="max-h-[85vh] max-w-[min(calc(100vw-2rem),80rem)] overflow-hidden overscroll-contain rounded-xl"
            onWheel={zoom}
          >
            <img
              src={imageSrc}
              alt={label}
              className="block max-h-[85vh] max-w-full object-contain transition-transform duration-75"
              style={{ transform: `scale(${scale})`, transformOrigin }}
            />
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
