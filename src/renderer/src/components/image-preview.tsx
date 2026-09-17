import { useRef, type JSX } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Lightbox for a single image. Controlled so a chip, a file tree, or a markdown
 * figure can all open the same overlay: click the dimmed page or press Esc to
 * dismiss. `src` is a data URL or http(s) URL — whatever `<img>` can paint.
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
  if (src) lastSrc.current = src;
  const imageSrc = src || lastSrc.current;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton
        overlayClassName="bg-black/70"
        className="w-fit max-w-[min(calc(100%-2rem),80rem)] gap-0 bg-transparent p-0 shadow-none ring-0 sm:max-w-[min(calc(100%-2rem),80rem)]"
      >
        <DialogTitle className="sr-only">{label}</DialogTitle>
        <DialogDescription className="sr-only">{t("clickToClose")}</DialogDescription>
        {imageSrc ? (
          <img
            src={imageSrc}
            alt={label}
            className="max-h-[85vh] max-w-full rounded-xl object-contain"
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
