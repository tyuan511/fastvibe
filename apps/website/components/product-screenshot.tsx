"use client";

import Image from "next/image";
import { useRef } from "react";
import { useLocale, useTranslations } from "next-intl";
import { screenshotUrl, type FeatureScene } from "@/lib/screenshots";
import { Icon } from "./icons";

export function ProductScreenshot({ scene, large = false, priority = false }: { scene: FeatureScene; large?: boolean; priority?: boolean }) {
  const locale = useLocale();
  const t = useTranslations("features");
  const dialog = useRef<HTMLDialogElement>(null);
  const src = screenshotUrl(locale, scene);

  return (
    <>
      <button type="button" className="product-screenshot" onClick={() => dialog.current?.showModal()} aria-label={`${t("enlarge")} — ${t(`${scene}.title`)}`}>
        <Image src={src} alt={t(`${scene}.alt`)} width={2880} height={1800} priority={priority} sizes={large ? "(max-width: 1200px) 92vw, 1140px" : "(max-width: 800px) 92vw, 650px"} />
        <span className="image-zoom" aria-hidden="true"><Icon name="external" size={16} /></span>
      </button>
      <dialog
        className="screenshot-dialog"
        ref={dialog}
        aria-label={t(`${scene}.title`)}
        onClick={(event) => { if (event.target === event.currentTarget) dialog.current?.close(); }}
      >
        <button type="button" className="close-screenshot" onClick={() => dialog.current?.close()} aria-label={t("close")}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
        </button>
        { /* The full-resolution source is loaded only when the reader opens it. */ }
        <Image src={src} alt={t(`${scene}.alt`)} width={2880} height={1800} sizes="96vw" />
      </dialog>
    </>
  );
}
