"use client";

import { useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";

type Scheme = "light" | "dark";

const readScheme = (): Scheme =>
  getComputedStyle(document.documentElement).colorScheme.startsWith("dark") ? "dark" : "light";

/** A drawing of the app's layout, shown until the real thing has rendered. */
function Skeleton() {
  return (
    <div className="preview-skeleton" aria-hidden="true">
      <div className="skeleton-side">
        <span className="skeleton-lights"><i /><i /><i /></span>
        {[62, 48, 0, 70, 56, 64, 52].map((w, i) => (w ? <i key={i} className="illu-bar" style={{ width: `${w}%` }} /> : <b key={i} />))}
      </div>
      <div className="skeleton-main">
        <i className="illu-bar" style={{ width: "34%" }} />
        <span className="skeleton-bubble"><i className="illu-bar" style={{ width: "90%" }} /><i className="illu-bar" style={{ width: "55%" }} /></span>
        <div className="skeleton-lines">
          {[96, 88, 72, 0, 84, 60, 78].map((w, i) => (w ? <i key={i} className="illu-bar" style={{ width: `${w}%` }} /> : <b key={i} />))}
        </div>
        <span className="skeleton-composer"><i className="illu-bar" style={{ width: "26%" }} /></span>
      </div>
    </div>
  );
}

/**
 * The real client UI, rendered by the renderer's own fixture page (`mock.html`,
 * pre-compiled into `public/app-preview/` by `pnpm preview:build`) — not a drawing of it.
 *
 * The page is told the theme the site is showing: once in the URL, so it never paints the
 * other theme first, and afterwards by message, so the theme switch (or the OS) changes the
 * window in place instead of reloading it. The `src` is therefore set exactly once.
 *
 * The frame stays invisible behind a skeleton until the app says it has drawn (a `ready`
 * message), not merely until the document has loaded — that is the blank white flash.
 */
export function AppPreview() {
  const t = useTranslations("hero.app");
  const locale = useLocale();
  const frame = useRef<HTMLIFrameElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const post = () => {
      frame.current?.contentWindow?.postMessage({ type: "fastvibe-website-theme", theme: readScheme() }, window.location.origin);
    };
    const onReady = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== frame.current?.contentWindow) return;
      if ((event.data as { type?: string } | null)?.type === "fastvibe-website-ready") setReady(true);
    };
    window.addEventListener("message", onReady);
    // If the app never reports (a blocked script, a slow network) do not hide it forever.
    const fallback = window.setTimeout(() => setReady(true), 12_000);
    // `desktop=1`: the app floats as a glass window over a wallpaper of its own, drawn
    // inside the frame — a blur cannot reach across an iframe to the page around it.
    setSrc(`/app-preview/mock.html?website=1&lang=${locale}&scene=workspace&pane=none&platform=darwin&desktop=1&theme=${readScheme()}`);

    const observer = new MutationObserver(post);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const media = matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", post);
    return () => {
      window.removeEventListener("message", onReady);
      window.clearTimeout(fallback);
      observer.disconnect();
      media.removeEventListener("change", post);
    };
  }, [locale]);

  // The preview is a desktop (wallpaper + window), so it sits on a Mac's screen: a black
  // bezel with the camera, and the base below it (`.mac-*` in globals.css).
  return (
    <div className="mac-device">
      <div className="mac-screen">
        <span className="mac-camera" aria-hidden="true" />
        <div className="preview-window" data-ready={ready || undefined}>
          <Skeleton />
          {src && (
            <iframe
              ref={frame}
              src={src}
              title={t("aria")}
              onLoad={() => {
                frame.current?.contentWindow?.postMessage({ type: "fastvibe-website-theme", theme: readScheme() }, window.location.origin);
              }}
            />
          )}
        </div>
      </div>
      <div className="mac-base" aria-hidden="true" />
    </div>
  );
}
