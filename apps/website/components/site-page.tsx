import Image from "next/image";
import { useLocale, useTranslations } from "next-intl";
import { LanguageSwitch } from "./language-switch";
import { DownloadCards } from "./download-cards";
import { DownloadPicker } from "./download-picker";
import { Icon } from "./icons";
import { ProductScreenshot } from "./product-screenshot";
import type { LatestRelease } from "@/lib/github-release";

const GITHUB_URL = "https://github.com/tyuan511/fastvibe";
const benefits = [
  { id: "minimal", icon: "terminal" },
  { id: "models", icon: "layers" },
  { id: "extensible", icon: "puzzle" },
] as const;
const sourceLayers = [
  { id: "desktop", name: "FastVibe", href: GITHUB_URL },
  { id: "session", name: "pi-coding-agent", href: "https://github.com/earendil-works/pi/tree/main/packages/coding-agent" },
  { id: "agent", name: "pi-agent-core", href: "https://github.com/earendil-works/pi/tree/main/packages/agent" },
  { id: "models", name: "pi-ai", href: "https://github.com/earendil-works/pi/tree/main/packages/ai" },
] as const;
const features = [
  { id: "workspace", icon: "terminal" },
  { id: "review", icon: "layers" },
  { id: "models", icon: "puzzle" },
] as const;

function TitleLines({ text }: { text: string }) {
  return <>{text.split("\n").map((line) => <span className="title-line" key={line}>{line}</span>)}</>;
}

