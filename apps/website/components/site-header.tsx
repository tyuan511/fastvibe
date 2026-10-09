"use client";

import Image from "next/image";
import { useEffect, useLayoutEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { fetchMe } from "@/lib/api";
import { readViewerHint, writeViewerHint, type Viewer } from "@/lib/viewer";
import { LanguageSwitch } from "./language-switch";
import { Icon } from "./icons";
import { ThemeSwitch } from "./theme-switch";

const GITHUB_URL = "https://github.com/tyuan511/fastvibe";
const links = [
  { id: "tasks", href: "#tasks" },
  { id: "practices", href: "#practices" },
  { id: "download", href: "#access" },
] as const;

/**
 * Open on the hero, the bar is transparent with white type. After the first scroll it shrinks
 * into a floating, frosted pill. The state lives on `<html data-scrolled>` and the styles key
 * off it, so the markup the server sends is already the at-the-top look: nothing flips after
 * hydration, which is what made the old bar flash from solid to clear on every refresh.
 * Without JavaScript the CSS shows the pill instead (`@media (scripting: none)`), because
 * white type over a white page would be unreadable.
 */
export function SiteHeader() {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  // "unknown" until the remembered hint or /api/me says otherwise; null is signed out.
  const [viewer, setViewer] = useState<Viewer | null | "unknown">("unknown");

  // Draw what was true last time before the first paint, then confirm it.
  useLayoutEffect(() => {
    const hint = readViewerHint();
    if (hint !== undefined) setViewer(hint);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchMe().then(
      (me) => {
        writeViewerHint(me);
        if (!cancelled) setViewer({ login: me.login, avatar: me.avatar_url });
      },
      () => {
        writeViewerHint(null);
        if (!cancelled) setViewer(null);
      },
    );
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const update = () => root.toggleAttribute("data-scrolled", window.scrollY > 24);
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => {
      window.removeEventListener("scroll", update);
      root.removeAttribute("data-scrolled");
    };
  }, []);

  return (
    <header className="site-header" data-open={open || undefined}>
      <div className="header-inner">
        <a className="brand" href="#top" aria-label={t("home")} onClick={() => setOpen(false)}>
          <Image src="/brand/f-mark.png" alt="" width={28} height={28} priority />
          <span>FastVibe</span>
        </a>
        <nav className="site-nav" id="site-nav" aria-label={t("navigation")}>
          {links.map(({ id, href }) => (
            <a key={id} href={href} onClick={() => setOpen(false)}>{t(`nav.${id}`)}</a>
          ))}
        </nav>
        <div className="header-actions">
          <LanguageSwitch />
          <ThemeSwitch />
          <a className="header-github" href={GITHUB_URL} target="_blank" rel="noreferrer" aria-label={t("nav.github")} title="GitHub">
            <Icon name="github" size={16} />
          </a>
          {viewer === "unknown" && <span className="header-account-slot" aria-hidden="true" />}
          {viewer === null && <Link className="header-signin" href="/login">{t("nav.signIn")}</Link>}
          {viewer && viewer !== "unknown" && (
            <Link className="header-avatar" href="/console" aria-label={t("console.label")} title={viewer.login}>
              {viewer.avatar ? (
                // eslint-disable-next-line @next/next/no-img-element -- a 34px avatar from GitHub's CDN; next/image would proxy it for nothing
                <img src={viewer.avatar} alt="" width={34} height={34} referrerPolicy="no-referrer" />
              ) : (
                viewer.login.slice(0, 1).toUpperCase()
              )}
            </Link>
          )}
          <button
            type="button"
            className="menu-toggle"
            aria-expanded={open}
            aria-controls="site-nav"
            aria-label={t("navigation")}
            onClick={() => setOpen((value) => !value)}
          >
            <Icon name={open ? "x" : "menu"} size={20} />
          </button>
        </div>
      </div>
    </header>
  );
}
