"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
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
 * Transparent over the blue hero, solid once the page scrolls — like the reference.
 * Without JavaScript `data-top` never appears, so the bar stays solid and legible
 * over white content instead of leaving white text on a white page.
 */
export function SiteHeader() {
  const t = useTranslations();
  const [top, setTop] = useState<boolean | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const update = () => setTop(window.scrollY < 24);
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, []);

  return (
    <header className="site-header" data-top={top === true && !open ? "true" : undefined} data-open={open || undefined}>
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
          <a className="header-github" href={GITHUB_URL} target="_blank" rel="noreferrer">
            <Icon name="github" size={15} /><span>{t("nav.github")}</span>
          </a>
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