export function SitePage({ release }: { release: LatestRelease }) {
  const t = useTranslations();
  const locale = useLocale();
  const guide = `${GITHUB_URL}/blob/main/${locale === "zh" ? "README.zh-CN.md" : "README.md"}`;

  return (
    <div className="site-shell">
      <a className="skip-link" href="#main-content">{t("skip")}</a>
      <header className="site-header">
        <div className="header-inner container">
          <a className="brand" href="#top" aria-label={t("home")}><Image src="/brand/f-mark.png" alt="" width={32} height={32} priority /><span>FastVibe</span></a>
          <span className="brand-badge">{t("nav.badge")}</span>
          <nav className="site-nav" aria-label={t("navigation")}><a href="#features">{t("nav.product")}</a><a href="#download">{t("nav.download")}</a></nav>
          <LanguageSwitch />
          <a className="header-github pill-button" href={GITHUB_URL} target="_blank" rel="noreferrer"><Icon name="github" size={15} />GitHub</a>
        </div>
      </header>

      <main id="main-content">
        <section className="hero" id="top">
          <div className="hero-content container">
            <div className="hero-copy">
              <p className="hero-eyebrow">{t("hero.eyebrow")}</p>
              <h1><TitleLines text={t("hero.title")} /></h1>
              <div className="hero-description">
                <p>{t.rich("hero.description", { strong: (text) => <strong>{text}</strong> })}</p>
                <p>{t.rich("hero.detail", { strong: (text) => <strong>{text}</strong> })}</p>
              </div>
              <div className="hero-links">
                <a className="pill-button primary" href="#download"><Icon name="download" size={15} />{t("hero.download")}</a>
                <a className="pill-button secondary" href={GITHUB_URL} target="_blank" rel="noreferrer"><Icon name="github" size={15} />{t("hero.source")}</a>
                <a className="text-link" href={guide} target="_blank" rel="noreferrer">{t("hero.docs")}<Icon name="arrow-up-right" size={14} /></a>
              </div>
            </div>
            <div className="hero-product">
              <div className="hero-product-label"><span>{t("hero.cardTitle")}</span><span>{t("hero.platforms")}</span></div>
              <div className="hero-product-frame"><ProductScreenshot scene="workspace" large priority /></div>
              <DownloadPicker release={release} />
            </div>
          </div>
        </section>

        <section className="overview-section container" id="built-on-pi" aria-labelledby="pi-heading">
          <div className="center-heading">
            <p className="section-label">{t("overview.eyebrow")}</p>
            <div className="overview-word" aria-hidden="true">{t("overview.word")}</div>
            <h2 id="pi-heading"><TitleLines text={t("overview.title")} /></h2>
            <p className="overview-description"><TitleLines text={t("overview.description")} /></p>
            <a className="text-link pi-link" href="https://pi.dev" target="_blank" rel="noreferrer">{t("overview.piLink")}<Icon name="arrow-up-right" size={14} /></a>
          </div>
          <div className="benefits-grid">
            {benefits.map(({ id, icon }) => (
              <article className="benefit" key={id}>
                <span className="benefit-icon"><Icon name={icon} size={30} /></span>
                <h3>{t(`overview.items.${id}.title`)}</h3><p>{t(`overview.items.${id}.copy`)}</p>
              </article>
            ))}
          </div>
          <div className="source-foundation">
            <div className="source-heading"><h3>{t("overview.sourceTitle")}</h3><p>{t("overview.sourceCopy")}</p></div>
            <ol className="source-chain" aria-label={t("overview.sourceLabel")}>
              {sourceLayers.map(({ id, name, href }) => (
                <li key={id}>
                  <a href={href} target="_blank" rel="noreferrer">
                    <span className="source-layer-name">{name}<Icon name="arrow-up-right" size={14} /></span>
                    <span className="source-layer-description">{t(`overview.layers.${id}`)}</span>
                  </a>
                </li>
              ))}
            </ol>
            <p className="source-scope">{t("overview.scope")}</p>
          </div>
        </section>

        <section className="features-section container" id="features">
          <div className="section-heading"><p className="section-label">{t("features.eyebrow")}</p><h2><TitleLines text={t("features.title")} /></h2></div>
          <div className="feature-rows">
            {features.map(({ id, icon }, index) => (
              <article className="feature-row" key={id}>
                <div className="feature-copy"><span className="feature-index" aria-hidden="true">0{index + 1}</span><h3><Icon name={icon} size={23} />{t(`features.${id}.title`)}</h3><p>{t(`features.${id}.copy`)}</p></div>
                <ProductScreenshot scene={id} />
              </article>
            ))}
          </div>
        </section>

        <section className="download-section container" id="download">
          <div className="download-heading">
            <div><p className="section-label">{t("download.eyebrow")}</p><h2>{t("download.title")}</h2><p className="section-description">{t("download.copy")}</p></div>
            <a className="release-link" href={release.url} target="_blank" rel="noreferrer">{release.isFallback ? t("download.fallback") : <><span>{release.version}</span>{t("download.releaseNotes")}</>}<Icon name="arrow-up-right" size={14} /></a>
          </div>
          <DownloadCards release={release} />
          <div className="download-notes"><div><p>{t("download.setupNote")}</p><p>{t("download.macNote")} <a href={guide} target="_blank" rel="noreferrer">{t("download.installGuide")} ↗</a></p></div><a className="text-link" href={release.url} target="_blank" rel="noreferrer">{t("download.allFiles")}<Icon name="arrow-up-right" size={14} /></a></div>
        </section>

        <section className="community-section container">
          <h2>{t("openSource.title")}</h2><p>{t("openSource.copy")}</p>
          <div className="community-links"><a className="pill-button primary" href={GITHUB_URL} target="_blank" rel="noreferrer"><Icon name="github" size={15} />{t("openSource.github")}</a><a className="pill-button secondary" href={`${GITHUB_URL}/issues`} target="_blank" rel="noreferrer">{t("openSource.issues")}<Icon name="arrow-up-right" size={14} /></a></div>
        </section>
      </main>

      <footer className="site-footer container">
        <a className="footer-brand" href="#top"><Image src="/brand/f-mark.png" alt="" width={20} height={20} /><span>FastVibe</span></a>
        <p>{t("footer.license")} · © {new Date().getFullYear()} FastVibe</p>
        <div className="footer-links"><a href={`${GITHUB_URL}/releases`} target="_blank" rel="noreferrer">{t("footer.changelog")}</a><a href={`${GITHUB_URL}/issues`} target="_blank" rel="noreferrer">{t("footer.contact")}</a></div>
      </footer>
    </div>
  );
}
